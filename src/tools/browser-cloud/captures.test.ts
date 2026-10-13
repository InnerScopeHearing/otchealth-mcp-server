import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import type { CloudBrowserCdp } from './actions.js';

type BrowserCaptureRequest = { type: 'screenshot'; format?: 'png' | 'jpeg' } | { type: 'pdf'; landscape?: boolean; printBackground?: boolean };
let captureModule: typeof import('./captures.js') | undefined;
try {
  captureModule = await import('./captures.js');
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'ERR_MODULE_NOT_FOUND') throw error;
}

function captureBrowserArtifact(...args: Parameters<NonNullable<typeof captureModule>['captureBrowserArtifact']>) {
  assert.ok(captureModule?.captureBrowserArtifact, 'capture capability missing');
  return captureModule.captureBrowserArtifact(...args);
}

class RecordingCdp implements CloudBrowserCdp {
  calls: Array<{ method: string; params: Record<string, unknown>; timeout: number; page?: string }> = [];
  result: Record<string, unknown> = {};
  failure?: Error;

  async command(method: string, params: Record<string, unknown>, timeout: number, page?: string): Promise<Record<string, unknown>> {
    this.calls.push({ method, params, timeout, page });
    if (this.failure) throw this.failure;
    return this.result;
  }
}

const base64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const png = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/WZkAAAAASUVORK5CYII=', 'base64'));
const pdf = new TextEncoder().encode('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n');

test('screenshot capture returns the verified PNG bytes, MIME type and SHA-256', async () => {
  const cdp = new RecordingCdp();
  cdp.result = { data: base64(png) };

  const artifact = await captureBrowserArtifact(cdp, 'tab-7', { type: 'screenshot', format: 'png' }, () => 8);

  assert.equal(artifact.contentType, 'image/png');
  assert.deepEqual(artifact.body, png);
  assert.equal(artifact.sha256, hash(png));
  assert.equal(artifact.pageCount, undefined);
  assert.equal(cdp.calls.length, 1);
  assert.equal(cdp.calls[0]?.method, 'Page.captureScreenshot');
  assert.deepEqual(cdp.calls[0]?.params, { format: 'png', fromSurface: true, captureBeyondViewport: true });
  assert.equal(cdp.calls[0]?.timeout, 8);
  assert.equal(cdp.calls[0]?.page, 'tab-7');
});

test('JPEG screenshot uses only the typed JPEG protocol parameters', async () => {
  const cdp = new RecordingCdp();
  const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]);
  cdp.result = { data: base64(jpeg) };

  const artifact = await captureBrowserArtifact(cdp, 'tab-1', { type: 'screenshot', format: 'jpeg' }, () => 3);

  assert.equal(artifact.contentType, 'image/jpeg');
  assert.deepEqual(cdp.calls[0]?.params, { format: 'jpeg', fromSurface: true, captureBeyondViewport: true });
});

test('PDF capture requests a base64 print result and returns verified complete PDF bytes', async () => {
  const cdp = new RecordingCdp();
  cdp.result = { data: base64(pdf) };

  const artifact = await captureBrowserArtifact(cdp, 'tab-2', { type: 'pdf', landscape: true, printBackground: true }, () => 12);

  assert.equal(artifact.contentType, 'application/pdf');
  assert.deepEqual(artifact.body, pdf);
  assert.equal(artifact.sha256, hash(pdf));
  assert.equal(artifact.pageCount, undefined);
  assert.equal(cdp.calls[0]?.method, 'Page.printToPDF');
  assert.deepEqual(cdp.calls[0]?.params, { landscape: true, printBackground: true, transferMode: 'ReturnAsBase64' });
});

test('rejects malformed and non-canonical base64 data', async () => {
  for (const data of ['not base64!', 'YWJj\n', 'YQ']) {
    const cdp = new RecordingCdp();
    cdp.result = { data };
    await assert.rejects(captureBrowserArtifact(cdp, 'tab', { type: 'screenshot' }, () => 1), /capture/i);
  }
});

test('rejects image or PDF bytes that do not match the requested format', async () => {
  const wrongImage = new RecordingCdp();
  wrongImage.result = { data: base64(pdf) };
  await assert.rejects(captureBrowserArtifact(wrongImage, 'tab', { type: 'screenshot' }, () => 1), /capture/i);

  const wrongPdf = new RecordingCdp();
  wrongPdf.result = { data: base64(png) };
  await assert.rejects(captureBrowserArtifact(wrongPdf, 'tab', { type: 'pdf' }, () => 1), /capture/i);
});

test('rejects incomplete PDFs without an EOF marker', async () => {
  const cdp = new RecordingCdp();
  cdp.result = { data: base64(new TextEncoder().encode('%PDF-1.7\n1 0 obj\n')) };
  await assert.rejects(captureBrowserArtifact(cdp, 'tab', { type: 'pdf' }, () => 1), /capture/i);
});

test('rejects decoded screenshot data above the strict four MiB bound', async () => {
  const cdp = new RecordingCdp();
  const oversized = new Uint8Array(4 * 1024 * 1024 + 1);
  oversized.set(png, 0);
  cdp.result = { data: base64(oversized) };
  await assert.rejects(captureBrowserArtifact(cdp, 'tab', { type: 'screenshot' }, () => 1), /capture/i);
});

test('redacts provider errors and rejects expired or non-finite deadlines', async () => {
  const cdp = new RecordingCdp();
  cdp.failure = new Error('provider response leaked secret-session-token');
  await assert.rejects(captureBrowserArtifact(cdp, 'tab', { type: 'screenshot' }, () => 1), error => {
    assert.doesNotMatch(String(error), /secret-session-token/);
    return true;
  });

  for (const timeout of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    const noCommand = new RecordingCdp();
    await assert.rejects(captureBrowserArtifact(noCommand, 'tab', { type: 'screenshot' }, () => timeout), /capture/i);
    assert.equal(noCommand.calls.length, 0);
  }
});

test('rejects unknown request properties instead of passing arbitrary CDP parameters', async () => {
  const cdp = new RecordingCdp();
  const malicious = { type: 'screenshot', method: 'Runtime.evaluate', expression: '1' } as unknown as BrowserCaptureRequest;
  await assert.rejects(captureBrowserArtifact(cdp, 'tab', malicious, () => 1), /capture/i);
  assert.equal(cdp.calls.length, 0);
});
