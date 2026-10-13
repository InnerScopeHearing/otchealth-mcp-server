import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';

const sourcePath = process.argv[2] ?? '/workspace/intercom-fin-control-research-20261013/intercom-api-2.17-public.json';
const outputPath = process.argv[3] ?? new URL('../src/intercom/operations-schema.json', import.meta.url);
const raw = await readFile(sourcePath);
const spec = JSON.parse(raw.toString('utf8'));
const hash = createHash('sha256').update(raw).digest('hex');
if (hash !== 'cc0bc82f24a3237a3a1d6eb3adc64e1a5c0b84ad43e88faec5a6c8afe9e7e6b8') {
  throw new Error(`Unexpected Intercom public spec digest: ${hash}`);
}

const schemas = spec.components?.schemas ?? {};
const operations = [];
const ids = new Set();
const normalizedPathParameters = [];
const resolveParam = (param) => {
  if (!param?.$ref) return param;
  const match = /^#\/components\/parameters\/([^/]+)$/.exec(param.$ref);
  if (!match || !spec.components?.parameters?.[match[1]]) throw new Error('Unsupported parameter reference');
  return spec.components.parameters[match[1]];
};
const responseContentTypes = (op) => {
  const types = new Set();
  for (const [status, response] of Object.entries(op.responses ?? {})) {
    if (!/^2\d\d$/.test(status)) continue;
    let resolved = response;
    if (resolved?.$ref) {
      const match = /^#\/components\/responses\/([^/]+)$/.exec(resolved.$ref);
      if (!match || !spec.components?.responses?.[match[1]]) continue;
      resolved = spec.components.responses[match[1]];
    }
    for (const contentType of Object.keys(resolved?.content ?? {})) types.add(contentType);
  }
  return [...types].sort();
};
for (const [path, pathItem] of Object.entries(spec.paths)) {
  if (!pathItem || typeof pathItem !== 'object') continue;
  const pathParams = pathItem.parameters ?? [];
  for (const [method, op] of Object.entries(pathItem)) {
    if (!['get', 'post', 'put', 'patch', 'delete'].includes(method) || !op || typeof op !== 'object') continue;
    const operationId = op.operationId ?? `${method}_${path.replace(/[^A-Za-z0-9]+/g, '_')}`;
    if (ids.has(operationId)) throw new Error(`Duplicate operationId: ${operationId}`);
    ids.add(operationId);
    const params = [...pathParams, ...(op.parameters ?? [])].map(resolveParam);
    // The published reporting status/download schemas incorrectly call their literal path
    // template's job_identifier a query parameter. Preserve the documented path and record
    // this transport normalization rather than inventing a different endpoint.
    for (const param of params) {
      if (param && path.includes(`{${param.name}}`) && param.in !== 'path') {
        normalizedPathParameters.push({ operation_id: operationId, path, name: param.name, source_in: param.in });
      }
    }
    const parameters = params.filter((p) => p?.in === 'path' || p?.in === 'query').map((p) => ({
      name: p.name,
      in: path.includes(`{${p.name}}`) ? 'path' : p.in,
      required: path.includes(`{${p.name}}`) || p.in === 'path' || Boolean(p.required),
      schema: p.schema ?? {},
      style: p.style,
      explode: p.explode,
      description: p.description,
    }));
    const req = op.requestBody;
    const jsonContent = req?.content?.['application/json'];
    const bodySchema = jsonContent?.schema;
    // Only JSON bodies are supported by this transport. A declared non-JSON body is marked
    // unsupported so the runtime fails closed instead of silently dropping it.
    const unsupportedBody = Boolean(req && !jsonContent);
    operations.push({
      operation_id: operationId,
      method: method.toUpperCase(),
      path,
      domain: path.startsWith('/fin/') ? 'fin_runtime' : 'admin',
      tags: op.tags ?? [],
      summary: op.summary ?? '',
      description: op.description ?? '',
      parameters,
      body_schema: bodySchema,
      body_required: Boolean(req?.required),
      unsupported_body: unsupportedBody,
      response_content_types: responseContentTypes(op),
      effect: method === 'get' ? 'read' : 'write',
      destructive: method === 'delete',
      customer_content: /^\/(?:fin|contacts|conversations|messages|tickets|data_exports)(?:\/|$)/.test(path),
    });
  }
}

const used = new Set();
function collectRefs(value) {
  if (Array.isArray(value)) return value.forEach(collectRefs);
  if (!value || typeof value !== 'object') return;
  if (typeof value.$ref === 'string') {
    const match = /^#\/components\/schemas\/([^/]+)$/.exec(value.$ref);
    if (!match) return;
    if (!used.has(match[1])) {
      used.add(match[1]);
      collectRefs(schemas[match[1]]);
    }
  }
  for (const child of Object.values(value)) collectRefs(child);
}
for (const op of operations) {
  collectRefs(op.parameters);
  collectRefs(op.body_schema);
}
const components = Object.fromEntries([...used].sort().map((name) => [name, schemas[name]]));
const manifest = {
  source: { title: spec.info?.title, version: spec.info?.version, sha256: hash, normalized_path_parameters: normalizedPathParameters },
  security: spec.security ?? [],
  operations,
  components: { schemas: components },
};
await writeFile(outputPath, `${JSON.stringify(manifest)}\n`);
console.log(`Generated ${operations.length} operations, ${used.size} local schemas from ${hash}`);
