import importlib.util
from pathlib import Path
import time
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('snapshot_order_dispatcher', Path(__file__).with_name('browser-dispatcher.py'))
dispatcher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(dispatcher)


class SnapshotNavigationOrderTests(unittest.TestCase):
    state = {'selected': 'PAGE1', 'owned': ['PAGE1']}
    public = 'https://example.com/form'

    def cdp(self, urls):
        class Cdp:
            deadline = time.monotonic() + 5
            reads = 0
            methods = None
            def remaining(self): return 1
            def command(self, method, params=None, session=None):
                self.methods = (self.methods or []) + [method]
                if method == 'Target.getTargetInfo': return {'targetInfo': {'type': 'page', 'url': 'https://example.com/form', 'title': 'Public form'}}
                if method == 'Target.attachToTarget': return {'sessionId': 'ATTACHED'}
                if method == 'Page.getFrameTree':
                    url = urls[min(self.reads, len(urls) - 1)]; self.reads += 1
                    return {'frameTree': {'frame': {'url': url}}}
                if method == 'Accessibility.getFullAXTree': return {'nodes': [{'role': {'value': 'StaticText'}, 'name': {'value': 'Public fixture'}}]}
                raise AssertionError('Unexpected non-read method')
        return Cdp()

    def test_blank_to_public_transition_retries_only_guarded_snapshot(self):
        cdp = self.cdp(['about:blank', 'about:blank', self.public])
        with patch.object(dispatcher.socket, 'getaddrinfo', return_value=[(2, 1, 6, '', ('93.184.216.34', 443))]), patch.object(dispatcher.time, 'sleep'):
            result = dispatcher.post_action_snapshot(cdp, self.state, True)
        self.assertEqual(result['url'], self.public)
        self.assertEqual(result['visibleText'], 'Public fixture')
        # The successful retry checks the URL both before and after locator metadata.
        self.assertEqual(cdp.reads, 7)
        self.assertEqual(cdp.methods.count('Accessibility.getFullAXTree'), 2)
        self.assertTrue(set(cdp.methods) <= {'Target.getTargetInfo', 'Target.attachToTarget', 'Page.getFrameTree', 'Accessibility.getFullAXTree'})

    def test_populated_stable_blank_and_private_final_destination_remain_forbidden(self):
        for final in ('about:blank', 'http://127.0.0.1/private'):
            cdp = self.cdp(['about:blank', 'about:blank', final])
            with self.subTest(final=final), patch.object(dispatcher.socket, 'getaddrinfo', side_effect=lambda host, *a, **k: [(2, 1, 6, '', ('127.0.0.1' if host == '127.0.0.1' else '93.184.216.34', 443))]), self.assertRaises(dispatcher.DispatchError) as failure:
                dispatcher.post_action_snapshot(cdp, self.state, True)
            expected = 'destination_forbidden_populated_blank_blank_has_content' if final == 'about:blank' else 'destination_forbidden_observed_main_nonpublic_address'
            self.assertEqual(failure.exception.code, expected)
            self.assertEqual(cdp.methods.count('Accessibility.getFullAXTree'), 1)


if __name__ == '__main__': unittest.main()
