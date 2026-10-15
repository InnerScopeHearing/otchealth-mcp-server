import { createHash } from 'node:crypto';
import { lookup as dnsLookup } from 'node:dns/promises';
import { connect as netConnect, isIP, type Socket } from 'node:net';
import { BROWSER_FILE_MAX_BYTES, type BrowserFileScanner } from './file-broker.js';

const MAX_AGE_MS = 48 * 60 * 60 * 1000;
const MAX_REPLY_BYTES = 4096;
type Options = { host: string; port?: number; timeoutMs?: number; allowLoopback?: boolean; now?: () => number;
  /** Trusted test seams only; never request input. */
  lookup?: typeof dnsLookup; connect?: (host: string, port: number) => Socket };
function allowedAddress(address: string, loopback: boolean): boolean {
  if (isIP(address) !== 4) return false;
  const [a, b] = address.split('.').map(Number);
  return a === 10 || (a === 172 && b! >= 16 && b! <= 31) || (a === 192 && b === 168) || (loopback && address === '127.0.0.1');
}
function version(value: string, now: number) {
  const match = /^ClamAV ([0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?)\/([1-9][0-9]{0,11})\/((?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) +[0-9]{1,2} [0-9]{2}:[0-9]{2}:[0-9]{2} [0-9]{4})$/.exec(value);
  if (!match) throw new Error('scanner_invalid_version');
  // Scanner deployment explicitly uses TZ=UTC; VERSION has no timezone field.
  const updatedAt = Date.parse(`${match[3]} UTC`);
  if (!Number.isSafeInteger(updatedAt) || updatedAt > now || now - updatedAt > MAX_AGE_MS) throw new Error('scanner_stale_signatures');
  return { engineVersion: match[1]!, signatureVersion: match[2]!, signaturesUpdatedAt: updatedAt };
}

/** Private server-only ClamAV INSTREAM adapter; no paths or arbitrary commands are accepted. */
export function createClamAvBrowserFileScanner(options: Options): BrowserFileScanner {
  if (!options || typeof options.host !== 'string' || !/^[A-Za-z0-9.-]{1,253}$/.test(options.host) || (options.port ?? 3310) !== 3310 ||
      !Number.isInteger(options.timeoutMs ?? 20000) || (options.timeoutMs ?? 20000) < 50 || (options.timeoutMs ?? 20000) > 20000) throw new Error('scanner_config_invalid');
  const now = options.now ?? Date.now;
  return { async scan(input) {
    try {
      if (!(input.body instanceof Uint8Array) || input.body.byteLength < 1 || input.body.byteLength > BROWSER_FILE_MAX_BYTES) throw new Error('scanner_invalid_size');
      const body = Buffer.from(input.body); const deadline = Date.now() + (options.timeoutMs ?? 20000);
      const remaining = () => { const ms = deadline - Date.now(); if (ms <= 0) throw new Error('scanner_timeout'); return ms; };
      let dnsTimer: ReturnType<typeof setTimeout> | undefined;
      const addresses = await Promise.race([(options.lookup ?? dnsLookup)(options.host, { all: true, verbatim: true }), new Promise<never>((_, reject) => { dnsTimer = setTimeout(() => reject(new Error('scanner_timeout')), remaining()); })]).finally(() => clearTimeout(dnsTimer));
      if (!addresses.length || addresses.some(item => !allowedAddress(item.address, options.allowLoopback === true))) throw new Error('scanner_endpoint_forbidden');
      const address = addresses[0]!.address;
      const request = (command: 'VERSION' | 'INSTREAM'): Promise<string> => new Promise((resolve, reject) => {
        const timeout = remaining();
        const socket = (options.connect ?? ((host, port) => netConnect({ host, port })))(address, 3310);
        let settled = false; let output = Buffer.alloc(0);
        const timer = setTimeout(() => done(new Error('scanner_timeout')), timeout);
        function done(error?: Error, result?: string) { if (settled) return; settled = true; clearTimeout(timer); socket.destroy(); error ? reject(error) : resolve(result!); }
        socket.on('error', () => done(new Error('scanner_transport_error')));
        socket.on('end', () => { if (!settled) done(new Error('scanner_truncated_reply')); });
        socket.on('close', () => { if (!settled) done(new Error('scanner_truncated_reply')); });
        socket.on('data', chunk => {
          if (output.length + chunk.length > MAX_REPLY_BYTES) { done(new Error('scanner_oversize_reply')); return; }
          output = Buffer.concat([output, chunk]);
          const end = output.indexOf(0);
          if (end >= 0) {
            if (end !== output.length - 1 || !output.subarray(0, end).every(byte => byte >= 32 && byte <= 126)) done(new Error('scanner_invalid_reply'));
            else done(undefined, output.subarray(0, end).toString('ascii'));
          }
        });
        socket.once('connect', () => {
          const write = (bytes: Buffer) => new Promise<void>((yes, no) => socket.write(bytes, error => error ? no(error) : yes()));
          void (async () => {
            await write(Buffer.from(`z${command}\0`, 'ascii'));
            if (command === 'INSTREAM') {
              for (let offset = 0; offset < body.length; offset += 65536) {
                if (settled) return;
                const chunk = body.subarray(offset, offset + 65536); const header = Buffer.alloc(4); header.writeUInt32BE(chunk.length);
                await write(Buffer.concat([header, chunk]));
              }
              await write(Buffer.alloc(4));
            }
          })().catch(() => done(new Error('scanner_transport_error')));
        });
      });
      const before = await request('VERSION'); const signature = version(before, now());
      const result = await request('INSTREAM');
      if (/^stream: [A-Za-z0-9_.()+ -]{1,256} FOUND$/.test(result)) return { verdict: 'infected' };
      if (result !== 'stream: OK') throw new Error('scanner_invalid_verdict');
      const after = await request('VERSION'); const scannedAt = now(); version(after, scannedAt);
      if (after !== before || !Number.isSafeInteger(scannedAt) || scannedAt < 0) throw new Error('scanner_signature_changed');
      return { verdict: 'clean', scanner: 'clamav', sha256: createHash('sha256').update(body).digest('hex'), byteLength: body.length, scannedAt, ...signature };
    } catch { return { verdict: 'error' }; }
  } };
}

/** Optional trusted env wiring. Partial/invalid configuration is an error scanner, never an unscanned fallback. */
export function createConfiguredBrowserFileScanner(env: NodeJS.ProcessEnv = process.env): BrowserFileScanner | undefined {
  const keys = ['BROWSER_FILE_CLAMAV_HOST', 'BROWSER_FILE_CLAMAV_PORT', 'BROWSER_FILE_CLAMAV_TIMEOUT_MS', 'BROWSER_FILE_CLAMAV_ALLOW_LOOPBACK'];
  if (!keys.some(key => env[key] !== undefined)) return undefined;
  try { return createClamAvBrowserFileScanner({ host: env.BROWSER_FILE_CLAMAV_HOST!, port: env.BROWSER_FILE_CLAMAV_PORT === undefined ? 3310 : Number(env.BROWSER_FILE_CLAMAV_PORT), timeoutMs: env.BROWSER_FILE_CLAMAV_TIMEOUT_MS === undefined ? 20000 : Number(env.BROWSER_FILE_CLAMAV_TIMEOUT_MS), allowLoopback: env.BROWSER_FILE_CLAMAV_ALLOW_LOOPBACK === 'true' }); }
  catch { return { scan: async () => ({ verdict: 'error' }) }; }
}
