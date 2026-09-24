import { test } from 'node:test';
import assert from 'node:assert/strict';

const requiredTestEnv: Record<string, string> = {
  CIO_SITE_ID: 'synthetic-test',
  CIO_TRACK_KEY: 'synthetic-test',
  CIO_APP_API_BEARER: 'synthetic-test',
  PERPLEXITY_CONNECTOR_TOKEN: 'p'.repeat(32),
  ADMIN_REVOKE_TOKEN: 'a'.repeat(32),
  N8N_WEBHOOK_SECRET: 'n'.repeat(32),
};
for (const [key, value] of Object.entries(requiredTestEnv)) process.env[key] ??= value;

test('rejects traversal in every COO-visible Intercom path ID before sending a request', async (t) => {
  process.env.INTERCOM_ACCESS_TOKEN = 'synthetic-intercom-token';
  const {
    fcGetTeam,
    fcGetTicketType,
    fcSetAdminAway,
    fcUpdateTicketType,
  } = await import('./full-client.js');
  const traversal = '../../conversations/synthetic-id';
  const cases: Array<{ name: string; invoke: () => Promise<unknown> }> = [
    {
      name: 'admin_id on intercom_admin_set_away',
      invoke: () => fcSetAdminAway({ admin_id: traversal, away_mode_enabled: true, away_mode_reassign: false }),
    },
    {
      name: 'team_id on intercom_team_get',
      invoke: () => fcGetTeam(traversal),
    },
    {
      name: 'ticket_type_id on intercom_ticket_type_get',
      invoke: () => fcGetTicketType(traversal),
    },
    {
      name: 'ticket_type_id on intercom_ticket_type_update',
      invoke: () => fcUpdateTicketType({ ticket_type_id: traversal, name: 'Synthetic type' }),
    },
  ];

  for (const { name, invoke } of cases) {
    await t.test(name, async () => {
      const originalFetch = globalThis.fetch;
      let outboundRequests = 0;
      globalThis.fetch = async () => {
        outboundRequests += 1;
        return new Response('{}', { status: 200 });
      };

      try {
        const outcome = await Promise.resolve()
          .then(invoke)
          .then(
            () => ({ rejected: false, messageMatches: false }),
            (error: unknown) => ({
              rejected: true,
              messageMatches: /invalid.*(?:path|ID)|path.*segment/i.test(error instanceof Error ? error.message : String(error)),
            }),
          );
        assert.deepEqual(
          { ...outcome, outboundRequests },
          { rejected: true, messageMatches: true, outboundRequests: 0 },
          'invalid path ID must fail closed before HTTP fetch',
        );
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  }
});

test('keeps ordinary Intercom IDs as single URL path segments', async () => {
  process.env.INTERCOM_ACCESS_TOKEN = 'synthetic-intercom-token';
  const {
    fcGetTeam,
    fcGetTicketType,
    fcSetAdminAway,
    fcUpdateTicketType,
  } = await import('./full-client.js');
  const originalFetch = globalThis.fetch;
  const paths: string[] = [];
  globalThis.fetch = async (input) => {
    paths.push(new URL(input).pathname);
    return new Response('{}', { status: 200 });
  };

  try {
    await fcSetAdminAway({ admin_id: 'admin_12-abc', away_mode_enabled: true, away_mode_reassign: false });
    await fcGetTeam('team_34-abc');
    await fcGetTicketType('ticket_56-abc');
    await fcUpdateTicketType({ ticket_type_id: 'ticket_56-abc', name: 'Synthetic type' });
    assert.deepEqual(paths, [
      '/admins/admin_12-abc/away',
      '/teams/team_34-abc',
      '/ticket_types/ticket_56-abc',
      '/ticket_types/ticket_56-abc',
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
