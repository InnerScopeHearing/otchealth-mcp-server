// One-shot script: registers the `otchealth-agentstate-load` ECS Fargate task definition,
// modelled exactly on the existing `otchealth-pgrestore:1` (image, entryPoint, secrets,
// executionRoleArn, taskRoleArn, logConfiguration shape, cpu/memory sizing, awsvpc/FARGATE),
// with the differences the loader actually needs:
//   - image node:22-slim instead of postgres:16
//   - command: install pg@8.22.0 (pinned, matches package.json), then decode+run the real
//     scripts/load-agentstate.mjs (embedded byte-for-byte via a base64 env var, the same
//     decode-and-run pattern already used by the otchealth-agentstate-schema:1 task for its
//     SCHEMA_B64 env var -- so the deployed task runs EXACTLY the committed file, no drift).
//   - logConfiguration streamPrefix "agentstate-load"
//   - an added PGDATABASE=agentstate env var
//
// This script only REGISTERS the task definition (ecs:RegisterTaskDefinition). It never calls
// RunTask/StartTask -- running the load is a separate, deliberate step for the CTO.
//
// Run: node scripts/register-agentstate-load-taskdef.mjs
// Needs AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY in the environment (or AWS_SESSION_TOKEN too).

import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REGION = 'us-east-1';
const ACCOUNT_ID = '900915535335';

function sha256hex(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}
function hmac(key, data) {
  return crypto.createHmac('sha256', key).update(data).digest();
}

// Generic SigV4 POST signer (JSON body), sufficient for the ECS control-plane API used here.
async function awsPost({ service, target, body }) {
  const AK = process.env.AWS_ACCESS_KEY_ID;
  const SK = process.env.AWS_SECRET_ACCESS_KEY;
  const ST = process.env.AWS_SESSION_TOKEN;
  if (!AK || !SK) throw new Error('AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY must be set in the environment.');

  const host = `${service}.${REGION}.amazonaws.com`;
  const path = '/';
  const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = sha256hex(body);

  const headerMap = {
    host,
    'content-type': 'application/x-amz-json-1.1',
    'x-amz-date': amzDate,
    'x-amz-content-sha256': payloadHash,
    'x-amz-target': target,
    ...(ST ? { 'x-amz-security-token': ST } : {}),
  };
  const sortedKeys = Object.keys(headerMap).map((k) => k.toLowerCase()).sort();
  const canonicalHeaders = sortedKeys.map((k) => `${k}:${String(headerMap[k]).trim()}\n`).join('');
  const signedHeaders = sortedKeys.join(';');
  const canonicalRequest = ['POST', path, '', canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const scope = `${dateStamp}/${REGION}/${service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256hex(canonicalRequest)].join('\n');

  let signingKey = hmac('AWS4' + SK, dateStamp);
  signingKey = hmac(signingKey, REGION);
  signingKey = hmac(signingKey, service);
  signingKey = hmac(signingKey, 'aws4_request');
  const signature = hmac(signingKey, stringToSign).toString('hex');

  headerMap.Authorization =
    `AWS4-HMAC-SHA256 Credential=${AK}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const res = await fetch(`https://${host}${path}`, { method: 'POST', headers: headerMap, body });
  const text = await res.text();
  return { status: res.status, text };
}

// ---- build the container command: install pg@8.22.0, then decode+run the real loader file ----
const COMMAND = [
  'set -e',
  'mkdir -p /tmp/loader',
  'cd /tmp/loader',
  'npm init -y >/dev/null 2>&1',
  'npm install --no-audit --no-fund pg@8.22.0 > /tmp/loader/npm-install.log 2>&1 || (cat /tmp/loader/npm-install.log; exit 1)',
  'echo "$LOADER_SCRIPT_B64" | base64 -d > /tmp/loader/load-agentstate.mjs',
  'node /tmp/loader/load-agentstate.mjs',
].join('\n');

const loaderPath = join(__dirname, 'load-agentstate.mjs');
const loaderSource = readFileSync(loaderPath, 'utf8');
const loaderB64 = Buffer.from(loaderSource, 'utf8').toString('base64');

console.log(`Embedding ${loaderPath}: ${loaderSource.length} source bytes -> ${loaderB64.length} base64 bytes.`);

const taskDefinitionRequest = {
  family: 'otchealth-agentstate-load',
  requiresCompatibilities: ['FARGATE'],
  networkMode: 'awsvpc',
  cpu: '512',
  memory: '1024',
  executionRoleArn: `arn:aws:iam::${ACCOUNT_ID}:role/otchealthEcsExecutionRole`,
  taskRoleArn: `arn:aws:iam::${ACCOUNT_ID}:role/otchealthTaskRole`,
  containerDefinitions: [
    {
      name: 'loader',
      image: 'node:22-slim',
      entryPoint: ['/bin/sh', '-c'],
      command: [COMMAND],
      essential: true,
      environment: [
        { name: 'PGDATABASE', value: 'agentstate' },
        { name: 'LOADER_SCRIPT_B64', value: loaderB64 },
      ],
      secrets: [
        { name: 'PGHOST', valueFrom: `arn:aws:ssm:${REGION}:${ACCOUNT_ID}:parameter/otchealth/aws-pg-host` },
        { name: 'PGUSER', valueFrom: `arn:aws:ssm:${REGION}:${ACCOUNT_ID}:parameter/otchealth/aws-pg-master-user` },
        {
          name: 'PGPASSWORD_IN',
          valueFrom: `arn:aws:ssm:${REGION}:${ACCOUNT_ID}:parameter/otchealth/aws-pg-master-password`,
        },
      ],
      logConfiguration: {
        logDriver: 'awslogs',
        options: {
          'awslogs-group': '/ecs/otchealth',
          'awslogs-region': REGION,
          'awslogs-stream-prefix': 'agentstate-load',
        },
      },
    },
  ],
};

const body = JSON.stringify(taskDefinitionRequest);
console.log(`Request body: ${body.length} bytes.`);

const r = await awsPost({
  service: 'ecs',
  target: 'AmazonEC2ContainerServiceV20141113.RegisterTaskDefinition',
  body,
});

console.log(`\nRegisterTaskDefinition HTTP ${r.status}`);
if (r.status !== 200) {
  console.error(r.text);
  process.exit(1);
}

const parsed = JSON.parse(r.text);
const td = parsed.taskDefinition;
console.log(`Registered: ${td.family}:${td.revision}`);
console.log(`ARN: ${td.taskDefinitionArn}`);
console.log(`Status: ${td.status}`);
