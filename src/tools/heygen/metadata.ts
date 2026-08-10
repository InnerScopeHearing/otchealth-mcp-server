import { createHash } from 'node:crypto';
import { z } from 'zod';

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function boundedString(value: unknown, max = 256): string | null {
  return typeof value === 'string' && value.length > 0 ? value.slice(0, max) : null;
}

const AssetEnvelopeSchema = z.object({
  data: z.object({
    id: z.string().min(1),
    name: z.string().min(1),
    type: z.string().min(1),
    owner: z.string().min(1),
    space_id: z.string().min(1),
    folder_id: z.string().nullable().optional(),
    uploaded_at: z.number().int(),
    url: z.string().url().nullable().optional(),
  }).passthrough(),
}).passthrough();

export interface SafeHeyGenAssetMetadata {
  id: string;
  name: string;
  type: string;
  space_id: string;
  folder_id: string | null;
  uploaded_at: number;
  url_available: boolean;
  url_sha256: string | null;
}

/** Remove owner identity and never return the provider URL or its signed query string. */
export function safeHeyGenAssetMetadata(value: unknown): SafeHeyGenAssetMetadata {
  const data = AssetEnvelopeSchema.parse(value).data;
  return {
    id: data.id,
    name: data.name.slice(0, 256),
    type: data.type.slice(0, 64),
    space_id: data.space_id,
    folder_id: data.folder_id ?? null,
    uploaded_at: data.uploaded_at,
    url_available: Boolean(data.url),
    url_sha256: data.url ? sha256(data.url) : null,
  };
}

const SessionResourceEnvelopeSchema = z.object({
  data: z.object({
    resource_id: z.string().min(1),
    resource_type: z.string().min(1),
    source_type: z.string().nullable().optional(),
    url: z.string().url().nullable().optional(),
    thumbnail_url: z.string().url().nullable().optional(),
    preview_url: z.string().url().nullable().optional(),
    created_at: z.number().int().nullable().optional(),
    metadata: z.record(z.unknown()).nullable().optional(),
  }).passthrough(),
}).passthrough();

const SAFE_METADATA_KEYS = new Set([
  'status',
  'width',
  'height',
  'duration',
  'mime_type',
  'size_bytes',
  'orientation',
]);

export interface SafeHeyGenSessionResource {
  resource_id: string;
  resource_type: string;
  source_type: string | null;
  created_at: number | null;
  url_available: boolean;
  thumbnail_available: boolean;
  preview_available: boolean;
  url_sha256: string | null;
  thumbnail_sha256: string | null;
  preview_sha256: string | null;
  metadata: Record<string, string | number | boolean | null>;
  metadata_sha256: string;
}

/**
 * Reduce open-ended Video Agent resources to bounded metadata. Provider URLs are credentials and
 * remain internal; provider-authored metadata is data, never instructions.
 */
export function safeHeyGenSessionResource(value: unknown): SafeHeyGenSessionResource {
  const data = SessionResourceEnvelopeSchema.parse(value).data;
  const metadata: Record<string, string | number | boolean | null> = {};
  for (const key of Object.keys(data.metadata ?? {}).sort()) {
    if (!SAFE_METADATA_KEYS.has(key)) continue;
    const raw = data.metadata?.[key];
    if (raw === null || typeof raw === 'number' || typeof raw === 'boolean') metadata[key] = raw;
    else if (typeof raw === 'string') metadata[key] = raw.slice(0, 256);
  }
  const canonical = JSON.stringify(metadata);
  return {
    resource_id: data.resource_id,
    resource_type: data.resource_type.slice(0, 64),
    source_type: boundedString(data.source_type, 64),
    created_at: data.created_at ?? null,
    url_available: Boolean(data.url),
    thumbnail_available: Boolean(data.thumbnail_url),
    preview_available: Boolean(data.preview_url),
    url_sha256: data.url ? sha256(data.url) : null,
    thumbnail_sha256: data.thumbnail_url ? sha256(data.thumbnail_url) : null,
    preview_sha256: data.preview_url ? sha256(data.preview_url) : null,
    metadata,
    metadata_sha256: sha256(canonical),
  };
}
