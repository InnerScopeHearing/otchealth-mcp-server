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

// Phase 4 — kb-memory shared brain (commons feed; the cross-agent / cross-platform memory)
import { registerMemoryRemember } from './memory/remember.js';
import { registerMemoryRecall } from './memory/recall.js';
import { registerMemoryTeam } from './memory/team.js';
import { registerMemoryPack } from './memory/pack.js';

// Agent persona (cross-platform identity bootstrap)
import { registerAgentPersona } from './agent/persona.js';

// Capability Catalog (self-describing gateway introspection)
import { registerCatalogListTools } from './catalog/list-tools.js';
import { registerCatalogServiceCapabilities } from './catalog/service-capabilities.js';
import { registerCatalogAuditUnused } from './catalog/audit-unused.js';
import { registerCatalogMaster } from './catalog/master.js';
import { registerCatalogSkill } from './catalog/skill.js';

// P3 wave 1 connectors (read-only)
import { registerSentryListProjects } from './sentry/list-projects.js';
import { registerSentryListIssues } from './sentry/list-issues.js';
import { registerRevenueCatListProjects } from './revenuecat/list-projects.js';
import { registerPostHogListProjects } from './posthog/list-projects.js';
import { registerDepotListProjects } from './depot/list-projects.js';
import { registerGitHubListPullRequests } from './github/list-pull-requests.js';
import { registerGitHubListWorkflowRuns } from './github/list-workflow-runs.js';
// GitHub writes (CTO-gated) + file read — custom-gateway, governed, custom-first code ops
import { registerGitHubPushFiles } from './github/push-files.js';
import { registerGitHubCreatePullRequest } from './github/create-pull-request.js';
import { registerGitHubMergePullRequest } from './github/merge-pull-request.js';
import { registerGitHubGetFileContents } from './github/get-file-contents.js';
import { registerTwilioGetBalance } from './twilio/get-balance.js';
import { registerTwilioListMessages } from './twilio/list-messages.js';

// Wave A — Azure AI Content Safety (Prompt Shields + groundedness): gateway-level guardrails
import { registerShieldCheck } from './safety/shield-check.js';
import { registerGroundednessCheck } from './safety/groundedness-check.js';

// Wave A — Azure Document Intelligence (CFO invoices + CLO contracts, read/analyze only)
import { registerDocintelAnalyzeInvoice } from './docintel/analyze-invoice.js';
import { registerDocintelAnalyzeContract } from './docintel/analyze-contract.js';

// Wave A+ — fleet knowledge RAG (hybrid AI Search; commons open, finance/legal ring-gated)
import { registerKbSearch } from './kb/search.js';
import { registerKbSearchPrivileged } from './kb/search-privileged.js';

// Wave A+ — llm_azure commodity path (credit-funded gpt-4.1, tiered): the cost-protocol escape hatch
import { registerLlmAzure } from './llm/azure.js';

// ===== FULL READ+WRITE WAVE: connector write tools (gated by ENABLE_WRITE_TOOLS / ENABLE_HIGH_RISK_TOOLS; role-gated in governance.ts) =====
import { registerCreateOrUpdateCustomer } from './cio/create-or-update-customer.js';
import { registerDeleteCustomer } from './cio/delete-customer.js';
import { registerSendTransactional } from './cio/send-transactional.js';
import { registerSuppressCustomer } from './cio/suppress-customer.js';
import { registerTriggerBroadcast } from './cio/trigger-broadcast.js';
import { registerUnsuppressCustomer } from './cio/unsuppress-customer.js';
import { registerCloudflareDeleteDnsRecord } from './cloudflare/delete-dns-record.js';
import { registerCloudflareDeleteEmailRule } from './cloudflare/delete-email-rule.js';
import { registerCloudflareUpdateDnsRecord } from './cloudflare/update-dns-record.js';
import { registerCloudflareUpdateEmailRule } from './cloudflare/update-email-rule.js';
import { registerDepotTriggerBuild } from './depot/trigger-build.js';
import { registerGitHubAddLabels } from './github/add-labels.js';
import { registerGitHubCommentOnIssue } from './github/comment-on-issue.js';
import { registerGitHubCreateBranch } from './github/create-branch.js';
import { registerGitHubCreateIssue } from './github/create-issue.js';
import { registerGitHubCreateOrUpdateFile } from './github/create-or-update-file.js';
import { registerGitHubCreateRelease } from './github/create-release.js';
import { registerGitHubDispatchWorkflow } from './github/dispatch-workflow.js';
import { registerGraphCreateCalendarEvent } from './graph/create-calendar-event.js';
import { registerGraphCreateDraft } from './graph/create-draft.js';
import { registerGraphMarkRead } from './graph/mark-read.js';
import { registerGraphMoveMessage } from './graph/move-message.js';
import { registerGraphReplyEmail } from './graph/reply-email.js';
import { registerGumroadDisableProduct } from './gumroad/disable-product.js';
import { registerGumroadEnableProduct } from './gumroad/enable-product.js';
import { registerGumroadUpdateProduct } from './gumroad/update-product.js';
import { registerIntercomAddNote } from './intercom/add-note.js';
import { registerIntercomCreateArticle } from './intercom/create-article.js';
import { registerIntercomCreateContact } from './intercom/create-contact.js';
import { registerIntercomCreateConversation } from './intercom/create-conversation.js';
import { registerIntercomReplyConversation } from './intercom/reply-conversation.js';
import { registerIntercomUpdateArticle } from './intercom/update-article.js';
import { registerN8nActivateWorkflow } from './n8n/activate-workflow.js';
import { registerN8nCreateWorkflow } from './n8n/create-workflow.js';
import { registerN8nDeactivateWorkflow } from './n8n/deactivate-workflow.js';
import { registerN8nRunWorkflow } from './n8n/run-workflow.js';
import { registerN8nUpdateWorkflow } from './n8n/update-workflow.js';
import { registerNetlifyCreateDeployHook } from './netlify/create-deploy-hook.js';
import { registerNetlifySetEnvVar } from './netlify/set-env-var.js';
import { registerNetlifyTriggerDeploy } from './netlify/trigger-deploy.js';
import { registerPostHogCreateAnnotation } from './posthog/create-annotation.js';
import { registerPostHogCreateFeatureFlag } from './posthog/create-feature-flag.js';
import { registerPostHogUpdateFeatureFlag } from './posthog/update-feature-flag.js';
import { registerRevenueCatGrantEntitlement } from './revenuecat/grant-entitlement.js';
import { registerRevenueCatRevokeEntitlement } from './revenuecat/revoke-entitlement.js';
import { registerRevenueCatSetSubscriberAttributes } from './revenuecat/set-subscriber-attributes.js';
import { registerSentryCreateRelease } from './sentry/create-release.js';
import { registerSentryUpdateIssue } from './sentry/update-issue.js';
import { registerShopifyCompleteDraftOrder } from './shopify/complete-draft-order.js';
import { registerShopifyCreateDiscountCode } from './shopify/create-discount-code.js';
import { registerShopifyCreateDraftOrder } from './shopify/create-draft-order.js';
import { registerShopifyCreateProduct } from './shopify/create-product.js';
import { registerShopifyFulfillOrder } from './shopify/fulfill-order.js';
import { registerShopifyUpdateInventoryLevel } from './shopify/update-inventory-level.js';
import { registerShopifyUpdateOrder } from './shopify/update-order.js';
import { registerShopifyUpdateProduct } from './shopify/update-product.js';
import { registerStripeCancelSubscription } from './stripe/cancel-subscription.js';
import { registerStripeCreateCustomer } from './stripe/create-customer.js';
import { registerStripeCreateInvoice } from './stripe/create-invoice.js';
import { registerStripeCreatePaymentLink } from './stripe/create-payment-link.js';
import { registerStripeCreatePrice } from './stripe/create-price.js';
import { registerStripeCreateProduct } from './stripe/create-product.js';
import { registerStripeCreateRefund } from './stripe/create-refund.js';
import { registerStripeUpdateCustomer } from './stripe/update-customer.js';
import { registerTwilioMakeCall } from './twilio/make-call.js';
import { registerTwilioSendMms } from './twilio/send-mms.js';
import { registerTwilioSendSms } from './twilio/send-sms.js';

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

  // ===== Phase 4: kb-memory shared brain (cross-agent / cross-platform memory) =====
  registerMemoryRecall(server, callerHash);
  registerMemoryTeam(server, callerHash);
  registerMemoryPack(server, callerHash);
  registerMemoryRemember(server, callerHash); // write_simple: gated by ENABLE_WRITE_TOOLS

  // ===== P2: Agent persona (cross-platform identity bootstrap) =====
  registerAgentPersona(server, callerHash);

  // ===== Capability Catalog (self-describing introspection) =====
  registerCatalogListTools(server, callerHash);
  registerCatalogServiceCapabilities(server, callerHash);
  registerCatalogAuditUnused(server, callerHash);
  registerCatalogMaster(server, callerHash);
  registerCatalogSkill(server, callerHash);

  // ===== P3 wave 1: Sentry + RevenueCat (read-only, ring-safe) =====
  registerSentryListProjects(server, callerHash);
  registerSentryListIssues(server, callerHash);
  registerRevenueCatListProjects(server, callerHash);
  registerPostHogListProjects(server, callerHash);
  registerDepotListProjects(server, callerHash);
  registerGitHubListPullRequests(server, callerHash);
  registerGitHubListWorkflowRuns(server, callerHash);
  registerGitHubGetFileContents(server, callerHash);
  registerGitHubPushFiles(server, callerHash);
  registerGitHubCreatePullRequest(server, callerHash);
  registerGitHubMergePullRequest(server, callerHash);
  registerTwilioGetBalance(server, callerHash);
  registerTwilioListMessages(server, callerHash);

  // ===== Wave A: Azure AI Content Safety (prompt-injection defense + groundedness) =====
  registerShieldCheck(server, callerHash);
  registerGroundednessCheck(server, callerHash);

  // ===== Wave A: Azure Document Intelligence (CFO + CLO, read/analyze only, non-BAA) =====
  registerDocintelAnalyzeInvoice(server, callerHash);
  registerDocintelAnalyzeContract(server, callerHash);

  // ===== Wave A+: fleet knowledge RAG + commodity LLM (credit-funded) =====
  registerKbSearch(server, callerHash);
  registerKbSearchPrivileged(server, callerHash);
  registerLlmAzure(server, callerHash);

  // ===== FULL READ+WRITE WAVE: connector write tools =====
  registerCreateOrUpdateCustomer(server, callerHash);
  registerDeleteCustomer(server, callerHash);
  registerSendTransactional(server, callerHash);
  registerSuppressCustomer(server, callerHash);
  registerTriggerBroadcast(server, callerHash);
  registerUnsuppressCustomer(server, callerHash);
  registerCloudflareDeleteDnsRecord(server, callerHash);
  registerCloudflareDeleteEmailRule(server, callerHash);
  registerCloudflareUpdateDnsRecord(server, callerHash);
  registerCloudflareUpdateEmailRule(server, callerHash);
  registerDepotTriggerBuild(server, callerHash);
  registerGitHubAddLabels(server, callerHash);
  registerGitHubCommentOnIssue(server, callerHash);
  registerGitHubCreateBranch(server, callerHash);
  registerGitHubCreateIssue(server, callerHash);
  registerGitHubCreateOrUpdateFile(server, callerHash);
  registerGitHubCreateRelease(server, callerHash);
  registerGitHubDispatchWorkflow(server, callerHash);
  registerGraphCreateCalendarEvent(server, callerHash);
  registerGraphCreateDraft(server, callerHash);
  registerGraphMarkRead(server, callerHash);
  registerGraphMoveMessage(server, callerHash);
  registerGraphReplyEmail(server, callerHash);
  registerGumroadDisableProduct(server, callerHash);
  registerGumroadEnableProduct(server, callerHash);
  registerGumroadUpdateProduct(server, callerHash);
  registerIntercomAddNote(server, callerHash);
  registerIntercomCreateArticle(server, callerHash);
  registerIntercomCreateContact(server, callerHash);
  registerIntercomCreateConversation(server, callerHash);
  registerIntercomReplyConversation(server, callerHash);
  registerIntercomUpdateArticle(server, callerHash);
  registerN8nActivateWorkflow(server, callerHash);
  registerN8nCreateWorkflow(server, callerHash);
  registerN8nDeactivateWorkflow(server, callerHash);
  registerN8nRunWorkflow(server, callerHash);
  registerN8nUpdateWorkflow(server, callerHash);
  registerNetlifyCreateDeployHook(server, callerHash);
  registerNetlifySetEnvVar(server, callerHash);
  registerNetlifyTriggerDeploy(server, callerHash);
  registerPostHogCreateAnnotation(server, callerHash);
  registerPostHogCreateFeatureFlag(server, callerHash);
  registerPostHogUpdateFeatureFlag(server, callerHash);
  registerRevenueCatGrantEntitlement(server, callerHash);
  registerRevenueCatRevokeEntitlement(server, callerHash);
  registerRevenueCatSetSubscriberAttributes(server, callerHash);
  registerSentryCreateRelease(server, callerHash);
  registerSentryUpdateIssue(server, callerHash);
  registerShopifyCompleteDraftOrder(server, callerHash);
  registerShopifyCreateDiscountCode(server, callerHash);
  registerShopifyCreateDraftOrder(server, callerHash);
  registerShopifyCreateProduct(server, callerHash);
  registerShopifyFulfillOrder(server, callerHash);
  registerShopifyUpdateInventoryLevel(server, callerHash);
  registerShopifyUpdateOrder(server, callerHash);
  registerShopifyUpdateProduct(server, callerHash);
  registerStripeCancelSubscription(server, callerHash);
  registerStripeCreateCustomer(server, callerHash);
  registerStripeCreateInvoice(server, callerHash);
  registerStripeCreatePaymentLink(server, callerHash);
  registerStripeCreatePrice(server, callerHash);
  registerStripeCreateProduct(server, callerHash);
  registerStripeCreateRefund(server, callerHash);
  registerStripeUpdateCustomer(server, callerHash);
  registerTwilioMakeCall(server, callerHash);
  registerTwilioSendMms(server, callerHash);
  registerTwilioSendSms(server, callerHash);
}
