import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getRetractionAuthorityDiagnostic, type RetractionAuthorityDiagnostic } from '../../memory/retractions.js';
import { registerTool, type CallerHashProvider, type ToolContext, type ToolResultPayload } from '../registry.js';

export interface RetractionDiagnosticDependencies {
  read?: () => Promise<RetractionAuthorityDiagnostic>;
}

export async function retractionAuthorityDiagnosticHandler(
  _input: Record<string, never>,
  ctx: ToolContext,
  dependencies: RetractionDiagnosticDependencies = {},
): Promise<ToolResultPayload> {
  if (ctx.callerAgent !== 'cto') {
    return {
      data: { error: 'forbidden_role' },
      summary: 'Retraction authority diagnostics are CTO-only.',
    };
  }
  const read = dependencies.read ?? getRetractionAuthorityDiagnostic;
  const diagnostic = await read();
  return {
    data: diagnostic,
    summary: `Retraction authorities: shared=${diagnostic.shared_source}, memory=${diagnostic.memory_source}, verified=${diagnostic.verified}, cache_age_ms=${diagnostic.cache_age_ms ?? 'unknown'}.`,
  };
}

export function registerRetractionAuthorityDiagnostic(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(
    server,
    {
      name: 'memory_retraction_diagnostic',
      category: 'read',
      annotations: {
        title: 'CTO: retraction authority diagnostic',
        description: 'CTO-only metadata diagnostic for the two retraction authorities. Returns fixed source statuses, cache age, and verified state. Never returns rows, ids, endpoints, errors, or source content.',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputShape: {},
      outputShape: {
        schema: z.literal('retraction-authority-diagnostic.v1'),
        shared_source: z.enum(['healthy', 'error', 'unknown']),
        memory_source: z.enum(['healthy', 'error', 'unknown']),
        cache_age_ms: z.number().int().nonnegative().nullable(),
        verified: z.boolean(),
      },
      handler: retractionAuthorityDiagnosticHandler,
    },
    callerHash,
  );
}
