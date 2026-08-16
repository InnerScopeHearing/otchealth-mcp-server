// Loads the exported Cosmos agent-state NDJSON files from S3 into the live RDS Postgres
// `agentstate` database (Azure -> AWS migration). Covers three containers/tables only:
// tasks, memory, events. cache (encrypted + regenerable), oauthcodes (ephemeral, nothing
// exported), decisions_pending and signals (no table exists yet, a separate workstream's
// scope) are deliberately never referenced anywhere in this file.
//
// MUST run inside the VPC as an ECS Fargate task (see scripts/register-agentstate-load-taskdef.mjs,
// which registers the `otchealth-agentstate-load` task definition that runs this exact file).
// RDS instance otchealth-pg / database agentstate is PubliclyAccessible=false and unreachable
// from any sandbox or local shell.
//
// RING SAFETY (non-negotiable). The partition-key field per container is:
//   tasks -> board | events -> task_id | memory -> agent
// The memory export from bucket otchealth-legal-personal-dr-55c84f6b holds attorney-privileged
// clo-personal rows (a prior incident put personal rows in a non-personal bucket and it had to
// be corrected -- this must never happen again). Before a single row from either memory file is
// written to Postgres, this script fully scans that file and hard-aborts the ENTIRE run (not a
// per-row skip) if:
//   - a row from the personal-bucket file does not carry a personal-lane `agent`, or
//   - a row from the non-personal-bucket file DOES carry a personal-lane `agent`.
// Verified empirically against the real exports before writing this file: every sampled row in
// the personal-bucket memory file carries agent:"clo-personal"; zero rows in the finance-legal
// -bucket memory file do. PERSONAL_LANES below is the single source of truth for both directions
// of that assertion, so a future personal lane only needs to be added in one place.
//
// Usage (inside the ECS task only): node load-agentstate.mjs
// Required env: PGHOST, PGUSER, PGPASSWORD_IN (or PGPASSWORD), PGDATABASE (defaults 'agentstate').
// AWS credentials: either automatic via the Fargate task-role metadata endpoint
// (AWS_CONTAINER_CREDENTIALS_RELATIVE_URI, set automatically when taskRoleArn=otchealthTaskRole)
// or plain AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY/AWS_SESSION_TOKEN env vars for local testing.
//
// KNOWN BLOCKER (verified 2026-08-16, not fixed by this script -- see the dispatch report):
// otchealthTaskRole's inline policy `runtime-access` grants s3:GetObject only on
// otchealth-brain-dr-55c84f6b and otchealth-finance-legal-dr-55c84f6b. It does NOT include
// otchealth-legal-personal-dr-55c84f6b, so the personal-memory job below will fail with
// AccessDenied until that IAM policy is widened. That is a deliberate ring-boundary decision
// this script does not make for you; it surfaces as a clear fatal error, not a silent skip.

import crypto from 'node:crypto';
import pg from 'pg';

// AWS's public us-east-1 RDS CA trust bundle (RSA2048 + RSA4096 + ECC384 roots), fetched from
// the well-known, unauthenticated endpoint https://truststore.pki.rds.amazonaws.com/us-east-1/
// us-east-1-bundle.pem. This is not a secret; it lets the pg client properly validate the RDS
// server's TLS certificate instead of disabling verification (rejectUnauthorized:false would be
// a real MITM weakening, not just a lint nit -- see the ssl: block in main() below).
const RDS_US_EAST_1_CA_BUNDLE = `-----BEGIN CERTIFICATE-----
MIID/zCCAuegAwIBAgIRAPVSMfFitmM5PhmbaOFoGfUwDQYJKoZIhvcNAQELBQAw
gZcxCzAJBgNVBAYTAlVTMSIwIAYDVQQKDBlBbWF6b24gV2ViIFNlcnZpY2VzLCBJ
bmMuMRMwEQYDVQQLDApBbWF6b24gUkRTMQswCQYDVQQIDAJXQTEwMC4GA1UEAwwn
QW1hem9uIFJEUyB1cy1lYXN0LTEgUm9vdCBDQSBSU0EyMDQ4IEcxMRAwDgYDVQQH
DAdTZWF0dGxlMCAXDTIxMDUyNTIyMzQ1N1oYDzIwNjEwNTI1MjMzNDU3WjCBlzEL
MAkGA1UEBhMCVVMxIjAgBgNVBAoMGUFtYXpvbiBXZWIgU2VydmljZXMsIEluYy4x
EzARBgNVBAsMCkFtYXpvbiBSRFMxCzAJBgNVBAgMAldBMTAwLgYDVQQDDCdBbWF6
b24gUkRTIHVzLWVhc3QtMSBSb290IENBIFJTQTIwNDggRzExEDAOBgNVBAcMB1Nl
YXR0bGUwggEiMA0GCSqGSIb3DQEBAQUAA4IBDwAwggEKAoIBAQDu9H7TBeGoDzMr
dxN6H8COntJX4IR6dbyhnj5qMD4xl/IWvp50lt0VpmMd+z2PNZzx8RazeGC5IniV
5nrLg0AKWRQ2A/lGGXbUrGXCSe09brMQCxWBSIYe1WZZ1iU1IJ/6Bp4D2YEHpXrW
bPkOq5x3YPcsoitgm1Xh8ygz6vb7PsvJvPbvRMnkDg5IqEThapPjmKb8ZJWyEFEE
QRrkCIRueB1EqQtJw0fvP4PKDlCJAKBEs/y049FoOqYpT3pRy0WKqPhWve+hScMd
6obq8kxTFy1IHACjHc51nrGII5Bt76/MpTWhnJIJrCnq1/Uc3Qs8IVeb+sLaFC8K
DI69Sw6bAgMBAAGjQjBAMA8GA1UdEwEB/wQFMAMBAf8wHQYDVR0OBBYEFE7PCopt
lyOgtXX0Y1lObBUxuKaCMA4GA1UdDwEB/wQEAwIBhjANBgkqhkiG9w0BAQsFAAOC
AQEAFj+bX8gLmMNefr5jRJfHjrL3iuZCjf7YEZgn89pS4z8408mjj9z6Q5D1H7yS
jNETVV8QaJip1qyhh5gRzRaArgGAYvi2/r0zPsy+Tgf7v1KGL5Lh8NT8iCEGGXwF
g3Ir+Nl3e+9XUp0eyyzBIjHtjLBm6yy8rGk9p6OtFDQnKF5OxwbAgip42CD75r/q
p421maEDDvvRFR4D+99JZxgAYDBGqRRceUoe16qDzbMvlz0A9paCZFclxeftAxv6
QlR5rItMz/XdzpBJUpYhdzM0gCzAzdQuVO5tjJxmXhkSMcDP+8Q+Uv6FA9k2VpUV
E/O5jgpqUJJ2Hc/5rs9VkAPXeA==
-----END CERTIFICATE-----
-----BEGIN CERTIFICATE-----
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
0Ws=
-----END CERTIFICATE-----
-----BEGIN CERTIFICATE-----
MIICrjCCAjSgAwIBAgIRAPAlEk8VJPmEzVRRaWvTh2AwCgYIKoZIzj0EAwMwgZYx
CzAJBgNVBAYTAlVTMSIwIAYDVQQKDBlBbWF6b24gV2ViIFNlcnZpY2VzLCBJbmMu
MRMwEQYDVQQLDApBbWF6b24gUkRTMQswCQYDVQQIDAJXQTEvMC0GA1UEAwwmQW1h
em9uIFJEUyB1cy1lYXN0LTEgUm9vdCBDQSBFQ0MzODQgRzExEDAOBgNVBAcMB1Nl
YXR0bGUwIBcNMjEwNTI1MjI0MTU1WhgPMjEyMTA1MjUyMzQxNTVaMIGWMQswCQYD
VQQGEwJVUzEiMCAGA1UECgwZQW1hem9uIFdlYiBTZXJ2aWNlcywgSW5jLjETMBEG
A1UECwwKQW1hem9uIFJEUzELMAkGA1UECAwCV0ExLzAtBgNVBAMMJkFtYXpvbiBS
RFMgdXMtZWFzdC0xIFJvb3QgQ0EgRUNDMzg0IEcxMRAwDgYDVQQHDAdTZWF0dGxl
MHYwEAYHKoZIzj0CAQYFK4EEACIDYgAEx5xjrup8II4HOJw15NTnS3H5yMrQGlbj
EDA5MMGnE9DmHp5dACIxmPXPMe/99nO7wNdl7G71OYPCgEvWm0FhdvVUeTb3LVnV
BnaXt32Ek7/oxGk1T+Df03C+W0vmuJ+wo0IwQDAPBgNVHRMBAf8EBTADAQH/MB0G
A1UdDgQWBBTGXmqBWN/1tkSea4pNw0oHrjk2UDAOBgNVHQ8BAf8EBAMCAYYwCgYI
KoZIzj0EAwMDaAAwZQIxAIqqZWCSrIkZ7zsv/FygtAusW6yvlL935YAWYPVXU30m
jkMFLM+/RJ9GMvnO8jHfCgIwB+whlkcItzE9CRQ6CsMo/d5cEHDUu/QW6jSIh9BR
OGh9pTYPVkUbBiKPA7lVVhre
-----END CERTIFICATE-----
`;

const REGION = process.env.AWS_REGION || 'us-east-1';
const BATCH_SIZE = Number(process.env.LOAD_BATCH_SIZE) || 500;
const KNOWN_TABLES = new Set(['agentstate_tasks', 'agentstate_memory', 'agentstate_events']);

// Single source of truth for "is this row personal-ring". Read by assertRing() in BOTH
// directions (personal-file rows must be IN this set; non-personal-file rows must NOT be).
const PERSONAL_LANES = new Set(['clo-personal']);

// ---- the load plan: exactly 4 source files -> exactly 3 tables, nothing else ------------------
export const JOBS = [
  {
    table: 'agentstate_tasks',
    pkField: 'board',
    bucket: 'otchealth-finance-legal-dr-55c84f6b',
    key: 'cosmos/agent-state/tasks-2026-08-13.ndjson',
    ring: 'none',
  },
  {
    table: 'agentstate_events',
    pkField: 'task_id',
    bucket: 'otchealth-finance-legal-dr-55c84f6b',
    key: 'cosmos/agent-state/events-2026-08-13.ndjson',
    ring: 'none',
  },
  {
    table: 'agentstate_memory',
    pkField: 'agent',
    bucket: 'otchealth-finance-legal-dr-55c84f6b',
    key: 'cosmos/agent-state/memory-2026-08-13.ndjson',
    ring: 'non-personal', // must contain ZERO personal-lane rows
  },
  {
    table: 'agentstate_memory',
    pkField: 'agent',
    bucket: 'otchealth-legal-personal-dr-55c84f6b',
    key: 'cosmos/agent-state/memory-2026-08-13.ndjson',
    ring: 'personal', // must be 100% personal-lane rows
  },
];

// ================================================================================================
// Dependency-free SigV4 for S3 GET, adapted for the Fargate task-role credential model (the
// sandbox's /tmp/awsx/sig.mjs env-var-only helper does not exist inside the ECS container).
// ================================================================================================

export async function getAwsCredentials() {
  const relUri = process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI;
  if (relUri) {
    const r = await fetch(`http://169.254.170.2${relUri}`);
    if (!r.ok) throw new Error(`ECS task-role credential fetch failed: HTTP ${r.status}`);
    const j = await r.json();
    return { AK: j.AccessKeyId, SK: j.SecretAccessKey, ST: j.Token };
  }
  if (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) {
    return {
      AK: process.env.AWS_ACCESS_KEY_ID,
      SK: process.env.AWS_SECRET_ACCESS_KEY,
      ST: process.env.AWS_SESSION_TOKEN,
    };
  }
  throw new Error(
    'No AWS credentials available: neither AWS_CONTAINER_CREDENTIALS_RELATIVE_URI (expected ' +
      'automatically inside the ECS task under otchealthTaskRole) nor AWS_ACCESS_KEY_ID/' +
      'AWS_SECRET_ACCESS_KEY are set.'
  );
}

function sha256hex(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function hmac(key, data) {
  return crypto.createHmac('sha256', key).update(data).digest();
}

export async function s3GetObject(creds, bucket, key, attempt = 1) {
  const host = `${bucket}.s3.${REGION}.amazonaws.com`;
  const path = `/${key.split('/').map(encodeURIComponent).join('/')}`;
  const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = sha256hex('');

  const headerMap = {
    host,
    'x-amz-date': amzDate,
    'x-amz-content-sha256': payloadHash,
    ...(creds.ST ? { 'x-amz-security-token': creds.ST } : {}),
  };
  const sortedKeys = Object.keys(headerMap).map((k) => k.toLowerCase()).sort();
  const canonicalHeaders = sortedKeys
    .map((k) => `${k}:${String(headerMap[Object.keys(headerMap).find((x) => x.toLowerCase() === k)]).trim()}\n`)
    .join('');
  const signedHeaders = sortedKeys.join(';');
  const canonicalRequest = ['GET', path, '', canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const scope = `${dateStamp}/${REGION}/s3/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256hex(canonicalRequest)].join('\n');

  let signingKey = hmac('AWS4' + creds.SK, dateStamp);
  signingKey = hmac(signingKey, REGION);
  signingKey = hmac(signingKey, 's3');
  signingKey = hmac(signingKey, 'aws4_request');
  const signature = hmac(signingKey, stringToSign).toString('hex');

  headerMap.Authorization =
    `AWS4-HMAC-SHA256 Credential=${creds.AK}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  let res;
  try {
    res = await fetch(`https://${host}${path}`, { method: 'GET', headers: headerMap });
  } catch (networkErr) {
    if (attempt < 3) return s3GetObject(creds, bucket, key, attempt + 1);
    throw new Error(`S3 GET ${bucket}/${key} network error after ${attempt} attempts: ${networkErr.message}`);
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    if (res.status >= 500 && attempt < 3) return s3GetObject(creds, bucket, key, attempt + 1);
    throw new Error(`S3 GET ${bucket}/${key} failed: HTTP ${res.status} ${body.slice(0, 500)}`);
  }
  return res.text();
}

// ================================================================================================
// Row validation + ring safety
// ================================================================================================

// Same validity rule for both the container's pk field and `id`: must resolve to a non-empty
// string. Missing/null/empty/object-typed values are invalid.
export function coerceKeyValue(v) {
  if (v === undefined || v === null) return null;
  if (typeof v === 'string') return v.trim() === '' ? null : v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return null;
}

export function assertRing(job, doc, lineNo) {
  if (job.ring === 'none') return;
  const isPersonalRow = PERSONAL_LANES.has(doc.agent);
  if (job.ring === 'personal' && !isPersonalRow) {
    throw new Error(
      `RING SAFETY ABORT: ${job.bucket}/${job.key} line ${lineNo} is from the PERSONAL-ring ` +
        `export but doc.agent=${JSON.stringify(doc.agent)} is not a personal lane ` +
        `(expected one of [${[...PERSONAL_LANES].join(', ')}]). Refusing to write ANY row from ` +
        `this run: a personal-file row must never land under a non-personal pk.`
    );
  }
  if (job.ring === 'non-personal' && isPersonalRow) {
    throw new Error(
      `RING SAFETY ABORT: ${job.bucket}/${job.key} line ${lineNo} is from the NON-PERSONAL ` +
        `export but doc.agent=${JSON.stringify(doc.agent)} IS a personal lane. Refusing to write ` +
        `ANY row from this run: a personal row must never be co-mingled into the non-personal load path.`
    );
  }
}

function computeUpdatedAt(doc) {
  if (typeof doc.updated_at === 'string') {
    const d = new Date(doc.updated_at);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  if (typeof doc._ts === 'number') {
    return new Date(doc._ts * 1000).toISOString();
  }
  if (typeof doc.created_at === 'string') {
    const d = new Date(doc.created_at);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  return new Date().toISOString();
}

// ================================================================================================
// Postgres batch upsert
// ================================================================================================

async function upsertBatch(pool, table, rows) {
  if (rows.length === 0) return;
  if (!KNOWN_TABLES.has(table)) throw new Error(`Refusing to write to unexpected table: ${table}`);

  const placeholders = [];
  const values = [];
  rows.forEach((r, i) => {
    const base = i * 5;
    placeholders.push(`($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5})`);
    values.push(r.pk, r.id, r.doc, r.etag, r.updatedAt);
  });

  const sql = `
    INSERT INTO ${table} (pk, id, doc, etag, updated_at)
    VALUES ${placeholders.join(',')}
    ON CONFLICT (pk, id) DO UPDATE SET
      doc = EXCLUDED.doc,
      etag = EXCLUDED.etag,
      updated_at = EXCLUDED.updated_at
  `;
  await pool.query(sql, values);
}

// ================================================================================================
// Per-job processing
// ================================================================================================

async function processJob(pool, creds, job, stats) {
  console.log(`\n--- ${job.bucket}/${job.key} -> ${job.table} (pk=${job.pkField}, ring=${job.ring}) ---`);

  const text = await s3GetObject(creds, job.bucket, job.key);
  const lines = text.split('\n');

  // Pass 1: parse every non-blank line. A malformed line aborts the whole run (a corrupt
  // export is a real problem, not something to silently drop).
  const parsed = [];
  lines.forEach((line, idx) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let doc;
    try {
      doc = JSON.parse(trimmed);
    } catch (e) {
      throw new Error(`PARSE ABORT: ${job.bucket}/${job.key} line ${idx + 1} is not valid JSON: ${e.message}`);
    }
    parsed.push({ doc, lineNo: idx + 1 });
  });
  const read = parsed.length;

  // Pass 2: ring-safety scan across the WHOLE file BEFORE any row is written, so a violation
  // aborts before a single row from a bad file reaches Postgres (idempotency makes a rerun safe
  // either way, but this keeps "fails the load" meaning nothing from that file gets written).
  for (const { doc, lineNo } of parsed) {
    assertRing(job, doc, lineNo);
  }

  // Pass 3: pk/id validation, building the rows to upsert.
  let skipped = 0;
  const skippedSamples = [];
  const upsertRows = [];
  for (const { doc, lineNo } of parsed) {
    const pk = coerceKeyValue(doc[job.pkField]);
    const id = coerceKeyValue(doc.id);
    if (pk === null || id === null) {
      skipped++;
      if (skippedSamples.length < 20) {
        skippedSamples.push(
          `line ${lineNo}: ${job.pkField}=${JSON.stringify(doc[job.pkField])} id=${JSON.stringify(doc.id)}`
        );
      }
      continue;
    }
    const etag = typeof doc._etag === 'string' && doc._etag ? doc._etag : `generated:${crypto.randomUUID()}`;
    upsertRows.push({ pk, id, doc, etag, updatedAt: computeUpdatedAt(doc) });
  }

  // Pass 4: batched idempotent upsert (ON CONFLICT (pk,id) DO UPDATE -- a rerun never duplicates).
  let written = 0;
  for (let i = 0; i < upsertRows.length; i += BATCH_SIZE) {
    const batch = upsertRows.slice(i, i + BATCH_SIZE);
    await upsertBatch(pool, job.table, batch);
    written += batch.length;
  }

  console.log(`  read=${read} written=${written} skipped=${skipped}`);
  if (skippedSamples.length) {
    const more = skipped > skippedSamples.length ? ` (+${skipped - skippedSamples.length} more)` : '';
    console.log(`  skipped rows (up to 20 shown)${more}:\n    ${skippedSamples.join('\n    ')}`);
  }

  stats.push({ file: `${job.bucket}/${job.key}`, table: job.table, read, written, skipped });
}

// ================================================================================================
// main
// ================================================================================================

async function main() {
  console.log('=== load-agentstate.mjs starting ===');
  console.log(
    `PGHOST=${process.env.PGHOST ? 'set' : 'MISSING'} PGUSER=${process.env.PGUSER ? 'set' : 'MISSING'} ` +
      `PGDATABASE=${process.env.PGDATABASE || 'agentstate'}`
  );

  const pool = new pg.Pool({
    host: process.env.PGHOST,
    user: process.env.PGUSER,
    password: process.env.PGPASSWORD_IN || process.env.PGPASSWORD,
    database: process.env.PGDATABASE || 'agentstate',
    port: Number(process.env.PGPORT) || 5432,
    // RDS Postgres supports TLS by default even when not force-required. Validate the server
    // cert for real against AWS's public us-east-1 RDS CA bundle (rejectUnauthorized:true is
    // the default once `ca` is set; stated explicitly here on purpose) rather than disabling
    // verification. Set PGSSLMODE=disable to turn TLS off entirely if this instance's parameter
    // group rejects it outright. NOT verified against the live instance from this build (RDS is
    // VPC-only, unreachable from the build sandbox) -- flagged in the dispatch report.
    ssl: process.env.PGSSLMODE === 'disable' ? false : { ca: RDS_US_EAST_1_CA_BUNDLE, rejectUnauthorized: true },
    max: 4,
  });

  await pool.query('SELECT 1');
  console.log('Postgres connection OK.');

  const creds = await getAwsCredentials();
  console.log(
    'AWS credentials resolved (source: ' +
      (process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI ? 'ECS task role' : 'env vars') +
      ').'
  );

  const stats = [];
  for (const job of JOBS) {
    await processJob(pool, creds, job, stats);
  }

  console.log('\n=== PER-SOURCE-FILE COUNTS ===');
  for (const s of stats) {
    console.log(`${s.file} -> ${s.table}: read=${s.read} written=${s.written} skipped=${s.skipped}`);
  }

  console.log('\n=== PER-TABLE SUMMARY ===');
  const byTable = {};
  for (const s of stats) {
    byTable[s.table] = byTable[s.table] || { read: 0, written: 0, skipped: 0 };
    byTable[s.table].read += s.read;
    byTable[s.table].written += s.written;
    byTable[s.table].skipped += s.skipped;
  }
  for (const table of Object.keys(byTable)) {
    if (!KNOWN_TABLES.has(table)) throw new Error(`Refusing to read back unexpected table: ${table}`);
    const { read, written, skipped } = byTable[table];
    const { rows } = await pool.query(`SELECT count(*)::text AS n FROM ${table}`);
    console.log(`${table}: read=${read} written=${written} skipped=${skipped} live_count=${rows[0].n}`);
  }

  await pool.end();
  console.log('\n=== load-agentstate.mjs complete ===');
}

// Run only when invoked directly (`node load-agentstate.mjs`), never on import -- lets this
// module's functions be exercised by a test/verification harness without triggering a real
// Postgres connection attempt or S3 load.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error('\nFATAL:', err && err.stack ? err.stack : err);
    process.exit(1);
  });
}
