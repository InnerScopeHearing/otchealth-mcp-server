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
}
