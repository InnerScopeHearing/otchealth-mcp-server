import { test } from 'node:test';
import assert from 'node:assert/strict';
process.env.CIO_SITE_ID='test'; process.env.CIO_TRACK_KEY='test'; process.env.CIO_APP_API_BEARER='test';
process.env.PERPLEXITY_CONNECTOR_TOKEN='a'.repeat(32); process.env.ADMIN_REVOKE_TOKEN='b'.repeat(32);
process.env.N8N_WEBHOOK_SECRET='c'.repeat(32); process.env.READ_ONLY_MODE='false';
process.env.ENABLE_WRITE_TOOLS='true'; process.env.DRY_RUN_DEFAULT='true';
const { registerCheckpoint } = await import('./checkpoint.js');
const { requestContext, currentCallerHash } = await import('../../server/request-context.js');

test('scope denial preserves the configured dry-run default when omitted', async () => {
  let handler: any;
  registerCheckpoint({ registerTool: (_name: any, _config: any, callback: any) => { handler = callback; } } as never, currentCallerHash);
  const response = await requestContext.run(
    { callerHash: 'synthetic', correlationId: 'synthetic', callerAgent: 'coo' },
    () => handler({ agent: 'cto' }),
  );
  assert.equal(response.isError, true);
  assert.equal(response.structuredContent.error.code, 'checkpoint_scope_forbidden');
  assert.equal(response.structuredContent.dry_run, true);
});
