#!/usr/bin/env node
/**
 * Idempotent find-or-create-or-update helper for the fleet gateway's Amazon Bedrock guardrail,
 * the provider behind shield_check / groundedness_check (src/safety/bedrock-guardrails.ts).
 *
 * LIVE STATE AS OF 2026-09-02 (verified from the CTO seat, not assumed):
 *   - The guardrail ALREADY EXISTS: name "otchealth-gateway-guardrail", id "m7goqvo48q4m",
 *     arn arn:aws:bedrock:us-east-1:900915535335:guardrail/m7goqvo48q4m, status READY.
 *   - Content filters (HATE/VIOLENCE/MISCONDUCT/SEXUAL at MEDIUM, INSULTS at LOW, PROMPT_ATTACK at
 *     HIGH-input) and contextual grounding (GROUNDING 0.7, RELEVANCE 0.5) are already configured
 *     and already proven live in production (a real prompt-injection sample was blocked by
 *     PROMPT_ATTACK + MISCONDUCT; a fabricated sentence scored GROUNDING 0 -> blocked at 0.7).
 *   - The gateway's ECS task role (otchealthTaskRole) already carries an inline policy
 *     (bedrock-apply-guardrail) granting bedrock:ApplyGuardrail scoped to this exact guardrail ARN.
 *   - The live gateway task definition (otchealth-gateway, the running revision) already sets
 *     GUARDRAIL_PROVIDER=bedrock, BEDROCK_GUARDRAIL_ID=m7goqvo48q4m, BEDROCK_GUARDRAIL_VERSION=DRAFT,
 *     BEDROCK_REGION=us-east-1 -- so this guardrail is not a future plan, it is live.
 *   - THE ONE GAP: sensitiveInformationPolicy has ZERO entities configured, so PII in a scanned
 *     prompt (verified live with a real SSN + card number) is currently invisible to shield_check.
 *
 * WHAT THIS SCRIPT DOES: it is an UPDATE+VERSION tool for the EXISTING guardrail, not a from-scratch
 * creator for the common case. It:
 *   1. Looks up the guardrail (by --guardrail-id, default m7goqvo48q4m; falls back to searching
 *      list-guardrails by --name, default "otchealth-gateway-guardrail", if no id matches).
 *   2. Reads back its CURRENT contentPolicy / contextualGroundingPolicy / blockedInput(Outputs)Messaging
 *      and re-supplies them VERBATIM in the update -- this script never changes an existing content
 *      filter strength or grounding threshold. Only sensitiveInformationPolicy is touched, and only
 *      additively: it MERGES the desired PII entity list into whatever piiEntitiesConfig already
 *      exists (by `type`; an existing entry for a type this script also wants is left completely
 *      untouched, never overwritten), so re-running this script is a safe no-op once applied.
 *   3. Prints the exact `aws bedrock update-guardrail` and `aws bedrock create-guardrail-version`
 *      commands (as --cli-input-json file references) it would run.
 *   4. Only in --apply mode does it actually run them, then prints the new numbered version for the
 *      CTO to set as BEDROCK_GUARDRAIL_VERSION on the task definition (pinning a numbered version,
 *      rather than the mutable DRAFT the guardrail runs on today, is the whole point of versioning --
 *      a future DRAFT edit then can no longer silently change already-verified production behavior).
 *   5. If NEITHER an id nor a name match resolves to a real guardrail, falls back to printing a
 *      from-scratch `create-guardrail` command with sensible defaults (content filters at MEDIUM,
 *      PROMPT_ATTACK at HIGH-input, the same PII set, grounding 0.7/0.7) -- this is the cold-start
 *      path for a NEW account/environment, not the expected path against production today.
 *
 * DESIRED PII ENTITIES (the actual gap this script closes), merged into whatever already exists:
 *   EMAIL, PHONE, NAME, ADDRESS       -> outputAction ANONYMIZE (inputAction NONE)
 *   US_SOCIAL_SECURITY_NUMBER,
 *   CREDIT_DEBIT_CARD_NUMBER          -> inputAction BLOCK (outputAction NONE)
 * Entity type strings verified against the live AWS API reference (API_GuardrailPiiEntityConfig.html
 * / API_GuardrailPiiEntity.html), not guessed. `action` (the legacy single-direction field, still
 * required alongside inputAction/outputAction on UpdateGuardrail per `aws bedrock update-guardrail
 * --generate-cli-skeleton`) is set to whichever of inputAction/outputAction is non-NONE for each
 * entry, so it agrees with the modern fields rather than silently conflicting with them.
 *
 * SAFETY: this script NEVER mutates anything by default. Read-only unless --apply is passed
 * explicitly. Even in --apply mode it never REMOVES or changes an existing content filter, grounding
 * threshold, or PII entity -- only adds. It always creates a NEW guardrail VERSION rather than
 * leaving the change live only on the mutable DRAFT that production currently points at, and it
 * never touches BEDROCK_GUARDRAIL_VERSION on any task definition itself -- that flip is a deliberate,
 * separate CTO action once the new version is reviewed (see docs/SAFETY-GUARDRAILS.md).
 *
 * Requires the AWS CLI (`aws`) authenticated with bedrock:GetGuardrail / ListGuardrails, and, only
 * for --apply, bedrock:UpdateGuardrail / bedrock:CreateGuardrailVersion / bedrock:CreateGuardrail.
 *
 * Usage:
 *   node scripts/create-guardrail.mjs                              # read-only: find + report + print commands
 *   node scripts/create-guardrail.mjs --dry-run                    # identical to the default (explicit)
 *   node scripts/create-guardrail.mjs --apply                      # actually update + version
 *   node scripts/create-guardrail.mjs --guardrail-id=abc123 --apply
 *   node scripts/create-guardrail.mjs --name="some-other-guardrail" --region=us-west-2
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DEFAULT_GUARDRAIL_ID = 'm7goqvo48q4m';
const DEFAULT_GUARDRAIL_NAME = 'otchealth-gateway-guardrail';
const DEFAULT_REGION = 'us-east-1';

const DESIRED_PII_ENTITIES = [
  { type: 'EMAIL', inputAction: 'NONE', outputAction: 'ANONYMIZE' },
  { type: 'PHONE', inputAction: 'NONE', outputAction: 'ANONYMIZE' },
  { type: 'NAME', inputAction: 'NONE', outputAction: 'ANONYMIZE' },
  { type: 'ADDRESS', inputAction: 'NONE', outputAction: 'ANONYMIZE' },
  { type: 'US_SOCIAL_SECURITY_NUMBER', inputAction: 'BLOCK', outputAction: 'NONE' },
  { type: 'CREDIT_DEBIT_CARD_NUMBER', inputAction: 'BLOCK', outputAction: 'NONE' },
].map((e) => ({
  ...e,
  // Legacy single-direction field, still required by UpdateGuardrail/CreateGuardrail per the CLI
  // skeleton -- set to whichever direction is actually active so it never disagrees with the
  // modern inputAction/outputAction pair.
  action: e.inputAction !== 'NONE' ? e.inputAction : e.outputAction,
  inputEnabled: true,
  outputEnabled: true,
}));

function parseArgs(argv) {
  const out = { apply: false, dryRun: false, guardrailId: undefined, name: undefined, region: undefined };
  for (const a of argv) {
    if (a === '--apply') out.apply = true;
    else if (a === '--dry-run') out.dryRun = true;
    else if (a.startsWith('--guardrail-id=')) out.guardrailId = a.slice('--guardrail-id='.length);
    else if (a.startsWith('--name=')) out.name = a.slice('--name='.length);
    else if (a.startsWith('--region=')) out.region = a.slice('--region='.length);
    else if (a === '--help' || a === '-h') out.help = true;
    else {
      console.error(`Unrecognized argument: ${a}`);
      process.exit(2);
    }
  }
  return out;
}

function aws(args, region) {
  const full = [...args, '--region', region, '--output', 'json'];
  console.error(`+ aws ${full.join(' ')}`);
  const out = execFileSync('aws', full, { encoding: 'utf8', maxBuffer: 1024 * 1024 * 16 });
  return out.trim() ? JSON.parse(out) : {};
}

function awsWithCliInputJson(command, payload, region, tmpDir) {
  const file = join(tmpDir, `${command.replace(/[^a-z0-9-]/gi, '_')}.json`);
  writeFileSync(file, JSON.stringify(payload, null, 2));
  console.error(`\n--- ${command} payload (${file}) ---`);
  console.error(JSON.stringify(payload, null, 2));
  const cmdLine = `aws bedrock ${command} --cli-input-json file://${file} --region ${region} --output json`;
  console.error(`\n+ ${cmdLine}`);
  return { file, cmdLine, run: () => JSON.parse(execFileSync('aws', ['bedrock', command, '--cli-input-json', `file://${file}`, '--region', region, '--output', 'json'], { encoding: 'utf8', maxBuffer: 1024 * 1024 * 16 })) };
}

/** Find the guardrail by id first (exact GetGuardrail), then by name via ListGuardrails. Returns
 *  null if neither resolves to a real guardrail -- the from-scratch create path. */
function findGuardrail({ guardrailId, name, region }) {
  if (guardrailId) {
    try {
      return aws(['bedrock', 'get-guardrail', '--guardrail-identifier', guardrailId], region);
    } catch (err) {
      console.error(`get-guardrail(${guardrailId}) failed: ${err.message}\nFalling back to a name search.`);
    }
  }
  const list = aws(['bedrock', 'list-guardrails'], region);
  const hit = (list.guardrails || []).find((g) => g.name === name);
  if (!hit) return null;
  return aws(['bedrock', 'get-guardrail', '--guardrail-identifier', hit.id], region);
}

/** Merge the desired PII entities into whatever piiEntitiesConfig already exists, by `type`.
 *  ADDITIVE ONLY: an existing entry for a type this script also wants is kept verbatim, never
 *  overwritten -- see this file's module doc comment. */
function mergePiiEntities(existing) {
  const existingTypes = new Set((existing || []).map((e) => e.type));
  const toAdd = DESIRED_PII_ENTITIES.filter((e) => !existingTypes.has(e.type));
  return {
    merged: [...(existing || []), ...toAdd],
    added: toAdd.map((e) => e.type),
    alreadyPresent: DESIRED_PII_ENTITIES.filter((e) => existingTypes.has(e.type)).map((e) => e.type),
  };
}

/** Re-supply the EXISTING contentPolicy/contextualGroundingPolicy verbatim (only the fields
 *  GetGuardrail actually returned for each filter -- see this file's module doc comment on why
 *  fields GetGuardrail omits are left omitted here rather than defaulted). */
function buildUpdatePayload(current, mergedPiiEntities, guardrailId) {
  const payload = {
    guardrailIdentifier: guardrailId,
    name: current.name,
    blockedInputMessaging: current.blockedInputMessaging,
    blockedOutputsMessaging: current.blockedOutputsMessaging,
  };
  if (current.description) payload.description = current.description;
  if (current.contentPolicy?.filters?.length) {
    payload.contentPolicyConfig = {
      filtersConfig: current.contentPolicy.filters.map((f) => {
        const out = { type: f.type };
        if (f.inputStrength) out.inputStrength = f.inputStrength;
        if (f.outputStrength) out.outputStrength = f.outputStrength;
        return out;
      }),
    };
  }
  if (current.contextualGroundingPolicy?.filters?.length) {
    payload.contextualGroundingPolicyConfig = {
      filtersConfig: current.contextualGroundingPolicy.filters.map((f) => ({
        type: f.type,
        threshold: f.threshold,
      })),
    };
  }
  payload.sensitiveInformationPolicyConfig = { piiEntitiesConfig: mergedPiiEntities };
  return payload;
}

function buildFromScratchPayload(name) {
  return {
    name,
    description: 'Gateway shield_check/groundedness_check provider (replaces retired Azure Content Safety). Contextual grounding + prompt-attack + content policy + PII.',
    contentPolicyConfig: {
      filtersConfig: [
        { type: 'HATE', inputStrength: 'MEDIUM', outputStrength: 'MEDIUM' },
        { type: 'INSULTS', inputStrength: 'MEDIUM', outputStrength: 'MEDIUM' },
        { type: 'SEXUAL', inputStrength: 'MEDIUM', outputStrength: 'MEDIUM' },
        { type: 'VIOLENCE', inputStrength: 'MEDIUM', outputStrength: 'MEDIUM' },
        { type: 'MISCONDUCT', inputStrength: 'MEDIUM', outputStrength: 'MEDIUM' },
        { type: 'PROMPT_ATTACK', inputStrength: 'HIGH', outputStrength: 'NONE' },
      ],
    },
    sensitiveInformationPolicyConfig: { piiEntitiesConfig: DESIRED_PII_ENTITIES },
    contextualGroundingPolicyConfig: {
      filtersConfig: [
        { type: 'GROUNDING', threshold: 0.7 },
        { type: 'RELEVANCE', threshold: 0.7 },
      ],
    },
    blockedInputMessaging: 'Blocked by OTCHealth gateway guardrail.',
    blockedOutputsMessaging: 'Blocked by OTCHealth gateway guardrail.',
  };
}

function printIamStatement(guardrailArn) {
  console.log('\nIAM statement needed on the gateway task role (otchealthTaskRole) for this guardrail:');
  const stmt = {
    Sid: 'ApplyGatewayGuardrail',
    Effect: 'Allow',
    Action: 'bedrock:ApplyGuardrail',
    Resource: guardrailArn,
  };
  console.log(JSON.stringify(stmt, null, 2));
  console.log('\nReady command (only needed if this ARN differs from the one already granted):');
  console.log(
    `  aws iam put-role-policy --role-name otchealthTaskRole --policy-name bedrock-apply-guardrail --policy-document '${JSON.stringify(
      { Version: '2012-10-17', Statement: [stmt] },
    )}'`,
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('See this file\'s module doc comment for full usage.');
    return;
  }
  const guardrailId = args.guardrailId || DEFAULT_GUARDRAIL_ID;
  const name = args.name || DEFAULT_GUARDRAIL_NAME;
  const region = args.region || DEFAULT_REGION;
  const apply = args.apply === true;

  const current = findGuardrail({ guardrailId, name, region });

  if (!current) {
    console.log(`No existing guardrail found (id="${guardrailId}", name="${name}"). This is the FROM-SCRATCH create path -- not the expected path against production, where "otchealth-gateway-guardrail" / m7goqvo48q4m already exists.`);
    const payload = buildFromScratchPayload(name);
    const tmpDir = mkdtempSync(join(tmpdir(), 'create-guardrail-'));
    try {
      const { run, cmdLine } = awsWithCliInputJson('create-guardrail', payload, region, tmpDir);
      if (!apply) {
        console.log('\nDRY RUN (default): the command above was NOT executed. Re-run with --apply to create it for real.');
        return;
      }
      const created = run();
      console.log(`\nCreated guardrail id=${created.guardrailId} arn=${created.guardrailArn} version=${created.version}`);
      printIamStatement(created.guardrailArn);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
    return;
  }

  console.log(`Found guardrail "${current.name}" (id=${current.guardrailId}, status=${current.status}, version=${current.version}).`);
  console.log('Current config:');
  console.log(JSON.stringify(current, null, 2));

  const existingPii = current.sensitiveInformationPolicy?.piiEntities || [];
  const { merged, added, alreadyPresent } = mergePiiEntities(existingPii);

  if (added.length === 0) {
    console.log(`\nAll ${DESIRED_PII_ENTITIES.length} desired PII entity types are already configured (${alreadyPresent.join(', ')}). Nothing to add -- this run is a no-op regardless of --apply.`);
    printIamStatement(current.guardrailArn);
    return;
  }

  console.log(`\nWould ADD these PII entity types (currently unconfigured): ${added.join(', ')}`);
  if (alreadyPresent.length) console.log(`Already configured, left untouched: ${alreadyPresent.join(', ')}`);
  console.log('Every existing content filter and grounding threshold is re-supplied VERBATIM, unchanged.');

  const payload = buildUpdatePayload(current, merged, current.guardrailId);
  const tmpDir = mkdtempSync(join(tmpdir(), 'create-guardrail-'));
  try {
    const updateCall = awsWithCliInputJson('update-guardrail', payload, region, tmpDir);
    const versionCmd = `aws bedrock create-guardrail-version --guardrail-identifier ${current.guardrailId} --description "add PII entities: ${added.join(', ')}" --region ${region} --output json`;
    console.error(`\n+ ${versionCmd}`);

    if (!apply) {
      console.log('\nDRY RUN (default): neither command above was executed. Re-run with --apply to update + version for real.');
      console.log('After --apply succeeds, set BEDROCK_GUARDRAIL_VERSION on the gateway task definition to the printed version number (NOT "DRAFT") and redeploy -- see docs/SAFETY-GUARDRAILS.md.');
      return;
    }

    updateCall.run();
    console.log('\nupdate-guardrail succeeded.');
    const versioned = JSON.parse(
      execFileSync(
        'aws',
        ['bedrock', 'create-guardrail-version', '--guardrail-identifier', current.guardrailId, '--description', `add PII entities: ${added.join(', ')}`, '--region', region, '--output', 'json'],
        { encoding: 'utf8', maxBuffer: 1024 * 1024 * 16 },
      ),
    );
    console.log(`\nCreated guardrail version: ${versioned.version}`);
    console.log(`\nNEXT (CTO, deliberate): set BEDROCK_GUARDRAIL_VERSION=${versioned.version} on the gateway task definition (replacing "DRAFT") and redeploy, so production is pinned to this reviewed, numbered version instead of the mutable draft. See docs/SAFETY-GUARDRAILS.md.`);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err.stack || err.message || String(err));
  process.exit(1);
});
