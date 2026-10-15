import contextlib
import importlib.util
import io
from pathlib import Path
import unittest


SCRIPT = Path(__file__).with_name('mission_clipboard.py')
spec = importlib.util.spec_from_file_location('mission_clipboard', SCRIPT)
clipboard = importlib.util.module_from_spec(spec) if SCRIPT.exists() else None
if clipboard:
    spec.loader.exec_module(clipboard)


class Cdp:
    def __init__(self, selection=None):
        self.selection = selection or {'status': 'selected', 'text': 'AA'}
        self.calls = []
        self.failure = None

    def command(self, method, params=None, session=None):
        self.calls.append((method, params, session))
        if self.failure:
            raise RuntimeError(self.failure)
        if method == 'Page.getFrameTree':
            return {'frameTree': {'frame': {'id': 'FRAME1'}}}
        if method == 'Page.createIsolatedWorld':
            return {'executionContextId': 17}
        if method == 'Runtime.evaluate':
            return {'result': {'type': 'object', 'value': self.selection}}
        if method == 'Input.insertText':
            return {}
        raise AssertionError('Unexpected CDP method')


class MissionClipboardTests(unittest.TestCase):
    def setUp(self):
        self.assertIsNotNone(clipboard, 'Per-mission clipboard implementation is missing')

    def action(self, key='KeyC', modifiers=2):
        return {'type': 'press_key', 'key': key, 'modifiers': modifiers}

    def test_copy_uses_fixed_isolated_native_selection_and_updates_only_its_returned_buffer(self):
        cdp = Cdp()
        self.assertEqual(clipboard.handle_clipboard(cdp, 'OWNED_A', self.action(), 'old'), {'clipboardText': 'AA', 'changed': True})
        self.assertEqual([call[0] for call in cdp.calls], ['Page.getFrameTree', 'Page.createIsolatedWorld', 'Runtime.evaluate'])
        self.assertTrue(all(call[2] == 'OWNED_A' for call in cdp.calls))
        self.assertEqual(cdp.calls[1][1]['frameId'], 'FRAME1')
        evaluate = cdp.calls[2][1]
        self.assertEqual(evaluate['contextId'], 17)
        self.assertTrue(evaluate['returnByValue'])
        self.assertIn('Object.getOwnPropertyDescriptor', evaluate['expression'])
        self.assertIn('HTMLInputElement.prototype', evaluate['expression'])
        self.assertNotIn('old', evaluate['expression'])

    def test_paste_inserts_only_its_own_buffer_without_os_clipboard_or_key_events(self):
        cdp = Cdp({'status': 'allowed'})
        text = 'BB " $(not-a-command)\n'
        self.assertEqual(clipboard.handle_clipboard(cdp, 'OWNED_B', self.action('KeyV', 4), text), {'clipboardText': text, 'changed': False})
        self.assertEqual(cdp.calls[-1], ('Input.insertText', {'text': text}, 'OWNED_B'))
        self.assertNotIn(text, cdp.calls[-2][1]['expression'])
        self.assertNotIn('Input.dispatchKeyEvent', [call[0] for call in cdp.calls])

    def test_two_missions_keep_disjoint_buffers_and_empty_selection_does_not_destroy_old_copy(self):
        a = clipboard.handle_clipboard(Cdp({'status': 'selected', 'text': 'AA'}), 'OWNED_A', self.action(), '')
        b = clipboard.handle_clipboard(Cdp({'status': 'selected', 'text': 'BB'}), 'OWNED_B', self.action(modifiers=4), '')
        for session, value in [('OWNED_A', a), ('OWNED_B', b)]:
            cdp = Cdp({'status': 'allowed'})
            clipboard.handle_clipboard(cdp, session, self.action('KeyV'), value['clipboardText'])
            self.assertEqual(cdp.calls[-1][1]['text'], 'AA' if session == 'OWNED_A' else 'BB')
        self.assertEqual(clipboard.handle_clipboard(Cdp({'status': 'none'}), 'OWNED_A', self.action(), 'AA'), {'clipboardText': 'AA', 'changed': False})
        self.assertEqual(clipboard.handle_clipboard(Cdp(), 'OWNED_A', self.action(), 'AA')['changed'], False)

    def test_invalid_actions_sessions_and_utf8_buffers_fail_before_any_browser_call(self):
        for action in [self.action('KeyX'), self.action(modifiers=0), self.action(modifiers=10), self.action(modifiers=True), {**self.action(), 'text': 'forbidden'}, {'type': 'evaluate', 'script': 'private'}]:
            cdp = Cdp()
            with self.assertRaises(clipboard.ClipboardError):
                clipboard.handle_clipboard(cdp, 'OWNED_A', action, '')
            self.assertEqual(cdp.calls, [])
        for buffer in [None, 'é' * 32769, '\ud800']:
            cdp = Cdp()
            with self.assertRaises(clipboard.ClipboardError):
                clipboard.handle_clipboard(cdp, 'OWNED_A', self.action(), buffer)
            self.assertEqual(cdp.calls, [])
        with self.assertRaises(clipboard.ClipboardError):
            clipboard.handle_clipboard(Cdp(), '../foreign', self.action(), '')
        text = 'é' * 32768
        self.assertEqual(clipboard.handle_clipboard(Cdp({'status': 'selected', 'text': text}), 'OWNED_A', self.action(), '')['clipboardText'], text)

    def test_private_or_malformed_selection_and_transport_errors_never_return_or_log_text(self):
        for selection in [{'status': 'sensitive'}, {'status': 'too_large'}, {'status': 'selected', 'text': 'x' * 65537}, {'status': 'selected', 'text': 'private', 'extra': True}, {'status': 'selected', 'text': 1}]:
            cdp = Cdp(selection)
            with self.assertRaises(clipboard.ClipboardError) as error:
                clipboard.handle_clipboard(cdp, 'OWNED_A', self.action(), '')
            self.assertNotIn('private', str(error.exception))
            self.assertNotIn('Input.insertText', [call[0] for call in cdp.calls])
        cdp = Cdp(); cdp.failure = 'PRIVATE-UPSTREAM-TEXT'
        output = io.StringIO()
        with contextlib.redirect_stdout(output), contextlib.redirect_stderr(output), self.assertRaises(clipboard.ClipboardError) as error:
            clipboard.handle_clipboard(cdp, 'OWNED_A', self.action(), '')
        self.assertNotIn('PRIVATE-UPSTREAM-TEXT', str(error.exception))
        self.assertEqual(output.getvalue(), '')

    def test_sanitized_errors_suppress_unicode_context_and_accept_only_fixed_codes(self):
        with self.assertRaises(clipboard.ClipboardError) as error:
            clipboard.handle_clipboard(Cdp(), 'OWNED_A', self.action(), 'PRIVATE\ud800')
        self.assertTrue(error.exception.__suppress_context__)
        self.assertEqual(str(clipboard.ClipboardError('PRIVATE-UPSTREAM-TEXT')), 'clipboard_provider_unavailable')
        self.assertEqual(str(clipboard.ClipboardError({'private': 'value'})), 'clipboard_provider_unavailable')


if __name__ == '__main__':
    unittest.main()
