import test from 'node:test';
import assert from 'node:assert/strict';
import type { CloudBrowserCdp } from './actions.js';

const moduleUnderTest = await import('./page-controls.js').catch((error: NodeJS.ErrnoException) => {
  if (error.code === 'ERR_MODULE_NOT_FOUND' && error.message.includes('page-controls.js')) return undefined;
  throw error;
});
const BrowserPageController = moduleUnderTest?.BrowserPageController;

class RecordingCdp implements CloudBrowserCdp {
  calls: Array<{ method: string; params: Record<string, unknown>; page?: string }> = [];
  response: (method: string, params: Record<string, unknown>) => Record<string, unknown> = (method, params) => {
    if (method === 'Target.getTargets') return { targetInfos: [{ type: 'page', targetId: 'owned-1', url: 'https://example.test/' }] };
    if (method === 'Target.attachToTarget') return { sessionId: 'session-1' };
    if (method === 'Target.createTarget') return { targetId: 'new-1' };
    if (method === 'Target.activateTarget') return {};
    if (method === 'Target.closeTarget') return { success: true };
    if (method === 'Page.getNavigationHistory') return { currentIndex: 1, entries: [{ id: 8, url: 'https://example.test/prev' }, { id: 9, url: 'https://example.test/current' }, { id: 10, url: 'https://example.test/next' }] };
    if (method === 'Page.getFrameTree') return { frameTree: { frame: { url: 'https://example.test/current' } } };
    if (method === 'DOM.performSearch') return { resultCount: 1, searchId: 'search-1' };
    if (method === 'DOM.getSearchResults') return { nodeIds: [41] };
    if (method === 'DOM.describeNode') return { node: { nodeName: 'SELECT', children: [
      { nodeName: 'OPTION', attributes: ['value', 'first'] },
      { nodeName: 'OPTION', attributes: ['value', 'chosen'] },
    ] } };
    return {};
  };
  async command(method: string, params: Record<string, unknown>, _timeout: number, page?: string): Promise<Record<string, unknown>> {
    this.calls.push({ method, params, page });
    return this.response(method, params);
  }
}

const remaining = () => 2_000;
const make = (cdp = new RecordingCdp(), overrides: Partial<{ selectedTargetId: string | null; dialogAcceptanceAuthorized: boolean }> = {}) => {
  const context = { ownedTargetIds: new Set(['owned-1']), selectedTargetId: overrides.selectedTargetId ?? 'owned-1', allowUrl: (url: string) => new URL(url).origin === 'https://example.test', dialogAcceptanceAuthorized: overrides.dialogAcceptanceAuthorized ?? false };
  return { cdp, context, controller: BrowserPageController && new BrowserPageController(cdp, context) };
};

test('typed control helper exists', () => {
  assert.ok(BrowserPageController, 'typed page controls implementation is required');
});

test('creates only allowlisted HTTPS tabs and records acknowledged target', async () => {
  assert.ok(BrowserPageController);
  const { cdp, context, controller } = make();
  const result = await controller!.execute({ type: 'tab_create', url: 'https://example.test/new' }, remaining);
  assert.deepEqual(result, { selectedTargetId: 'owned-1', createdTargetId: 'new-1', completed: true });
  assert.equal(context.selectedTargetId, 'owned-1');
  assert.equal(context.ownedTargetIds.has('new-1'), true);
  assert.equal(cdp.calls.some(call => call.method === 'Target.createTarget'), true);
});

test('legacy fixture host policy rejects attacker-controlled suffixes and userinfo', async () => {
  const { cdp, controller } = make();
  for (const url of ['https://example.test.attacker.test/', 'https://example.test@attacker.test/']) {
    await assert.rejects(controller!.execute({ type: 'tab_create', url }, remaining));
  }
  assert.equal(cdp.calls.length, 0);
});

test('trusted HTTP policy permits and reads back an HTTP page while HTTPS-only policy denies it', async () => {
  assert.ok(BrowserPageController);
  const { cdp } = make();
  cdp.response = (method) => method === 'Target.getTargets'
    ? { targetInfos: [{ type: 'page', targetId: 'owned-1', url: 'http://example.test/' }] }
    : method === 'Target.attachToTarget' ? { sessionId: 'session-1' }
      : method === 'Page.getFrameTree' ? { frameTree: { frame: { url: 'http://example.test/current' } } }
        : method === 'DOM.performSearch' ? { resultCount: 1, searchId: 'search-1' }
          : method === 'DOM.getSearchResults' ? { nodeIds: [41] } : {};
  const httpPolicy = new BrowserPageController(cdp, {
    ownedTargetIds: new Set(['owned-1']), selectedTargetId: 'owned-1',
    allowUrl: url => new URL(url).origin === 'http://example.test', dialogAcceptanceAuthorized: false,
  });
  await httpPolicy.execute({ type: 'focus', selector: '#search' }, remaining);
  assert.equal(cdp.calls.some(call => call.method === 'DOM.focus' && call.page === 'session-1'), true);
  const httpsOnlyPolicy = new BrowserPageController(cdp, {
    ownedTargetIds: new Set(['owned-1']), selectedTargetId: 'owned-1',
    allowUrl: url => new URL(url).origin === 'https://example.test', dialogAcceptanceAuthorized: false,
  });
  const before = cdp.calls.length;
  await assert.rejects(httpsOnlyPolicy.execute({ type: 'focus', selector: '#search' }, remaining), (error: Error & { code?: string }) => error.code === 'navigation_not_allowed');
  assert.equal(cdp.calls.slice(before).some(call => call.method === 'DOM.focus'), false);
});

test('HTTP tab creation follows the trusted URL policy and legacy HTTPS-only policy still denies it', async () => {
  assert.ok(BrowserPageController);
  const allowedCdp = new RecordingCdp();
  allowedCdp.response = (method) => method === 'Target.createTarget' ? { targetId: 'http-new' } : {};
  const allowed = new BrowserPageController(allowedCdp, {
    ownedTargetIds: new Set(['owned-1']), selectedTargetId: 'owned-1',
    allowUrl: url => new URL(url).origin === 'http://example.test', dialogAcceptanceAuthorized: false,
  });
  const receipt = await allowed.execute({ type: 'tab_create', url: 'http://example.test/new' }, remaining);
  assert.equal(receipt.createdTargetId, 'http-new');
  assert.equal(allowedCdp.calls.some(call => call.method === 'Target.createTarget'), true);

  const legacy = make();
  await assert.rejects(legacy.controller!.execute({ type: 'tab_create', url: 'http://example.test/new' }, remaining), (error: Error & { code?: string }) => error.code === 'navigation_not_allowed');
  assert.equal(legacy.cdp.calls.length, 0);
});

test('rejects unsafe intended/history/current URLs before action', async () => {
  assert.ok(BrowserPageController);
  const { cdp, controller } = make();
  const bad = (url: string) => url !== 'https://evil.test/' && !url.includes('/next');
  const c = new BrowserPageController(cdp, { ownedTargetIds: new Set(['owned-1']), selectedTargetId: 'owned-1', allowUrl: bad, dialogAcceptanceAuthorized: false });
  await assert.rejects(c.execute({ type: 'navigate_forward' }, remaining), (error: Error & { code?: string }) => error.code === 'navigation_not_allowed');
  assert.equal(cdp.calls.some(call => call.method === 'Page.goForward'), false);
  const before = cdp.calls.length;
  await assert.rejects(controller!.execute({ type: 'tab_create', url: 'https://evil.test/' }, remaining));
  assert.equal(cdp.calls.length, before);
});

test('refuses unknown or unowned targets before attachment', async () => {
  assert.ok(BrowserPageController);
  const { cdp, controller } = make();
  await assert.rejects(controller!.execute({ type: 'tab_select', targetId: 'other' }, remaining));
  await assert.rejects(controller!.execute({ type: 'tab_close', targetId: 'other' }, remaining));
  assert.equal(cdp.calls.some(call => call.method === 'Target.attachToTarget'), false);
});

test('close updates ownership and selection only after provider confirmation', async () => {
  assert.ok(BrowserPageController);
  const success = make();
  const receipt = await success.controller!.execute({ type: 'tab_close', targetId: 'owned-1' }, remaining);
  assert.equal(receipt.closedTargetId, 'owned-1');
  assert.equal(success.context.ownedTargetIds.has('owned-1'), false);
  assert.equal(success.context.selectedTargetId, null);

  const refused = make();
  refused.cdp.response = (method) => method === 'Target.getTargets'
    ? { targetInfos: [{ type: 'page', targetId: 'owned-1', url: 'https://example.test/' }] }
    : method === 'Target.closeTarget' ? { success: false } : {};
  await assert.rejects(refused.controller!.execute({ type: 'tab_close', targetId: 'owned-1' }, remaining));
  assert.equal(refused.context.ownedTargetIds.has('owned-1'), true);
  assert.equal(refused.context.selectedTargetId, 'owned-1');
});

test('uncertain create acknowledgement never invents or registers a target', async () => {
  assert.ok(BrowserPageController);
  const { cdp, context, controller } = make();
  cdp.response = () => ({});
  await assert.rejects(controller!.execute({ type: 'tab_create', url: 'https://example.test/new' }, remaining), (error: Error & { code?: string }) => error.code === 'target_create_uncertain');
  assert.deepEqual([...context.ownedTargetIds], ['owned-1']);
  assert.equal(context.selectedTargetId, 'owned-1');
});

test('back, forward, reload and focus use only typed commands on attached owned page', async () => {
  assert.ok(BrowserPageController);
  const { cdp, controller } = make();
  for (const action of [{ type: 'navigate_back' }, { type: 'navigate_forward' }, { type: 'reload' }, { type: 'focus', selector: '#search' }] as const) {
    await controller!.execute(action, remaining);
  }
  assert.deepEqual(cdp.calls.filter(call => call.method === 'Page.navigateToHistoryEntry' || call.method === 'Page.reload').map(call => call.method), ['Page.navigateToHistoryEntry', 'Page.navigateToHistoryEntry', 'Page.reload']);
  assert.equal(cdp.calls.some(call => call.method === 'DOM.focus' && call.page === 'session-1'), true);
  assert.equal(cdp.calls.every(call => !call.method.includes('Runtime.evaluate') && !call.method.includes('callFunctionOn')), true);
});

test('select rejects unknown values and wrong controls before keyboard input', async () => {
  assert.ok(BrowserPageController);
  const { cdp, controller } = make();
  cdp.response = (method) => method === 'Target.getTargets'
    ? { targetInfos: [{ type: 'page', targetId: 'owned-1', url: 'https://example.test/' }] }
    : method === 'Target.attachToTarget' ? { sessionId: 'session-1' }
      : method === 'Page.getFrameTree' ? { frameTree: { frame: { url: 'https://example.test/' } } }
        : method === 'DOM.performSearch' ? { resultCount: 1, searchId: 'search-1' }
          : method === 'DOM.getSearchResults' ? { nodeIds: [41] }
            : method === 'DOM.describeNode' ? { node: { nodeName: 'SELECT', backendNodeId: 501, children: [{ nodeName: 'OPTION', attributes: ['value', 'first'] }] } } : {};
  await assert.rejects(controller!.execute({ type: 'select', selector: 'select#choice', value: 'missing' }, remaining), (error: Error & { code?: string }) => error.code === 'option_not_found');
  cdp.response = (method) => method === 'Target.getTargets'
    ? { targetInfos: [{ type: 'page', targetId: 'owned-1', url: 'https://example.test/' }] }
    : method === 'Target.attachToTarget' ? { sessionId: 'session-1' }
      : method === 'Page.getFrameTree' ? { frameTree: { frame: { url: 'https://example.test/' } } }
        : method === 'DOM.performSearch' ? { resultCount: 1, searchId: 'search-1' }
          : method === 'DOM.getSearchResults' ? { nodeIds: [41] }
            : method === 'DOM.describeNode' ? { node: { nodeName: 'INPUT' } } : {};
  await assert.rejects(controller!.execute({ type: 'select', selector: 'input#choice', value: 'first' }, remaining), (error: Error & { code?: string }) => error.code === 'wrong_control');
  assert.equal(cdp.calls.some(call => call.method === 'Input.dispatchKeyEvent'), false);
  assert.equal(cdp.calls.some(call => call.method === 'Runtime.evaluate' || call.method === 'Runtime.callFunctionOn'), false);
});

test('native select uses keyboard input and verifies the selected option through a snapshot', async () => {
  assert.ok(BrowserPageController);
  const { cdp, controller } = make();
  let selectedIndex = 0;
  cdp.response = (method, params) => {
    if (method === 'Target.getTargets') return { targetInfos: [{ type: 'page', targetId: 'owned-1', url: 'https://example.test/' }] };
    if (method === 'Target.attachToTarget') return { sessionId: 'session-1' };
    if (method === 'Page.getFrameTree') return { frameTree: { frame: { url: 'https://example.test/' } } };
    if (method === 'DOM.performSearch') return { resultCount: 1, searchId: 'select-search' };
    if (method === 'DOM.getSearchResults') return { nodeIds: [41] };
    if (method === 'DOM.describeNode') return { node: { nodeName: 'SELECT', backendNodeId: 501, children: [
      { nodeName: 'OPTION', attributes: ['value', 'first'] },
      { nodeName: 'OPTION', attributes: ['value', 'chosen'] },
    ] } };
    if (method === 'Input.dispatchKeyEvent' && params.type === 'keyDown') {
      if (params.key === 'Home') selectedIndex = 0;
      if (params.key === 'ArrowDown') selectedIndex = Math.min(1, selectedIndex + 1);
    }
    if (method === 'DOMSnapshot.captureSnapshot') return { strings: ['SELECT', 'OPTION', 'value', 'first', 'chosen'], documents: [{ nodes: {
      nodeName: [0, 1, 1], backendNodeId: [501, 502, 503], parentIndex: [-1, 0, 0],
      attributes: [[], [2, 3], [2, 4]], optionSelected: { index: [selectedIndex + 1] },
    } }] };
    return {};
  };
  await controller!.execute({ type: 'select', selector: 'select#choice', value: 'chosen' }, remaining);
  assert.deepEqual(cdp.calls.filter(call => call.method === 'Input.dispatchKeyEvent' && call.params.type === 'keyDown').map(call => call.params.key), ['Home', 'ArrowDown']);
  assert.equal(cdp.calls.some(call => call.method === 'DOMSnapshot.captureSnapshot'), true);
  assert.equal(cdp.calls.some(call => call.method === 'Runtime.evaluate' || call.method === 'Runtime.callFunctionOn'), false);
});

test('tab activation treats an empty CDP result as acknowledged success', async () => {
  assert.ok(BrowserPageController);
  const { cdp, context, controller } = make();
  const receipt = await controller!.execute({ type: 'tab_select', targetId: 'owned-1' }, remaining);
  assert.equal(receipt.selectedTargetId, 'owned-1');
  assert.equal(context.selectedTargetId, 'owned-1');
  assert.equal(cdp.calls.some(call => call.method === 'Target.activateTarget'), true);
});

test('history navigation uses a verified CDP entry id', async () => {
  assert.ok(BrowserPageController);
  const back = make();
  await back.controller!.execute({ type: 'navigate_back' }, remaining);
  assert.deepEqual(back.cdp.calls.find(call => call.method === 'Page.navigateToHistoryEntry')?.params, { entryId: 8 });
  const forward = make();
  await forward.controller!.execute({ type: 'navigate_forward' }, remaining);
  assert.deepEqual(forward.cdp.calls.find(call => call.method === 'Page.navigateToHistoryEntry')?.params, { entryId: 10 });
  assert.equal(back.cdp.calls.some(call => call.method === 'Page.goBack'), false);
});

test('history navigation rejects malformed indices or entry ids before navigation', async () => {
  assert.ok(BrowserPageController);
  const badIndex = make();
  badIndex.cdp.response = (method) => method === 'Page.getNavigationHistory'
    ? { currentIndex: 1.5, entries: [{ id: 8, url: 'https://example.test/prev' }, { id: 9, url: 'https://example.test/current' }, { id: 10, url: 'https://example.test/next' }] }
    : method === 'Target.getTargets' ? { targetInfos: [{ type: 'page', targetId: 'owned-1', url: 'https://example.test/' }] }
      : method === 'Target.attachToTarget' ? { sessionId: 'session-1' }
        : method === 'Page.getFrameTree' ? { frameTree: { frame: { url: 'https://example.test/current' } } } : {};
  await assert.rejects(badIndex.controller!.execute({ type: 'navigate_back' }, remaining), (error: Error & { code?: string }) => error.code === 'navigation_state_unknown');
  assert.equal(badIndex.cdp.calls.some(call => call.method === 'Page.navigateToHistoryEntry'), false);

  const badId = make();
  badId.cdp.response = (method) => method === 'Page.getNavigationHistory'
    ? { currentIndex: 1, entries: [{ id: Number.MAX_SAFE_INTEGER + 1, url: 'https://example.test/prev' }, { id: 9, url: 'https://example.test/current' }, { id: 10, url: 'https://example.test/next' }] }
    : method === 'Target.getTargets' ? { targetInfos: [{ type: 'page', targetId: 'owned-1', url: 'https://example.test/' }] }
      : method === 'Target.attachToTarget' ? { sessionId: 'session-1' }
        : method === 'Page.getFrameTree' ? { frameTree: { frame: { url: 'https://example.test/current' } } } : {};
  await assert.rejects(badId.controller!.execute({ type: 'navigate_back' }, remaining), (error: Error & { code?: string }) => error.code === 'navigation_state_unknown');
  assert.equal(badId.cdp.calls.some(call => call.method === 'Page.navigateToHistoryEntry'), false);
});

test('rejects extra action fields before sending any CDP command', async () => {
  assert.ok(BrowserPageController);
  const { cdp, controller } = make();
  await assert.rejects(controller!.execute({ type: 'reload', arbitrary: true } as never, remaining), (error: Error & { code?: string }) => error.code === 'invalid_action');
  await assert.rejects(controller!.execute({ type: 'toString' } as never, remaining), (error: Error & { code?: string }) => error.code === 'invalid_action');
  assert.equal(cdp.calls.length, 0);
});

test('dialog accept needs authorization and dismiss rejects prompt text', async () => {
  assert.ok(BrowserPageController);
  const unauthorized = make();
  await assert.rejects(unauthorized.controller!.execute({ type: 'dialog', accept: true }, remaining));
  assert.equal(unauthorized.cdp.calls.some(call => call.method === 'Page.handleJavaScriptDialog'), false);
  const authorized = make(new RecordingCdp(), { dialogAcceptanceAuthorized: true });
  await authorized.controller!.execute({ type: 'dialog', accept: true, promptText: 'safe' }, remaining);
  assert.deepEqual(authorized.cdp.calls.find(call => call.method === 'Page.handleJavaScriptDialog')?.params, { accept: true, promptText: 'safe' });
  await assert.rejects(authorized.controller!.execute({ type: 'dialog', accept: false, promptText: 'no' }, remaining));
});

test('rejects malformed bounds and sanitizes provider errors', async () => {
  assert.ok(BrowserPageController);
  const { cdp, controller } = make();
  await assert.rejects(controller!.execute({ type: 'focus', selector: `a${'x'.repeat(256)}` }, remaining));
  await assert.rejects(controller!.execute({ type: 'select', selector: '#x', value: 'x\u0001' }, remaining));
  cdp.response = () => { throw new Error('private provider detail'); };
  await assert.rejects(controller!.execute({ type: 'tab_select', targetId: 'owned-1' }, remaining), (error: Error) => !error.message.includes('private provider detail'));
});
