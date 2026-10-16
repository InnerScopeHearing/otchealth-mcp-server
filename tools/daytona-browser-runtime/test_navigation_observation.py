import importlib.util
from pathlib import Path
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('navigation_dispatcher', Path(__file__).with_name('browser-dispatcher.py'))
dispatcher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(dispatcher)


class NavigationObservationTests(unittest.TestCase):
    state = {'selected': 'PAGE1', 'owned': ['PAGE1']}
    payload = {'action': {'type': 'navigate', 'url': 'https://example.com/result'}}

    def test_navigation_is_sent_once_and_only_read_context_loss_is_retried(self):
        class Cdp:
            deadline = time.monotonic() + 3
            effect_count = 0
            methods = None
            frame_reads = 0
            failure_code = 'provider_context_destroyed'
            def remaining(self): return 1
            def command(self, method, params=None, session=None):
                if method == 'Target.getTargetInfo': return {'targetInfo': {'type': 'page', 'url': 'https://example.com/result', 'title': 'Received'}}
                if method == 'Target.attachToTarget': return {'sessionId': 'ATTACHED'}
                self.methods = (self.methods or []) + [method]
                if method == 'Page.navigate' or method == 'Input.dispatchMouseEvent' and params.get('type') == 'mouseReleased': self.effect_count += 1; return {}
                if method == 'DOM.getDocument': return {'root': {'nodeId': 1}}
                if method == 'DOM.querySelector': return {'nodeId': 2}
                if method == 'DOM.getBoxModel': return {'model': {'content': [0, 0, 10, 0, 10, 10, 0, 10]}}
                if method == 'Page.getFrameTree':
                    self.frame_reads += 1
                    if self.effect_count and self.frame_reads == 2 and self.failure_code == 'provider_context_destroyed': raise dispatcher.DispatchError('provider_context_destroyed')
                    url = 'https://example.com/result?accepted=1' if self.failure_code == 'navigation_changed' and self.frame_reads >= 4 else 'https://example.com/result'
                    return {'frameTree': {'frame': {'url': url}}}
                if method == 'Accessibility.getFullAXTree': return {'nodes': [{'role': {'value': 'StaticText'}, 'name': {'value': 'Received!'}}]}
                return {}
        for action in (self.payload['action'], {'type': 'click', 'selector': '#submit'}):
            for failure_code in ('provider_context_destroyed', 'navigation_changed'):
                with self.subTest(action=action, failure_code=failure_code):
                    cdp = Cdp(); cdp.failure_code = failure_code
                    with patch.object(dispatcher, 'allow_url'), patch.object(dispatcher.time, 'sleep'):
                        result = dispatcher.perform_action(cdp, self.state, {'action': action}, None)
                    self.assertEqual(cdp.effect_count, 1)
                    self.assertEqual((cdp.methods or []).count('Page.navigate'), int(action['type'] == 'navigate'))
                    self.assertEqual((cdp.methods or []).count('Input.dispatchMouseEvent'), 2 if action['type'] == 'click' else 0)
                    self.assertEqual(result['visibleText'], 'Received!')
                    if failure_code == 'navigation_changed':
                        self.assertEqual(result['url'], 'https://example.com/result?accepted=1')
                        self.assertGreaterEqual(cdp.frame_reads, 7)

    def test_only_exact_context_loss_errors_are_classified_and_failed_effects_never_retry(self):
        def command(method, message):
            cdp = dispatcher.Cdp.__new__(dispatcher.Cdp)
            cdp.identifier = 0
            cdp.send = lambda *_: None
            cdp.message = lambda *_: {'id': 1, 'error': {'code': -32000, 'message': message}}
            with self.assertRaises(dispatcher.DispatchError) as error: cdp.command(method)
            return error.exception.code
        self.assertEqual(command('Page.getFrameTree', 'Cannot find context with specified id'), 'provider_context_destroyed')
        self.assertEqual(command('Page.getFrameTree', 'untrusted private error details'), 'provider_action_failed')
        self.assertEqual(command('Input.dispatchMouseEvent', 'Cannot find context with specified id'), 'provider_action_failed')
        with patch.object(dispatcher, 'execute', side_effect=dispatcher.DispatchError('provider_action_failed')) as effect, patch.object(dispatcher, 'selected') as observe:
            with self.assertRaises(dispatcher.DispatchError): dispatcher.perform_action(object(), self.state, self.payload, None)
            effect.assert_called_once()
            observe.assert_not_called()
        cdp = SimpleNamespace(deadline=time.monotonic() + 3, remaining=lambda: 1)
        for code in ('destination_forbidden', 'sensitive_output_suppressed', 'target_not_owned', 'provider_timeout', 'provider_action_failed'):
            with self.subTest(code=code), patch.object(dispatcher, 'selected', side_effect=dispatcher.DispatchError(code)) as observe:
                with self.assertRaises(dispatcher.DispatchError): dispatcher.post_action_snapshot(cdp, self.state, True)
                observe.assert_called_once()


if __name__ == '__main__': unittest.main()
