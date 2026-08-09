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
  for (const line of lines) {
    const match = line.trim().match(/^(\d{2}:\d{2}:\d{2},\d{3})\s+-->\s+(\d{2}:\d{2}:\d{2},\d{3})$/);
    if (!match) continue;
    const start = parseSrtTime(match[1]);
    const end = parseSrtTime(match[2]);
    if (end <= start) throw new Error('HeyGen subtitle cue has non-positive duration.');
    if (start < previousStart) throw new Error('HeyGen subtitle cues are not monotonic.');
    previousStart = start;
    cues += 1;
  }
  if (cues < 1) throw new Error('HeyGen subtitle has no valid SRT cues.');
  return cues;
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
        signal: AbortSignal.timeout(45_000),
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
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length < 1 || bytes.length > maxAssetBytes) {
    throw new Error(`HeyGen ${kind} size is outside the allowed range.`);
  }
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
  for (const [kind, url] of requestedAssets(detail, options)) {
    downloads.push(await fetchAsset(kind, url, options.maxAssetBytes, fetchImpl));
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
  if (assets.some((asset) => asset.kind === 'subtitle')) checks.push('subtitle_cues_monotonic');
  const manifest = {
    schema: 'otchealth.heygen.artifact-manifest.v1',
    operation_id: options.operationId,
    video_id: detail.id,
    provider_status: detail.status,
    title: detail.title,
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
  };
}
