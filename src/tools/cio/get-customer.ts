import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { appApiGet, CustomerIoApiError } from '../../customerio/app-api-client.js';

interface CustomerSearchResult {
  results?: Array<{
    cio_id?: string;
    email?: string;
    id?: string;
    [k: string]: unknown;
  }>;
  ids?: string[];
}

export function registerGetCustomer(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(
    server,
    {
      name: 'cio_get_customer',
      category: 'read',
      annotations: {
        title: 'Get a Customer.io customer profile',
        description:
          'Look up a customer profile by email, cio_id, or workspace id. Returns profile attributes plus segment membership when accessible.',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputShape: {
        email: z.string().email().optional(),
        cio_id: z.string().optional(),
        id: z.string().optional().describe('Workspace identifier (the value tracked as "id").'),
        include_segments: z
          .boolean()
          .optional()
          .describe('If true, also fetch /customers/{cio_id}/segments after resolving the customer.'),
      },
      outputShape: {
        identifier_used: z.string(),
        cio_id: z.string().nullable(),
        customer: z.unknown(),
        attributes: z.unknown().nullable(),
        attributes_status: z.string(),
        segments: z.unknown().nullable(),
        segments_status: z.string(),
      },
      handler: async (input, ctx) => {
        if (!input.email && !input.cio_id && !input.id) {
          throw new CustomerIoApiError({
            code: 'invalid_input',
            status: 400,
            message: 'Provide at least one of: email, cio_id, id.',
            nextStep:
              'Pass one of email/cio_id/id. Use cio_list_segment_people to find ids inside a known segment.',
          });
        }

        let cio_id: string | null = input.cio_id ?? null;
        let identifier_used: string;
        let customer: unknown = null;

        if (cio_id) {
          identifier_used = `cio_id:${cio_id}`;
          customer = await appApiGet<unknown>(`/customers/${encodeURIComponent(cio_id)}`, {
            correlationId: ctx.correlationId,
          });
        } else {
          const lookupField = input.email ? 'email' : 'id';
          const lookupValue = input.email ?? input.id!;
          identifier_used = `${lookupField}:${lookupValue}`;
          const search = await appApiGet<CustomerSearchResult>(`/customers`, {
            query: { [lookupField]: lookupValue },
            correlationId: ctx.correlationId,
          });
          const hit = search.results?.[0];
          if (!hit) {
            throw new CustomerIoApiError({
              code: 'cio_not_found',
              status: 404,
              message: `No Customer.io customer found for ${identifier_used}.`,
              nextStep:
                'Verify the email/id is exactly as stored in workspace 193366. Try cio_list_segment_people to confirm membership.',
            });
          }
          cio_id = (hit.cio_id as string | undefined) ?? null;
          customer = hit;
        }

        let attributes: unknown = null;
        let attributes_status = 'not_attempted';
        if (cio_id) {
          try {
            attributes = await appApiGet<unknown>(
              `/customers/${encodeURIComponent(cio_id)}/attributes`,
              { correlationId: ctx.correlationId },
            );
            attributes_status = 'ok';
          } catch (err) {
            if (err instanceof CustomerIoApiError && err.status === 404) {
              attributes_status = 'unsupported_via_api';
            } else {
              throw err;
            }
          }
        }

        let segments: unknown = null;
        let segments_status = 'not_requested';
        if (input.include_segments === true && cio_id) {
          try {
            segments = await appApiGet<unknown>(
              `/customers/${encodeURIComponent(cio_id)}/segments`,
              { correlationId: ctx.correlationId },
            );
            segments_status = 'ok';
          } catch (err) {
            if (err instanceof CustomerIoApiError && err.status === 404) {
              segments_status = 'unsupported_via_api';
            } else {
              throw err;
            }
          }
        }

        return {
          data: {
            identifier_used,
            cio_id,
            customer,
            attributes,
            attributes_status,
            segments,
            segments_status,
          },
        };
      },
    },
    callerHash,
  );
}
