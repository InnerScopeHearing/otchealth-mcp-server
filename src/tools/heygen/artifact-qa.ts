import { createHash } from 'node:crypto';
import {
  defaultHeyGenArtifactStore,
  type HeyGenArtifactStore,
} from './artifact-store.js';
import type { HeyGenVideoDetail } from './video-contracts.js';

export type HeyGenArtifactKind = 'video' | 'captioned_video' | 'subtitle' | 'thumbnail' | 'gif';

export interface HeyGenIngestOptions {
  operationId: string;
  includeCaptionedVideo: boolean;
  includeSubtitle: boolean;
  includeThumbnail: boolean;
  includeGif: boolean;
  maxAssetBytes: number;
}

export interface HeyGenArtifactQaResult {
  kind: HeyGenArtifactKind;
  artifactUri: string;
  sha256: string;
  sizeBytes: number;
  contentType: string;
  extension: string;
  magicValid: boolean;
  srtCueCount?: number;
}

export interface HeyGenIngestResult {
  manifestUri: string;
  videoId: string;
  providerStatus: 'completed';
  duration: number;
  assets: HeyGenArtifactQaResult[];
  qa: {
    technicalPass: true;
    manualVisualReviewRequired: true;
    checks: string[];
  };
  /** True ONLY when one or more OPTIONAL requested assets (subtitle/thumbnail/gif/captioned_video)
   *  were skipped because the bounded ingest deadline was reached after the mandatory `video`
   *  asset was already fetched (FND-20260829-e454). Never true for a video-download failure --
   *  that is always a hard failure, since there is nothing to ingest without it. Absent (not
   *  merely false) when every requested asset was fetched, so a normal result's shape is
   *  unchanged. */
  partial?: true;
  /** Present only when partial is true: the requested-but-not-fetched asset kinds, in the order
   *  they would otherwise have been downloaded. */
  skippedAssets?: HeyGenArtifactKind[];
}

interface DownloadedAsset {
  kind: HeyGenArtifactKind;
  bytes: Uint8Array;
  contentType: string;
  extension: string;
  sha256: string;
  magicValid: boolean;
  srtCueCount?: number;
}

function assertSignedHeyGenUrl(value: string, kind: HeyGenArtifactKind): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`HeyGen ${kind} URL is invalid.`);
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    (url.hostname !== 'heygen.ai' && !url.hostname.endsWith('.heygen.ai'))
  ) {
    throw new Error(`HeyGen ${kind} URL host is not allowed.`);
  }
  return url;
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function startsWith(bytes: Uint8Array, signature: number[]): boolean {
  return signature.every((value, index) => bytes[index] === value);
}

function textAt(bytes: Uint8Array, start: number, length: number): string {
  return new TextDecoder().decode(bytes.slice(start, start + length));
}

function mediaTypeFor(kind: HeyGenArtifactKind, bytes: Uint8Array, header: string): {
  contentType: string;
  extension: string;
  magicValid: boolean;
  srtCueCount?: number;
} {
  const normalized = header.split(';', 1)[0]?.trim().toLowerCase() || 'application/octet-stream';
  if (kind === 'video' || kind === 'captioned_video') {
    const mp4 = bytes.length >= 12 && textAt(bytes, 4, 4) === 'ftyp';
    const webm = bytes.length >= 4 && startsWith(bytes, [0x1a, 0x45, 0xdf, 0xa3]);
    if (!mp4 && !webm) throw new Error(`HeyGen ${kind} failed video magic validation.`);
    return {
      contentType: mp4 ? 'video/mp4' : 'video/webm',
      extension: mp4 ? 'mp4' : 'webm',
      magicValid: true,
    };
  }
  if (kind === 'subtitle') {
    const text = new TextDecoder().decode(bytes);
    if (text.includes('\u0000')) throw new Error('HeyGen subtitle contains binary data.');
    const cueCount = validateSrt(text);
    return { contentType: 'application/x-subrip', extension: 'srt', magicValid: true, srtCueCount: cueCount };
  }
  if (kind === 'gif') {
    const valid = textAt(bytes, 0, 6) === 'GIF87a' || textAt(bytes, 0, 6) === 'GIF89a';
    if (!valid) throw new Error('HeyGen GIF failed magic validation.');
    return { contentType: 'image/gif', extension: 'gif', magicValid: true };
  }
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) {
    return { contentType: 'image/jpeg', extension: 'jpg', magicValid: true };
  }
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return { contentType: 'image/png', extension: 'png', magicValid: true };
  }
  if (textAt(bytes, 0, 4) === 'RIFF' && textAt(bytes, 8, 4) === 'WEBP') {
    return { contentType: 'image/webp', extension: 'webp', magicValid: true };
  }
  throw new Error(`HeyGen ${kind} failed image magic validation (${normalized}).`);
}

function parseSrtTime(value: string): number {
  const match = value.match(/^(\d{2}):(\d{2}):(\d{2}),(\d{3})$/);
  if (!match) throw new Error('HeyGen subtitle timestamp is invalid.');
  return (((Number(match[1]) * 60 + Number(match[2])) * 60 + Number(match[3])) * 1000) + Number(match[4]);
}

export function validateSrt(value: string): number {
  const lines = value.replace(/\r\n/g, '\n').split('\n');
  let cues = 0;
  let previousStart = -1;
  let previousEnd = -1;
  for (const line of lines) {
    const match = line.trim().match(/^(\d{2}:\d{2}:\d{2},\d{3})\s+-->\s+(\d{2}:\d{2}:\d{2},\d{3})$/);
    if (!match) continue;
    const start = parseSrtTime(match[1]);
    const end = parseSrtTime(match[2]);
    if (end <= start) throw new Error('HeyGen subtitle cue has non-positive duration.');
    if (start < previousStart) throw new Error('HeyGen subtitle cues are not monotonic.');
    if (start < previousEnd) throw new Error('HeyGen subtitle cues overlap.');
    previousStart = start;
    previousEnd = end;
    cues += 1;
  }
  if (cues < 1) throw new Error('HeyGen subtitle has no valid SRT cues.');
  return cues;
}

async function readBoundedResponseBody(
  response: Response,
  maxAssetBytes: number,
  kind: HeyGenArtifactKind,
): Promise<Uint8Array> {
  if (!response.body) throw new Error(`HeyGen ${kind} download returned no body.`);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxAssetBytes) {
        await reader.cancel('size limit exceeded').catch(() => undefined);
        throw new Error(`HeyGen ${kind} exceeds max_asset_bytes.`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  if (total < 1) throw new Error(`HeyGen ${kind} size is outside the allowed range.`);
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

/**
 * Per-attempt download timeout (FND-20260829-e454). Was a hardcoded 45_000 -- two attempts at
 * that ceiling alone could consume up to 90s for a SINGLE asset, before the ingest loop's own
 * (also-fixed) deadline check ever ran again. 8s x 2 attempts = ~16s worst case for one asset,
 * which is what INGEST_DEADLINE_MS below is sized against. Env-overridable ONLY DOWNWARD (never
 * above the 8s safe ceiling, so a misconfiguration can never reintroduce the original bug) --
 * same "read fresh from process.env, clamp to a hard max" convention as
 * deep-retrieval.ts's resolveDeepBudgetMs; exists mainly so tests can prove the deadline behavior
 * in milliseconds instead of real seconds, without weakening the production default.
 */
export function fetchAttemptTimeoutMs(): number {
  const n = Number(process.env.HEYGEN_FETCH_ATTEMPT_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 8_000) : 8_000;
}

async function fetchAsset(
  kind: HeyGenArtifactKind,
  urlValue: string,
  maxAssetBytes: number,
  fetchImpl: typeof fetch,
): Promise<DownloadedAsset> {
  const url = assertSignedHeyGenUrl(urlValue, kind);
  let response: Response | null = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      response = await fetchImpl(url, {
        method: 'GET',
        headers: { Accept: '*/*' },
        redirect: 'manual',
        signal: AbortSignal.timeout(fetchAttemptTimeoutMs()),
      });
    } catch {
      response = null;
    }
    if (response?.ok) break;
    if (response && response.status < 500 && response.status !== 429) break;
  }
  if (!response?.ok) throw new Error(`HeyGen ${kind} download failed.`);
  const announced = Number(response.headers.get('content-length') || 0);
  if (announced > maxAssetBytes) throw new Error(`HeyGen ${kind} exceeds max_asset_bytes.`);
  const bytes = await readBoundedResponseBody(response, maxAssetBytes, kind);
  const detected = mediaTypeFor(kind, bytes, response.headers.get('content-type') || '');
  return {
    kind,
    bytes,
    ...detected,
    sha256: sha256(bytes),
  };
}

function requestedAssets(detail: HeyGenVideoDetail, options: HeyGenIngestOptions): Array<[HeyGenArtifactKind, string]> {
  const requested: Array<[HeyGenArtifactKind, string]> = [];
  if (!detail.videoUrl) throw new Error('Completed HeyGen video has no video_url.');
  requested.push(['video', detail.videoUrl]);
  if (options.includeCaptionedVideo && detail.captionedVideoUrl) requested.push(['captioned_video', detail.captionedVideoUrl]);
  if (options.includeSubtitle && detail.subtitleUrl) requested.push(['subtitle', detail.subtitleUrl]);
  if (options.includeThumbnail && detail.thumbnailUrl) requested.push(['thumbnail', detail.thumbnailUrl]);
  if (options.includeGif && detail.gifUrl) requested.push(['gif', detail.gifUrl]);
  return requested;
}

/**
 * Overall ingest deadline (FND-20260829-e454). Was a hardcoded 120_000 (2 minutes) -- on its own,
 * that alone could make heygen_video_wait_ingest_qa block for minutes, far past ChatGPT's
 * 45-second-per-call hard timeout, stacked on top of the poll loop that runs before it. Sized to
 * comfortably cover one worst-case mandatory `video` fetch (see fetchAttemptTimeoutMs above: ~16s)
 * with a little headroom, since requestedAssets() always orders `video` first and it is the one
 * asset this function may never skip. Env-overridable ONLY DOWNWARD, same reasoning and same
 * purpose (fast, deterministic tests) as fetchAttemptTimeoutMs above.
 */
export function ingestDeadlineMs(): number {
  const n = Number(process.env.HEYGEN_INGEST_DEADLINE_MS);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 16_000) : 16_000;
}

export async function ingestHeyGenVideoArtifacts(
  detail: HeyGenVideoDetail,
  options: HeyGenIngestOptions,
  store: HeyGenArtifactStore = defaultHeyGenArtifactStore,
  fetchImpl: typeof fetch = fetch,
): Promise<HeyGenIngestResult> {
  if (detail.status !== 'completed') throw new Error(`HeyGen video is not completed (${detail.status}).`);
  if (!detail.duration || detail.duration <= 0) throw new Error('Completed HeyGen video has no positive duration.');
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(options.operationId)) throw new Error('operation_id is invalid.');
  if (!Number.isInteger(options.maxAssetBytes) || options.maxAssetBytes < 1_048_576 || options.maxAssetBytes > 52_428_800) {
    throw new Error('max_asset_bytes must be 1-50 MiB.');
  }
  if (!store.configured()) throw new Error('HeyGen artifact storage is not configured.');

  const downloads: DownloadedAsset[] = [];
  const skippedAssets: HeyGenArtifactKind[] = [];
  const aggregateLimit = Math.min(104_857_600, options.maxAssetBytes * 2);
  let aggregateBytes = 0;
  const deadline = Date.now() + ingestDeadlineMs();
  const requested = requestedAssets(detail, options);
  for (let i = 0; i < requested.length; i++) {
    const [kind, url] = requested[i]!;
    if (Date.now() >= deadline) {
      if (kind === 'video') {
        // The one asset this function may never skip -- there is nothing to ingest without it.
        throw new Error('HeyGen artifact ingestion exceeded its bounded deadline before the mandatory video asset could be fetched.');
      }
      // Every remaining requested asset is optional: skip gracefully (never discard the video --
      // or any other asset -- already downloaded) rather than throwing away a completed ingest
      // over a caption/thumbnail/gif that ran out of time.
      skippedAssets.push(kind, ...requested.slice(i + 1).map(([k]) => k));
      break;
    }
    const downloaded = await fetchAsset(kind, url, options.maxAssetBytes, fetchImpl);
    aggregateBytes += downloaded.bytes.length;
    if (aggregateBytes > aggregateLimit) {
      throw new Error('HeyGen artifact bundle exceeds the aggregate byte limit.');
    }
    downloads.push(downloaded);
  }

  const assets: HeyGenArtifactQaResult[] = [];
  for (const asset of downloads) {
    const relative = `${options.operationId}/${detail.id}/${asset.kind}-${asset.sha256.slice(0, 16)}.${asset.extension}`;
    const stored = await store.put(relative, asset.bytes, asset.contentType);
    assets.push({
      kind: asset.kind,
      artifactUri: stored.artifactUri,
      sha256: asset.sha256,
      sizeBytes: asset.bytes.length,
      contentType: asset.contentType,
      extension: asset.extension,
      magicValid: asset.magicValid,
      srtCueCount: asset.srtCueCount,
    });
  }

  const checks = [
    'provider_status_completed',
    'duration_positive',
    'signed_url_host_allowlisted',
    'size_bounded',
    'content_magic_valid',
    'sha256_recorded',
  ];
  if (assets.some((asset) => asset.kind === 'subtitle')) checks.push('subtitle_cues_monotonic_nonoverlapping');
  const manifest = {
    schema: 'otchealth.heygen.artifact-manifest.v1',
    operation_id: options.operationId,
    video_id: detail.id,
    provider_status: detail.status,
    title_sha256: createHash('sha256').update(detail.title ?? '', 'utf8').digest('hex'),
    duration_seconds: detail.duration,
    completed_at: detail.completedAt,
    ingested_at: new Date().toISOString(),
    assets: assets.map((asset) => ({
      kind: asset.kind,
      artifact_uri: asset.artifactUri,
      sha256: asset.sha256,
      size_bytes: asset.sizeBytes,
      content_type: asset.contentType,
      extension: asset.extension,
      magic_valid: asset.magicValid,
      srt_cue_count: asset.srtCueCount,
    })),
    qa: { technical_pass: true, manual_visual_review_required: true, checks },
    // FND-20260829-e454: recorded on the durable manifest too, not just the tool response, so the
    // audit trail itself discloses when the bounded ingest deadline skipped an optional asset.
    ...(skippedAssets.length ? { skipped_assets: skippedAssets } : {}),
  };
  const manifestBytes = new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`);
  const manifestStored = await store.put(
    `${options.operationId}/${detail.id}/manifest.json`,
    manifestBytes,
    'application/json',
  );

  return {
    manifestUri: manifestStored.artifactUri,
    videoId: detail.id,
    providerStatus: 'completed',
    duration: detail.duration,
    assets,
    qa: { technicalPass: true, manualVisualReviewRequired: true, checks },
    ...(skippedAssets.length ? { partial: true as const, skippedAssets } : {}),
  };
}
