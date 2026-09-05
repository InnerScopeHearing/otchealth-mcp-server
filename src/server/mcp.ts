import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  ListPromptsRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListResourcesRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
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
 * Codex compatibility (2026-09-05). OpenAI Codex's MCP client decides a connected server is
 * "available" by calling resources/list (and prompts/list); a tools-only server that answers
 * `-32601 Method not found` is marked unavailable and ALL its tools are hidden from the model, even
 * though tools/list works and the connection is authenticated. Proven live: a healthy, elevated
 * Codex session showed 512 tools with ZERO gateway tools, and a direct probe returned -32601 on
 * resources/list, prompts/list and resources/templates/list. The gateway genuinely has no resources
 * or prompts, so the fix is to ADVERTISE those two capabilities and answer their list calls with an
 * empty array -- spec-valid, and inert for clients that ignore resources (Claude.ai / Claude Code
 * connectors never read them). Gated by MCP_STUB_RESOURCES_MODE (default 'on'); setting it to 'off'
 * (a task-definition env change plus a rollout, no image rebuild) reverts to the exact prior
 * tools-only handshake if any client ever regresses. Read fresh from process.env per request, the
 * same convention as the other connector-compat toggles (CONNECTOR_ANNOTATIONS_MODE et al.).
 */
export function stubResourceListsEnabled(): boolean {
  return (process.env.MCP_STUB_RESOURCES_MODE || '').trim().toLowerCase() !== 'off';
}

/** Per-request server capabilities. Adds the empty resources/prompts capabilities when the Codex
 *  compatibility flag is on (see stubResourceListsEnabled); the capability MUST be declared here
 *  before applyStubResourceHandlers() may register the matching list handlers on the same server. */
export function serverOptions(): { capabilities: Record<string, unknown> } {
  const capabilities: Record<string, unknown> = {
    tools: { listChanged: true },
    logging: {},
  };
  if (stubResourceListsEnabled()) {
    capabilities.resources = {};
    capabilities.prompts = {};
  }
  return { capabilities };
}

/** Register empty resources/prompts list handlers so an availability probe gets a valid empty list
 *  instead of -32601. resources/read and prompts/get are deliberately left unhandled: the lists are
 *  always empty, so a spec-compliant client never asks to read one. Never call registerResource on
 *  the same server -- the SDK would then also try to own resources/list and the two would collide. */
export function applyStubResourceHandlers(mcp: McpServer): void {
  mcp.server.setRequestHandler(ListResourcesRequestSchema, () => ({ resources: [] }));
  mcp.server.setRequestHandler(ListResourceTemplatesRequestSchema, () => ({ resourceTemplates: [] }));
  mcp.server.setRequestHandler(ListPromptsRequestSchema, () => ({ prompts: [] }));
}

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
      {
        callerHash: ctx.caller_hash,
        correlationId,
        callerAgent: ctx.caller_agent,
        connectorSurface: ctx.connector_surface,
        m365StaticAuth: ctx.m365_static_auth,
      },
      async () => {
        // serverOptions() advertises listChanged (so a Custom MCP client cannot cache an earlier
        // curated tools/list across a deploy) plus, when MCP_STUB_RESOURCES_MODE is on, the empty
        // resources/prompts capabilities Codex's availability probe requires. Tool availability
        // still remains authorization- and lane-specific at registration time.
        const mcp = new McpServer(SERVER_INFO, serverOptions());
        if (stubResourceListsEnabled()) applyStubResourceHandlers(mcp);
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
