import importlib.util
from pathlib import Path
import time
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('pending_dispatcher', Path(__file__).with_name('browser-dispatcher.py'))
dispatcher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(dispatcher)


class DocumentPendingTests(unittest.TestCase):
    state = {'selected': 'PAGE1', 'owned': ['PAGE1']}
    public = 'https://example.com/form'

    def test_empty_observed_frame_or_target_retries_until_guarded_public_document(self):
        for pending in ('frame', 'target', 'child_frame'):
            class Cdp:
                deadline = time.monotonic() + 5
                seen_pending = False
                methods = None
                def remaining(self): return 1
                def command(self, method, params=None, session=None):
                    self.methods = (self.methods or []) + [method]
                    if method == 'Target.getTargetInfo':
                        url = 'https://example.com/form'
                        if pending == 'target' and not self.seen_pending: url = ''; self.seen_pending = True
                        return {'targetInfo': {'type': 'page', 'url': url, 'title': 'Public form'}}
                    if method == 'Target.attachToTarget': return {'sessionId': 'ATTACHED'}
                    if method == 'Page.getFrameTree':
                        tree = {'frame': {'url': 'https://example.com/form'}}
                        if pending in ('frame', 'child_frame') and not self.seen_pending:
                            if pending == 'frame': tree['frame']['url'] = ''
                            else: tree['childFrames'] = [{'frame': {'url': ''}}]
                            self.seen_pending = True
                        return {'frameTree': tree}
                    if method == 'Accessibility.getFullAXTree': return {'nodes': [{'role': {'value': 'StaticText'}, 'name': {'value': 'Public fixture'}}]}
                    raise AssertionError('Unexpected non-read method')
            with self.subTest(pending=pending), patch.object(dispatcher.socket, 'getaddrinfo', return_value=[(2, 1, 6, '', ('93.184.216.34', 443))]), patch.object(dispatcher.time, 'sleep'):
                cdp = Cdp(); result = dispatcher.post_action_snapshot(cdp, self.state, True)
                self.assertTrue(cdp.seen_pending)
                self.assertEqual(result['url'], self.public)
                self.assertEqual(result['visibleText'], 'Public fixture')
                self.assertEqual(cdp.methods.count('Accessibility.getFullAXTree'), 1)
                self.assertTrue(set(cdp.methods) <= {'Target.getTargetInfo', 'Target.attachToTarget', 'Page.getFrameTree', 'Accessibility.getFullAXTree'})

    def test_direct_empty_and_private_destinations_remain_forbidden(self):
        for url in ('', None, 'http://127.0.0.1/private', 'http://169.254.169.254/', 'file:///etc/passwd'):
            with self.subTest(url=url), self.assertRaises(dispatcher.DispatchError) as failure:
                dispatcher.allow_url(url)
            reason = 'scheme_or_credentials' if isinstance(url, str) and url.startswith('file:') else ('nonpublic_address' if isinstance(url, str) and url.startswith('http') else 'invalid_url')
            self.assertEqual(failure.exception.code, f'destination_forbidden_requested_navigation_{reason}')
        for url in (None, 'http://127.0.0.1/private'):
            with self.subTest(observed=url), self.assertRaises(dispatcher.DispatchError) as failure:
                dispatcher.allow_observed_url(url)
            reason = 'nonpublic_address' if isinstance(url, str) and url.startswith('http') else 'invalid_url'
            self.assertEqual(failure.exception.code, f'destination_forbidden_observed_main_{reason}')
        with self.assertRaises(dispatcher.DispatchError) as failure: dispatcher.allow_observed_url('')
        self.assertEqual(failure.exception.code, 'provider_document_pending')


if __name__ == '__main__': unittest.main()
