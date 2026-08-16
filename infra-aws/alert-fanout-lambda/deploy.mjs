#!/usr/bin/env node
// Provisions otchealth-aws-alert-fanout end to end: IAM execution role (least privilege --
// SSM GetParameter/GetParameters scoped to exactly the 10 parameters index.mjs reads, plus
// KMS Decrypt scoped by kms:ViaService=ssm.<region>.amazonaws.com, mirroring the existing
// otchealthTaskRole pattern; AWSLambdaBasicExecutionRole managed policy for CloudWatch Logs
// only), the Lambda function itself, the SNS-invoke permission, and the SNS subscription.
//
// Idempotent: safe to re-run. CreateRole/CreateFunction/Subscribe all tolerate "already exists"
// by falling through to update-in-place.
//
// Credentials: reads AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY from the environment (the CTO's
// own IAM user, used only to provision -- the Lambda's RUNTIME credentials are its own execution
// role, assumed by the Lambda service, never these).
//
// Usage: AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=... node deploy.mjs

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const REGION = 'us-east-1';
const ACCOUNT_ID = '900915535335';
const ROLE_NAME = 'otchealth-aws-alert-fanout-role';
const FUNCTION_NAME = 'otchealth-aws-alert-fanout';
const TOPIC_ARN = `arn:aws:sns:${REGION}:${ACCOUNT_ID}:otchealth-aws-alerts`;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SSM_PARAM_ARNS = [
  'github-app-id', 'github-app-private-key', 'github-app-installation-id',
  'datadog-api-key', 'datadog-site',
  'posthog-gatewayops-ingest-key', 'posthog-host',
  'graph-mail-client-id', 'graph-mail-client-secret', 'graph-mail-tenant-id',
].map((n) => `arn:aws:ssm:${REGION}:${ACCOUNT_ID}:parameter/otchealth/${n}`);

if (!process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY) {
  console.error('Set AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY first.');
  process.exit(1);
}

function sha256Hex(body) { return crypto.createHash('sha256').update(body).digest('hex'); }
function hmac(key, data) { return crypto.createHmac('sha256', key).update(data).digest(); }
// encodeURIComponent leaves `! ' ( ) *` unescaped (ECMAScript legacy), but AWS SigV4 requires
// full RFC 3986 encoding (only A-Za-z0-9-_.~ are unreserved) -- a query VALUE containing any of
// those five characters (e.g. a policy JSON's `"Resource":"*"`, or prose with parens) signs
// clean locally but 403s SignatureDoesNotMatch against AWS's own re-canonicalization. Escape
// them explicitly. Use this for every query-string VALUE passed to awsCall, never raw
// encodeURIComponent.
function uriEncode(str) {
  return encodeURIComponent(str).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}
async function awsCall({ service, region = REGION, host, method = 'POST', path: p = '/', query = '', body = '', headers = {} }) {
  const AK = process.env.AWS_ACCESS_KEY_ID, SK = process.env.AWS_SECRET_ACCESS_KEY, ST = process.env.AWS_SESSION_TOKEN;
  if (query) query = query.split('&').filter(Boolean).sort().join('&');
  host = host || `${service}.${region}.amazonaws.com`;
  const amz = new Date().toISOString().replace(/[:-]|\..{3}/g, ''); const date = amz.slice(0, 8);
  const hh = { host, 'x-amz-date': amz, 'x-amz-content-sha256': sha256Hex(body), ...(ST ? { 'x-amz-security-token': ST } : {}), ...headers };
  const keys = Object.keys(hh).map((k) => k.toLowerCase()).sort();
  const canonH = keys.map((k) => `${k}:${String(hh[Object.keys(hh).find((x) => x.toLowerCase() === k)]).trim()}\n`).join('');
  const signed = keys.join(';');
  const creq = [method, p, query, canonH, signed, sha256Hex(body)].join('\n');
  const scope = `${date}/${region}/${service}/aws4_request`;
  const sts = ['AWS4-HMAC-SHA256', amz, scope, sha256Hex(creq)].join('\n');
  let k = hmac('AWS4' + SK, date); k = hmac(k, region); k = hmac(k, service); k = hmac(k, 'aws4_request');
  const sig = hmac(k, sts).toString('hex');
  hh.Authorization = `AWS4-HMAC-SHA256 Credential=${AK}/${scope}, SignedHeaders=${signed}, Signature=${sig}`;
  const url = `https://${host}${p}${query ? '?' + query : ''}`;
  const r = await fetch(url, { method, headers: hh, body: method === 'GET' ? undefined : body });
  return { status: r.status, text: await r.text() };
}
function iamCall(query) { return awsCall({ service: 'iam', host: 'iam.amazonaws.com', method: 'GET', path: '/', query: query + '&Version=2010-05-08' }); }
function lambdaCall(method, path, body) { return awsCall({ service: 'lambda', host: `lambda.${REGION}.amazonaws.com`, method, path, body: body ? JSON.stringify(body) : '' }); }
function snsCall(query) { return awsCall({ service: 'sns', host: `sns.${REGION}.amazonaws.com`, method: 'GET', path: '/', query: query + '&Version=2010-03-31' }); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function main() {
  // ---- 1. IAM role ----
  const trustPolicy = JSON.stringify({
    Version: '2012-10-17',
    Statement: [{ Effect: 'Allow', Principal: { Service: 'lambda.amazonaws.com' }, Action: 'sts:AssumeRole' }],
  });
  console.log('### IAM: CreateRole ###');
  let r = await iamCall(`Action=CreateRole&RoleName=${ROLE_NAME}&AssumeRolePolicyDocument=${uriEncode(trustPolicy)}&Description=${uriEncode('Execution role for otchealth-aws-alert-fanout Lambda (SNS -> no-click alert fanout)')}`);
  let roleArn;
  if (r.status === 200) {
    roleArn = r.text.match(/<Arn>([^<]+)<\/Arn>/)?.[1];
    console.log('created:', roleArn);
  } else if (r.text.includes('EntityAlreadyExists')) {
    const gr = await iamCall(`Action=GetRole&RoleName=${ROLE_NAME}`);
    roleArn = gr.text.match(/<Arn>([^<]+)<\/Arn>/)?.[1];
    console.log('already exists:', roleArn);
  } else {
    throw new Error(`CreateRole failed: ${r.status} ${r.text}`);
  }

  console.log('### IAM: PutRolePolicy (least-privilege SSM+KMS) ###');
  const inlinePolicy = JSON.stringify({
    Version: '2012-10-17',
    Statement: [
      { Effect: 'Allow', Action: ['ssm:GetParameter', 'ssm:GetParameters'], Resource: SSM_PARAM_ARNS },
      { Effect: 'Allow', Action: ['kms:Decrypt'], Resource: '*', Condition: { StringEquals: { 'kms:ViaService': `ssm.${REGION}.amazonaws.com` } } },
    ],
  });
  r = await iamCall(`Action=PutRolePolicy&RoleName=${ROLE_NAME}&PolicyName=alert-fanout-secrets-read&PolicyDocument=${uriEncode(inlinePolicy)}`);
  if (r.status !== 200) throw new Error(`PutRolePolicy failed: ${r.status} ${r.text}`);
  console.log('OK (scoped to', SSM_PARAM_ARNS.length, 'parameters)');

  console.log('### IAM: AttachRolePolicy (AWSLambdaBasicExecutionRole -- CloudWatch Logs only) ###');
  r = await iamCall(`Action=AttachRolePolicy&RoleName=${ROLE_NAME}&PolicyArn=${uriEncode('arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole')}`);
  if (r.status !== 200) throw new Error(`AttachRolePolicy failed: ${r.status} ${r.text}`);
  console.log('OK');

  // ---- 2. Zip the handler (single file, zero deps) ----
  console.log('### Zip index.mjs ###');
  const zipPath = path.join(__dirname, 'function.zip');
  try { fs.unlinkSync(zipPath); } catch {}
  execFileSync('zip', ['-j', zipPath, path.join(__dirname, 'index.mjs')], { stdio: 'inherit' });
  const zipB64 = fs.readFileSync(zipPath).toString('base64');
  console.log('zip bytes:', fs.statSync(zipPath).size);

  // ---- 3. IAM propagation: Lambda CreateFunction can transiently fail right after CreateRole ----
  console.log('### Lambda: CreateFunction (or update code if it already exists) ###');
  let functionArn;
  for (let attempt = 1; attempt <= 8; attempt++) {
    const cr = await lambdaCall('POST', '/2015-03-31/functions', {
      FunctionName: FUNCTION_NAME,
      Runtime: 'nodejs22.x',
      Role: roleArn,
      Handler: 'index.handler',
      Code: { ZipFile: zipB64 },
      Timeout: 30,
      MemorySize: 128,
      Description: 'Fans otchealth-aws-alerts SNS messages out to GitHub/Datadog/PostHog/Graph -- no human click required.',
    });
    if (cr.status === 201) {
      functionArn = JSON.parse(cr.text).FunctionArn;
      console.log('created:', functionArn);
      break;
    }
    const body = cr.text;
    if (body.includes('ResourceConflictException') || body.includes('Function already exist')) {
      console.log('already exists, updating code + config...');
      const gr = await lambdaCall('GET', `/2015-03-31/functions/${FUNCTION_NAME}`);
      functionArn = JSON.parse(gr.text).Configuration.FunctionArn;
      const ur = await lambdaCall('PUT', `/2015-03-31/functions/${FUNCTION_NAME}/code`, { ZipFile: zipB64 });
      if (ur.status !== 200) throw new Error(`UpdateFunctionCode failed: ${ur.status} ${ur.text}`);
      console.log('code updated:', functionArn);
      break;
    }
    if (/assumed by Lambda|cannot be assumed/i.test(body) && attempt < 8) {
      console.log(`IAM role not yet propagated (attempt ${attempt}/8), retrying in 5s...`);
      await sleep(5000);
      continue;
    }
    throw new Error(`CreateFunction failed: ${cr.status} ${body}`);
  }
  if (!functionArn) throw new Error('CreateFunction never succeeded after retries.');

  // ---- 4. Allow SNS to invoke this function ----
  console.log('### Lambda: AddPermission (allow SNS topic to invoke) ###');
  r = await lambdaCall('POST', `/2015-03-31/functions/${FUNCTION_NAME}/policy`, {
    StatementId: 'AllowSNSInvoke',
    Action: 'lambda:InvokeFunction',
    Principal: 'sns.amazonaws.com',
    SourceArn: TOPIC_ARN,
  });
  if (r.status === 201 || r.status === 200) {
    console.log('OK');
  } else if (r.text.includes('ResourceConflictException')) {
    console.log('permission statement already present, OK');
  } else {
    throw new Error(`AddPermission failed: ${r.status} ${r.text}`);
  }

  // ---- 5. Subscribe the Lambda to the SNS topic (protocol=lambda -> auto-confirms) ----
  console.log('### SNS: Subscribe (protocol=lambda) ###');
  r = await snsCall(`Action=Subscribe&TopicArn=${uriEncode(TOPIC_ARN)}&Protocol=lambda&Endpoint=${uriEncode(functionArn)}&ReturnSubscriptionArn=true`);
  if (r.status !== 200) throw new Error(`Subscribe failed: ${r.status} ${r.text}`);
  const subArn = r.text.match(/<SubscriptionArn>([^<]+)<\/SubscriptionArn>/)?.[1];
  console.log('subscription:', subArn);
  console.log(subArn && subArn.startsWith('arn:') ? 'CONFIRMED (Lambda subscriptions auto-confirm)' : 'UNEXPECTED: not auto-confirmed');

  console.log('\n=== DONE ===');
  console.log('roleArn:', roleArn);
  console.log('functionArn:', functionArn);
  console.log('subscriptionArn:', subArn);
}

main().catch((e) => { console.error('DEPLOY FAILED:', e.message); process.exit(1); });
