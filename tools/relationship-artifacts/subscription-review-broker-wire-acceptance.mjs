import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  subscriptionReviewBundlesForRequest,
  validSubscriptionReviewOutput,
} from '../../src/server/subscription-review-broker.js';

// Cross-checkout synthetic only. The first argument is the exact reviewed PR198
// checkout. It makes no network, AWS, credential, or model calls.
const producerRoot = resolve(process.argv[2] ?? '');
if (!process.argv[2]) throw new Error('subscription_review_checkout_required');
const load = (path) => import(pathToFileURL(join(producerRoot, path)));
const [{ canonical, sha256 }, { createGatewayBrokerClient }, { createS3SubscriptionOperationStore },
  { createSubscriptionJobReconciler }, { createCodexReviewProvider }, { preparedTextIdentity }] = await Promise.all([
  load('tools/neptune-trial/aws-adapters/aws-http.mjs'),
  load('tools/neptune-trial/subscription-jobs/broker-client.mjs'),
  load('tools/neptune-trial/subscription-jobs/operation-store.mjs'),
  load('tools/neptune-trial/subscription-jobs/reconciler.mjs'),
  load('tools/neptune-trial/subscription-review/provider.mjs'),
  load('tools/neptune-trial/subscription-jobs/prepared-text-binding.mjs'),
]);

const hash = (value) => createHash('sha256').update(value).digest('hex');
const text = 'A-001 does not depend on ORG-001.';
const run = {
  ref_version: 'neptune-trial-active-run-ref-v1', purpose: 'relationship-review', scope: 'finance',
  run_version: 'wire-v1', manifest_sha256: hash('wire-manifest'),
};
run.run_id = 'run_' + hash(canonical(run));
const binding = Object.freeze({
  schema: 'cfo-prepared-chunk-binding-v1', run_id: run.run_id, room: 'finance',
  source_index: 'finance-cfo-source-docs', catalog_manifest_sha256: run.manifest_sha256,
  document_ordinal: 0, source_document_version: 'docv_' + hash('source-version'),
  catalog_source_sha256: hash('catalog-source'), snapshot_id: 'txtsnap_' + hash('snapshot'),
  prepared_manifest_sha256: hash('prepared-manifest'), sidecar_content_sha256: hash(text),
  chunk_ordinal: 0, chunk_sha256: hash(text),
});
const identity = preparedTextIdentity({ purpose: run.purpose, source_binding: binding });
const document = Object.freeze({ text, document_version_id: identity.source_version, room: 'finance' });
const token = 'synthetic-subscription-review-cfo-token';
const state = new Map();
let revisions = 0, modelCalls = 0;

function response(body = '', status = 200, headers = {}) {
  return new Response(body, { status, headers });
}
function etag() { return '"wire-' + (++revisions) + '"'; }
const transport = async (url, init) => {
  const parsed = new URL(url);
  assert.equal(parsed.origin, 'https://mcp.otchealth.app');
  assert.match(parsed.pathname, new RegExp('^/graph-worker/v1/state/' + run.run_id + '/(?:operations|results)/subop_[a-f0-9]{64}\\.json$'));
  assert.equal(init.headers.authorization, 'Bearer ' + token);
  const prior = state.get(parsed.pathname);
  if (init.method === 'GET') return prior
    ? response(prior.body, 200, { etag: prior.etag, 'content-type': 'application/json' })
    : response('', 404);
  assert.equal(init.method, 'PUT');
  const headers = new Headers(init.headers);
  if ((headers.get('if-none-match') === '*' && prior) ||
      (headers.has('if-match') && headers.get('if-match') !== prior?.etag)) return response('', 412);
  const next = { body: String(init.body), etag: etag() };
  state.set(parsed.pathname, next);
  return response('', 201, { etag: next.etag });
};
const broker = createGatewayBrokerClient({ seat: 'cfo', run, transport, bearerTokenProvider: () => token });
const store = createS3SubscriptionOperationStore({ ...broker.stateConfig,
  signRequest: broker.signRequest, fetchImpl: broker.fetchImpl });

function reviewRequest(label) {
  return Object.freeze({ source_sha256: hash(text), candidate: { subject: 'A-001', object: 'ORG-001', label } });
}
function reviewReply(request, verdict = 'supported') {
  return {
    request_sha256: hash(canonical(request)), verdict, subject_index: 0, object_index: 1,
    predicate: 'depends_on', polarity: 'negative', qualifications: verdict === 'uncertain' ? ['synthetic uncertainty'] : [],
    evidence: { start_utf16: 0, end_utf16: text.length, quote: text }, reason_code: 'synthetic_wire',
  };
}
function providerFor(request, reply = reviewReply(request)) {
  return createCodexReviewProvider({
    binary: process.platform === 'win32' ? 'C:/synthetic/codex.exe' : '/synthetic/codex', request, env: {},
    authorize: async () => true,
    run: async (_binary, args) => {
      if (args[0] === 'login') return { code: 0, out: 'Logged in using ChatGPT', err: '' };
      modelCalls++;
      await writeFile(args[args.indexOf('--output-last-message') + 1], JSON.stringify(reply));
      return { code: 0, out: '', err: '' };
    },
  });
}
function reconcilerFor(provider) {
  return createSubscriptionJobReconciler({
    store, extractor: provider, provider: provider.provider,
    extractorVersion: provider.identity.extractor_version, model: provider.identity.model,
    readSource: async () => document,
    authorizeSource: async () => ({ authorized: true, decision_ref: 'synthetic-wire-authorized', source_binding: binding }),
  });
}
const job = Object.freeze({ ...identity, purpose: run.purpose, source_binding: binding });

const firstRequest = reviewRequest('first');
const firstProvider = providerFor(firstRequest);
const first = await reconcilerFor(firstProvider).run(job);
assert.equal(first.status, 'complete');
assert.equal(first.result.review.polarity, 'negative');
assert.ok(subscriptionReviewBundlesForRequest(first.result.review.request_sha256)
  .includes(firstProvider.identity.extractor_bundle_sha256));
assert.equal(validSubscriptionReviewOutput(first.result, {
  provider: firstProvider.provider, model: firstProvider.identity.model,
  extractor_bundle_sha256: firstProvider.identity.extractor_bundle_sha256,
}, { text, textSha256: hash(text) }), true);

const replay = await reconcilerFor(providerFor(firstRequest)).run(job);
assert.equal(replay.status, 'complete');
assert.equal(replay.replayed, true);
assert.equal(modelCalls, 1);

const secondRequest = reviewRequest('second');
const secondProvider = providerFor(secondRequest, reviewReply(firstRequest));
const mismatched = await reconcilerFor(secondProvider).run(job);
assert.equal(mismatched.status, 'unknown');
assert.equal(mismatched.code, 'review_output_shape');
assert.notEqual(secondProvider.identity.extractor_bundle_sha256, firstProvider.identity.extractor_bundle_sha256);
assert.equal(validSubscriptionReviewOutput({ ...first.result, review: reviewReply(firstRequest) }, {
  provider: secondProvider.provider, model: secondProvider.identity.model,
  extractor_bundle_sha256: secondProvider.identity.extractor_bundle_sha256,
}, { text, textSha256: hash(text) }), false);

const uncertainRequest = reviewRequest('uncertain');
const uncertain = await reconcilerFor(providerFor(uncertainRequest, reviewReply(uncertainRequest, 'uncertain'))).run(job);
assert.equal(uncertain.status, 'complete');
assert.equal(uncertain.result.review.verdict, 'uncertain');
assert.equal(modelCalls, 3);
process.stdout.write(JSON.stringify({
  schema: 'subscription-review-broker-wire-acceptance-v1', status: 'passed',
  transport: 'in_process_broker_client', provider: 'codex-chatgpt-subscription-review',
  real_aws_calls: 0, real_model_calls: 0, operation_store: 'createS3SubscriptionOperationStore',
  mismatched_request_held: true, replay_without_second_model: true, negative_and_uncertain_validated: true,
}) + '\n');
