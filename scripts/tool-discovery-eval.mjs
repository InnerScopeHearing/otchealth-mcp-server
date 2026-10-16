import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { searchDiscoveryTools } from '../src/tools/catalog/discovery-search.ts';

const fixturePath = new URL('../fixtures/tool-discovery-eval.json', import.meta.url);
const byteLength = (value) => Buffer.byteLength(value, 'utf8');
const serialized = (value) => JSON.stringify(value);

function runSearch(tools, route, limit) {
  const started = process.hrtime.bigint();
  const result = searchDiscoveryTools(tools, {
    query: route.query,
    ...(limit === undefined ? {} : { limit }),
    ...(route.includeSchema === undefined ? {} : { includeSchema: route.includeSchema }),
  });
  return { result, elapsedNs: Number(process.hrtime.bigint() - started) };
}

export function evaluateDiscovery(fixture) {
  if (!fixture || !Array.isArray(fixture.tools) || !Array.isArray(fixture.routes)) {
    throw new TypeError('Invalid discovery evaluation fixture');
  }

  const routes = fixture.routes.map((route) => {
    const supplied = route.scope
      ? fixture.tools.filter((tool) => route.scope.includes(tool.name))
      : fixture.tools;
    const suppliedJson = serialized(supplied);
    const initial = runSearch(supplied, route);
    const initialNames = initial.result.matches.map(({ name }) => name);
    const needsRetry = route.retryLimit !== undefined && !initialNames.includes(route.expected);
    const retry = needsRetry ? runSearch(supplied, route, route.retryLimit) : null;
    const final = retry ?? initial;
    const finalNames = final.result.matches.map(({ name }) => name);
    const selectedJson = serialized(final.result.matches);
    const initialContainsExpected = route.expected === null ? initialNames.length === 0 : initialNames.includes(route.expected);
    const found = route.expected === null ? finalNames.length === 0 : finalNames.includes(route.expected);
    const expectedRetry = route.mustRequireRetry !== true || needsRetry;
    const forbiddenClear = (route.forbidden ?? []).every((name) => !finalNames.includes(name));
    const boundedDescription = !route.assertDescriptionBound || final.result.matches.every(
      ({ description }) => description === undefined || description.length <= fixture.limits.descriptionCharacters,
    );
    const schemaCorrect = route.includeSchema === true
      ? final.result.matches.filter(({ name }) => name === route.expected).every(({ inputSchema }) => inputSchema !== undefined)
      : final.result.matches.every(({ inputSchema }) => inputSchema === undefined);
    const success = found && expectedRetry && forbiddenClear && boundedDescription && schemaCorrect;
    return {
      id: route.id,
      success,
      expected: route.expected,
      selected: finalNames,
      helperCalls: retry ? 2 : 1,
      retryUsed: needsRetry,
      initialContainsExpected,
      suppliedMetadataChars: suppliedJson.length,
      suppliedMetadataUtf8Bytes: byteLength(suppliedJson),
      initialMetadataChars: initial.result.matches.reduce((n, item) => n + serialized(item).length, 0),
      selectedMetadataChars: selectedJson.length,
      selectedMetadataUtf8Bytes: byteLength(selectedJson),
      helperSamples: retry ? 2 : 1,
      elapsedHelperNs: initial.elapsedNs + (retry?.elapsedNs ?? 0),
      checks: { expectedRoute: found, requiredRetry: expectedRetry, forbiddenAbsent: forbiddenClear, boundedDescription, schemaPolicy: schemaCorrect },
    };
  });

  const fullCatalogJson = serialized(fixture.tools);
  const selectedMetadataChars = routes.reduce((sum, route) => sum + route.selectedMetadataChars, 0);
  const selectedMetadataUtf8Bytes = routes.reduce((sum, route) => sum + route.selectedMetadataUtf8Bytes, 0);
  const helperSamples = routes.reduce((sum, route) => sum + route.helperSamples, 0);
  const elapsedHelperNs = routes.reduce((sum, route) => sum + route.elapsedHelperNs, 0);
  return {
    evaluation: 'synthetic bounded discovery/routing acceptance',
    task_id: 'synthetic-discovery-pilot-v1',
    role: 'synthetic-routing-evaluation',
    product: 'gateway discovery helper',
    routeCount: routes.length,
    successCount: routes.filter(({ success }) => success).length,
    failureCount: routes.filter(({ success }) => !success).length,
    evaluationScope: 'helper-only synthetic acceptance; no tool execution or LLM route scoring',
    helperToolExecutions: 0,
    llmRoutingAccuracy: null,
    actualToolDefinitionTokens: null,
    actualToolInputTokens: null,
    actualToolOutputTokens: null,
    hostDeferredLoading: null,
    timeToFirstValidCallMs: null,
    taskCompletion: null,
    claimedHostContextSaving: null,
    limits: fixture.limits,
    routingGuidance: fixture.routingGuidance ?? [],
    metadata: {
      syntheticToolCount: fixture.tools.length,
      fullCatalogChars: fullCatalogJson.length,
      fullCatalogUtf8Bytes: byteLength(fullCatalogJson),
      selectedReturnedMetadataCharsAcrossRoutes: selectedMetadataChars,
      selectedReturnedMetadataUtf8BytesAcrossRoutes: selectedMetadataUtf8Bytes,
      helperElapsedMsAcrossSamples: elapsedHelperNs / 1e6,
      helperSampleCount: helperSamples,
      helperCalls: helperSamples,
      meanHelperMs: helperSamples ? elapsedHelperNs / helperSamples / 1e6 : 0,
    },
    routes,
  };
}

async function main() {
  const fixture = JSON.parse(await readFile(fixturePath, 'utf8'));
  const report = evaluateDiscovery(fixture);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (report.failureCount > 0) process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
