/**
 * Central tool registration entrypoint. Wires every Phase 1 + Phase 2 tool to
 * the shared McpServer instance. Reads first (always live), then guarded
 * writes (registry.ts enforces gating).
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallerHashProvider } from './registry.js';

// Phase 1 — Customer.io
import { registerListNewsletters } from './cio/list-newsletters.js';
import { registerGetNewsletter } from './cio/get-newsletter.js';
import { registerGetNewsletterMetrics } from './cio/get-newsletter-metrics.js';
import { registerGetNewsletterSchedule } from './cio/get-newsletter-schedule.js';
import { registerGetSegment } from './cio/get-segment.js';
import { registerListSegmentPeople } from './cio/list-segment-people.js';
import { registerGetCustomer } from './cio/get-customer.js';
import { registerGetTemplateOrContent } from './cio/get-template-or-content.js';
import { registerGetBroadcastHistory } from './cio/get-broadcast-history-for-segment.js';
import { registerTrackEvent } from './cio/track-event.js';
import { registerUpdateCustomerAttributes } from './cio/update-customer-attributes.js';
import { registerUpdateNewsletterVariant } from './cio/update-newsletter-variant.js';
import { registerDuplicateNewsletter } from './cio/duplicate-newsletter.js';

// Phase 2 — Shopify
import { registerShopifyListProducts } from './shopify/list-products.js';
import { registerShopifyGetProduct } from './shopify/get-product.js';
import { registerShopifyGetOrder } from './shopify/get-order.js';
import { registerShopifyListAbandonedCheckouts } from './shopify/list-abandoned-checkouts.js';

// Phase 2 — Intercom
import { registerIntercomListArticles } from './intercom/list-articles.js';
import { registerIntercomGetArticle } from './intercom/get-article.js';

// Phase 2 — n8n meta-tools
import { registerN8nListWorkflows } from './n8n/list-workflows.js';
import { registerN8nGetExecution } from './n8n/get-execution.js';

// Phase 3 — Cloudflare (fleet email routing + DNS)
import { registerCloudflareListEmailDestinations } from './cloudflare/list-email-destinations.js';
import { registerCloudflareAddEmailDestination } from './cloudflare/add-email-destination.js';
import { registerCloudflareListEmailRules } from './cloudflare/list-email-rules.js';
import { registerCloudflareCreateEmailRule } from './cloudflare/create-email-rule.js';
import { registerCloudflareListDnsRecords } from './cloudflare/list-dns-records.js';
import { registerCloudflareCreateDnsRecord } from './cloudflare/create-dns-record.js';

// Phase 3 — Microsoft Graph (COO email send-as + inbox)
import { registerGraphSendEmail } from './graph/send-email.js';
import { registerGraphListMessages } from './graph/list-messages.js';

// Phase 3 — Stripe (read-only: CFO scoreboard + CRO visibility)
import { registerStripeGetBalance } from './stripe/get-balance.js';
import { registerStripeListCharges } from './stripe/list-charges.js';
import { registerStripeListCustomers } from './stripe/list-customers.js';
import { registerStripeListPaymentIntents } from './stripe/list-payment-intents.js';
import { registerStripeListProducts as registerStripeListProductsCatalog } from './stripe/list-products.js';

// Phase 3 — Netlify (deploy visibility, read-only)
import { registerNetlifyListSites } from './netlify/list-sites.js';
import { registerNetlifyListSiteDeploys } from './netlify/list-site-deploys.js';

// Phase 3 — Gumroad (digital-products cash scoreboard, read-only)
import { registerGumroadListProducts } from './gumroad/list-products.js';
import { registerGumroadListSales } from './gumroad/list-sales.js';

export function registerAllTools(server: McpServer, callerHash: CallerHashProvider): void {
  // ===== Phase 1: Customer.io (ADR Section 4) =====
  // Read tools — direct App API
  registerListNewsletters(server, callerHash);
  registerGetNewsletter(server, callerHash);
  registerGetNewsletterMetrics(server, callerHash);
  registerGetNewsletterSchedule(server, callerHash);
  registerGetSegment(server, callerHash);
  registerListSegmentPeople(server, callerHash);
  registerGetCustomer(server, callerHash);
  registerGetTemplateOrContent(server, callerHash);
  registerGetBroadcastHistory(server, callerHash);

  // Simple writes — direct Track API
  registerTrackEvent(server, callerHash);
  registerUpdateCustomerAttributes(server, callerHash);

  // Orchestrated writes — n8n
  registerUpdateNewsletterVariant(server, callerHash);
  registerDuplicateNewsletter(server, callerHash);

  // ===== Phase 2: Shopify =====
  registerShopifyListProducts(server, callerHash);
  registerShopifyGetProduct(server, callerHash);
  registerShopifyGetOrder(server, callerHash);
  registerShopifyListAbandonedCheckouts(server, callerHash);

  // ===== Phase 2: Intercom =====
  registerIntercomListArticles(server, callerHash);
  registerIntercomGetArticle(server, callerHash);

  // ===== Phase 2: n8n meta-tools =====
  registerN8nListWorkflows(server, callerHash);
  registerN8nGetExecution(server, callerHash);

  // ===== Phase 3: Cloudflare (fleet email routing + DNS) =====
  registerCloudflareListEmailDestinations(server, callerHash);
  registerCloudflareAddEmailDestination(server, callerHash);
  registerCloudflareListEmailRules(server, callerHash);
  registerCloudflareCreateEmailRule(server, callerHash);
  registerCloudflareListDnsRecords(server, callerHash);
  registerCloudflareCreateDnsRecord(server, callerHash);

  // ===== Phase 3: Microsoft Graph (COO send-as + inbox) =====
  registerGraphSendEmail(server, callerHash);
  registerGraphListMessages(server, callerHash);

  // ===== Phase 3: Stripe (read-only scoreboard) =====
  registerStripeGetBalance(server, callerHash);
  registerStripeListCharges(server, callerHash);
  registerStripeListCustomers(server, callerHash);
  registerStripeListPaymentIntents(server, callerHash);
  registerStripeListProductsCatalog(server, callerHash);

  // ===== Phase 3: Netlify (deploy visibility) =====
  registerNetlifyListSites(server, callerHash);
  registerNetlifyListSiteDeploys(server, callerHash);

  // ===== Phase 3: Gumroad (digital-products cash scoreboard) =====
  registerGumroadListProducts(server, callerHash);
  registerGumroadListSales(server, callerHash);
}
