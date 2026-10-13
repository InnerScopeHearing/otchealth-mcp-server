import manifest from './operations-schema.json' with { type: 'json' };

export interface OperationInput {
  operation_id: string;
  path_params?: Record<string, string>;
  query?: Record<string, unknown>;
  body?: unknown;
}

export type OperationDomain = 'admin' | 'fin_runtime';
export type OperationEffect = 'read' | 'write';

export interface IntercomOperation {
  operation_id: string;
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  domain: OperationDomain;
  tags: string[];
  summary: string;
  description: string;
  parameters: Array<{ name: string; in: 'path' | 'query'; required: boolean; schema: JsonSchema; style?: string; explode?: boolean; description?: string }>;
  body_schema?: JsonSchema;
  body_required: boolean;
  unsupported_body: boolean;
  response_content_types: string[];
  effect: OperationEffect;
  destructive: boolean;
  customer_content: boolean;
}

export type JsonSchema = Record<string, unknown>;
export interface OperationSchema {
  operation_id: string;
  parameters: IntercomOperation['parameters'];
  body_schema?: JsonSchema;
  body_required: boolean;
  unsupported_body: boolean;
  components: { schemas: Record<string, JsonSchema> };
  response_content_types: string[];
}
export interface ValidationResult { valid: boolean; errors: string[] }
export interface ListOperationOptions { domain?: OperationDomain; offset?: number; limit?: number }

interface Manifest { operations: IntercomOperation[]; components: { schemas: Record<string, JsonSchema> } }
const data = manifest as unknown as Manifest;
const byId = new Map(data.operations.map((operation) => [operation.operation_id, operation]));

export function getOperation(operationId: string): IntercomOperation | undefined {
  const operation = byId.get(operationId);
  return operation ? structuredClone(operation) : undefined;
}

export function listOperations(options: ListOperationOptions = {}): IntercomOperation[] {
  const offset = options.offset ?? 0;
  const limit = options.limit ?? 50;
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) return [];
  const filtered = data.operations.filter((operation) => !options.domain || operation.domain === options.domain);
  return structuredClone(filtered.slice(offset, offset + limit));
}

export function getOperationSchema(operationId: string): OperationSchema | undefined {
  const operation = byId.get(operationId);
  if (!operation) return undefined;
  const reachable = new Set<string>();
  const collect = (value: unknown): void => {
    if (Array.isArray(value)) { value.forEach(collect); return; }
    if (!value || typeof value !== 'object') return;
    const schema = value as Record<string, unknown>;
    if (typeof schema.$ref === 'string') {
      const match = /^#\/components\/schemas\/([^/]+)$/.exec(schema.$ref);
      if (match && !reachable.has(match[1]) && data.components.schemas[match[1]]) {
        reachable.add(match[1]);
        collect(data.components.schemas[match[1]]);
      }
    }
    Object.values(schema).forEach(collect);
  };
  collect(operation.parameters);
  collect(operation.body_schema);
  return structuredClone({
    operation_id: operation.operation_id,
    parameters: operation.parameters,
    body_schema: operation.body_schema,
    body_required: operation.body_required,
    unsupported_body: operation.unsupported_body,
    components: { schemas: Object.fromEntries([...reachable].sort().map((name) => [name, data.components.schemas[name]])) },
    response_content_types: operation.response_content_types,
  });
}

const allowedKeywords = new Set([
  '$ref', 'type', 'enum', 'const', 'properties', 'required', 'additionalProperties', 'items',
  'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'minLength', 'maxLength', 'pattern',
  'minItems', 'maxItems', 'minProperties', 'maxProperties', 'allOf', 'anyOf', 'oneOf', 'nullable',
  'format', 'description', 'title', 'default', 'example', 'examples', 'deprecated', 'readOnly', 'writeOnly',
  'discriminator',
]);
const metadataKeys = new Set(['description', 'title', 'default', 'example', 'examples', 'deprecated', 'readOnly', 'writeOnly', 'discriminator']);

function refSchema(ref: string): JsonSchema | undefined {
  const match = /^#\/components\/schemas\/([^/]+)$/.exec(ref);
  return match ? data.components.schemas[match[1]] : undefined;
}

function declaredType(schema: JsonSchema, visited = new Set<JsonSchema>()): unknown {
  if (visited.has(schema)) return undefined;
  visited.add(schema);
  if (schema.type !== undefined) return schema.type;
  if (typeof schema.$ref === 'string') {
    const target = refSchema(schema.$ref);
    if (target) return declaredType(target, visited);
  }
  return undefined;
}

function validateValue(value: unknown, schema: JsonSchema, path: string, issues: string[], stack = new Set<JsonSchema>()): void {
  if (stack.has(schema)) { issues.push(`${path}: recursive schema is unsupported`); return; }
  stack.add(schema);
  try {
    for (const keyword of Object.keys(schema)) {
      if (!allowedKeywords.has(keyword) && !keyword.startsWith('x-')) issues.push(`${path}: schema keyword is unsupported`);
    }
    if (issues.length) return;
    if (typeof schema.$ref === 'string') {
      const target = refSchema(schema.$ref);
      if (!target) { issues.push(`${path}: schema reference is unavailable`); return; }
      validateValue(value, target, path, issues, stack);
      const siblingSchema = Object.fromEntries(Object.entries(schema).filter(([key]) => key !== '$ref'));
      if (Object.keys(siblingSchema).some((key) => !metadataKeys.has(key))) validateValue(value, siblingSchema, path, issues, stack);
      return;
    }
    if (schema.nullable === true && value === null) return;
    if ('const' in schema && value !== schema.const) issues.push(`${path}: value does not match required constant`);
    if (Array.isArray(schema.enum) && !schema.enum.some((entry) => Object.is(entry, value))) issues.push(`${path}: value is outside allowed values`);
    if (schema.type !== undefined) {
      const types = Array.isArray(schema.type) ? schema.type : [schema.type];
      const matches = types.some((type) => {
        if (type === 'object') return value !== null && typeof value === 'object' && !Array.isArray(value);
        if (type === 'array') return Array.isArray(value);
        if (type === 'integer') return typeof value === 'number' && Number.isInteger(value);
        if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
        if (type === 'string') return typeof value === 'string';
        if (type === 'boolean') return typeof value === 'boolean';
        if (type === 'null') return value === null;
        return false;
      });
      if (!matches) { issues.push(`${path}: value has the wrong type`); return; }
    }
    if (typeof value === 'number') {
      if (typeof schema.minimum === 'number' && value < schema.minimum) issues.push(`${path}: value is below minimum`);
      if (typeof schema.maximum === 'number' && value > schema.maximum) issues.push(`${path}: value is above maximum`);
      if (typeof schema.exclusiveMinimum === 'number' && value <= schema.exclusiveMinimum) issues.push(`${path}: value is below exclusive minimum`);
      if (typeof schema.exclusiveMaximum === 'number' && value >= schema.exclusiveMaximum) issues.push(`${path}: value is above exclusive maximum`);
    }
    if (typeof value === 'string') {
      if (typeof schema.minLength === 'number' && value.length < schema.minLength) issues.push(`${path}: string is too short`);
      if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) issues.push(`${path}: string is too long`);
      if (typeof schema.pattern === 'string') {
        try { if (!new RegExp(schema.pattern).test(value)) issues.push(`${path}: string does not match required pattern`); }
        catch { issues.push(`${path}: invalid schema pattern`); }
      }
      if (typeof schema.format === 'string') {
        const valid = schema.format === 'email' ? /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
          : schema.format === 'date' ? /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value))
            : schema.format === 'date-time' ? !Number.isNaN(Date.parse(value))
              : schema.format === 'uri' ? (() => { try { return new URL(value).protocol.length > 0; } catch { return false; } })()
                : schema.format === 'uuid' ? /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
                  : schema.format === 'byte' ? /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
                    : false;
        if (!valid) issues.push(`${path}: value does not match required format`);
      }
    }
    if (typeof schema.format === 'string' && !['email', 'date', 'date-time', 'uri', 'uuid', 'int64', 'int32', 'float', 'double', 'timestamp', 'byte'].includes(schema.format)) {
      issues.push(`${path}: schema format is unsupported`);
    }
    if (Array.isArray(value)) {
      if (typeof schema.minItems === 'number' && value.length < schema.minItems) issues.push(`${path}: array has too few items`);
      if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) issues.push(`${path}: array has too many items`);
      if (schema.items && typeof schema.items === 'object' && !Array.isArray(schema.items)) {
        value.forEach((item, index) => validateValue(item, schema.items as JsonSchema, `${path}[${index}]`, issues, stack));
      }
    }
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      const objectValue = value as Record<string, unknown>;
      const properties = (schema.properties && typeof schema.properties === 'object' ? schema.properties : {}) as Record<string, JsonSchema>;
      if (Array.isArray(schema.required)) for (const key of schema.required) if (typeof key === 'string' && !(key in objectValue)) issues.push(`${path}.${key}: required value is missing`);
      if (typeof schema.minProperties === 'number' && Object.keys(objectValue).length < schema.minProperties) issues.push(`${path}: object has too few properties`);
      if (typeof schema.maxProperties === 'number' && Object.keys(objectValue).length > schema.maxProperties) issues.push(`${path}: object has too many properties`);
      for (const [key, child] of Object.entries(objectValue)) {
        if (properties[key]) validateValue(child, properties[key], `${path}.${key}`, issues, stack);
        else if (schema.additionalProperties === false) issues.push(`${path}.${key}: additional property is not allowed`);
        else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') validateValue(child, schema.additionalProperties as JsonSchema, `${path}.${key}`, issues, stack);
      }
    }
    for (const keyword of ['allOf', 'anyOf', 'oneOf'] as const) {
      const branches = schema[keyword];
      if (Array.isArray(branches)) {
        const results = branches.map((branch) => { const nested: string[] = []; validateValue(value, branch as JsonSchema, path, nested, new Set(stack)); return nested.length === 0; });
        const matched = results.filter(Boolean).length;
        if (keyword === 'allOf' && matched !== branches.length) issues.push(`${path}: value does not match all required schemas`);
        if (keyword === 'anyOf' && matched === 0) issues.push(`${path}: value does not match any allowed schema`);
        if (keyword === 'oneOf' && matched !== 1) issues.push(`${path}: value does not match exactly one allowed schema`);
      }
    }
  } finally {
    stack.delete(schema);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function validateOperationRequest(input: OperationInput): ValidationResult {
  const operation = byId.get(input?.operation_id);
  if (!operation) return { valid: false, errors: ['Unknown operation.'] };
  const errors: string[] = [];
  if (operation.unsupported_body) errors.push('Operation request body media type is unsupported.');
  const pathParams = input.path_params ?? {};
  const query = input.query ?? {};
  if (!isRecord(pathParams) || !isRecord(query)) return { valid: false, errors: ['Path parameters and query must be objects.'] };
  const pathNames = new Set(operation.parameters.filter((p) => p.in === 'path').map((p) => p.name));
  const queryParams = operation.parameters.filter((p) => p.in === 'query');
  for (const key of Object.keys(pathParams)) if (!pathNames.has(key)) errors.push(`Unexpected path parameter: ${key}.`);
  for (const key of Object.keys(query)) if (!queryParams.some((p) => p.name === key)) errors.push(`Unexpected query parameter: ${key}.`);
  for (const param of operation.parameters) {
    const source = param.in === 'path' ? pathParams : query;
    if (!(param.name in source)) {
      if (param.required) errors.push(`Required ${param.in} parameter is missing: ${param.name}.`);
      continue;
    }
    let value = source[param.name];
    if (param.in === 'path' && (typeof value !== 'string' || !value || value === '.' || value === '..' || /[^A-Za-z0-9._~-]/.test(value))) {
      errors.push(`Invalid path parameter: ${param.name}.`);
      continue;
    }
    if (param.in === 'path' && typeof value === 'string') {
      const type = declaredType(param.schema);
      if (type === 'integer' || type === 'number') {
        if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) {
          errors.push(`Invalid numeric path parameter: ${param.name}.`);
          continue;
        }
        const numeric = Number(value);
        if (!Number.isFinite(numeric) || (type === 'integer' && !Number.isSafeInteger(numeric))) {
          errors.push(`Invalid numeric path parameter: ${param.name}.`);
          continue;
        }
        value = numeric;
      }
    }
    validateValue(value, param.schema, param.name, errors);
  }
  const pathTokens = [...operation.path.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]);
  if (pathTokens.some((token) => !pathNames.has(token))) errors.push('Operation path has an unsupported path template.');
  if (input.body === undefined && operation.body_required) errors.push('Request body is required.');
  if (input.body !== undefined) {
    if (!operation.body_schema) errors.push('Operation does not accept a JSON request body.');
    else validateValue(input.body, operation.body_schema, 'body', errors);
  }
  return { valid: errors.length === 0, errors };
}
