/**
 * MCP tool: docintel_analyze_contract
 *
 * Required env vars (read by src/docintel/client.ts):
 *   DOCINTEL_ENDPOINT  – Azure Document Intelligence endpoint
 *   DOCINTEL_KEY       – Azure subscription key
 *
 * PHI / RING SAFETY WARNING:
 *   This gateway is NOT covered by a BAA. NEVER route PHI, MedReview
 *   documents, or any clinical records through this tool.
 *   Permitted callers: CLO agent (commercial contracts only).
 *
 * PRIVILEGE RING NOTE:
 *   Output stays on trusted engines and is NEVER auto-published or forwarded
 *   to external parties. Contract content may be commercially sensitive.
 *
 * This is a READ/analysis tool only. It takes no write actions.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { analyzeDocument, fieldValue, fieldArray } from '../../docintel/client.js';

interface ContractParty {
  role?: string;
  name?: string;
  address?: string;
}

interface ContractClause {
  clause?: string;
  content?: string;
}

interface ContractData {
  contractId?: string;
  title?: string;
  parties: ContractParty[];
  effectiveDate?: string;
  expirationDate?: string;
  contractDuration?: string;
  renewalDate?: string;
  clauses: ContractClause[];
  _raw_status: string;
  _error?: string;
}

export function registerDocintelAnalyzeContract(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'docintel_analyze_contract',
    category: 'read',
    annotations: {
      title: 'Analyze contract with Azure Document Intelligence',
      description:
        'Extracts structured fields from a commercial contract (parties, dates, duration, ' +
        'key clauses) using Azure Document Intelligence prebuilt-contract model. ' +
        'For CLO agent use only. PHI and MedReview documents are PROHIBITED — ' +
        'this gateway has no BAA. Output stays on trusted engines; never auto-published. ' +
        'Supply either urlSource or base64Source.',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputShape: {
      urlSource: z
        .string()
        .url()
        .optional()
        .describe('Publicly reachable URL of the contract document (PDF or image). Mutually exclusive with base64Source.'),
      base64Source: z
        .string()
        .optional()
        .describe('Base64-encoded contract document content. Mutually exclusive with urlSource.'),
    },
    outputShape: {
      contract: z.object({
        contractId: z.string().optional(),
        title: z.string().optional(),
        parties: z.array(
          z.object({
            role: z.string().optional(),
            name: z.string().optional(),
            address: z.string().optional(),
          }),
        ),
        effectiveDate: z.string().optional(),
        expirationDate: z.string().optional(),
        contractDuration: z.string().optional(),
        renewalDate: z.string().optional(),
        clauses: z.array(
          z.object({
            clause: z.string().optional(),
            content: z.string().optional(),
          }),
        ),
        _raw_status: z.string(),
        _error: z.string().optional(),
      }),
    },
    handler: async (input) => {
      // Validate: at least one source required
      if (!input.urlSource && !input.base64Source) {
        throw new Error('Provide either urlSource or base64Source — both are absent.');
      }
      if (input.urlSource && input.base64Source) {
        throw new Error('Provide only one of urlSource or base64Source, not both.');
      }

      const outcome = await analyzeDocument('prebuilt-contract', {
        urlSource: input.urlSource,
        base64Source: input.base64Source,
      });

      if (outcome.status !== 'succeeded') {
        const contract: ContractData = {
          parties: [],
          clauses: [],
          _raw_status: outcome.status,
          _error: (outcome as any).error,
        };
        return {
          data: { contract },
          summary: `Contract analysis did not succeed: ${outcome.status}${(outcome as any).error ? ' — ' + (outcome as any).error : ''}.`,
        };
      }

      // Extract fields from the first document
      const docs: any[] = (outcome.analyzeResult as any)?.documents ?? [];
      const fields: Record<string, any> = docs[0]?.fields ?? {};

      // Parties — DI returns Parties as an array of objects with role/name/address
      const rawParties = fieldArray(fields, 'Parties');
      const parties: ContractParty[] = rawParties.map((item: any) => {
        const f: Record<string, any> = item.valueObject ?? {};
        return {
          role: fieldValue(f, 'Role'),
          name: fieldValue(f, 'Name'),
          address: fieldValue(f, 'Address'),
        };
      });

      // Key clauses — DI contract model surfaces Clauses as an array
      const rawClauses = fieldArray(fields, 'Clauses');
      const clauses: ContractClause[] = rawClauses.map((item: any) => {
        const f: Record<string, any> = item.valueObject ?? {};
        // DI may return the clause type name in 'Clause' and its text in content
        return {
          clause: fieldValue(f, 'Clause') ?? fieldValue(f, 'ClauseType'),
          content: item.content ?? fieldValue(f, 'Content'),
        };
      });

      const effectiveDate = fieldValue(fields, 'EffectiveDate') ?? fieldValue(fields, 'StartDate');
      const expirationDate = fieldValue(fields, 'ExpirationDate') ?? fieldValue(fields, 'EndDate');
      const contractTitle = fieldValue(fields, 'Title') ?? fieldValue(fields, 'ContractTitle');

      const contract: ContractData = {
        contractId: fieldValue(fields, 'ContractId') ?? fieldValue(fields, 'ContractNumber'),
        title: contractTitle,
        parties,
        effectiveDate,
        expirationDate,
        contractDuration: fieldValue(fields, 'ContractDuration') ?? fieldValue(fields, 'Duration'),
        renewalDate: fieldValue(fields, 'RenewalDate') ?? fieldValue(fields, 'AutoRenewalDate'),
        clauses,
        _raw_status: 'succeeded',
      };

      const partyCount = parties.length;
      const dateStr = effectiveDate ?? 'unknown date';
      const summary =
        `Contract: ${partyCount} part${partyCount !== 1 ? 'ies' : 'y'}, effective ${dateStr}` +
        (expirationDate ? `, expires ${expirationDate}` : '') +
        (clauses.length ? `, ${clauses.length} clause${clauses.length !== 1 ? 's' : ''} extracted` : '') +
        '.';

      return { data: { contract }, summary };
    },
  }, callerHash);
}
