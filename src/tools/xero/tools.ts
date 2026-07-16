/**
 * xero_* tools — READ-ONLY accounting reads for the executive ring (see client.ts header for the
 * ring + token-rotation design). Six tools, all category 'read', all EXEC_RING-gated in-handler:
 *
 *   xero_orgs               org registry + connection status (never token values)
 *   xero_report             TrialBalance | BalanceSheet | ProfitAndLoss | AgedPayablesByContact |
 *                           AgedReceivablesByContact
 *   xero_accounts           full chart of accounts
 *   xero_manual_journals    list (paged) or one by id
 *   xero_bank_transactions  list (paged)
 *   xero_invoices           list (paged, filterable)
 *
 * The audit read-surface was specced by the CFO seat (dispatch 2026-07-16): trial balance as-at
 * any date, full COA, manual journals, bank transactions, invoices, aged payables/receivables,
 * across all four orgs, read-only, rate-governed. Financial WRITES stay Matt-gated: no write tool
 * exists here by design.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import {
  XERO_ORGS,
  type XeroOrg,
  isXeroAllowed,
  ringRefusal,
  xeroConfigured,
  configuredOrgs,
  getOrgAccess,
  xeroGet,
} from './client.js';

const ORG_ENUM = z.enum(XERO_ORGS).describe('Which org: otchealth | innd | hearingassist | personal.');

const REPORTS = ['TrialBalance', 'BalanceSheet', 'ProfitAndLoss', 'AgedPayablesByContact', 'AgedReceivablesByContact'] as const;

function unconfigured(tool: string) {
  return {
    data: { error: 'unconfigured' },
    summary: `${tool}: Xero is not configured on this gateway (XERO_CLIENT_ID/SECRET + XERO_RT_<ORG> secrets + Cosmos required).`,
  };
}

export function registerXeroTools(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(
    server,
    {
      name: 'xero_orgs',
      category: 'read',
      annotations: {
        title: 'Xero: list orgs + connection status (executive ring only)',
        description:
          'Lists the configured Xero orgs (otchealth, innd, hearingassist, personal) and each connection status (live/dead/unbootstrapped + tenant name). MNPI-adjacent metadata: executive-ring lanes only. Never returns token material. Read-only.',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputShape: {
        probe: z
          .boolean()
          .optional()
          .describe('true = live-probe each configured org (refreshing tokens as needed). false/omitted = config-only view, no network.'),
      },
      outputShape: {
        orgs: z.array(z.unknown()),
        error: z.string().optional(),
      },
      handler: async (input, ctx) => {
        if (!isXeroAllowed(ctx.callerAgent)) return ringRefusal('xero_orgs', ctx.callerAgent);
        if (!xeroConfigured()) return unconfigured('xero_orgs');
        const configured = new Set(configuredOrgs());
        const orgs: Record<string, unknown>[] = [];
        for (const org of XERO_ORGS) {
          if (!configured.has(org)) {
            orgs.push({ org, configured: false, status: 'unbootstrapped' });
            continue;
          }
          if (!input.probe) {
            orgs.push({ org, configured: true, status: 'configured (unprobed)' });
            continue;
          }
          try {
            const a = await getOrgAccess(org);
            orgs.push({ org, configured: true, status: 'live', tenantName: a.tenantName });
          } catch (e) {
            orgs.push({ org, configured: true, status: 'dead', detail: (e as Error).message });
          }
        }
        const live = orgs.filter((o) => o.status === 'live').length;
        return {
          data: { orgs },
          summary: input.probe
            ? `Xero orgs probed: ${live}/${configured.size} live (${orgs.map((o) => `${o.org}=${o.status}`).join(', ')}).`
            : `Xero orgs configured: ${[...configured].join(', ') || '(none)'}. Pass probe:true for a live check.`,
        };
      },
    },
    callerHash,
  );

  registerTool(
    server,
    {
      name: 'xero_report',
      category: 'read',
      annotations: {
        title: 'Xero: run a financial report (executive ring only)',
        description:
          'Runs a Xero report for an org: TrialBalance (as-at date), BalanceSheet (date/periods/timeframe), ProfitAndLoss (fromDate/toDate or periods/timeframe), AgedPayablesByContact / AgedReceivablesByContact (require contactId). MNPI: executive-ring lanes only. Read-only.',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputShape: {
        org: ORG_ENUM,
        report: z.enum(REPORTS).describe('Which report to run.'),
        date: z.string().optional().describe('As-at date YYYY-MM-DD (TrialBalance, BalanceSheet, Aged*).'),
        fromDate: z.string().optional().describe('Period start YYYY-MM-DD (ProfitAndLoss).'),
        toDate: z.string().optional().describe('Period end YYYY-MM-DD (ProfitAndLoss).'),
        periods: z.number().int().min(1).max(12).optional().describe('Number of comparison periods.'),
        timeframe: z.enum(['MONTH', 'QUARTER', 'YEAR']).optional().describe('Comparison period size.'),
        contactId: z.string().optional().describe('Contact GUID — REQUIRED for the Aged* reports.'),
        paymentsOnly: z.boolean().optional().describe('Cash basis (TrialBalance/P&L).'),
      },
      outputShape: {
        org: z.string(),
        report: z.string(),
        body: z.unknown(),
        day_limit_remaining: z.string().nullable().optional(),
        error: z.string().optional(),
      },
      handler: async (input, ctx) => {
        if (!isXeroAllowed(ctx.callerAgent)) return ringRefusal('xero_report', ctx.callerAgent);
        if (!xeroConfigured()) return unconfigured('xero_report');
        const org = input.org as XeroOrg;
        if (/^Aged/.test(input.report) && !input.contactId) {
          return {
            data: { org, report: input.report, body: null, error: 'contactId_required' },
            summary: `${input.report} requires contactId (Xero aged reports are per-contact).`,
          };
        }
        const res = await xeroGet(org, `/Reports/${input.report}`, {
          date: input.date,
          fromDate: input.fromDate,
          toDate: input.toDate,
          periods: input.periods !== undefined ? String(input.periods) : undefined,
          timeframe: input.timeframe,
          contactID: input.contactId,
          paymentsOnly: input.paymentsOnly !== undefined ? String(input.paymentsOnly) : undefined,
        });
        return {
          data: { org, report: input.report, body: res.body, day_limit_remaining: res.dayLimitRemaining },
          summary: `Xero ${input.report} for ${org} retrieved.${res.dayLimitRemaining ? ` Day-limit remaining: ${res.dayLimitRemaining}.` : ''}`,
        };
      },
    },
    callerHash,
  );

  registerTool(
    server,
    {
      name: 'xero_accounts',
      category: 'read',
      annotations: {
        title: 'Xero: chart of accounts (executive ring only)',
        description: 'Full chart of accounts for an org (codes, names, types, classes). MNPI: executive-ring lanes only. Read-only.',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputShape: {
        org: ORG_ENUM,
        where: z.string().optional().describe('Optional Xero where filter, e.g. Type=="BANK".'),
      },
      outputShape: { org: z.string(), body: z.unknown(), error: z.string().optional() },
      handler: async (input, ctx) => {
        if (!isXeroAllowed(ctx.callerAgent)) return ringRefusal('xero_accounts', ctx.callerAgent);
        if (!xeroConfigured()) return unconfigured('xero_accounts');
        const res = await xeroGet(input.org as XeroOrg, '/Accounts', { where: input.where });
        const count = Array.isArray((res.body as { Accounts?: unknown[] })?.Accounts)
          ? (res.body as { Accounts: unknown[] }).Accounts.length
          : undefined;
        return {
          data: { org: input.org, body: res.body },
          summary: `Xero chart of accounts for ${input.org}${count !== undefined ? `: ${count} account(s)` : ''}.`,
        };
      },
    },
    callerHash,
  );

  registerTool(
    server,
    {
      name: 'xero_manual_journals',
      category: 'read',
      annotations: {
        title: 'Xero: manual journals (executive ring only)',
        description: 'Manual journals for an org — paged list, or one journal by id (with lines). MNPI: executive-ring lanes only. Read-only.',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputShape: {
        org: ORG_ENUM,
        id: z.string().optional().describe('ManualJournal GUID for a single-journal fetch (includes lines).'),
        page: z.number().int().min(1).optional().describe('Page number (100/page). Default 1.'),
        modifiedAfter: z.string().optional().describe('ISO timestamp — only journals modified after this.'),
      },
      outputShape: { org: z.string(), body: z.unknown(), error: z.string().optional() },
      handler: async (input, ctx) => {
        if (!isXeroAllowed(ctx.callerAgent)) return ringRefusal('xero_manual_journals', ctx.callerAgent);
        if (!xeroConfigured()) return unconfigured('xero_manual_journals');
        const path = input.id ? `/ManualJournals/${encodeURIComponent(input.id)}` : '/ManualJournals';
        const res = await xeroGet(
          input.org as XeroOrg,
          path,
          input.id ? {} : { page: String(input.page ?? 1) },
          { modifiedAfter: input.modifiedAfter },
        );
        return {
          data: { org: input.org, body: res.body },
          summary: input.id
            ? `Xero manual journal ${input.id} (${input.org}) retrieved.`
            : `Xero manual journals for ${input.org}, page ${input.page ?? 1}.`,
        };
      },
    },
    callerHash,
  );

  registerTool(
    server,
    {
      name: 'xero_bank_transactions',
      category: 'read',
      annotations: {
        title: 'Xero: bank transactions (executive ring only)',
        description: 'Bank transactions for an org — paged list, optional where filter (e.g. by bank account). MNPI: executive-ring lanes only. Read-only.',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputShape: {
        org: ORG_ENUM,
        page: z.number().int().min(1).optional().describe('Page number (100/page). Default 1.'),
        where: z.string().optional().describe('Optional Xero where filter, e.g. BankAccount.AccountID==GUID("...").'),
        modifiedAfter: z.string().optional().describe('ISO timestamp — only transactions modified after this.'),
      },
      outputShape: { org: z.string(), body: z.unknown(), error: z.string().optional() },
      handler: async (input, ctx) => {
        if (!isXeroAllowed(ctx.callerAgent)) return ringRefusal('xero_bank_transactions', ctx.callerAgent);
        if (!xeroConfigured()) return unconfigured('xero_bank_transactions');
        const res = await xeroGet(
          input.org as XeroOrg,
          '/BankTransactions',
          { page: String(input.page ?? 1), where: input.where },
          { modifiedAfter: input.modifiedAfter },
        );
        return {
          data: { org: input.org, body: res.body },
          summary: `Xero bank transactions for ${input.org}, page ${input.page ?? 1}.`,
        };
      },
    },
    callerHash,
  );

  registerTool(
    server,
    {
      name: 'xero_invoices',
      category: 'read',
      annotations: {
        title: 'Xero: invoices (executive ring only)',
        description: 'Invoices (AR + AP) for an org — paged list, filterable by status/number. MNPI: executive-ring lanes only. Read-only.',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputShape: {
        org: ORG_ENUM,
        page: z.number().int().min(1).optional().describe('Page number (100/page). Default 1.'),
        statuses: z.string().optional().describe('CSV of statuses, e.g. AUTHORISED,PAID.'),
        invoiceNumber: z.string().optional().describe('Exact invoice number lookup.'),
        modifiedAfter: z.string().optional().describe('ISO timestamp — only invoices modified after this.'),
      },
      outputShape: { org: z.string(), body: z.unknown(), error: z.string().optional() },
      handler: async (input, ctx) => {
        if (!isXeroAllowed(ctx.callerAgent)) return ringRefusal('xero_invoices', ctx.callerAgent);
        if (!xeroConfigured()) return unconfigured('xero_invoices');
        const res = await xeroGet(
          input.org as XeroOrg,
          '/Invoices',
          {
            page: String(input.page ?? 1),
            Statuses: input.statuses,
            InvoiceNumbers: input.invoiceNumber,
          },
          { modifiedAfter: input.modifiedAfter },
        );
        return {
          data: { org: input.org, body: res.body },
          summary: `Xero invoices for ${input.org}, page ${input.page ?? 1}${input.statuses ? ` (statuses: ${input.statuses})` : ''}.`,
        };
      },
    },
    callerHash,
  );
}
