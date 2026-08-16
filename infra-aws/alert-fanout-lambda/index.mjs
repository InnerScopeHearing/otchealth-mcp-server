// otchealth-aws-alert-fanout
//
// Subscribed (protocol=lambda) to the SNS topic `otchealth-aws-alerts`. Lambda/SQS/HTTPS
// subscriptions auto-confirm -- unlike the topic's original protocol=email subscription to
// matthew@otchealth.app, which has sat PendingConfirmation since creation (SNS email
// confirmation tokens expire after 3 days, so that original subscription is permanently dead;
// it is left in place, harmless, in case someone confirms it later, but nothing depends on it).
//
// Every CloudWatch alarm state change and any other message published to the topic lands here
// and is fanned out, with NO human click anywhere in the path, to channels the fleet can read
// back and prove received:
//   1. A GitHub issue comment (InnerScopeHearing/otchealth-mcp-server issue #226 -- NOT the
//      original #21 "Nightly Medic Log": #21 hit GitHub's hard 2500-comment cap around
//      2026-08-10 and now 403s on every new comment, so #21 is itself a dead channel).
//   2. A Datadog Event (Events API v1).
//   3. A PostHog capture event (Gateway Ops project).
//   4. Microsoft Graph email, best-effort (same mechanism the gateway's own `graph_send_email`
//      tool uses: app-only client-credentials against the CS-Engine-Mailboxes-scoped app,
//      sent as coo@otchealthmart.com, which is on that app's Exchange ApplicationAccessPolicy
//      allowlist). This is last because it is the hardest of the four to prove delivered from
//      inside a Lambda with no human inbox access, so it must never be the only channel.
//
// Every channel call is independently caught and logged: one channel failing (rate limit,
// expired secret, transient 5xx) never blocks the others. The invocation only throws (so SNS's
// built-in Lambda retry kicks in) if EVERY channel failed -- a single-channel outage is visible
// in CloudWatch Logs but does not need a retry storm.
//
// Dependency-free by design (mirrors the fleet's existing /tmp/awsx/sig.mjs convention): no
// npm install, no layer, no aws-sdk import. SSM is called with a hand-rolled SigV4 signer using
// the Lambda execution role's own credentials (AWS_ACCESS_KEY_ID/SECRET/SESSION_TOKEN, injected
// automatically by the Lambda runtime -- never hardcoded, never logged).
//
// Secrets: read at runtime from SSM Parameter Store under /otchealth/*. Only parameter NAMES
// live in this file; every VALUE is fetched fresh per invocation and never printed or embedded.

import crypto from 'node:crypto';

const REGION = process.env.AWS_REGION || 'us-east-1';
const REPO_OWNER = 'InnerScopeHearing';
const REPO_NAME = 'otchealth-mcp-server';
const ALERT_ISSUE_NUMBER = 226; // "AWS Fleet Alerts (SNS -> Lambda fanout)" -- see file header
const GRAPH_SENDER = 'coo@otchealthmart.com'; // allowlisted CS-engine sender (Exchange ApplicationAccessPolicy)
const GRAPH_RECIPIENT = 'matthew@otchealth.app'; // the original (dead) SNS email subscription's target

const SSM_PARAM_NAMES = [
  '/otchealth/github-app-id',
  '/otchealth/github-app-private-key',
  '/otchealth/github-app-installation-id',
  '/otchealth/datadog-api-key',
  '/otchealth/datadog-site',
  '/otchealth/posthog-gatewayops-ingest-key',
  '/otchealth/posthog-host',
  '/otchealth/graph-mail-client-id',
  '/otchealth/graph-mail-client-secret',
  '/otchealth/graph-mail-tenant-id',
];

// ---------------------------------------------------------------------------------------------
// Minimal dependency-free SigV4 (same algorithm as /tmp/awsx/sig.mjs). Reproduced inline so this
// Lambda ships as a single file with zero npm dependencies and zero cold-start layer risk.
// ---------------------------------------------------------------------------------------------
function sha256Hex(body) { return crypto.createHash('sha256').update(body).digest('hex'); }
function hmac(key, data) { return crypto.createHmac('sha256', key).update(data).digest(); }

async function awsCall({ service, region = REGION, host, method = 'POST', path = '/', query = '', body = '', headers = {} }) {
  const AK = process.env.AWS_ACCESS_KEY_ID;
  const SK = process.env.AWS_SECRET_ACCESS_KEY;
  const ST = process.env.AWS_SESSION_TOKEN;
  if (query) query = query.split('&').filter(Boolean).sort().join('&');
  host = host || `${service}.${region}.amazonaws.com`;
  const amz = new Date().toISOString().replace(/[:-]|\..{3}/g, '');
  const date = amz.slice(0, 8);
  const hh = { host, 'x-amz-date': amz, 'x-amz-content-sha256': sha256Hex(body), ...(ST ? { 'x-amz-security-token': ST } : {}), ...headers };
  const keys = Object.keys(hh).map((k) => k.toLowerCase()).sort();
  const canonH = keys.map((k) => `${k}:${String(hh[Object.keys(hh).find((x) => x.toLowerCase() === k)]).trim()}\n`).join('');
  const signed = keys.join(';');
  const creq = [method, path, query, canonH, signed, sha256Hex(body)].join('\n');
  const scope = `${date}/${region}/${service}/aws4_request`;
  const sts = ['AWS4-HMAC-SHA256', amz, scope, sha256Hex(creq)].join('\n');
  let k = hmac('AWS4' + SK, date);
  k = hmac(k, region);
  k = hmac(k, service);
  k = hmac(k, 'aws4_request');
  const sig = hmac(k, sts).toString('hex');
  hh.Authorization = `AWS4-HMAC-SHA256 Credential=${AK}/${scope}, SignedHeaders=${signed}, Signature=${sig}`;
  const url = `https://${host}${path}${query ? '?' + query : ''}`;
  const r = await fetch(url, { method, headers: hh, body: method === 'GET' ? undefined : body });
  return { status: r.status, text: await r.text() };
}

// ---------------------------------------------------------------------------------------------
// Secrets: one batched SSM GetParameters call (max 10 names; we have exactly 10). Fetched fresh
// every invocation -- this is a low-frequency alert path, so we trade a few ms of SSM latency for
// never risking a stale secret after a rotation. Values are held only in local variables, never
// logged.
// ---------------------------------------------------------------------------------------------
async function loadSecrets() {
  const r = await awsCall({
    service: 'ssm',
    host: `ssm.${REGION}.amazonaws.com`,
    method: 'POST',
    body: JSON.stringify({ Names: SSM_PARAM_NAMES, WithDecryption: true }),
    headers: { 'Content-Type': 'application/x-amz-json-1.1', 'X-Amz-Target': 'AmazonSSM.GetParameters' },
  });
  if (r.status !== 200) throw new Error(`SSM GetParameters failed: ${r.status} ${r.text.slice(0, 300)}`);
  const j = JSON.parse(r.text);
  if (j.InvalidParameters && j.InvalidParameters.length) {
    console.error('SSM InvalidParameters (missing/no access):', JSON.stringify(j.InvalidParameters));
  }
  const map = {};
  for (const p of j.Parameters) map[p.Name] = p.Value;
  const need = (name) => {
    const v = map[name];
    if (!v) throw new Error(`Missing required SSM parameter: ${name}`);
    return v;
  };
  return {
    ghAppId: need('/otchealth/github-app-id'),
    ghPrivateKey: need('/otchealth/github-app-private-key'),
    ghInstallationId: need('/otchealth/github-app-installation-id'),
    ddApiKey: need('/otchealth/datadog-api-key'),
    ddSite: need('/otchealth/datadog-site'),
    phIngestKey: need('/otchealth/posthog-gatewayops-ingest-key'),
    phHost: need('/otchealth/posthog-host'),
    graphClientId: need('/otchealth/graph-mail-client-id'),
    graphClientSecret: need('/otchealth/graph-mail-client-secret'),
    graphTenantId: need('/otchealth/graph-mail-tenant-id'),
  };
}

function withTimeout(ms) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  return { signal: ac.signal, done: () => clearTimeout(t) };
}

// ---------------------------------------------------------------------------------------------
// Alert formatting: understands a CloudWatch alarm state-change JSON payload (the shape every
// AlarmAction/OKAction on this topic publishes); falls back to raw Subject/Message for anything
// else (manual test publishes, future non-CloudWatch producers).
// ---------------------------------------------------------------------------------------------
function formatAlert(subject, rawMessage) {
  let parsed = null;
  try { parsed = JSON.parse(rawMessage); } catch { /* not JSON -- raw text alert */ }

  if (parsed && typeof parsed === 'object' && parsed.AlarmName) {
    const emoji = parsed.NewStateValue === 'ALARM' ? '\u{1F534}' : parsed.NewStateValue === 'OK' ? '\u{1F7E2}' : '⚪';
    const title = `${emoji} ${parsed.AlarmName}: ${parsed.OldStateValue || '?'} -> ${parsed.NewStateValue || '?'}`;
    const lines = [
      `Reason: ${parsed.NewStateReason || '(none given)'}`,
      parsed.Trigger ? `Metric: ${parsed.Trigger.MetricName} (${parsed.Trigger.Namespace})` : null,
      `Region: ${parsed.Region || REGION}`,
      `Changed: ${parsed.StateChangeTime || '(unknown)'}`,
      parsed.AlarmDescription ? `Description: ${parsed.AlarmDescription}` : null,
    ].filter(Boolean);
    return {
      title,
      body: lines.join('\n'),
      severity: parsed.NewStateValue === 'ALARM' ? 'error' : parsed.NewStateValue === 'OK' ? 'success' : 'info',
      isRecovery: parsed.NewStateValue === 'OK',
    };
  }

  // Non-CloudWatch (or unparseable) message: pass through as-is.
  return {
    title: subject || '(no subject) AWS SNS alert',
    body: rawMessage,
    severity: 'info',
    isRecovery: false,
  };
}

// ---------------------------------------------------------------------------------------------
// Channel 1: GitHub issue comment (App JWT -> installation token -> POST comment).
// ---------------------------------------------------------------------------------------------
async function postGithubComment(secrets, alert) {
  const now = Math.floor(Date.now() / 1000);
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const jwtInput = `${enc({ alg: 'RS256', typ: 'JWT' })}.${enc({ iat: now - 60, exp: now + 540, iss: secrets.ghAppId })}`;
  const jwtSig = crypto.createSign('RSA-SHA256').update(jwtInput).sign(secrets.ghPrivateKey, 'base64url');
  const jwt = `${jwtInput}.${jwtSig}`;

  const t1 = withTimeout(8000);
  const tr = await fetch(`https://api.github.com/app/installations/${secrets.ghInstallationId}/access_tokens`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${jwt}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
    signal: t1.signal,
  }).finally(t1.done);
  const tj = await tr.json();
  if (!tr.ok) throw new Error(`installation token ${tr.status}: ${JSON.stringify(tj).slice(0, 200)}`);

  const t2 = withTimeout(8000);
  const cr = await fetch(`https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/issues/${ALERT_ISSUE_NUMBER}/comments`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${tj.token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'Content-Type': 'application/json' },
    body: JSON.stringify({ body: `**${alert.title}**\n\n${alert.body}\n\n_Delivered by otchealth-aws-alert-fanout, ${new Date().toISOString()}_` }),
    signal: t2.signal,
  }).finally(t2.done);
  const cj = await cr.json();
  if (!cr.ok) throw new Error(`issue comment ${cr.status}: ${JSON.stringify(cj).slice(0, 200)}`);
  return { html_url: cj.html_url, id: cj.id };
}

// ---------------------------------------------------------------------------------------------
// Channel 2: Datadog Event (Events API v1).
// ---------------------------------------------------------------------------------------------
async function postDatadogEvent(secrets, alert) {
  const t = withTimeout(8000);
  const r = await fetch(`https://api.${secrets.ddSite}/api/v1/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'DD-API-KEY': secrets.ddApiKey },
    body: JSON.stringify({
      title: alert.title,
      text: alert.body,
      alert_type: alert.severity,
      tags: ['source:otchealth-aws-alert-fanout', `env:${process.env.AWS_LAMBDA_FUNCTION_NAME || 'unknown'}`],
    }),
    signal: t.signal,
  }).finally(t.done);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`datadog event ${r.status}: ${JSON.stringify(j).slice(0, 200)}`);
  return { id: j.event?.id, url: j.event?.url };
}

// ---------------------------------------------------------------------------------------------
// Channel 3: PostHog capture (Gateway Ops project).
// ---------------------------------------------------------------------------------------------
async function postPostHogCapture(secrets, alert) {
  const t = withTimeout(8000);
  const r = await fetch(`${secrets.phHost}/capture/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: secrets.phIngestKey,
      event: 'aws_fleet_alert',
      distinct_id: 'otchealth-aws-alert-fanout',
      properties: {
        title: alert.title,
        severity: alert.severity,
        is_recovery: alert.isRecovery,
        source: 'sns:otchealth-aws-alerts',
      },
    }),
    signal: t.signal,
  }).finally(t.done);
  const text = await r.text();
  if (!r.ok) throw new Error(`posthog capture ${r.status}: ${text.slice(0, 200)}`);
  return { status: text.slice(0, 100) };
}

// ---------------------------------------------------------------------------------------------
// Channel 4: Microsoft Graph email, best-effort. Same app-only client-credentials mechanism as
// the gateway's graph_send_email tool (src/graph/api-client.ts); GRAPH_SENDER must stay one of
// the CS-Engine-Mailboxes addresses (care/sarah/helen/ray/coo@otchealthmart.com) -- that set is
// enforced both in the gateway's own code and by a real Exchange ApplicationAccessPolicy
// (RestrictAccess) on this app registration, so any other sender 403s at the Exchange layer
// regardless of what this Lambda requests.
// ---------------------------------------------------------------------------------------------
async function sendGraphEmail(secrets, alert) {
  const t1 = withTimeout(8000);
  const tr = await fetch(`https://login.microsoftonline.com/${secrets.graphTenantId}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: secrets.graphClientId,
      client_secret: secrets.graphClientSecret,
      scope: 'https://graph.microsoft.com/.default',
    }).toString(),
    signal: t1.signal,
  }).finally(t1.done);
  const tj = await tr.json();
  if (!tr.ok) throw new Error(`graph token ${tr.status}: ${JSON.stringify(tj).slice(0, 200)}`);

  const t2 = withTimeout(8000);
  const sr = await fetch(`https://graph.microsoft.com/v1.0/users/${GRAPH_SENDER}/sendMail`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${tj.access_token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: {
        subject: `[AWS Alert] ${alert.title}`,
        body: { contentType: 'Text', content: alert.body },
        toRecipients: [{ emailAddress: { address: GRAPH_RECIPIENT } }],
      },
      saveToSentItems: true,
    }),
    signal: t2.signal,
  }).finally(t2.done);
  if (!sr.ok) {
    const text = await sr.text().catch(() => '');
    throw new Error(`graph sendMail ${sr.status}: ${text.slice(0, 200)}`);
  }
  return { status: sr.status, to: GRAPH_RECIPIENT, from: GRAPH_SENDER };
}

// ---------------------------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------------------------
export async function handler(event) {
  const records = event?.Records || [];
  if (!records.length) {
    console.error('No SNS Records in event; nothing to fan out.', JSON.stringify(event).slice(0, 500));
    return { processed: 0 };
  }

  const secrets = await loadSecrets();
  let anyChannelEverSucceeded = false;
  const summaries = [];

  for (const record of records) {
    const sns = record.Sns || {};
    const alert = formatAlert(sns.Subject, sns.Message || '');
    console.log('Fanning out alert:', alert.title);

    const [gh, dd, ph, graph] = await Promise.allSettled([
      postGithubComment(secrets, alert),
      postDatadogEvent(secrets, alert),
      postPostHogCapture(secrets, alert),
      sendGraphEmail(secrets, alert),
    ]);

    for (const [name, res] of [['github', gh], ['datadog', dd], ['posthog', ph], ['graph_email', graph]]) {
      if (res.status === 'fulfilled') {
        anyChannelEverSucceeded = true;
        console.log(`OK   ${name}:`, JSON.stringify(res.value));
      } else {
        console.error(`FAIL ${name}:`, res.reason?.message || String(res.reason));
      }
    }

    summaries.push({
      title: alert.title,
      github: gh.status,
      datadog: dd.status,
      posthog: ph.status,
      graph_email: graph.status,
    });
  }

  if (!anyChannelEverSucceeded) {
    // Every channel failed on every record in this batch: throw so SNS's built-in Lambda retry
    // (async invocation retries twice, then -- if a DLQ/on-failure destination is configured --
    // lands there) gets a chance, instead of silently swallowing a total outage.
    throw new Error(`All channels failed for all ${records.length} record(s): ${JSON.stringify(summaries)}`);
  }

  return { processed: records.length, summaries };
}
