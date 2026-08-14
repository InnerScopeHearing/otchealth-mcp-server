import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { requireConnectorAuth } from '../auth/bearer.js';
import { logger, newCorrelationId } from '../audit/logger.js';
import { currentCallerHash, requestContext } from './request-context.js';
import { registerAllTools } from '../tools/index.js';
import { wrapCompressibleResponse } from './compress-response.js';

const SERVER_INFO = { name: 'otchealth-mcp', version: '0.1.0' } as const;
const SERVER_OPTIONS = { capabilities: { tools: { listChanged: true as const }, logging: {} } } as const;

/** Stateless MCP route: each request gets an isolated server and transport. */
export function registerMcpRoutes(app: FastifyInstance): void {
  try {
    registerAllTools(new McpServer(SERVER_INFO, SERVER_OPTIONS), currentCallerHash);
  } catch (err) {
    logger.error({ type: 'catalog_warm_error', err: (err as Error).message }, 'failed to warm tool catalog at startup');
  }

  app.post('/mcp', async (request: FastifyRequest, reply: FastifyReply) => {
    const ctx = await requireConnectorAuth(request, reply);
    if (!ctx) return;
    const correlationId = newCorrelationId();
    reply.raw.setHeader('x-correlation-id', correlationId);

    await requestContext.run({
      callerHash: ctx.caller_hash,
      correlationId,
      callerAgent: ctx.caller_agent,
      connectorSurface: ctx.connector_surface,
      m365StaticAuth: ctx.m365_static_auth,
    }, async () => {
      // Advertise tools.listChanged to Custom MCP connectors as well as internal callers. This lets
      // conforming clients invalidate a cached curated tools/list response after the gateway deploys
      // new tools; registration and execution remain independently authorization/lane gated.
      const mcp = new McpServer(SERVER_INFO, SERVER_OPTIONS);
      registerAllTools(mcp, currentCallerHash);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      const cleanup = (): void => {
        void transport.close().catch(() => {});
        void mcp.close().catch(() => {});
      };
      try {
        await mcp.connect(transport);
        reply.hijack();
        reply.raw.once('close', cleanup);
        const res = wrapCompressibleResponse(reply.raw, request.headers['accept-encoding']);
        await transport.handleRequest(request.raw, res, request.body);
      } catch (err) {
        logger.error({ type: 'mcp_transport_error', correlation_id: correlationId, err: (err as Error).message }, 'mcp transport error');
        cleanup();
        if (!reply.raw.headersSent) {
          reply.raw.statusCode = 500;
          reply.raw.setHeader('content-type', 'application/json');
          reply.raw.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message: 'MCP transport failed' }, id: null }));
        }
      }
    });
  });
}
