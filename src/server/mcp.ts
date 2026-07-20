import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { requireConnectorAuth } from '../auth/bearer.js';
import { logger, newCorrelationId } from '../audit/logger.js';
import { currentCallerHash, requestContext } from './request-context.js';
import { registerAllTools } from '../tools/index.js';
import { wrapCompressibleResponse } from './compress-response.js';

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
  // Warm the capability catalog at startup. Tools otherwise register lazily, per request (below),
  // so before the first MCP session the module-level catalog is empty and toolCount() (exposed on
  // /health) reads 0 — which trips the deploy pipeline's tool_count regression guard on a perfectly
  // good image. registerAllTools records every tool into the catalog (recordTool is idempotent by
  // name), so the per-request registration below is unaffected; the throwaway server is discarded.
  // currentCallerHash is only invoked at tool-execution time, never during registration.
  try {
    registerAllTools(new McpServer(SERVER_INFO, SERVER_OPTIONS), currentCallerHash);
  } catch (err) {
    logger.error(
      { type: 'catalog_warm_error', err: (err as Error).message },
      'failed to warm tool catalog at startup',
    );
  }

  app.post('/mcp', async (request: FastifyRequest, reply: FastifyReply) => {
    const ctx = await requireConnectorAuth(request, reply);
    if (!ctx) return;
    const correlationId = newCorrelationId();
    reply.raw.setHeader('x-correlation-id', correlationId);

    await requestContext.run(
      { callerHash: ctx.caller_hash, correlationId, callerAgent: ctx.caller_agent, connectorSurface: ctx.connector_surface },
      async () => {
        const mcp = new McpServer(
          SERVER_INFO,
          ctx.connector_surface ? { capabilities: { tools: {} } } : SERVER_OPTIONS,
        );
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
          // Compress the JSON response (the ~1.9MB tools/list catalog gzips ~16x). The wrapper only
          // intercepts writeHead/write/end and only for compressible JSON/text; SSE and clients that
          // do not accept gzip pass through the real socket untouched. Cleanup stays on reply.raw.
          const res = wrapCompressibleResponse(reply.raw, request.headers['accept-encoding']);
          await transport.handleRequest(request.raw, res, request.body);
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
