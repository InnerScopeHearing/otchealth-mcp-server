"""Internal per-mission text clipboard. No OS clipboard or observable payloads.

The caller must hold the physical action mutex and validate target ownership,
public frame URLs and the password/protected AX guard before entering here.
Plaintext results are only for the private mission registry, never tool output.
"""
import re


MAX_BYTES = 65536
_CODES = {'clipboard_invalid_action', 'clipboard_buffer_invalid',
          'clipboard_selection_unavailable', 'clipboard_sensitive_field',
          'clipboard_provider_unavailable'}


class ClipboardError(Exception):
    def __init__(self, code='clipboard_provider_unavailable'):
        self.code = code if isinstance(code, str) and code in _CODES else 'clipboard_provider_unavailable'
        super().__init__(self.code)


def _fail(code='clipboard_provider_unavailable'):
    raise ClipboardError(code) from None


def _bounded_text(value):
    if not isinstance(value, str):
        _fail('clipboard_buffer_invalid')
    try:
        if len(value.encode('utf-8')) > MAX_BYTES:
            _fail('clipboard_buffer_invalid')
    except UnicodeError:
        _fail('clipboard_buffer_invalid')
    return value


# Isolated worlds have their own native DOM wrappers/prototypes: page-defined
# getters and overrides cannot substitute field values or selection functions.
# No caller text, selector or JavaScript is interpolated into these constants.
_GUARD = r'''(() => {
"use strict";
const nativeGet = (prototype, name, receiver) => Reflect.apply(
  Object.getOwnPropertyDescriptor(prototype, name).get, receiver, []);
const attr = (node, name) => Reflect.apply(Element.prototype.getAttribute, node, [name]);
let active = nativeGet(Document.prototype, "activeElement", document);
for (let depth = 0; active && depth < 32; depth++) {
  const shadow = nativeGet(Element.prototype, "shadowRoot", active);
  if (!shadow) break;
  const inner = nativeGet(ShadowRoot.prototype, "activeElement", shadow);
  if (!inner) break;
  active = inner;
  if (depth === 31) return {status:"unavailable"};
}
const tag = active ? nativeGet(Element.prototype, "tagName", active).toLowerCase() : "";
if (tag === "iframe" || tag === "frame" || tag.includes("-")) return {status:"unavailable"};
const input = tag === "input", textarea = tag === "textarea";
if (input && ["password", "hidden", "file"].includes(
    nativeGet(HTMLInputElement.prototype, "type", active))) return {status:"sensitive"};
let ancestor = active;
for (let depth = 0; ancestor && depth < 128; depth++) {
  const tokens = (attr(ancestor, "autocomplete") || "").toLowerCase().split(/\s+/);
  if (tokens.some(token => ["username", "current-password", "new-password", "one-time-code", "webauthn"].includes(token)
      || token.startsWith("cc-"))) return {status:"sensitive"};
  ancestor = nativeGet(Node.prototype, "parentElement", ancestor);
  if (depth === 127 && ancestor) return {status:"unavailable"};
}
'''

_COPY_EXPRESSION = _GUARD + r'''
let text;
if (input || textarea) {
  const prototype = input ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
  const start = nativeGet(prototype, "selectionStart", active);
  const end = nativeGet(prototype, "selectionEnd", active);
  if (!Number.isInteger(start) || !Number.isInteger(end) || start === end) return {status:"none"};
  if (end < start || end - start > 65536) return {status:"too_large"};
  text = Reflect.apply(String.prototype.slice, nativeGet(prototype, "value", active), [start, end]);
} else {
  const selection = Reflect.apply(Document.prototype.getSelection, document, []);
  if (!selection || nativeGet(Selection.prototype, "isCollapsed", selection)) return {status:"none"};
  text = Reflect.apply(Selection.prototype.toString, selection, []);
}
if (new TextEncoder().encode(text).byteLength > 65536) return {status:"too_large"};
return {status:"selected", text};
})()'''

_PASTE_EXPRESSION = _GUARD + r'''
if (!active || (!input && !textarea && !nativeGet(HTMLElement.prototype, "isContentEditable", active)))
  return {status:"unavailable"};
return {status:"allowed"};
})()'''


def handle_clipboard(cdp, attached_session, action, clipboard_text):
    """Handle only validated Ctrl/Meta+C/V; return private buffer bookkeeping."""
    try:
        if (not isinstance(action, dict) or set(action) - {'type', 'key', 'modifiers'}
                or action.get('type') != 'press_key' or action.get('key') not in ('KeyC', 'KeyV')
                or type(action.get('modifiers')) is not int or action['modifiers'] not in (2, 4, 6)
                or not isinstance(attached_session, str)
                or not re.fullmatch(r'[A-Za-z0-9_-]{1,256}', attached_session)):
            _fail('clipboard_invalid_action')
        old = _bounded_text(clipboard_text)
        tree = cdp.command('Page.getFrameTree', {}, attached_session)
        frame_id = tree.get('frameTree', {}).get('frame', {}).get('id')
        if not isinstance(frame_id, str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,256}', frame_id):
            _fail()
        world = cdp.command('Page.createIsolatedWorld', {
            'frameId': frame_id, 'worldName': 'otchealth-mission-clipboard-v1',
            'grantUniveralAccess': False,
        }, attached_session)
        context = world.get('executionContextId')
        if type(context) is not int or context <= 0:
            _fail()
        copy = action['key'] == 'KeyC'
        evaluated = cdp.command('Runtime.evaluate', {
            'expression': _COPY_EXPRESSION if copy else _PASTE_EXPRESSION,
            'contextId': context, 'returnByValue': True, 'silent': True,
        }, attached_session)
        if 'exceptionDetails' in evaluated:
            _fail()
        value = evaluated.get('result', {}).get('value')
        if not isinstance(value, dict):
            _fail()
        if value == {'status': 'sensitive'}:
            _fail('clipboard_sensitive_field')
        if copy and value == {'status': 'none'}:
            return {'clipboardText': old, 'changed': False}
        if copy and set(value) == {'status', 'text'} and value['status'] == 'selected':
            text = _bounded_text(value['text'])
            return {'clipboardText': text, 'changed': text != old}
        if not copy and value == {'status': 'allowed'}:
            cdp.command('Input.insertText', {'text': old}, attached_session)
            return {'clipboardText': old, 'changed': False}
        _fail('clipboard_selection_unavailable')
    except ClipboardError:
        raise
    except Exception:
        raise ClipboardError() from None
