/**
 * xero_* tools — full READ + WRITE for the executive ring (see client.ts header for the ring +
 * token-rotation design). 20 tools, all EXEC_RING-gated in-handler. They cover the FULL consented
 * OAuth scope surface (accounting + all reports + payroll + files + assets + projects), across all
 * four orgs, rate-governed. The CFO seat is authorized for full read+write on the books (Matt
 * directive 2026-07-16); Xero writes are bookkeeping (they post to the ledger, they do NOT move real
 * money — bank execution is separate). xero_request is the write tool (POST/PUT/DELETE, dry-run-first).
 *
 * Universal backstops:
 *   xero_get                READ  — ANY endpoint on ANY scoped API (api: accounting|payroll|assets|projects|files)
 *   xero_request            WRITE — POST/PUT/DELETE ANY scoped endpoint (dry_run defaults true)
 * Accounting (api.xro/2.0):
 *   xero_orgs               org registry + connection status (never token values)
 *   xero_report             TrialBalance | BalanceSheet | ProfitAndLoss | Aged{Payables,Receivables}ByContact |
 *                           BankSummary | BudgetSummary | ExecutiveSummary | TenNinetyNine (1099)
 *   xero_accounts           full chart of accounts
 *   xero_contacts           contacts (customers + suppliers), paged/filterable
 *   xero_invoices           invoices (AR + AP), paged/filterable
 *   xero_credit_notes       credit notes (AR + AP)
 *   xero_payments           payments (cash applied)
 *   xero_bank_transactions  bank transactions, paged
 *   xero_bank_transfers     transfers between own bank accounts
 *   xero_manual_journals    manual journals (list or one by id)
 *   xero_budgets            budgets (list or one by id)
 *   xero_settings           Organisation | TaxRates | TrackingCategories | Currencies | Users |
 *                           BrandingThemes | ContactGroups | Items
 *   xero_attachments        source-doc attachments on a record (list/read only — see xero_attachment_upload for writes)
 *   xero_attachment_upload  upload a source-doc attachment (dry-run-first) — see client.ts xeroUploadAttachment
 * Other product APIs:
 *   xero_payroll            Employees | PayRuns | PayItems | PayrollCalendars | Timesheets | Settings (payroll.xro/1.0)
 *   xero_assets             Assets | AssetTypes | Settings (assets.xro/1.0)
 *   xero_projects           Projects | Tasks | Time (projects.xro/2.0)
 *   xero_files              Files | Folders | Associations (files.xro/1.0)
 *
 * The four paged accounting reads (contacts/payments/credit_notes/bank_transfers) register via the
 * shared registerPagedAccountingRead helper (one gated call-site each stays EXEC_RING-checked).
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import {
  XERO_ORGS,
  XERO_API_BASES,
  type XeroApi,
  type XeroOrg,
  isXeroAllowed,
  ringRefusal,
  xeroConfigured,
  configuredOrgs,
  getOrgAccess,
  xeroGet,
  xeroRequest,
  xeroUploadAttachment,
} from './client.js';

const ORG_ENUM = z.enum(XERO_ORGS).describe('Which org: otchealth | innd | hearingassist | personal.');

const REPORTS = [
  'TrialBalance',
  'BalanceSheet',
  'ProfitAndLoss',
  'AgedPayablesByContact',
  'AgedReceivablesByContact',
  'BankSummary',
  'BudgetSummary',
  'ExecutiveSummary',
  'TenNinetyNine',
] as const;
const API_ENUM = Object.keys(XERO_API_BASES) as [XeroApi, ...XeroApi[]];
const ATTACHMENT_ENDPOINT_ENUM = [
  'Invoices',
  'CreditNotes',
  'BankTransactions',
  'BankTransfers',
  'Payments',
  'ManualJournals',
  'Receipts',
  'Contacts',
  'PurchaseOrders',
] as const;

function unconfigured(tool: string) {
  return {
    data: { error: 'unconfigured' },
    summary: `${tool}: Xero is not configured on this gateway (XERO_CLIENT_ID/SECRET + XERO_RT_<ORG> secrets + Cosmos required).`,
  };
}

/**
 * Compact registrar for the straightforward accounting "paged list, optional where filter" reads
 * (Contacts, Payments, CreditNotes, BankTransfers). All EXEC_RING-gated, read-only. countKey names
 * the response array to size in the summary.
 */
function registerPagedAccountingRead(
  server: McpServer,
  callerHash: CallerHashProvider,
  cfg: { name: string; title: string; description: string; path: string; countKey?: string; whereHint?: string },
): void {
  registerTool(
    server,
    {
      name: cfg.name,
      category: 'read',
      annotations: {
        title: cfg.title,
        description: cfg.description,
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputShape: {
        org: ORG_ENUM,
        page: z.number().int().min(1).optional().describe('Page number (100/page). Default 1.'),
        where: z.string().optional().describe(cfg.whereHint ?? 'Optional Xero where filter.'),
        modifiedAfter: z.string().optional().describe('ISO timestamp — only records modified after this (If-Modified-Since).'),
      },
      outputShape: { org: z.string(), body: z.unknown(), error: z.string().optional() },
      handler: async (input, ctx) => {
        if (!isXeroAllowed(ctx.callerAgent)) return ringRefusal(cfg.name, ctx.callerAgent);
        if (!xeroConfigured()) return unconfigured(cfg.name);
        const res = await xeroGet(
          input.org as XeroOrg,
          cfg.path,
          { page: String(input.page ?? 1), where: input.where },
          { modifiedAfter: input.modifiedAfter },
        );
        const arr = cfg.countKey ? (res.body as Record<string, unknown>)?.[cfg.countKey] : undefined;
        const count = Array.isArray(arr) ? arr.length : undefined;
        return {
          data: { org: input.org, body: res.body },
          summary: `Xero ${cfg.path.replace('/', '')} for ${input.org}, page ${input.page ?? 1}${count !== undefined ? ` (${count})` : ''}.`,
        };
      },
    },
    callerHash,
  );
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
          'Runs a Xero report for an org: TrialBalance (as-at date), BalanceSheet (date/periods/timeframe), ProfitAndLoss (fromDate/toDate or periods/timeframe), AgedPayablesByContact / AgedReceivablesByContact (require contactId), BankSummary (fromDate/toDate), BudgetSummary (date/periods/timeframe), ExecutiveSummary (date), TenNinetyNine (reportYear, the US 1099 report). MNPI: executive-ring lanes only. Read-only.',
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
        reportYear: z.string().optional().describe('4-digit year — REQUIRED for TenNinetyNine (the 1099 report), e.g. "2021".'),
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
        if (input.report === 'TenNinetyNine' && !input.reportYear) {
          return {
            data: { org, report: input.report, body: null, error: 'reportYear_required' },
            summary: 'TenNinetyNine (1099) requires reportYear, e.g. "2021".',
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
          reportYear: input.reportYear,
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

  // --- Universal read: ANY endpoint on ANY scoped Xero API (full-scope coverage backstop) ---
  registerTool(
    server,
    {
      name: 'xero_get',
      category: 'read',
      annotations: {
        title: 'Xero: universal read — any scoped endpoint (executive ring only)',
        description:
          'GET any read endpoint on any Xero API the tokens are scoped for. api = accounting (default) | payroll | assets | projects | files. path starts with "/" and is the endpoint after the base, e.g. "/Contacts", "/Reports/BankSummary", "/Payments" (accounting); "/Employees", "/PayRuns" (payroll); "/Assets" (assets); "/Projects" (projects); "/Files" (files). params is a query-string map (page, where, dates, statuses, ...). Read-only: GET only, so no path can mutate the books. MNPI: executive-ring lanes only.',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputShape: {
        org: ORG_ENUM,
        path: z.string().describe('Endpoint path starting with "/", e.g. /Contacts or /Reports/BankSummary.'),
        api: z.enum(API_ENUM).optional().describe('Which Xero API base. Default accounting.'),
        params: z.record(z.string()).optional().describe('Query params as a string map, e.g. {"page":"1"}.'),
        modifiedAfter: z.string().optional().describe('ISO timestamp -> If-Modified-Since.'),
      },
      outputShape: {
        org: z.string(),
        api: z.string(),
        path: z.string(),
        body: z.unknown(),
        day_limit_remaining: z.string().nullable().optional(),
        error: z.string().optional(),
      },
      handler: async (input, ctx) => {
        if (!isXeroAllowed(ctx.callerAgent)) return ringRefusal('xero_get', ctx.callerAgent);
        if (!xeroConfigured()) return unconfigured('xero_get');
        const path = input.path.startsWith('/') ? input.path : `/${input.path}`;
        const api = (input.api ?? 'accounting') as XeroApi;
        if (path.includes('..')) {
          return {
            data: { org: input.org, api, path, body: null, error: 'bad_path' },
            summary: 'xero_get: path must not contain "..".',
          };
        }
        const res = await xeroGet(
          input.org as XeroOrg,
          path,
          (input.params ?? {}) as Record<string, string | undefined>,
          { modifiedAfter: input.modifiedAfter, api },
        );
        return {
          data: { org: input.org, api, path, body: res.body, day_limit_remaining: res.dayLimitRemaining },
          summary: `Xero ${api} GET ${path} for ${input.org}.${res.dayLimitRemaining ? ` Day-limit remaining: ${res.dayLimitRemaining}.` : ''}`,
        };
      },
    },
    callerHash,
  );

  // --- Typed accounting reads (paged list + optional where) ---
  registerPagedAccountingRead(server, callerHash, {
    name: 'xero_contacts',
    title: 'Xero: contacts (executive ring only)',
    description:
      'Contacts (customers + suppliers) for an org — paged, filterable. Use to resolve the contactId the Aged* reports require. MNPI: executive-ring lanes only. Read-only.',
    path: '/Contacts',
    countKey: 'Contacts',
    whereHint: 'Optional Xero where filter, e.g. Name.Contains("Acme") or IsSupplier==true.',
  });
  registerPagedAccountingRead(server, callerHash, {
    name: 'xero_payments',
    title: 'Xero: payments (executive ring only)',
    description:
      'Payments (cash received + spent, applied to invoices/bills) for an org — paged, filterable. MNPI: executive-ring lanes only. Read-only.',
    path: '/Payments',
    countKey: 'Payments',
    whereHint: 'Optional Xero where filter, e.g. Status=="AUTHORISED".',
  });
  registerPagedAccountingRead(server, callerHash, {
    name: 'xero_credit_notes',
    title: 'Xero: credit notes (executive ring only)',
    description: 'Credit notes (AR + AP) for an org — paged, filterable. MNPI: executive-ring lanes only. Read-only.',
    path: '/CreditNotes',
    countKey: 'CreditNotes',
  });
  registerPagedAccountingRead(server, callerHash, {
    name: 'xero_bank_transfers',
    title: 'Xero: bank transfers (executive ring only)',
    description: "Bank transfers (money moved between the org's own bank accounts) — paged. MNPI: executive-ring lanes only. Read-only.",
    path: '/BankTransfers',
    countKey: 'BankTransfers',
  });

  // --- Budgets ---
  registerTool(
    server,
    {
      name: 'xero_budgets',
      category: 'read',
      annotations: {
        title: 'Xero: budgets (executive ring only)',
        description:
          'Budgets for an org — list, or one budget by id (with the period breakdown). Pair with the BudgetSummary report for budget-vs-actual. MNPI: executive-ring lanes only. Read-only.',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputShape: {
        org: ORG_ENUM,
        budgetId: z.string().optional().describe('Budget GUID for a single budget (includes period lines).'),
      },
      outputShape: { org: z.string(), body: z.unknown(), error: z.string().optional() },
      handler: async (input, ctx) => {
        if (!isXeroAllowed(ctx.callerAgent)) return ringRefusal('xero_budgets', ctx.callerAgent);
        if (!xeroConfigured()) return unconfigured('xero_budgets');
        const path = input.budgetId ? `/Budgets/${encodeURIComponent(input.budgetId)}` : '/Budgets';
        const res = await xeroGet(input.org as XeroOrg, path, {});
        return {
          data: { org: input.org, body: res.body },
          summary: input.budgetId ? `Xero budget ${input.budgetId} (${input.org}).` : `Xero budgets for ${input.org}.`,
        };
      },
    },
    callerHash,
  );

  // --- Settings (organisation, tax rates, tracking, currencies, users, items, ...) ---
  registerTool(
    server,
    {
      name: 'xero_settings',
      category: 'read',
      annotations: {
        title: 'Xero: org settings (executive ring only)',
        description:
          'Read an accounting settings resource for an org: Organisation (details, base currency, financial year end), TaxRates, TrackingCategories, Currencies, Users, BrandingThemes, ContactGroups, Items. MNPI: executive-ring lanes only. Read-only.',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputShape: {
        org: ORG_ENUM,
        resource: z
          .enum(['Organisation', 'TaxRates', 'TrackingCategories', 'Currencies', 'Users', 'BrandingThemes', 'ContactGroups', 'Items'])
          .describe('Which settings resource to read.'),
      },
      outputShape: { org: z.string(), resource: z.string(), body: z.unknown(), error: z.string().optional() },
      handler: async (input, ctx) => {
        if (!isXeroAllowed(ctx.callerAgent)) return ringRefusal('xero_settings', ctx.callerAgent);
        if (!xeroConfigured()) return unconfigured('xero_settings');
        const res = await xeroGet(input.org as XeroOrg, `/${input.resource}`, {});
        return { data: { org: input.org, resource: input.resource, body: res.body }, summary: `Xero ${input.resource} for ${input.org}.` };
      },
    },
    callerHash,
  );

  // --- Attachments (source docs on a record) ---
  registerTool(
    server,
    {
      name: 'xero_attachments',
      category: 'read',
      annotations: {
        title: 'Xero: list attachments on a record (executive ring only)',
        description:
          'List the attachments (source docs) on a specific accounting record, e.g. endpoint="Invoices", guid=<InvoiceID>. Returns attachment metadata (filename, mime type, url). Use this to independently VERIFY an xero_attachment_upload actually persisted — its own response is not sufficient proof. MNPI: executive-ring lanes only. Read-only.',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputShape: {
        org: ORG_ENUM,
        endpoint: z
          .enum(['Invoices', 'CreditNotes', 'BankTransactions', 'BankTransfers', 'Payments', 'ManualJournals', 'Receipts', 'Contacts', 'PurchaseOrders'])
          .describe('Which record type the attachment hangs off.'),
        guid: z.string().describe('The record GUID.'),
      },
      outputShape: { org: z.string(), body: z.unknown(), error: z.string().optional() },
      handler: async (input, ctx) => {
        if (!isXeroAllowed(ctx.callerAgent)) return ringRefusal('xero_attachments', ctx.callerAgent);
        if (!xeroConfigured()) return unconfigured('xero_attachments');
        const res = await xeroGet(input.org as XeroOrg, `/${input.endpoint}/${encodeURIComponent(input.guid)}/Attachments`, {});
        return { data: { org: input.org, body: res.body }, summary: `Xero attachments on ${input.endpoint}/${input.guid} (${input.org}).` };
      },
    },
    callerHash,
  );

  // --- Attachment WRITE (fixes FND-20260724-f6df: the universal xero_request write tool always
  // sends JSON, but Xero's Attachments API requires raw file bytes + the file's real Content-Type.
  // This dedicated tool calls xeroUploadAttachment(), which sends the request correctly. ---
  registerTool(
    server,
    {
      name: 'xero_attachment_upload',
      category: 'write_simple',
      annotations: {
        title: 'Xero: upload a source-document attachment (executive ring only)',
        description:
          'Upload a source document (contract, statement, work paper) as an attachment on a Xero accounting record: endpoint="ManualJournals", guid=<JournalID>, fileName="executed-spa.pdf", contentBase64=<base64-encoded file bytes>, mimeType="application/pdf". ' +
          'This is NOT the same as xero_request — Xero\\'s attachment API requires the raw file bytes with the correct Content-Type header, which this tool sends correctly (xero_request always sends JSON and cannot upload a real file). ' +
          '10MB cap on this gateway (Xero\\'s own limit is 25MB); for larger files, host externally and attach a link instead. ' +
          'dry_run defaults TRUE and only validates + previews (decodes and size-checks the payload without calling Xero); pass dry_run:false to actually upload. ' +
          'IMPORTANT: a 200 response from this tool is NOT sufficient proof the attachment persisted — always follow up with xero_attachments on the same endpoint/guid to independently confirm the file actually appears before reporting success.',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputShape: {
        org: ORG_ENUM,
        endpoint: z.enum(ATTACHMENT_ENDPOINT_ENUM).describe('Which record type the attachment hangs off.'),
        guid: z.string().describe('The record GUID to attach the document to.'),
        fileName: z.string().min(1).describe('File name including extension, e.g. "executed-spa.pdf".'),
        contentBase64: z.string().min(1).describe('The file content, base64-encoded.'),
        mimeType: z.string().min(1).describe('The file\'s actual MIME type, e.g. "application/pdf", "image/png".'),
      },
      outputShape: {
        org: z.string(),
        endpoint: z.string(),
        guid: z.string(),
        fileName: z.string(),
        bytes: z.number().optional(),
        body: z.unknown(),
        error: z.string().optional(),
      },
      handler: async (input, ctx) => {
        if (!isXeroAllowed(ctx.callerAgent)) return ringRefusal('xero_attachment_upload', ctx.callerAgent);
        if (!xeroConfigured()) return unconfigured('xero_attachment_upload');

        let buf: Buffer;
        try {
          buf = Buffer.from(input.contentBase64, 'base64');
        } catch {
          return {
            data: { org: input.org, endpoint: input.endpoint, guid: input.guid, fileName: input.fileName, body: null, error: 'bad_base64' },
            summary: 'xero_attachment_upload: contentBase64 did not decode as valid base64.',
          };
        }
        if (buf.length === 0) {
          return {
            data: { org: input.org, endpoint: input.endpoint, guid: input.guid, fileName: input.fileName, body: null, error: 'empty_content' },
            summary: 'xero_attachment_upload: decoded content is empty.',
          };
        }

        if (ctx.dryRun) {
          return {
            data: {
              org: input.org,
              endpoint: input.endpoint,
              guid: input.guid,
              fileName: input.fileName,
              bytes: buf.length,
              body: null,
              error: 'dry_run',
            },
            summary: `DRY RUN (nothing uploaded): would PUT ${buf.length} bytes as "${input.fileName}" (${input.mimeType}) to ${input.endpoint}/${input.guid} for ${input.org}. Re-call with dry_run:false to execute, then verify with xero_attachments.`,
          };
        }

        const res = await xeroUploadAttachment(
          input.org as XeroOrg,
          input.endpoint,
          input.guid,
          input.fileName,
          buf,
          input.mimeType,
        );
        return {
          data: { org: input.org, endpoint: input.endpoint, guid: input.guid, fileName: input.fileName, bytes: buf.length, body: res.body },
          summary:
            `Xero attachment upload "${input.fileName}" (${buf.length} bytes) to ${input.endpoint}/${input.guid} for ${input.org} — HTTP ${res.status}. ` +
            `NOT independently verified yet — call xero_attachments(org:"${input.org}", endpoint:"${input.endpoint}", guid:"${input.guid}") before reporting this as successful.`,
        };
      },
    },
    callerHash,
  );

  // --- Payroll API (US: payroll.xro/1.0) ---
  registerTool(
    server,
    {
      name: 'xero_payroll',
      category: 'read',
      annotations: {
        title: 'Xero: payroll read (executive ring only)',
        description:
          'Read a US Payroll resource for an org: Employees, PayRuns, PayItems, PayrollCalendars, Timesheets, Settings. Optionally one by id. For any payroll endpoint not listed, use xero_get with api="payroll". MNPI: executive-ring lanes only. Read-only.',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputShape: {
        org: ORG_ENUM,
        resource: z.enum(['Employees', 'PayRuns', 'PayItems', 'PayrollCalendars', 'Timesheets', 'Settings']).describe('Which payroll resource.'),
        id: z.string().optional().describe('Resource GUID for a single-record fetch.'),
        page: z.number().int().min(1).optional().describe('Page number where the endpoint pages.'),
      },
      outputShape: { org: z.string(), body: z.unknown(), error: z.string().optional() },
      handler: async (input, ctx) => {
        if (!isXeroAllowed(ctx.callerAgent)) return ringRefusal('xero_payroll', ctx.callerAgent);
        if (!xeroConfigured()) return unconfigured('xero_payroll');
        const path = input.id ? `/${input.resource}/${encodeURIComponent(input.id)}` : `/${input.resource}`;
        const res = await xeroGet(
          input.org as XeroOrg,
          path,
          input.id ? {} : { page: input.page !== undefined ? String(input.page) : undefined },
          { api: 'payroll' },
        );
        return { data: { org: input.org, body: res.body }, summary: `Xero payroll ${input.resource}${input.id ? ` ${input.id}` : ''} for ${input.org}.` };
      },
    },
    callerHash,
  );

  // --- Assets API (fixed-asset register: assets.xro/1.0) ---
  registerTool(
    server,
    {
      name: 'xero_assets',
      category: 'read',
      annotations: {
        title: 'Xero: fixed assets (executive ring only)',
        description: 'Read the fixed-asset register for an org: Assets (by status), AssetTypes, or Settings. MNPI: executive-ring lanes only. Read-only.',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputShape: {
        org: ORG_ENUM,
        resource: z.enum(['Assets', 'AssetTypes', 'Settings']).describe('Which assets resource.'),
        status: z.enum(['DRAFT', 'REGISTERED', 'DISPOSED']).optional().describe('Asset status (Assets list; the Xero Assets API requires it — default REGISTERED).'),
        page: z.number().int().min(1).optional().describe('Page number (Assets list).'),
      },
      outputShape: { org: z.string(), body: z.unknown(), error: z.string().optional() },
      handler: async (input, ctx) => {
        if (!isXeroAllowed(ctx.callerAgent)) return ringRefusal('xero_assets', ctx.callerAgent);
        if (!xeroConfigured()) return unconfigured('xero_assets');
        const params: Record<string, string | undefined> = {};
        if (input.resource === 'Assets') {
          params.status = input.status ?? 'REGISTERED';
          if (input.page !== undefined) params.page = String(input.page);
        }
        const res = await xeroGet(input.org as XeroOrg, `/${input.resource}`, params, { api: 'assets' });
        return {
          data: { org: input.org, body: res.body },
          summary: `Xero assets ${input.resource} for ${input.org}${input.resource === 'Assets' ? ` (status ${input.status ?? 'REGISTERED'})` : ''}.`,
        };
      },
    },
    callerHash,
  );

  // --- Projects API (projects.xro/2.0) ---
  registerTool(
    server,
    {
      name: 'xero_projects',
      category: 'read',
      annotations: {
        title: 'Xero: projects (executive ring only)',
        description:
          "Read the Projects API for an org: Projects (optionally one by id), or a project's Tasks / Time entries (pass projectId). MNPI: executive-ring lanes only. Read-only.",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputShape: {
        org: ORG_ENUM,
        resource: z.enum(['Projects', 'Tasks', 'Time']).describe('Which projects resource. Tasks/Time require projectId.'),
        projectId: z.string().optional().describe('Project GUID (required for Tasks/Time).'),
        page: z.number().int().min(1).optional().describe('Page number.'),
      },
      outputShape: { org: z.string(), body: z.unknown(), error: z.string().optional() },
      handler: async (input, ctx) => {
        if (!isXeroAllowed(ctx.callerAgent)) return ringRefusal('xero_projects', ctx.callerAgent);
        if (!xeroConfigured()) return unconfigured('xero_projects');
        if ((input.resource === 'Tasks' || input.resource === 'Time') && !input.projectId) {
          return { data: { org: input.org, body: null, error: 'projectId_required' }, summary: `${input.resource} requires projectId.` };
        }
        const path = input.resource === 'Projects' ? '/Projects' : `/Projects/${encodeURIComponent(input.projectId as string)}/${input.resource}`;
        const res = await xeroGet(input.org as XeroOrg, path, { page: input.page !== undefined ? String(input.page) : undefined }, { api: 'projects' });
        return { data: { org: input.org, body: res.body }, summary: `Xero projects ${input.resource} for ${input.org}.` };
      },
    },
    callerHash,
  );

  // --- Files API (files.xro/1.0) ---
  registerTool(
    server,
    {
      name: 'xero_files',
      category: 'read',
      annotations: {
        title: 'Xero: files library (executive ring only)',
        description: 'Read the Files API for an org: Files (optionally one by id), Folders, or Associations for a file. MNPI: executive-ring lanes only. Read-only.',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputShape: {
        org: ORG_ENUM,
        resource: z.enum(['Files', 'Folders', 'Associations']).describe('Which files resource. Associations requires id (the FileId).'),
        id: z.string().optional().describe('File/Folder GUID (Associations requires the FileId).'),
        page: z.number().int().min(1).optional().describe('Page number (Files list).'),
      },
      outputShape: { org: z.string(), body: z.unknown(), error: z.string().optional() },
      handler: async (input, ctx) => {
        if (!isXeroAllowed(ctx.callerAgent)) return ringRefusal('xero_files', ctx.callerAgent);
        if (!xeroConfigured()) return unconfigured('xero_files');
        if (input.resource === 'Associations' && !input.id) {
          return { data: { org: input.org, body: null, error: 'id_required' }, summary: 'Associations requires the FileId (id).' };
        }
        let path: string;
        if (input.resource === 'Folders') path = '/Folders';
        else if (input.resource === 'Associations') path = `/Files/${encodeURIComponent(input.id as string)}/Associations`;
        else path = input.id ? `/Files/${encodeURIComponent(input.id)}` : '/Files';
        const res = await xeroGet(
          input.org as XeroOrg,
          path,
          input.resource === 'Files' && !input.id ? { pagesize: '50', page: input.page !== undefined ? String(input.page) : undefined } : {},
          { api: 'files' },
        );
        return { data: { org: input.org, body: res.body }, summary: `Xero files ${input.resource} for ${input.org}.` };
      },
    },
    callerHash,
  );

  // --- Universal WRITE: POST/PUT/DELETE any scoped endpoint (the CFO write lane; Matt-authorized) ---
  registerTool(
    server,
    {
      name: 'xero_request',
      category: 'write_simple',
      annotations: {
        title: 'Xero: write — POST/PUT/DELETE any scoped endpoint (executive ring only)',
        description:
          'Create / update / void on any Xero API the tokens are scoped for (the CFO write lane). method = POST | PUT | DELETE. api = accounting (default) | payroll | assets | projects | files. path starts with "/", e.g. "/Invoices", "/Contacts", "/Payments", "/ManualJournals", "/BankTransactions", "/CreditNotes", "/Accounts". body is the JSON payload — for accounting collections wrap in the plural key, e.g. {"Invoices":[{...}]}. Xero writes are BOOKKEEPING (they post to the ledger, they do NOT move real money). dry_run defaults TRUE and previews without sending; pass dry_run:false to actually write. Do NOT use this for attachment uploads — Xero\\'s Attachments API needs raw file bytes with the file\\'s Content-Type, which this JSON-only tool cannot send; use xero_attachment_upload instead. MNPI: executive-ring lanes only.',
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
      inputShape: {
        org: ORG_ENUM,
        method: z.enum(['POST', 'PUT', 'DELETE']).describe('POST = create/update, PUT = create-if-absent, DELETE where Xero supports it.'),
        path: z.string().describe('Endpoint path starting with "/", e.g. /Invoices or /Contacts.'),
        api: z.enum(API_ENUM).optional().describe('Which Xero API base. Default accounting.'),
        body: z.unknown().optional().describe('JSON payload. For accounting collections wrap in the plural key, e.g. {"Invoices":[{...}]}.'),
        params: z.record(z.string()).optional().describe('Query params as a string map, e.g. {"summarizeErrors":"false"}.'),
      },
      outputShape: {
        org: z.string(),
        method: z.string(),
        api: z.string(),
        path: z.string(),
        body: z.unknown(),
        day_limit_remaining: z.string().nullable().optional(),
        error: z.string().optional(),
      },
      handler: async (input, ctx) => {
        if (!isXeroAllowed(ctx.callerAgent)) return ringRefusal('xero_request', ctx.callerAgent);
        if (!xeroConfigured()) return unconfigured('xero_request');
        const path = input.path.startsWith('/') ? input.path : `/${input.path}`;
        const api = (input.api ?? 'accounting') as XeroApi;
        if (path.includes('..')) {
          return {
            data: { org: input.org, method: input.method, api, path, body: null, error: 'bad_path' },
            summary: 'xero_request: path must not contain "..".',
          };
        }
        if (ctx.dryRun) {
          return {
            data: { org: input.org, method: input.method, api, path, body: null, error: 'dry_run' },
            summary: `DRY RUN (nothing written): ${input.method} ${api} ${path} for ${input.org}. Re-call with dry_run:false to execute.`,
          };
        }
        const res = await xeroRequest(
          input.org as XeroOrg,
          input.method,
          path,
          input.body,
          (input.params ?? {}) as Record<string, string | undefined>,
          { api },
        );
        return {
          data: { org: input.org, method: input.method, api, path, body: res.body, day_limit_remaining: res.dayLimitRemaining },
          summary: `Xero ${input.method} ${api} ${path} for ${input.org} — HTTP ${res.status}.${res.dayLimitRemaining ? ` Day-limit remaining: ${res.dayLimitRemaining}.` : ''}`,
        };
      },
    },
    callerHash,
  );
}
