import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { requireConnectorAuth } from '../auth/bearer.js';
import { logger, newCorrelationId } from '../audit/logger.js';
import { currentCallerHash, requestContext } from './request-context.js';
import { registerAllTools } from '../tools/index.js';

const SERVER_INFO = {
  name: 'otchealth-mcp',
  version: '0.1.0',
} as const;

const SERVER_OPTIONS = {
  capabilities: {
    tools: { listChanged: true as const },
    logging: {},
  },
} as const;

/**
 * Canonical stateless pattern (per MCP SDK docs): build a fresh McpServer +
 * Transport per request. Reusing one McpServer across multiple connected
 * transports is unsafe in stateless mode — tool registrations end up bound
 * to whichever transport was last connected and the others see empty results.
 */
export function registerMcpRoutes(app: FastifyInstance): void {
  app.post('/mcp', async (request: FastifyRequest, reply: FastifyReply) => {
    const ctx = await requireConnectorAuth(request, reply);
    if (!ctx) return;
    const correlationId = newCorrelationId();
    reply.raw.setHeader('x-correlation-id', correlationId);

    await requestContext.run(
      { callerHash: ctx.caller_hash, correlationId, callerAgent: ctx.caller_agent },
      async () => {
        const mcp = new McpServer(SERVER_INFO, SERVER_OPTIONS);
        registerAllTools(mcp, currentCallerHash);
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
          enableJsonResponse: true,
        });

        // Clean up after the response so we don't leak listeners.
        const cleanup = (): void => {
          void transport.close().catch(() => {});
          void mcp.close().catch(() => {});
        };

        try {
          await mcp.connect(transport);
          reply.hijack();
          reply.raw.once('close', cleanup);
          await transport.handleRequest(request.raw, reply.raw, request.body);
        } catch (err) {
          logger.error(
            {
              type: 'mcp_transport_error',
              correlation_id: correlationId,
              err: (err as Error).message,
            },
            'mcp transport error',
          );
          cleanup();
          if (!reply.raw.headersSent) {
            reply.raw.statusCode = 500;
            reply.raw.setHeader('content-type', 'application/json');
            reply.raw.end(
              JSON.stringify({
                jsonrpc: '2.0',
                error: {
                  code: -32603,
                  message: 'Internal MCP transport error',
                  data: { correlation_id: correlationId },
                },
                id: null,
              }),
            );
          } else {
            reply.raw.end();
          }
        }
      },
    );
  });

  app.get('/mcp', async (_request, reply) => {
    await reply.code(405).send({
      jsonrpc: '2.0',
      error: {
        code: -32000,
        message:
          'Method Not Allowed. This MCP server runs in stateless JSON mode; use POST /mcp.',
      },
      id: null,
    });
  });
}
