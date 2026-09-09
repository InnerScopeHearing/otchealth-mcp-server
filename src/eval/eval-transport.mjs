/** Strict transport boundary for the standalone gateway eval runner. */

const HTTP_STATUS_MARKER = /\n__HTTP_STATUS__(\d{3})$/;
const POLICY_REFUSAL_CODE = 'prompt_injection_blocked';

function plain(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype;
}

function fail(code) {
  throw Object.assign(new Error(code), { code });
}

export function parseCurlJsonOutput(stdout) {
  if (typeof stdout !== 'string') fail('eval_transport_invalid');
  const match = stdout.match(HTTP_STATUS_MARKER);
  if (!match) fail('eval_transport_invalid');
  const status = Number(match[1]);
  if (!Number.isInteger(status) || status < 100 || status > 599) fail('eval_transport_invalid');
  const rawBody = stdout.slice(0, match.index).trim();
  if (!rawBody) fail('eval_response_body_missing');
  let body;
  try {
    body = JSON.parse(rawBody);
  } catch {
    fail('eval_response_invalid_json');
  }
  return Object.freeze({ status, body });
}

export function validateMcpToolEnvelope(body, expectedId = 1) {
  if (!plain(body) || body.jsonrpc !== '2.0' || body.id !== expectedId) {
    fail('eval_mcp_envelope_invalid');
  }
  const hasResult = Object.prototype.hasOwnProperty.call(body, 'result');
  const hasError = Object.prototype.hasOwnProperty.call(body, 'error');
  if (hasResult === hasError) fail('eval_mcp_envelope_invalid');

  if (hasError) {
    const error = body.error;
    if (!plain(error) || !Number.isInteger(error.code) ||
        typeof error.message !== 'string' || error.message.length < 1 || error.message.length > 4096) {
      fail('eval_mcp_envelope_invalid');
    }
    return body;
  }

  const result = body.result;
  if (!plain(result) || !Array.isArray(result.content) || result.content.length < 1 ||
      (Object.prototype.hasOwnProperty.call(result, 'isError') && typeof result.isError !== 'boolean') ||
      (Object.prototype.hasOwnProperty.call(result, 'structuredContent') && !plain(result.structuredContent))) {
    fail('eval_mcp_envelope_invalid');
  }
  for (const block of result.content) {
    if (!plain(block) || block.type !== 'text' || typeof block.text !== 'string') {
      fail('eval_mcp_envelope_invalid');
    }
  }
  return body;
}

export async function callMcpTool({
  gatewayBaseUrl,
  bearer,
  toolName,
  toolArgs,
  curlJsonFn,
}) {
  const envelope = {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: toolName, arguments: toolArgs },
  };
  const response = await curlJsonFn(`${gatewayBaseUrl}/mcp`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${bearer}` },
    body: envelope,
  });
  if (!plain(response) || !Number.isInteger(response.status) ||
      !Object.prototype.hasOwnProperty.call(response, 'body')) {
    fail('eval_transport_invalid');
  }
  if (response.status === 401 || response.status === 403) {
    throw new Error(`Auth rejected (HTTP ${response.status}), check GATEWAY_BEARER.`);
  }
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`MCP request failed (HTTP ${response.status || 'no response'}).`);
  }
  return validateMcpToolEnvelope(response.body, 1);
}

export function isExpectedPolicyRefusal(responseBody) {
  let response;
  try {
    response = validateMcpToolEnvelope(responseBody, 1);
  } catch {
    return false;
  }
  if (response.error) {
    return plain(response.error.data) && response.error.data.code === POLICY_REFUSAL_CODE;
  }
  const result = response.result;
  const structured = result.structuredContent;
  return result.isError === true && plain(structured) && plain(structured.error) &&
    structured.error.code === POLICY_REFUSAL_CODE && plain(structured.prompt_shield) &&
    structured.prompt_shield.attackDetected === true;
}

export { POLICY_REFUSAL_CODE };
