import test from 'node:test';
import assert from 'node:assert/strict';
import type { CloudBrowserCdp } from './actions.js';
const implementation = await import('./actions.js').catch((error: NodeJS.ErrnoException) => { if (error.code === 'ERR_MODULE_NOT_FOUND') return undefined; throw error; });
const executeCloudBrowserInteraction = implementation?.executeCloudBrowserInteraction;
const validateCloudBrowserAction = implementation?.validateCloudBrowserAction;

class RecordingCdp implements CloudBrowserCdp {
  readonly calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  async command(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.calls.push({ method, params });
    if (method === 'DOM.performSearch') return { resultCount: 1, searchId: 'query' };
    if (method === 'DOM.getSearchResults') return { nodeIds: [42] };
    if (method === 'DOM.getBoxModel') return { model: { content: [0, 0, 20, 0, 20, 10, 0, 10] } };
    return {};
  }
}

test('right/double click uses typed mouse commands and the located element centre', async () => {
  assert.ok(executeCloudBrowserInteraction && validateCloudBrowserAction, 'typed browser interaction support is missing');
  for (const button of ['left', 'right'] as const) {
    const cdp = new RecordingCdp();
    await executeCloudBrowserInteraction(cdp, 'page', validateCloudBrowserAction({ type: 'click', selector: '#target', button, clickCount: 2 }), () => 1000);
    assert.deepEqual(cdp.calls.filter(x => x.method === 'Input.dispatchMouseEvent').map(x => x.params), [
      { type: 'mousePressed', x: 10, y: 5, button, clickCount: 1 },
      { type: 'mouseReleased', x: 10, y: 5, button, clickCount: 1 },
      { type: 'mousePressed', x: 10, y: 5, button, clickCount: 2 },
      { type: 'mouseReleased', x: 10, y: 5, button, clickCount: 2 },
    ]);
    assert.equal(cdp.calls.some(x => x.method === 'Runtime.evaluate'), false);
  }
});

test('keyboard shortcuts produce bounded keydown/up commands, never arbitrary script', async () => {
  assert.ok(executeCloudBrowserInteraction && validateCloudBrowserAction, 'typed browser interaction support is missing');
  const cdp = new RecordingCdp();
  await executeCloudBrowserInteraction(cdp, 'page', validateCloudBrowserAction({ type: 'press_key', key: 'KeyA', modifiers: 2 }), () => 1000);
  assert.deepEqual(cdp.calls.map(x => x.params.type), ['keyDown', 'keyUp']);
  assert.equal(cdp.calls[0].params.code, 'KeyA');
  assert.equal(cdp.calls[0].params.modifiers, 2);
  assert.equal(cdp.calls[0].params.text, undefined);
  assert.equal(cdp.calls.every(x => x.method === 'Input.dispatchKeyEvent'), true);
});

test('scroll and mouse movement carry validated viewport coordinates', async () => {
  assert.ok(executeCloudBrowserInteraction && validateCloudBrowserAction, 'typed browser interaction support is missing');
  const cdp = new RecordingCdp();
  await executeCloudBrowserInteraction(cdp, 'page', validateCloudBrowserAction({ type: 'scroll', x: 50, y: 60, deltaX: 0, deltaY: -100 }), () => 1000);
  await executeCloudBrowserInteraction(cdp, 'page', validateCloudBrowserAction({ type: 'mouse_move', x: 75, y: 80 }), () => 1000);
  assert.deepEqual(cdp.calls.map(x => x.params), [
    { type: 'mouseWheel', x: 50, y: 60, deltaX: 0, deltaY: -100 },
    { type: 'mouseMoved', x: 75, y: 80 },
  ]);
});

test('drag releases the mouse even when an intermediate move fails', async () => {
  assert.ok(executeCloudBrowserInteraction && validateCloudBrowserAction, 'typed browser interaction support is missing');
  const cdp = new RecordingCdp();
  const original = cdp.command.bind(cdp);
  cdp.command = async (method, params) => { const result = await original(method, params); if (params.type === 'mouseMoved' && params.buttons === 1) throw new Error('synthetic move failure'); return result; };
  await assert.rejects(executeCloudBrowserInteraction(cdp, 'page', validateCloudBrowserAction({ type: 'drag', fromX: 10, fromY: 20, toX: 30, toY: 40, steps: 3 }), () => 1000), /synthetic move failure/);
  assert.equal(cdp.calls.at(-1)?.params.type, 'mouseReleased');
  assert.equal(cdp.calls.at(-1)?.params.x, 10 + 20 / 3);
  assert.equal(cdp.calls.at(-1)?.params.y, 20 + 20 / 3);
});

test('unbounded, malformed and arbitrary commands are rejected before the provider', () => {
  assert.ok(validateCloudBrowserAction, 'typed browser validation is missing');
  for (const action of [
    { type: 'press_key', key: 'eval(console.log(1))' },
    { type: 'press_key', key: 'Enter', modifiers: 16 },
    { type: 'scroll', x: -1, y: 0, deltaX: 0, deltaY: 2 },
    { type: 'mouse_move', x: Infinity, y: 0 },
    { type: 'drag', fromX: 0, fromY: 0, toX: 10, toY: 10, steps: 1000 },
    { type: 'click', selector: '#x', button: 'unknown' },
    { type: 'click', selector: '#x', clickCount: 100 },
    { type: 'click', selector: '#x\nscript' },
    { type: 'click', selector: '#x', method: 'Runtime.evaluate' },
  ]) assert.throws(() => validateCloudBrowserAction(action));
});

test('capture is a strict typed screenshot or PDF request', () => {
  assert.ok(validateCloudBrowserAction);
  assert.deepEqual(validateCloudBrowserAction({ type: 'capture', request: { type: 'screenshot', format: 'jpeg' } }), { type: 'capture', request: { type: 'screenshot', format: 'jpeg' } });
  assert.deepEqual(validateCloudBrowserAction({ type: 'capture', request: { type: 'pdf', landscape: true } }), { type: 'capture', request: { type: 'pdf', landscape: true } });
  for (const input of [
    { type: 'capture', request: { type: 'pdf', filePath: '/tmp/x' } },
    { type: 'capture', request: { type: 'screenshot', format: 'svg' } },
    { type: 'capture', request: { type: 'screenshot' }, method: 'Runtime.evaluate' },
  ]) assert.throws(() => validateCloudBrowserAction(input));
});

test('keyboard release is attempted when the action deadline expires after keydown', async () => {
  assert.ok(executeCloudBrowserInteraction && validateCloudBrowserAction);
  const cdp = new RecordingCdp();
  let budgetReads = 0;
  await executeCloudBrowserInteraction(cdp, 'page', validateCloudBrowserAction({ type: 'press_key', key: 'Enter' }), () => {
    if (++budgetReads > 1) throw new Error('synthetic expired deadline');
    return 1000;
  });
  assert.deepEqual(cdp.calls.map(x => x.params.type), ['keyDown', 'keyUp']);
});

test('click release is attempted when the action deadline expires after mouse press', async () => {
  assert.ok(executeCloudBrowserInteraction && validateCloudBrowserAction);
  const cdp = new RecordingCdp();
  const original = cdp.command.bind(cdp);
  let pressed = false;
  cdp.command = async (method, params) => { const result = await original(method, params); if (params.type === 'mousePressed') pressed = true; return result; };
  await executeCloudBrowserInteraction(cdp, 'page', validateCloudBrowserAction({ type: 'click', selector: '#target' }), () => {
    if (pressed) throw new Error('synthetic expired deadline');
    return 1000;
  });
  assert.equal(cdp.calls.at(-1)?.params.type, 'mouseReleased');
});

test('a failed drag release cannot replace the primary movement failure', async () => {
  assert.ok(executeCloudBrowserInteraction && validateCloudBrowserAction);
  const cdp = new RecordingCdp();
  const original = cdp.command.bind(cdp);
  cdp.command = async (method, params) => {
    const result = await original(method, params);
    if (params.buttons === 1) throw new Error('synthetic primary move failure');
    if (params.type === 'mouseReleased') throw new Error('synthetic cleanup failure');
    return result;
  };
  await assert.rejects(executeCloudBrowserInteraction(cdp, 'page', validateCloudBrowserAction({ type: 'drag', fromX: 1, fromY: 2, toX: 3, toY: 4 }), () => 1000), /synthetic primary move failure/);
  assert.equal(cdp.calls.at(-1)?.params.type, 'mouseReleased');
});

test('selector search resources are discarded when no element matches', async () => {
  assert.ok(executeCloudBrowserInteraction && validateCloudBrowserAction);
  const cdp = new RecordingCdp();
  const original = cdp.command.bind(cdp);
  cdp.command = async (method, params) => { const result = await original(method, params); return method === 'DOM.performSearch' ? { resultCount: 0, searchId: 'query' } : result; };
  await assert.rejects(executeCloudBrowserInteraction(cdp, 'page', validateCloudBrowserAction({ type: 'wait_for', selector: '#missing' }), () => 1000), /did not match/);
  assert.equal(cdp.calls.at(-1)?.method, 'DOM.discardSearchResults');
});

test('Enter and printable keys include CDP text unless a shortcut modifier suppresses it', async () => {
  assert.ok(executeCloudBrowserInteraction && validateCloudBrowserAction);
  for (const [key, modifiers, expected] of [['Enter', 0, '\r'], ['Space', 0, ' '], ['KeyA', 0, 'a'], ['KeyA', 8, 'A'], ['Enter', 2, undefined], ['KeyA', 1, undefined]] as const) {
    const cdp = new RecordingCdp();
    await executeCloudBrowserInteraction(cdp, 'page', validateCloudBrowserAction({ type: 'press_key', key, modifiers }), () => 1000);
    assert.equal(cdp.calls[0].params.text, expected);
    assert.equal(cdp.calls[1].params.text, undefined);
  }
});

test('drag attempts release after a lost mouse-press acknowledgement', async () => {
  assert.ok(executeCloudBrowserInteraction && validateCloudBrowserAction);
  const cdp = new RecordingCdp();
  const original = cdp.command.bind(cdp);
  cdp.command = async (method, params) => { const result = await original(method, params); if (params.type === 'mousePressed') throw new Error('synthetic lost press acknowledgement'); return result; };
  await assert.rejects(executeCloudBrowserInteraction(cdp, 'page', validateCloudBrowserAction({ type: 'drag', fromX: 1, fromY: 2, toX: 3, toY: 4 }), () => 1000), /lost press acknowledgement/);
  assert.equal(cdp.calls.at(-1)?.params.type, 'mouseReleased');
});
