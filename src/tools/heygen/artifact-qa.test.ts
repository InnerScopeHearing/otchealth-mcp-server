import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ingestHeyGenVideoArtifacts,
  validateSrt,
} from './artifact-qa.js';
import {
  heyGenArtifactUri,
  validateHeyGenArtifactRelativePath,
  type HeyGenArtifactStore,
} from './artifact-store.js';
import type { HeyGenVideoDetail } from './video-contracts.js';

const MP4 = new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0, 0, 0, 0]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xdb, 0, 1, 2, 3]);
const SRT = new TextEncoder().encode('1\n00:00:00,000 --> 00:00:01,000\nHello\n\n2\n00:00:01,100 --> 00:00:02,000\nWorld\n');

function completed(overrides: Partial<HeyGenVideoDetail> = {}): HeyGenVideoDetail {
  return {
    id: 'v_1', status: 'completed', title: 'Video',
    videoUrl: 'https://files2.heygen.ai/video.mp4?sig=SECRET',
    captionedVideoUrl: null,
    subtitleUrl: 'https://files2.heygen.ai/video.srt?sig=SECRET',
    thumbnailUrl: 'https://resource2.heygen.ai/thumb.jpg?sig=SECRET',
    gifUrl: null,
    duration: 2,
    failureCode: null,
    failureMessage: null,
    completedAt: 1_000,
    ...overrides,
  };
}

function response(body: Uint8Array, contentType: string): Response {
  return new Response(body, {
    status: 200,
    headers: { 'content-type': contentType, 'content-length': String(body.length) },
  });
}

test('SRT validation requires positive monotonic cues', () => {
  assert.equal(validateSrt(new TextDecoder().decode(SRT)), 2);
  assert.throws(() => validateSrt('1\n00:00:02,000 --> 00:00:01,000\nBad\n'));
  assert.throws(() => validateSrt('No timestamps'));
  assert.throws(() => validateSrt('1\n00:00:02,000 --> 00:00:03,000\nOne\n\n2\n00:00:01,000 --> 00:00:02,000\nTwo\n'));
  assert.throws(() => validateSrt('1\n00:00:00,000 --> 00:00:02,000\nOne\n\n2\n00:00:01,500 --> 00:00:03,000\nOverlap\n'), /overlap/);
});

test('artifact paths are traversal-safe and private URIs contain no SAS material', () => {
  assert.equal(validateHeyGenArtifactRelativePath('op_123/v_1/video.mp4'), 'op_123/v_1/video.mp4');
  assert.equal(
    heyGenArtifactUri('otchealthcommons', 'op_123/v_1/video.mp4'),
    'azure://otchealthcommons/heygen-artifacts/_ARTIFACTS/heygen/op_123/v_1/video.mp4',
  );
  for (const invalid of ['../escape', '/absolute', 'trailing/', 'bad?query', '']) {
    assert.throws(() => validateHeyGenArtifactRelativePath(invalid));
  }
});

test('completed video ingestion validates all bytes before writing, hashes assets, and writes manifest last', async () => {
  const writes: Array<{ path: string; type: string; body: Uint8Array }> = [];
  const store: HeyGenArtifactStore = {
    configured: () => true,
    put: async (path, body, contentType) => {
      writes.push({ path, type: contentType, body: new Uint8Array(body) });
      return { artifactUri: `azure://test/${path}`, blobPath: path };
    },
  };
  const fetchedHosts: string[] = [];
  const fetchImpl = (async (url: string | URL) => {
    const parsed = new URL(String(url));
    fetchedHosts.push(parsed.hostname);
    if (parsed.pathname.endsWith('.mp4')) return response(MP4, 'application/octet-stream');
    if (parsed.pathname.endsWith('.srt')) return response(SRT, 'text/plain');
    if (parsed.pathname.endsWith('.jpg')) return response(JPEG, 'image/jpeg');
    return new Response('missing', { status: 404 });
  }) as typeof fetch;

  const result = await ingestHeyGenVideoArtifacts(completed(), {
    operationId: 'video_op_01',
    includeCaptionedVideo: false,
    includeSubtitle: true,
    includeThumbnail: true,
    includeGif: false,
    maxAssetBytes: 1_048_576,
  }, store, fetchImpl);

  assert.deepEqual(fetchedHosts, ['files2.heygen.ai', 'files2.heygen.ai', 'resource2.heygen.ai']);
  assert.equal(result.assets.length, 3);
  assert.equal(result.qa.technicalPass, true);
  assert.equal(result.qa.manualVisualReviewRequired, true);
  assert.ok(result.qa.checks.includes('subtitle_cues_monotonic_nonoverlapping'));
  assert.match(result.assets[0].sha256, /^[a-f0-9]{64}$/);
  assert.equal(result.assets.find((asset) => asset.kind === 'subtitle')?.srtCueCount, 2);
  assert.ok(writes.at(-1)?.path.endsWith('/manifest.json'), 'manifest must be the final commit marker');
  const manifest = JSON.parse(new TextDecoder().decode(writes.at(-1)!.body));
  assert.equal(manifest.qa.technical_pass, true);
  assert.match(manifest.title_sha256, /^[a-f0-9]{64}$/);
  assert.equal(Object.hasOwn(manifest, 'title'), false, 'raw provider title must not enter the manifest');
  assert.equal(JSON.stringify(manifest).includes('SECRET'), false, 'signed URL query must never enter manifest');
});

test('ingestion rejects non-HeyGen URLs, oversized assets, bad magic, and non-completed videos before Blob writes', async () => {
  let writes = 0;
  const store: HeyGenArtifactStore = {
    configured: () => true,
    put: async () => {
      writes += 1;
      return { artifactUri: 'azure://test/x', blobPath: 'x' };
    },
  };
  const never = (async () => response(MP4, 'video/mp4')) as typeof fetch;
  await assert.rejects(() => ingestHeyGenVideoArtifacts(
    completed({ videoUrl: 'https://evil.example/video.mp4' }),
    { operationId: 'video_op_01', includeCaptionedVideo: false, includeSubtitle: false, includeThumbnail: false, includeGif: false, maxAssetBytes: 1_048_576 },
    store,
    never,
  ), /host is not allowed/);
  await assert.rejects(() => ingestHeyGenVideoArtifacts(
    completed({ status: 'processing' }),
    { operationId: 'video_op_01', includeCaptionedVideo: false, includeSubtitle: false, includeThumbnail: false, includeGif: false, maxAssetBytes: 1_048_576 },
    store,
    never,
  ), /not completed/);
  const bad = (async () => response(new Uint8Array([1, 2, 3]), 'video/mp4')) as typeof fetch;
  await assert.rejects(() => ingestHeyGenVideoArtifacts(
    completed(),
    { operationId: 'video_op_01', includeCaptionedVideo: false, includeSubtitle: false, includeThumbnail: false, includeGif: false, maxAssetBytes: 1_048_576 },
    store,
    bad,
  ), /magic validation/);
  const announcedOversize = (async () => new Response(MP4, {
    status: 200,
    headers: { 'content-type': 'video/mp4', 'content-length': '2000000' },
  })) as typeof fetch;
  await assert.rejects(() => ingestHeyGenVideoArtifacts(
    completed(),
    { operationId: 'video_op_01', includeCaptionedVideo: false, includeSubtitle: false, includeThumbnail: false, includeGif: false, maxAssetBytes: 1_048_576 },
    store,
    announcedOversize,
  ), /exceeds max_asset_bytes/);
  const chunkedOversize = (async () => {
    const chunks = [new Uint8Array(700_000), new Uint8Array(700_000)];
    chunks[0].set(MP4);
    return new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        const next = chunks.shift();
        if (next) controller.enqueue(next);
        else controller.close();
      },
    }), { status: 200, headers: { 'content-type': 'video/mp4' } });
  }) as typeof fetch;
  await assert.rejects(() => ingestHeyGenVideoArtifacts(
    completed(),
    { operationId: 'video_op_01', includeCaptionedVideo: false, includeSubtitle: false, includeThumbnail: false, includeGif: false, maxAssetBytes: 1_048_576 },
    store,
    chunkedOversize,
  ), /exceeds max_asset_bytes/);
  assert.equal(writes, 0);
});
