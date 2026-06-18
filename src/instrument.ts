// Datadog APM init. MUST be imported FIRST, before any other module, so dd-trace can
// patch http/fastify/undici before they load.
//
// GATE: this no-ops unless DD_API_KEY is present in the environment. So an environment
// without the key sends nothing to Datadog. The gateway is keys-to-the-kingdom, so
// telemetry is provisioned deliberately, per environment, never by default.
//
// SAFETY: dd-trace's default obfuscation scrubs query strings and SQL in spans, and we do
// NOT enable any custom request-header capture here, so auth headers, bearer tokens, and
// secrets are not recorded as span tags. Do not add header/body capture to this module.
import tracer from 'dd-trace';

if (process.env.DD_API_KEY) {
  tracer.init({
    service: process.env.DD_SERVICE || 'gateway-mcp',
    env: process.env.DD_ENV || process.env.NODE_ENV || 'development',
    version: process.env.DD_VERSION,
    logInjection: true,
    runtimeMetrics: true,
  });
}

export default tracer;
