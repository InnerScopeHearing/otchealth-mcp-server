import { createReadStream, realpathSync, statSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, extname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

const MAX_ASSET_BYTES = 8 * 1024 * 1024;
const ASSET_PREFIX = '/browser/login/assets/';
const SDK_ASSET_SUBDIR = 'nice-dcv-web-client-sdk';
const MIME_TYPES: Record<string, string> = {
  '.js': 'application/javascript; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

function securityHeaders(reply: FastifyReply, nonce?: string): void {
  const scriptSource = nonce ? `'self' 'nonce-${nonce}'` : "'self'";
  reply
    .header('cache-control', 'no-store, max-age=0')
    .header('pragma', 'no-cache')
    .header('referrer-policy', 'no-referrer')
    .header('x-content-type-options', 'nosniff')
    .header('cross-origin-resource-policy', 'same-origin')
    // DCV independently attempts async clipboard sync on focus even when its
    // clipboardAutoSync option is false. Permit only explicit native gestures.
    .header('permissions-policy', 'clipboard-read=(), clipboard-write=()')
    .header('content-security-policy', [
      "default-src 'none'",
      `script-src ${scriptSource}`,
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "font-src 'self' data:",
      "connect-src 'self' https: wss:",
      "worker-src 'self' blob:",
      "media-src 'self' blob:",
      "base-uri 'none'",
      "form-action 'self'",
      "frame-ancestors 'none'",
      "object-src 'none'",
    ].join('; '));
}

function renderLoginPage(nonce: string, website = false): string {
  const routePrefix = website ? '/browser/connect' : '/browser/login';
  const title = website ? 'Connect your browser' : 'Connect to Intercom';
  const heading = website ? 'Connect your browser' : 'Connect to your Intercom workspace';
  const instructions = website
    ? 'Sign in to the requested website in the secure window below, then open its signed-in workspace, feed, or editor. Confirm that the account is correct before clicking Done. Enter your password or verification code only in that window. Never paste credentials into chat or this page.'
    : 'Sign in to the company workspace in the secure window below, then open its Settings page. Confirm that the signed-in company and account are correct before clicking Done. Enter your password or verification code only in that window. Never paste credentials into chat or this page.';
  const windowLabel = website ? 'Website sign-in window' : 'Company sign-in window';
  const doneLabel = website ? 'Done, I confirm the account' : 'Done, I confirm the company account';
  const signInMessage = website ? 'Sign in to the requested website in the window below.' : 'Sign in to your company workspace in the window below.';
  const connectedMessage = website ? 'Open the signed-in workspace, feed, or editor, confirm the correct account, then select Done.' : 'Sign in to your company workspace, then select Done.';
  const savedMessage = website ? 'Your browser profile is saved. Your agent will reopen it to verify access. You may close this page.' : 'Your owned browser profile is saved. Your COO can now verify Settings access. You may close this page.';
  const saveError = website ? 'Your sign-in could not be saved. Request a fresh sign-in link from your agent.' : 'Your sign-in could not be saved. Request a fresh sign-in link from your COO agent.';
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="referrer" content="no-referrer">
  <title>${title}</title>
  <style nonce="${nonce}">
    :root { color-scheme: light; font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #17212b; background: #f4f6f8; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px; }
    main { width: min(100%, 1280px); }
    .card { background: white; border: 1px solid #d9e0e6; border-radius: 12px; padding: 24px; box-shadow: 0 4px 18px #17212b12; }
    h1 { font-size: clamp(1.35rem, 3vw, 1.8rem); margin: 0 0 8px; }
    p { line-height: 1.5; margin: 8px 0; }
    .note { color: #435363; max-width: 75ch; }
    #status { min-height: 1.5em; color: #34495e; font-weight: 600; }
    #status[data-error="true"] { color: #9b1c1c; }
    #stage { display: none; width: min(100%, calc((100vh - 260px) * 16 / 9)); min-width: 280px; aspect-ratio: 16 / 9; margin: 20px auto; overflow: hidden; border: 1px solid #aebbc6; border-radius: 8px; background: #111820; }
    #dcv-display { width: 100%; height: 100%; }
    .actions { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; margin-top: 16px; }
    button { min-height: 44px; padding: 10px 20px; border: 0; border-radius: 6px; font: inherit; font-weight: 650; cursor: pointer; }
    button.primary { color: white; background: #146c5a; }
    button:disabled { opacity: .55; cursor: not-allowed; }
    .legal { font-size: .85rem; color: #52616e; margin-top: 18px; }
    .legal a { color: #145f83; }
    @media (max-width: 560px) { body { padding: 12px; } .card { padding: 18px; } #stage { min-width: 0; width: 100%; } }
  </style>
  <script src="${ASSET_PREFIX}dcvjs-umd/dcv.js"></script>
</head>
<body>
  <main>
    <section class="card" aria-labelledby="title">
      <h1 id="title">${heading}</h1>
      <p class="note">${instructions}</p>
      <p id="status" role="status" aria-live="polite">Preparing your secure sign-in window…</p>
      <div id="stage" aria-label="${windowLabel}"><div id="dcv-display" tabindex="0"></div></div>
      <div class="actions">
        <button id="clipboard-paste" type="button" disabled>Paste text into browser</button>
        <button id="clipboard-copy" type="button" disabled>Copy browser text</button>
        <button id="done" class="primary" type="button" disabled>${doneLabel}</button>
      </div>
      <p id="clipboard-status" class="note" role="status" aria-live="polite">Clipboard sharing is manual. To copy, select text in the secure window and press Ctrl+C or Command+C, then choose Copy browser text.</p>
      <p class="legal">The secure connection uses Amazon DCV. <a href="${ASSET_PREFIX}dcvjs-umd/EULA.txt" target="_blank" rel="noopener">License</a> · <a href="${ASSET_PREFIX}dcvjs-umd/third-party-licenses.txt" target="_blank" rel="noopener">Third-party notices</a></p>
    </section>
  </main>
  <script nonce="${nonce}">
  (() => {
    'use strict';
    const statusNode = document.getElementById('status');
    const stage = document.getElementById('stage');
    const done = document.getElementById('done');
    const paste = document.getElementById('clipboard-paste');
    const copy = document.getElementById('clipboard-copy');
    const clipboardStatus = document.getElementById('clipboard-status');
    let connection = null;
    let busy = false;
    let clipboardClosed = false;
    let clipboardArmed = false;
    ${website ? 'let terminal = false;' : ''}
    ${website ? 'let handoffId = null;' : ''}
    ${website ? `const handoffStorageKey = 'otc.website-login.handoff:/browser/connect';
    function storedHandoff() {
      try {
        const value = window.sessionStorage.getItem(handoffStorageKey);
        return typeof value === 'string' && /^[a-f0-9]{32}$/.test(value) ? value : null;
      } catch { return null; }
    }
    function rememberHandoff(value) {
      try { window.sessionStorage.setItem(handoffStorageKey, value); } catch { /* Initial sign-in works without storage. */ }
    }
    function forgetHandoff() {
      try { window.sessionStorage.removeItem(handoffStorageKey); } catch { /* Storage may be unavailable. */ }
    }` : ''}

    function show(message, isError = false) {
      statusNode.textContent = message;
      statusNode.dataset.error = String(isError);
    }

    function clipboardAvailable() {
      return connection && !busy && !clipboardClosed
        && typeof connection.captureClipboardEvents === 'function'
        && typeof connection.syncClipboards === 'function';
    }

    function showClipboard(message, isError = false) {
      clipboardStatus.textContent = message;
      clipboardStatus.dataset.error = String(isError);
    }

    function disarmClipboard() {
      if (!clipboardArmed) return;
      clipboardArmed = false;
      try { connection?.captureClipboardEvents(false, window); } catch { /* Already disconnected. */ }
    }

    function closeClipboard() {
      disarmClipboard();
      clipboardClosed = true;
      paste.disabled = true;
      copy.disabled = true;
    }

    function clipboardEvent(event) {
      if (!clipboardAvailable()) return;
      // Inspect only the event name, never clipboardData or provider error text.
      if (event?.name === 'paste') {
        disarmClipboard();
        showClipboard('Paste captured for this browser. Verify the text in the secure window.');
      } else if (event?.name === 'remoteError' || event?.name === 'dataSizeAlert') {
        disarmClipboard();
        showClipboard('Clipboard text could not be transferred. Try selecting and copying plain text again.', true);
      }
    }

    paste.addEventListener('click', () => {
      if (!clipboardAvailable()) return;
      try {
        connection.captureClipboardEvents(true, window);
        clipboardArmed = true;
        document.getElementById('dcv-display').focus();
        showClipboard('Click the destination in the secure window, then press Ctrl+V (Windows) or Command+V (Mac).');
      } catch {
        disarmClipboard();
        showClipboard('Clipboard paste is unavailable in this browser. Type directly in the secure window.', true);
      }
    });

    copy.addEventListener('click', () => {
      if (!clipboardAvailable()) return;
      const activeConnection = connection;
      const keepArmed = clipboardArmed;
      try {
        activeConnection.captureClipboardEvents(true, window);
        if (!activeConnection.syncClipboards()) throw new Error('copy_unavailable');
        showClipboard('Browser text copied to this device clipboard.');
      } catch {
        showClipboard('Copy is unavailable. Select text in the secure window and press Ctrl+C or Command+C, then try again.', true);
      } finally {
        if (!keepArmed) {
          try { activeConnection.captureClipboardEvents(false, window); } catch { /* Already disconnected. */ }
        }
      }
    });

    async function postJson(path, body) {
      const headers = { accept: 'application/json' };
      if (body !== undefined) headers['content-type'] = 'application/json';
      const response = await fetch(path, {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        redirect: 'error',
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (!response.ok) {
        ${website ? "if (path === '/browser/connect/resume' && response.status === 409) forgetHandoff();" : ''}
        throw new Error('request_failed');
      }
      return response.json();
    }

    async function start() {
      const fragment = new URLSearchParams(window.location.hash.slice(1));
      const token = fragment.get('token');
      // Remove the one-time link token from browser history before sending it to the server.
      history.replaceState(null, '', window.location.pathname);
      ${website ? 'if (token !== null) forgetHandoff();\n      else handoffId = storedHandoff();' : ''}
      if (${website ? '(!token && !handoffId)' : '!token'} || (token && token.length > 8192) || !window.dcv) {
        show('This sign-in link is unavailable or expired. Request a new link from your administrator.', true);
        return;
      }
      show('Preparing your secure sign-in window…');
      try {
        const result = ${website ? "token !== null ? await postJson('/browser/connect/exchange', { token }) : await postJson('/browser/connect/resume', { handoff_id: handoffId })" : "await postJson('/browser/login/exchange', { token })"};
        if (result.status !== 'login_required' || typeof result.signed_url !== 'string' || !Number.isSafeInteger(result.expires_at) || typeof result.workspace_id !== 'string') throw new Error('invalid_response');
        ${website ? "if (typeof result.handoff_id !== 'string' || !/^[a-f0-9]{32}$/.test(result.handoff_id) || (token === null && result.handoff_id !== handoffId)) throw new Error('invalid_response');\n        handoffId = result.handoff_id;\n        rememberHandoff(handoffId);" : ''}
        ${website ? "if (typeof result.site_label === 'string' && result.site_label) document.getElementById('title').textContent = 'Connect your browser: ' + result.site_label;" : ''}
        const signedUrl = result.signed_url;
        if (!signedUrl.startsWith('https://')) throw new Error('invalid_response');
        const extraParams = () => new URL(signedUrl).searchParams;
        window.dcv.setLogLevel(window.dcv.LogLevel.SILENT);
        stage.style.display = 'block';
        show('${signInMessage}');
        window.dcv.authenticate(signedUrl, {
          promptCredentials: () => {},
          httpExtraSearchParams: extraParams,
          error: () => show('The secure sign-in window could not connect. Request a new link or try again later.', true),
          success: (_auth, resultList) => {
            const auth = Array.isArray(resultList) ? resultList[0] : null;
            if (!auth || typeof auth.sessionId !== 'string' || typeof auth.authToken !== 'string') {
              show('The secure sign-in window could not connect. Request a new link or try again later.', true);
              return;
            }
            window.dcv.connect({
              url: signedUrl,
              sessionId: auth.sessionId,
              authToken: auth.authToken,
              baseUrl: '${ASSET_PREFIX}dcvjs-umd',
              divId: 'dcv-display',
              clipboardAutoSync: false,
              observers: {
                httpExtraSearchParams: extraParams,
                clipboardEvent,
                disconnect: () => {
                  const wasOpen = !clipboardClosed;
                  closeClipboard();
                  connection = null;
                  done.disabled = true;
                  if (wasOpen) show('The secure sign-in window disconnected. Request a fresh link to continue.', true);
                },
              },
            }).then((activeConnection) => {
              if (clipboardClosed) { activeConnection.disconnect(); return; }
              connection = activeConnection;
              if (typeof connection.captureClipboardEvents === 'function') connection.captureClipboardEvents(false, window);
              done.disabled = false;
              paste.disabled = !clipboardAvailable();
              copy.disabled = !clipboardAvailable();
              show('${connectedMessage}');
            }).catch(() => show('The secure sign-in window could not connect. Request a new link or try again later.', true));
          },
        });
      } catch {
        show('This sign-in link is unavailable or expired. Request a new link from your administrator.', true);
      }
    }

    done.addEventListener('click', async () => {
      if (busy || done.disabled${website ? ' || terminal' : ''}) return;
      busy = true;
      closeClipboard();
      ${website ? 'terminal = true;' : ''}
      ${website ? 'forgetHandoff();' : ''}
      done.disabled = true;
      show('Saving your secure sign-in…');
      try {
        const result = await postJson('${routePrefix}/complete'${website ? ', { handoff_id: handoffId }' : ''});
        if (result.status !== 'saved' || typeof result.workspace_id !== 'string') throw new Error('save_failed');
        connection?.disconnect();
        connection = null;
        stage.style.display = 'none';
        show('${savedMessage}');
      } catch {
        show('${saveError}', true);
        done.disabled = ${website};
      } finally {
        busy = false;
      }
    });

    window.addEventListener('pagehide', () => { closeClipboard(); connection?.disconnect(); }, { once: true });
    start();
  })();
  </script>
</body>
</html>`;
}

function sdkAssetRoot(): string {
  const entry = fileURLToPath(import.meta.resolve('bedrock-agentcore/browser/live-view'));
  return resolve(dirname(entry), SDK_ASSET_SUBDIR);
}

function sendAsset(request: FastifyRequest, reply: FastifyReply, root: string): void {
  securityHeaders(reply);
  const requested = (request.params as { '*': string })['*'];
  if (!requested || requested.includes('\\') || requested.includes('\0')) {
    reply.code(404).send();
    return;
  }
  const target = resolve(root, requested);
  const rel = relative(root, target);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) {
    reply.code(404).send();
    return;
  }
  const ext = extname(target).toLowerCase();
  const type = MIME_TYPES[ext];
  if (!type) {
    reply.code(404).send();
    return;
  }
  try {
    const actual = realpathSync(target);
    const rootActual = realpathSync(root);
    const actualRel = relative(rootActual, actual);
    if (!actualRel || actualRel.startsWith('..') || isAbsolute(actualRel)) {
      reply.code(404).send();
      return;
    }
    const stat = statSync(actual);
    if (!stat.isFile() || stat.size > MAX_ASSET_BYTES) {
      reply.code(404).send();
      return;
    }
    reply.type(type).header('content-length', String(stat.size)).send(createReadStream(actual));
  } catch {
    reply.code(404).send();
  }
}

/** Register the human sign-in page and same-origin vendored NICE DCV assets. */
export function registerIntercomLoginPage(app: FastifyInstance): void {
  const assetRoot = sdkAssetRoot();

  app.get('/browser/login', async (_request, reply) => {
    const nonce = randomBytes(18).toString('base64');
    securityHeaders(reply, nonce);
    return reply.type('text/html; charset=utf-8').send(renderLoginPage(nonce));
  });

  app.get('/browser/login/assets/*', (request, reply) => sendAsset(request, reply, assetRoot));
}

/** Reuse the Intercom viewer's vendored SDK without registering a second asset route. */
export function registerWebsiteLoginPage(app: FastifyInstance): void {
  app.get('/browser/connect', async (_request, reply) => {
    const nonce = randomBytes(18).toString('base64');
    securityHeaders(reply, nonce);
    return reply.type('text/html; charset=utf-8').send(renderLoginPage(nonce, true));
  });
}
