// Refreshes the NON-PERSONAL `memory` container's S3 export in place, so a subsequent run of
// scripts/load-agentstate.mjs (the idempotent Cosmos-S3-to-RDS loader) picks up current data
// instead of the original 2026-08-13 evacuation snapshot.
//
// WHY ONLY `memory`, AND ONLY THE NON-PERSONAL FILE
// A full delta audit against live Cosmos (A2, 2026-08-16) found tasks/events/personal-ring-memory
// at EXACTLY zero delta -- those three containers are static or near-static (a handful of
// engineering records, a single attorney-privileged agent lane). All drift was concentrated in the
// non-personal `memory` container (auto-journal/status/decision/pitfall writes land there
// continuously). Re-exporting the other three is pointless risk for zero benefit; this script
// touches exactly one file.
//
// RING SAFETY (non-negotiable, mirrors scripts/load-agentstate.mjs's own gate)
// Uses cosmos-export.mjs's dumpContainerSegregated()/classifyLane() -- the SAME vetted,
// fail-closed classifier the loader's source files were already built from (memory-2026-08-13.ndjson
// in the personal bucket was independently verified 100% clo-personal, 0 leakage, on first use of
// this A2 task). This script ALSO re-verifies before writing: it recomputes classifyLane() itself
// and hard-aborts if a single clo-personal row appears in the general/non-personal set. The
// `restricted` bucket returned by dumpContainerSegregated() is discarded entirely here -- never
// written to disk, never uploaded, never logged beyond its count -- because the personal-ring file
// is deliberately left untouched (see above).
//
// SAFETY NET: THE TARGET BUCKET HAS S3 VERSIONING ENABLED (verified live before this script was
// first run). Overwriting the object in place does not destroy the prior version -- it becomes a
// non-latest version, retrievable via ListObjectVersions/GetObject?versionId=. This script does not
// re-verify versioning itself (that is an out-of-band bucket property, not per-run state); if the
// bucket's versioning is ever disabled, an operator should restore a manual pre-write backup step
// before relying on this script against production data again.
//
// WHAT THIS SCRIPT DOES NOT DO: it does not run the loader, and it does not touch RDS. Run
// scripts/load-agentstate.mjs's registered task (`otchealth-agentstate-load:1`, via ECS RunTask)
// afterward to actually absorb the refreshed file -- that task is idempotent (ON CONFLICT DO
// UPDATE), so running it again is always safe.
//
// Usage (run from an authorized session with Cosmos + AWS credentials resolvable via Key Vault /
// env, same credential path as this repo's other scripts/*.mjs one-shot operational tools):
//   node scripts/refresh-memory-export.mjs [--dry-run]
//
// Requires: AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY (or a kvSecret()-resolvable equivalent) with
// s3:GetObject + s3:PutObject on the target bucket; Cosmos agent-state read credentials resolvable
// by skills/fleet-backup/cosmos-export.mjs (cosmos-agent-state-endpoint / cosmos-agent-state-key).

const BUCKET = 'otchealth-finance-legal-dr-55c84f6b';
const KEY = 'cosmos/agent-state/memory-2026-08-13.ndjson';
const PERSONAL_LANE = 'clo-personal';

async function sha256hex(data) {
  const crypto = await import('node:crypto');
  return crypto.createHash('sha256').update(data).digest('hex');
}

async function s3Put(awsCall, bucket, key, body) {
  const path = '/' + key.split('/').map(encodeURIComponent).join('/');
  return awsCall({ service: 's3', host: `${bucket}.s3.us-east-1.amazonaws.com`, method: 'PUT', path, body });
}

async function s3Get(awsCall, bucket, key) {
  const path = '/' + key.split('/').map(encodeURIComponent).join('/');
  return awsCall({ service: 's3', host: `${bucket}.s3.us-east-1.amazonaws.com`, method: 'GET', path });
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');

  // This script deliberately reuses the fleet's already-reviewed, already-proven ring-safety
  // classifier (cosmos-export.mjs's dumpContainerSegregated/classifyLane, PR #433) rather than
  // reimplementing Cosmos auth + cross-partition pagination + lane classification inline -- for a
  // security-sensitive path like this one, importing a proven implementation is safer than a fresh
  // one. This assumes otchealth-claude-tools is checked out as a sibling of this repo, which is the
  // standing convention for every Claude Code session in this fleet (see that repo's CLAUDE.md /
  // setup/session-start.sh). If that assumption does not hold in whatever environment is running
  // this, fail with a clear message rather than a confusing module-resolution stack trace.
  let cosmosExport;
  try {
    cosmosExport = await import('../../otchealth-claude-tools/skills/fleet-backup/cosmos-export.mjs');
  } catch (e) {
    throw new Error(
      `Could not import ../../otchealth-claude-tools/skills/fleet-backup/cosmos-export.mjs relative ` +
      `to this file. This script expects otchealth-claude-tools checked out as a sibling directory ` +
      `of otchealth-mcp-server (the standing fleet convention). Original error: ${e.message}`
    );
  }
  const { dumpContainerSegregated, classifyLane } = cosmosExport;

  console.log('Fetching live `memory` container from Cosmos, ring-classifying via classifyLane()...');
  const t0 = Date.now();
  const { general, restricted } = await dumpContainerSegregated('memory');
  console.log(`Fetched in ${Date.now() - t0}ms: general(non-personal)=${general.length} restricted(personal, discarded here)=${restricted.length}`);

  // Independent re-check, not just trust in the library: recompute the classification and hard-abort
  // on any personal-lane row found in the set we are about to write as "non-personal".
  const contaminated = general.filter((d) => classifyLane('memory', d) === 'restricted' || d.agent === PERSONAL_LANE);
  if (contaminated.length > 0) {
    throw new Error(
      `RING SAFETY ABORT: ${contaminated.length} row(s) classified as personal/restricted appeared in ` +
      `the general set. Refusing to write anything. This must never happen -- investigate ` +
      `classifyLane() and the live data before re-running.`
    );
  }
  console.log('Ring-safety pre-write gate: 0 personal-lane rows in the general set. OK to proceed.');

  const ndjson = general.map((d) => JSON.stringify(d)).join('\n') + '\n';
  const hash = await sha256hex(ndjson);
  console.log(`Prepared ${ndjson.length} bytes / ${general.length} rows. sha256=${hash}`);

  if (dryRun) {
    console.log('\n--dry-run: not writing to S3. Exiting.');
    return;
  }

  const { kvSecret } = await import('../../otchealth-claude-tools/skills/kb-memory/azure-secret.mjs');
  if (!process.env.AWS_ACCESS_KEY_ID) process.env.AWS_ACCESS_KEY_ID = (await kvSecret('aws-cto-access-key-id')).trim();
  if (!process.env.AWS_SECRET_ACCESS_KEY) process.env.AWS_SECRET_ACCESS_KEY = (await kvSecret('aws-cto-secret-access-key')).trim();
  const { awsCall } = await import('/tmp/awsx/sig.mjs');

  console.log(`\nUploading to s3://${BUCKET}/${KEY} (overwrite; prior version preserved by bucket versioning)...`);
  const put = await s3Put(awsCall, BUCKET, KEY, ndjson);
  if (put.status !== 200) {
    throw new Error(`S3 PUT failed: HTTP ${put.status} ${put.text.slice(0, 500)}`);
  }
  console.log('PUT OK.');

  const after = await s3Get(awsCall, BUCKET, KEY);
  if (after.status !== 200) throw new Error(`post-write verification GET failed: HTTP ${after.status}`);
  const matches = after.text === ndjson;
  const rows = after.text.split('\n').filter((l) => l.trim()).length;
  console.log(`Post-write verification: byte-exact match=${matches}, row count=${rows}`);
  if (!matches) {
    throw new Error('Post-write GET did not byte-match what was uploaded -- treat the refresh as unverified.');
  }

  console.log('\nDone. Next step: run the otchealth-agentstate-load:1 ECS task to absorb this file (idempotent, safe to re-run).');
}

main().catch((err) => {
  console.error('\nFATAL:', err && err.stack ? err.stack : err);
  process.exit(1);
});
