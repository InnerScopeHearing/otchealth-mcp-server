import { CloudBrowserError } from './contract.js';
import type { CloudBrowserCdp } from './actions.js';

export type BrowserPageAction =
  | { type: 'tab_create'; url: string }
  | { type: 'tab_select' | 'tab_close'; targetId: string }
  | { type: 'navigate_back' | 'navigate_forward' | 'reload' }
  | { type: 'focus'; selector: string }
  | { type: 'select'; selector: string; value: string }
  | { type: 'dialog'; accept: boolean; promptText?: string };

export interface BrowserPageReceipt {
  selectedTargetId: string | null;
  createdTargetId?: string;
  closedTargetId?: string;
  completed: true;
}

export interface BrowserPageContext {
  ownedTargetIds: Set<string>;
  selectedTargetId: string | null;
  allowUrl: (url: string) => boolean;
  dialogAcceptanceAuthorized: boolean;
}

const fail = (code: string, message: string): never => { throw new CloudBrowserError(code, message); };
const checkedString = (value: unknown, limit: number, allowControls = false): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= limit && (allowControls || !/[\u0000-\u001f\u007f]/.test(value));
const boundedText = (value: unknown, limit: number): value is string =>
  typeof value === 'string' && value.length <= limit && !/[\u0000-\u001f\u007f]/.test(value);

/** Exposes a deliberately small set of typed browser controls for already-owned tabs. */
export class BrowserPageController {
  constructor(private readonly cdp: CloudBrowserCdp, private readonly context: BrowserPageContext) {}

  async execute(action: BrowserPageAction, remaining: () => number): Promise<BrowserPageReceipt> {
    this.validate(action);
    const command = async (method: string, params: Record<string, unknown> = {}, page?: string): Promise<Record<string, unknown>> => {
      let timeout: number;
      try { timeout = remaining(); } catch { return fail('provider_timeout', 'Browser action exceeded its deadline.'); }
      if (!Number.isFinite(timeout) || timeout <= 0) return fail('provider_timeout', 'Browser action exceeded its deadline.');
      try { return await this.cdp.command(method, params, timeout, page); }
      catch (error) {
        if (error instanceof CloudBrowserError) throw error;
        throw new CloudBrowserError('provider_action_failed', 'The browser control could not be completed.');
      }
    };
    const success = (): BrowserPageReceipt => ({ selectedTargetId: this.context.selectedTargetId, completed: true });

    if (action.type === 'tab_create') {
      this.assertAllowed(action.url);
      let created: Record<string, unknown>;
      try { created = await command('Target.createTarget', { url: action.url }); }
      catch { return fail('target_create_uncertain', 'The tab creation result is uncertain; do not retry automatically.'); }
      if (!checkedString(created.targetId, 256)) return fail('target_create_uncertain', 'The tab creation result is uncertain; do not retry automatically.');
      const targetId = created.targetId;
      this.context.ownedTargetIds.add(targetId);
      return { selectedTargetId: this.context.selectedTargetId, createdTargetId: targetId, completed: true };
    }

    if (action.type === 'tab_select') {
      this.assertOwned(action.targetId);
      const target = await this.targetInfo(action.targetId, command);
      this.assertAllowed(target.url);
      await command('Target.activateTarget', { targetId: action.targetId });
      this.context.selectedTargetId = action.targetId;
      return success();
    }

    if (action.type === 'tab_close') {
      this.assertOwned(action.targetId);
      const target = await this.targetInfo(action.targetId, command);
      this.assertAllowed(target.url);
      const result = await command('Target.closeTarget', { targetId: action.targetId });
      if (result.success !== true) return fail('target_operation_failed', 'The owned tab close was not confirmed.');
      this.context.ownedTargetIds.delete(action.targetId);
      if (this.context.selectedTargetId === action.targetId) this.context.selectedTargetId = null;
      return { selectedTargetId: this.context.selectedTargetId, closedTargetId: action.targetId, completed: true };
    }

    if (action.type === 'dialog') {
      if (action.accept && !this.context.dialogAcceptanceAuthorized) return fail('dialog_accept_forbidden', 'Accepting browser dialogs is not authorized.');
      const result = await command('Page.handleJavaScriptDialog', { accept: action.accept, ...(action.promptText === undefined ? {} : { promptText: action.promptText }) }, await this.selectedPage(command));
      if (result.success === false) return fail('dialog_operation_failed', 'The browser dialog action was not confirmed.');
      return success();
    }

    const page = await this.selectedPage(command);
    const currentUrl = await this.currentUrl(page, command);
    this.assertAllowed(currentUrl);
    if (action.type === 'navigate_back' || action.type === 'navigate_forward') {
      const history = await command('Page.getNavigationHistory', {}, page);
      const entries = Array.isArray(history.entries) ? history.entries as Array<{ id?: unknown; url?: unknown }> : [];
      const index = history.currentIndex;
      if (!Number.isSafeInteger(index) || (index as number) < 0 || (index as number) >= entries.length) return fail('navigation_state_unknown', 'The browser history could not be verified.');
      const target = entries[(index as number) + (action.type === 'navigate_back' ? -1 : 1)];
      if (!target || typeof target.url !== 'string') return fail('navigation_unavailable', 'The requested browser history entry is unavailable.');
      if (!Number.isSafeInteger(target.id)) return fail('navigation_state_unknown', 'The requested browser history entry could not be verified.');
      this.assertAllowed(target.url);
      await command('Page.navigateToHistoryEntry', { entryId: target.id as number }, page);
      await this.assertCurrentAllowed(page, command);
      return success();
    }
    if (action.type === 'reload') {
      await command('Page.reload', {}, page);
      await this.assertCurrentAllowed(page, command);
      return success();
    }
    if (action.type !== 'focus' && action.type !== 'select') return fail('invalid_action', 'Browser page action is invalid.');
    await command('DOM.enable', {}, page);
    await command('DOM.getDocument', { depth: 0 }, page);
    const search = await command('DOM.performSearch', { query: action.selector }, page);
    const searchId = checkedString(search.searchId, 256) ? search.searchId : '';
    const count = typeof search.resultCount === 'number' ? search.resultCount : 0;
    if (!searchId || count < 1) return fail('selector_not_found', 'The browser selector did not match a page element.');
    let nodeId: number | undefined;
    try {
      const matches = await command('DOM.getSearchResults', { searchId, fromIndex: 0, toIndex: 1 }, page);
      nodeId = Array.isArray(matches.nodeIds) && typeof matches.nodeIds[0] === 'number' ? matches.nodeIds[0] : undefined;
    } finally {
      try { await command('DOM.discardSearchResults', { searchId }, page); } catch { /* bounded cleanup attempt */ }
    }
    if (nodeId === undefined) return fail('selector_not_found', 'The browser selector did not resolve to an element.');
    if (action.type === 'focus') {
      await command('DOM.focus', { nodeId }, page);
      return success();
    }
    if (action.type === 'select') {
      const described = await command('DOM.describeNode', { nodeId, depth: 1 }, page);
      const node = described.node as { nodeName?: unknown; backendNodeId?: unknown; attributes?: unknown; children?: unknown } | undefined;
      if (typeof node?.nodeName !== 'string' || node.nodeName.toUpperCase() !== 'SELECT') return fail('wrong_control', 'The selector did not resolve to a native select control.');
      if (!Number.isSafeInteger(node.backendNodeId) || !Array.isArray(node.children)) return fail('select_state_unknown', 'The native select options could not be verified.');
      const attributes = Array.isArray(node.attributes) ? node.attributes : [];
      if (attributes.some((value, index) => index % 2 === 0 && value === 'multiple')) return fail('unsupported_select', 'Multiple select controls are not supported.');
      const options = node.children as Array<{ nodeName?: unknown; attributes?: unknown }>;
      if (options.some(option => option.nodeName === 'OPTGROUP')) return fail('unsupported_select', 'Grouped native select options are not supported.');
      if (options.some(option => {
        if (typeof option.nodeName !== 'string' || option.nodeName.toUpperCase() !== 'OPTION') return false;
        const attrs = Array.isArray(option.attributes) ? option.attributes : [];
        return attrs.some((value, index) => index % 2 === 0 && value === 'disabled');
      })) return fail('unsupported_select', 'Disabled native select options are not supported.');
      const values = options.filter(option => typeof option.nodeName === 'string' && option.nodeName.toUpperCase() === 'OPTION').map(option => {
        const attrs = Array.isArray(option.attributes) ? option.attributes : [];
        const valueIndex = attrs.findIndex((value, index) => index % 2 === 0 && value === 'value');
        return valueIndex >= 0 && typeof attrs[valueIndex + 1] === 'string' ? attrs[valueIndex + 1] as string : undefined;
      });
      const optionIndex = values.findIndex(value => value === action.value);
      if (optionIndex < 0) return fail('option_not_found', 'The requested value is not an option in the native select.');
      await command('DOM.focus', { nodeId }, page);
      const key = async (name: string, code: number): Promise<void> => {
        const params = { key: name, code: name, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code };
        await command('Input.dispatchKeyEvent', { ...params, type: 'keyDown' }, page);
        await command('Input.dispatchKeyEvent', { ...params, type: 'keyUp' }, page);
      };
      await key('Home', 36);
      for (let index = 0; index < optionIndex; index += 1) await key('ArrowDown', 40);
      const snapshot = await command('DOMSnapshot.captureSnapshot', { computedStyles: [], includeDOMRects: false, includePaintOrder: false }, page);
      const strings = Array.isArray(snapshot.strings) ? snapshot.strings : [];
      const documents = Array.isArray(snapshot.documents) ? snapshot.documents as Array<{ nodes?: Record<string, unknown> }> : [];
      const actual = documents.flatMap(document => {
        const nodes = document.nodes;
        const selected = nodes?.optionSelected as { index?: unknown } | undefined;
        if (!nodes || !Array.isArray(nodes.backendNodeId) || !Array.isArray(nodes.parentIndex) || !Array.isArray(nodes.attributes) || !Array.isArray(selected?.index)) return [];
        const selectIndex = nodes.backendNodeId.findIndex(value => value === node.backendNodeId);
        if (selectIndex < 0) return [];
        const parentIndices = nodes.parentIndex as number[];
        const selectedIndices = selected.index as number[];
        const nodeAttributes = nodes.attributes as unknown[];
        return parentIndices.flatMap((parent, index) => {
          if (parent !== selectIndex || !selectedIndices.includes(index)) return [];
          const attrs = nodeAttributes[index];
          if (!Array.isArray(attrs)) return [];
          for (let attrIndex = 0; attrIndex + 1 < attrs.length; attrIndex += 2) {
            const nameIndex = attrs[attrIndex];
            const valueIndex = attrs[attrIndex + 1];
            if (!Number.isSafeInteger(nameIndex) || !Number.isSafeInteger(valueIndex)) return [];
            if (strings[nameIndex as number] === 'value') {
              const value = strings[valueIndex as number];
              return typeof value === 'string' ? [value] : [];
            }
          }
          return [];
        });
      });
      if (actual.length !== 1 || actual[0] !== action.value) return fail('select_verification_failed', 'The native select did not confirm the requested value.');
      return success();
    }
    return fail('invalid_action', 'Browser page action is invalid.');
  }

  private validate(action: BrowserPageAction): void {
    if (!action || typeof action !== 'object') return fail('invalid_action', 'Browser page action is invalid.');
    const allowedKeys: Record<string, string[]> = {
      tab_create: ['type', 'url'], tab_select: ['type', 'targetId'], tab_close: ['type', 'targetId'],
      navigate_back: ['type'], navigate_forward: ['type'], reload: ['type'], focus: ['type', 'selector'],
      select: ['type', 'selector', 'value'], dialog: ['type', 'accept', 'promptText'],
    };
    const expected = Object.hasOwn(allowedKeys, action.type) ? allowedKeys[action.type] : undefined;
    if (!expected || Object.keys(action).some(key => !expected.includes(key)) || expected.some(key => key !== 'promptText' && !Object.hasOwn(action, key))) return fail('invalid_action', 'Browser page action is invalid.');
    if (action.type === 'dialog' && action.promptText === undefined && Object.hasOwn(action, 'promptText')) return fail('invalid_action', 'Browser page action is invalid.');
    if (action.type === 'tab_create') {
      if (!checkedString(action.url, 2048)) return fail('invalid_action', 'Browser page action is invalid.');
      let url: URL;
      try { url = new URL(action.url); } catch { return fail('invalid_action', 'Browser page action is invalid.'); }
      if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password) return fail('url_not_allowed', 'Only allowlisted HTTP or HTTPS pages can be opened.');
    } else if (action.type === 'tab_select' || action.type === 'tab_close') {
      if (!checkedString(action.targetId, 256)) return fail('invalid_action', 'Browser page action is invalid.');
    } else if (action.type === 'focus' || action.type === 'select') {
      if (!checkedString(action.selector, 256) || /[\r\n]/.test(action.selector)) return fail('invalid_action', 'Browser page action is invalid.');
      if (action.type === 'select' && !boundedText(action.value, 1024)) return fail('invalid_action', 'Browser page action is invalid.');
    } else if (action.type === 'dialog') {
      if (typeof action.accept !== 'boolean' || (action.promptText !== undefined && (!boundedText(action.promptText, 1024) || !action.accept))) return fail('invalid_action', 'Browser page action is invalid.');
    } else if (!['navigate_back', 'navigate_forward', 'reload'].includes(action.type)) return fail('invalid_action', 'Browser page action is invalid.');
  }

  private assertAllowed(url: string): void {
    let valid = false;
    try {
      const parsed = new URL(url);
      valid = (parsed.protocol === 'https:' || parsed.protocol === 'http:') && !parsed.username && !parsed.password && this.context.allowUrl(url);
    } catch { /* fail closed */ }
    if (!valid) return fail('navigation_not_allowed', 'The current or requested browser URL is not allowed.');
  }

  private assertOwned(targetId: string): void {
    if (!this.context.ownedTargetIds.has(targetId)) return fail('target_not_owned', 'The browser tab is not owned by this session.');
  }

  private async targetInfo(targetId: string, command: (method: string, params?: Record<string, unknown>, page?: string) => Promise<Record<string, unknown>>): Promise<{ url: string }> {
    this.assertOwned(targetId);
    const targets = await command('Target.getTargets');
    const infos = Array.isArray(targets.targetInfos) ? targets.targetInfos as Array<{ type?: unknown; targetId?: unknown; url?: unknown }> : [];
    const info = infos.find(target => target.targetId === targetId && target.type === 'page');
    if (!info || typeof info.url !== 'string') return fail('target_unknown', 'The owned browser tab is no longer available.');
    return { url: info.url };
  }

  private async selectedPage(command: (method: string, params?: Record<string, unknown>, page?: string) => Promise<Record<string, unknown>>): Promise<string> {
    const targetId = this.context.selectedTargetId;
    if (!targetId) return fail('target_not_selected', 'No owned browser tab is selected.');
    this.assertOwned(targetId);
    const target = await this.targetInfo(targetId, command);
    this.assertAllowed(target.url);
    const attached = await command('Target.attachToTarget', { targetId, flatten: true });
    if (!checkedString(attached.sessionId, 256)) return fail('target_attach_failed', 'The selected owned browser tab could not be attached.');
    return attached.sessionId;
  }

  private async currentUrl(page: string, command: (method: string, params?: Record<string, unknown>, page?: string) => Promise<Record<string, unknown>>): Promise<string> {
    const result = await command('Page.getFrameTree', {}, page);
    const tree = result.frameTree as { frame?: { url?: unknown } } | undefined;
    if (typeof tree?.frame?.url !== 'string') return fail('navigation_state_unknown', 'The current browser URL could not be verified.');
    return tree.frame.url;
  }

  private async assertCurrentAllowed(page: string, command: (method: string, params?: Record<string, unknown>, page?: string) => Promise<Record<string, unknown>>): Promise<void> {
    this.assertAllowed(await this.currentUrl(page, command));
  }
}
