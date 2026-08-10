import { createHash } from 'node:crypto';
import { flyGet, flyQuery } from '../../customerio/fly-client.js';

const MAX_LINKS = 100;

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function extractAttributeUrls(html: string, tag: string, attribute: string): string[] {
  const out: string[] = [];
  const tagPattern = new RegExp(`<${tag}\\b[^>]*>`, 'gi');
  const attributePattern = new RegExp(`\\b${attribute}\\s*=\\s*(["'])(.*?)\\1`, 'i');
  for (const match of html.matchAll(tagPattern)) {
    const raw = match[0] ?? '';
    const value = raw.match(attributePattern)?.[2]?.trim();
    if (!value) continue;
    if (/^(mailto:|tel:|cid:|data:|javascript:|#)/i.test(value)) continue;
    if (value.includes('{{') || value.includes('{%')) continue;
    try {
      const parsed = new URL(value);
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') out.push(value);
    } catch {
      // Relative and malformed URLs are surfaced by the static findings instead of sent upstream.
    }
  }
  return unique(out).slice(0, MAX_LINKS);
}

function countMatches(value: string, pattern: RegExp): number {
  return [...value.matchAll(pattern)].length;
}

function urlReceipt(url: string, upstream?: Record<string, unknown>): Record<string, unknown> {
  let origin: string | null = null;
  try {
    origin = new URL(url).origin;
  } catch {
    // keep null
  }
  return {
    url_sha256: sha256(url),
    origin,
    status_code: typeof upstream?.status_code === 'number' ? upstream.status_code : null,
    timeout: upstream?.timeout === true,
    error: typeof upstream?.error === 'string' && upstream.error ? upstream.error.slice(0, 300) : null,
  };
}

function statusMap(raw: unknown): Map<string, Record<string, unknown>> {
  const map = new Map<string, Record<string, unknown>>();
  if (!raw || typeof raw !== 'object') return map;
  const urls = (raw as Record<string, unknown>).urls;
  if (!Array.isArray(urls)) return map;
  for (const item of urls) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    if (typeof record.url === 'string') map.set(record.url, record);
  }
  return map;
}

function staticReadiness(html: string, subject: string, from: string, accessibilityEnabled: boolean | null): Record<string, unknown> {
  const imageTags = [...html.matchAll(/<img\b[^>]*>/gi)].map((match) => match[0]);
  const missingAlt = imageTags.filter((tag) => !/\balt\s*=\s*(["']).*?\1/i.test(tag)).length;
  const emptyAlt = imageTags.filter((tag) => /\balt\s*=\s*(["'])\1/i.test(tag)).length;
  const headingOnes = countMatches(html, /<h1\b/gi);
  const findings: string[] = [];
  if (!/<html\b[^>]*\blang\s*=\s*(["']).+?\1/i.test(html)) findings.push('missing_html_lang');
  if (!/<title\b[^>]*>.*?<\/title>/is.test(html)) findings.push('missing_document_title');
  if (missingAlt > 0) findings.push('images_missing_alt');
  if (headingOnes === 0) findings.push('missing_h1');
  if (headingOnes > 1) findings.push('multiple_h1');
  if (!subject.trim()) findings.push('missing_subject');
  if (!from.trim()) findings.push('missing_from_identity');
  if (!/(unsubscribe|manage_subscription_preferences_url)/i.test(html)) findings.push('missing_unsubscribe_marker');
  if (/href\s*=\s*(["'])\s*\1/i.test(html)) findings.push('empty_link_href');
  if (/src\s*=\s*(["'])\s*\1/i.test(html)) findings.push('empty_image_src');

  return {
    status: findings.length === 0 ? 'pass_static' : 'needs_review',
    findings,
    counts: {
      images: imageTags.length,
      images_missing_alt: missingAlt,
      decorative_images_empty_alt: emptyAlt,
      h1: headingOnes,
    },
    design_studio_accessibility_transformer_enabled: accessibilityEnabled,
    limitation: 'Static checks are a bounded preflight, not a complete WCAG audit or assistive-technology test.',
  };
}

export type CioReadinessResourceType = 'design_studio_email' | 'template';

export async function getCioDesignReadiness(args: {
  resourceType: CioReadinessResourceType;
  resourceId: string;
  checkLinks: boolean;
  correlationId?: string;
}): Promise<Record<string, unknown>> {
  const environmentId = String(process.env.CIO_WORKSPACE_ID || '193366');
  let html = '';
  let subject = '';
  let from = '';
  let name = '';
  let isLinked: boolean | null = null;
  let unpublishedChanges: unknown = null;
  let accessibilityEnabled: boolean | null = null;

  if (args.resourceType === 'design_studio_email') {
    const raw = await flyGet(
      `/v1/environments/${encodeURIComponent(environmentId)}/design_studio/emails/${encodeURIComponent(args.resourceId)}`,
      { correlationId: args.correlationId },
    );
    const email = raw && typeof raw === 'object' ? (raw as Record<string, unknown>).email as Record<string, unknown> | undefined : undefined;
    const content = email?.content as Record<string, unknown> | undefined;
    const envelope = email?.envelope as Record<string, unknown> | undefined;
    const transformers = email?.transformers as Record<string, unknown> | undefined;
    const accessibility = transformers?.accessibility as Record<string, unknown> | undefined;
    html = typeof content?.html === 'string' ? content.html : '';
    subject = typeof content?.subject === 'string' ? content.subject : '';
    from = typeof envelope?.from === 'string' ? envelope.from : '';
    name = typeof email?.name === 'string' ? email.name : '';
    isLinked = typeof email?.is_linked === 'boolean' ? email.is_linked : null;
    accessibilityEnabled = typeof accessibility?.enabled === 'boolean' ? accessibility.enabled : null;
    unpublishedChanges = await flyGet(
      `/v1/environments/${encodeURIComponent(environmentId)}/design_studio/emails/${encodeURIComponent(args.resourceId)}/unpublished_changes`,
      { correlationId: args.correlationId },
    );
  } else {
    const raw = await flyGet(
      `/v1/environments/${encodeURIComponent(environmentId)}/templates/${encodeURIComponent(args.resourceId)}`,
      { correlationId: args.correlationId },
    );
    const template = raw && typeof raw === 'object' ? (raw as Record<string, unknown>).template as Record<string, unknown> | undefined : undefined;
    html = typeof template?.body === 'string' ? template.body : '';
    subject = typeof template?.subject === 'string' ? template.subject : '';
    name = typeof template?.name === 'string' ? template.name : '';
    from = '';
    isLinked = Boolean(template?.action_id || template?.newsletter_id || template?.transactional_message_id);
  }

  const links = extractAttributeUrls(html, 'a', 'href');
  const images = extractAttributeUrls(html, 'img', 'src');
  let checked = new Map<string, Record<string, unknown>>();
  if (args.checkLinks && links.length + images.length > 0) {
    const response = await flyQuery(
      `/v1/environments/${encodeURIComponent(environmentId)}/previews/link_statuses`,
      { urls: unique([...links, ...images]).slice(0, MAX_LINKS) },
      { correlationId: args.correlationId },
    );
    checked = statusMap(response);
  }

  const linkReceipts = links.map((url) => urlReceipt(url, checked.get(url)));
  const imageReceipts = images.map((url) => urlReceipt(url, checked.get(url)));
  const badLinks = linkReceipts.filter((item) => item.timeout === true || (typeof item.status_code === 'number' && item.status_code >= 400));
  const badImages = imageReceipts.filter((item) => item.timeout === true || (typeof item.status_code === 'number' && item.status_code >= 400));
  const accessibility = staticReadiness(html, subject, from, accessibilityEnabled);
  const staticFindings = (accessibility.findings as string[]).length;
  const ready = html.length > 0 && staticFindings === 0 && badLinks.length === 0 && badImages.length === 0;

  return {
    resource_type: args.resourceType,
    resource_id: args.resourceId,
    name,
    html_sha256: sha256(html),
    html_bytes: Buffer.byteLength(html, 'utf8'),
    subject_present: Boolean(subject.trim()),
    from_identity_present: Boolean(from.trim()),
    linked: isLinked,
    unpublished_changes: unpublishedChanges,
    accessibility,
    links: {
      requested: args.checkLinks,
      checked: linkReceipts.length,
      failures: badLinks.length,
      receipts: linkReceipts,
    },
    images: {
      requested: args.checkLinks,
      checked: imageReceipts.length,
      failures: badImages.length,
      receipts: imageReceipts,
    },
    spam_status: {
      status: 'not_available',
      reason: 'The 2026-08-09 Customer.io OpenAPI schema exposes no schema-backed SpamAssassin or spam-score endpoint. This tool does not invent one or send content to an external scanner.',
    },
    ready_for_human_review: ready,
    limitation: 'No customer/profile data is read. Full inbox-client rendering and manual assistive-technology review remain separate gates.',
  };
}
