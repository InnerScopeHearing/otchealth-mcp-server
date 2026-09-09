import { createHash } from "node:crypto";

export const AWS_ADAPTER_VERSION = "neptune-trial-aws-adapters-v1";
export const MAX_REQUEST_BYTES = 256 * 1024;
export const MAX_RESPONSE_BYTES = 512 * 1024;
export const MAX_HTTP_CONCURRENCY = 4;

export class AwsAdapterError extends Error {
  constructor(code, status = null) {
    super(code);
    this.name = "AwsAdapterError";
    this.code = code;
    this.status = status;
  }
}

export const sha256 = value => createHash("sha256").update(value).digest("hex");
export const canonical = value => value === null || typeof value !== "object"
  ? JSON.stringify(value)
  : Array.isArray(value)
    ? `[${value.map(canonical).join(",")}]`
    : `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
export const intentSha256 = value => sha256(canonical(value));

export function assertActive(signal) {
  if (signal?.aborted) throw new AwsAdapterError("operation_deadline");
}

function abortable(value, signal) {
  assertActive(signal);
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(new AwsAdapterError("operation_deadline"));
    signal?.addEventListener("abort", onAbort, { once: true });
    Promise.resolve(value).then(resolve, reject).finally(() => signal?.removeEventListener("abort", onAbort));
  });
}

class Semaphore {
  constructor(limit) { this.limit = limit; this.active = 0; this.waiters = []; }
  async acquire(signal) {
    assertActive(signal);
    if (this.active < this.limit) { this.active++; return; }
    await new Promise((resolve, reject) => {
      const waiter = { resolve: () => { cleanup(); this.active++; resolve(); }, reject };
      const onAbort = () => { this.waiters = this.waiters.filter(item => item !== waiter); cleanup(); reject(new AwsAdapterError("operation_deadline")); };
      const cleanup = () => signal?.removeEventListener("abort", onAbort);
      signal?.addEventListener("abort", onAbort, { once: true });
      this.waiters.push(waiter);
    });
  }
  release() {
    this.active--;
    this.waiters.shift()?.resolve();
  }
}

async function boundedBody(response, limit, signal) {
  const declared = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(declared) && declared > limit) throw new AwsAdapterError("response_too_large", response.status);
  if (!response.body?.getReader) {
    const bytes = Buffer.from(await abortable(response.arrayBuffer(), signal));
    if (bytes.length > limit) throw new AwsAdapterError("response_too_large", response.status);
    return bytes.toString("utf8");
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await abortable(reader.read(), signal);
      if (done) break;
      size += value.byteLength;
      if (size > limit) { await reader.cancel(); throw new AwsAdapterError("response_too_large", response.status); }
      chunks.push(Buffer.from(value));
    }
  } catch (error) {
    try { await reader.cancel(); } catch { /* best effort */ }
    throw error;
  }
  return Buffer.concat(chunks, size).toString("utf8");
}

export function createSignedHttpClient({ region, signRequest, fetchImpl = globalThis.fetch }) {
  if (typeof region !== "string" || !/^[a-z]{2}(?:-gov)?-[a-z]+-\d$/.test(region) ||
      typeof signRequest !== "function" || typeof fetchImpl !== "function") {
    throw new AwsAdapterError("adapter_config_invalid");
  }
  const semaphore = new Semaphore(MAX_HTTP_CONCURRENCY);
  return Object.freeze({
    async request({ method = "GET", url, service, headers = {}, body = "", signal }) {
      assertActive(signal);
      const bytes = Buffer.byteLength(body);
      if (bytes > MAX_REQUEST_BYTES) throw new AwsAdapterError("request_too_large");
      let signed;
      try {
        signed = await abortable(signRequest({ method, url, service, region, headers, body }), signal);
      } catch (error) {
        if (error instanceof AwsAdapterError) throw error;
        throw new AwsAdapterError("signing_failed");
      }
      assertActive(signal);
      if (!signed || signed.error || typeof signed.url !== "string" || !signed.headers) throw new AwsAdapterError("auth_failed");
      await semaphore.acquire(signal);
      try {
        let response;
        try {
          response = await fetchImpl(signed.url, {
            method,
            headers: signed.headers,
            body: method === "GET" || method === "HEAD" ? undefined : body,
            signal,
            redirect: "error",
          });
        } catch (error) {
          if (signal?.aborted || error?.name === "AbortError") throw new AwsAdapterError("operation_deadline");
          throw new AwsAdapterError("transport_unknown");
        }
        const text = await boundedBody(response, MAX_RESPONSE_BYTES, signal);
        let json = null;
        if (text) { try { json = JSON.parse(text); } catch { /* caller decides if JSON was required */ } }
        assertActive(signal);
        return { status: response.status, headers: response.headers, text, json };
      } finally {
        semaphore.release();
      }
    },
  });
}

export function encodeS3Key(key) {
  return key.split("/").map(segment => encodeURIComponent(segment).replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)).join("/");
}

export function normalizeS3Config({ bucket, prefix, region }) {
  if (typeof bucket !== "string" || !/^(?!\d+\.\d+\.\d+\.\d+$)[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket) ||
      typeof prefix !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9/_-]{0,159}$/.test(prefix) || prefix.includes("//") || prefix.includes("..")) {
    throw new AwsAdapterError("adapter_config_invalid");
  }
  return Object.freeze({ bucket, prefix: prefix.replace(/\/$/, ""), region });
}

export function s3Url(config, suffix) {
  return `https://${config.bucket}.s3.${config.region}.amazonaws.com/${encodeS3Key(`${config.prefix}/${suffix}`)}`;
}
