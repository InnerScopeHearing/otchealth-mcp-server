/**
 * MCP tool: docintel_analyze_invoice
 *
 * Required env vars (read by src/docintel/client.ts):
 *   DOCINTEL_ENDPOINT  – Azure Document Intelligence endpoint
 *   DOCINTEL_KEY       – Azure subscription key
 *
 * PHI / RING SAFETY WARNING:
 *   This gateway is NOT covered by a BAA. NEVER route PHI, MedReview
 *   documents, or any clinical records through this tool.
 *   Permitted callers: CFO agent (finance invoices for Xero feed only).
 *
 * This is a READ/analysis tool only. It takes no write actions.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { analyzeDocument, fieldValue, fieldCurrency, fieldArray } from '../../docintel/client.js';

interface InvoiceLineItem {
  description?: string;
  quantity?: string;
  unitPrice?: string;
  amount?: string;
}

interface InvoiceData {
  vendorName?: string;
  invoiceId?: string;
  invoiceDate?: string;
  dueDate?: string;
  invoiceTotal?: string;
  subTotal?: string;
  totalTax?: string;
  currency?: string;
  items: InvoiceLineItem[];
  _raw_status: string;
  _error?: string;
}

export function registerDocintelAnalyzeInvoice(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(server, {
    name: 'docintel_analyze_invoice',
    category: 'read',
    annotations: {
      title: 'Analyze invoice with Azure Document Intelligence',
      description:
        'Extracts structured fields from a finance invoice (vendor, dates, totals, line items) ' +
        'using Azure Document Intelligence prebuilt-invoice model. ' +
        'For CFO agent / Xero feed use only. PHI and MedReview documents are PROHIBITED — ' +
        'this gateway has no BAA. Supply either urlSource or base64Source.',
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
        .describe('Publicly reachable URL of the invoice document (PDF or image). Mutually exclusive with base64Source.'),
      base64Source: z
        .string()
        .optional()
        .describe('Base64-encoded invoice document content. Mutually exclusive with urlSource.'),
    },
    outputShape: {
      invoice: z.object({
        vendorName: z.string().optional(),
        invoiceId: z.string().optional(),
        invoiceDate: z.string().optional(),
        dueDate: z.string().optional(),
        invoiceTotal: z.string().optional(),
        subTotal: z.string().optional(),
        totalTax: z.string().optional(),
        currency: z.string().optional(),
        items: z.array(
          z.object({
            description: z.string().optional(),
            quantity: z.string().optional(),
            unitPrice: z.string().optional(),
            amount: z.string().optional(),
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

      const outcome = await analyzeDocument('prebuilt-invoice', {
        urlSource: input.urlSource,
        base64Source: input.base64Source,
      });

      if (outcome.status !== 'succeeded') {
        const invoice: InvoiceData = {
          items: [],
          _raw_status: outcome.status,
          _error: (outcome as any).error,
        };
        return {
          data: { invoice },
          summary: `Invoice analysis did not succeed: ${outcome.status}${(outcome as any).error ? ' — ' + (outcome as any).error : ''}.`,
        };
      }

      // Extract fields from the first document
      const docs: any[] = (outcome.analyzeResult as any)?.documents ?? [];
      const fields: Record<string, any> = docs[0]?.fields ?? {};

      // Line items
      const rawItems = fieldArray(fields, 'Items');
      const items: InvoiceLineItem[] = rawItems.map((item: any) => {
        const f: Record<string, any> = item.valueObject ?? {};
        return {
          description: fieldValue(f, 'Description'),
          quantity: fieldValue(f, 'Quantity'),
          unitPrice: fieldValue(f, 'UnitPrice'),
          amount: fieldValue(f, 'Amount'),
        };
      });

      const vendorName = fieldValue(fields, 'VendorName');
      const invoiceTotal = fieldValue(fields, 'InvoiceTotal');
      const currency =
        fieldCurrency(fields, 'InvoiceTotal') ??
        fieldCurrency(fields, 'SubTotal') ??
        fieldCurrency(fields, 'TotalTax');

      const invoice: InvoiceData = {
        vendorName,
        invoiceId: fieldValue(fields, 'InvoiceId'),
        invoiceDate: fieldValue(fields, 'InvoiceDate'),
        dueDate: fieldValue(fields, 'DueDate'),
        invoiceTotal,
        subTotal: fieldValue(fields, 'SubTotal'),
        totalTax: fieldValue(fields, 'TotalTax'),
        currency,
        items,
        _raw_status: 'succeeded',
      };

      const vendor = vendorName ?? 'Unknown vendor';
      const total = invoiceTotal ? `${invoiceTotal}${currency ? ' ' + currency : ''}` : 'unknown total';
      const summary = `Invoice from ${vendor}: ${total}${items.length ? ` (${items.length} line item${items.length !== 1 ? 's' : ''})` : ''}.`;

      return { data: { invoice }, summary };
    },
  }, callerHash);
}
