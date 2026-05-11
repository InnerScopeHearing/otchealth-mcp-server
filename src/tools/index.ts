/**
 * Central tool registration entrypoint. Wires every Phase 1 tool to the
 * shared McpServer instance. Read tools first (always live), then guarded
 * write tools (registry.ts enforces gating).
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallerHashProvider } from './registry.js';

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

export function registerAllTools(server: McpServer, callerHash: CallerHashProvider): void {
  // Phase 1 read tools — ADR Section 4a.
  registerListNewsletters(server, callerHash);
  registerGetNewsletter(server, callerHash);
  registerGetNewsletterMetrics(server, callerHash);
  registerGetNewsletterSchedule(server, callerHash);
  registerGetSegment(server, callerHash);
  registerListSegmentPeople(server, callerHash);
  registerGetCustomer(server, callerHash);
  registerGetTemplateOrContent(server, callerHash);
  registerGetBroadcastHistory(server, callerHash);

  // Phase 1 simple writes — ADR Section 4a (Track API).
  registerTrackEvent(server, callerHash);
  registerUpdateCustomerAttributes(server, callerHash);

  // Phase 1 orchestrated writes — ADR Section 4b (n8n).
  registerUpdateNewsletterVariant(server, callerHash);
  registerDuplicateNewsletter(server, callerHash);
}
