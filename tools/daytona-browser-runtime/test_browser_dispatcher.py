import base64
import importlib.util
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import tempfile
import time
import unittest
from unittest.mock import patch


SCRIPT = Path(__file__).with_name('browser-dispatcher.py')
spec = importlib.util.spec_from_file_location('browser_dispatcher', SCRIPT)
dispatcher = importlib.util.module_from_spec(spec) if spec and SCRIPT.exists() else None
if dispatcher:
    spec.loader.exec_module(dispatcher)


class DispatcherTests(unittest.TestCase):
    def setUp(self):
        self.assertIsNotNone(dispatcher, 'Fixed typed dispatcher is not implemented')
        self.payload = {'version': 1, 'op': 'execute', 'profileKey': 'cto-test',
                        'profilePath': '/home/otcbrowser/.local/share/otchealth-browser/cto-test/chromium',
                        'sessionId': '11111111-1111-4111-8111-111111111111', 'timeoutMs': 18000,
                        'principalHash': 'a' * 64, 'action': {'type': 'snapshot'}}

    def test_exact_profile_and_typed_actions_reject_injection(self):
        self.assertEqual(dispatcher.validate_payload(self.payload)['op'], 'execute')
        for change in ({'shell': 'id'}, {'timeoutMs': 18001}, {'profilePath': '/tmp/chromium'},
                       {'action': {'type': 'evaluate', 'script': 'alert(1)'}},
                       {'action': {'type': 'click', 'selector': '#ok', 'script': 'id'}},
                       {'profileKey': '../other'}, {'sessionId': 'not-a-session'},
                       {'action': {'type': 'press_key', 'key': 'eval(1)'}}):
            with self.subTest(change=change), self.assertRaises(dispatcher.DispatchError):
                dispatcher.validate_payload({**self.payload, **change})

    def test_url_boundary_rejects_private_and_credentials_before_any_page_operation(self):
        for url in ('http://127.0.0.1/', 'http://169.254.169.254/', 'file:///etc/passwd',
                    'http://user:password@example.com/', 'http://[::1]/', 'http://224.0.0.1/',
                    'http://[ff02::1]/', 'javascript:alert(1)'):
            with self.subTest(url=url), self.assertRaises(dispatcher.DispatchError):
                dispatcher.allow_url(url)
        with patch.object(dispatcher.socket, 'getaddrinfo', return_value=[(2, 1, 6, '', ('93.184.216.34', 443))]):
            dispatcher.allow_url('https://example.com/')
        with patch.object(dispatcher.socket, 'getaddrinfo', return_value=[(2, 1, 6, '', ('10.0.0.1', 443))]):
            with self.assertRaises(dispatcher.DispatchError):
                dispatcher.allow_url('https://example.com/')

    def test_receipts_are_exact_session_fenced_private_and_symlink_safe(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            root.chmod(0o700)
            with dispatcher.Receipt(root) as receipt:
                receipt.write({'sessionId': self.payload['sessionId'], 'selected': 'PAGE1', 'owned': ['PAGE1'], 'uncertain': False})
            self.assertEqual((root / 'mission.json').stat().st_mode & 0o777, 0o600)
            with dispatcher.Receipt(root) as receipt:
                self.assertEqual(receipt.read()['selected'], 'PAGE1')
                with self.assertRaises(dispatcher.DispatchError):
                    receipt.require('22222222-2222-4222-8222-222222222222')
            (root / 'mission.json').unlink()
            (root / 'mission.json').symlink_to(root / 'other')
            with dispatcher.Receipt(root) as receipt:
                with self.assertRaises(dispatcher.DispatchError):
                    receipt.read()

    def test_snapshot_is_actual_bounded_and_refuses_private_main_frame(self):
        class Cdp:
            def __init__(self, url): self.url, self.methods = url, []
            def command(self, method, params=None, session=None):
                self.methods.append(method)
                if method == 'Page.getFrameTree': return {'frameTree': {'frame': {'url': self.url}}}
                if method == 'Target.getTargetInfo': return {'targetInfo': {'title': 'Actual title'}}
                if method == 'Accessibility.getFullAXTree': return {'nodes': [{'role': {'value': 'StaticText'}, 'name': {'value': 'real text' * 3000}}]}
                return {}
        cdp = Cdp('https://example.com/')
        with patch.object(dispatcher, 'allow_url'):
            result = dispatcher.snapshot(cdp, 'SESSION', 'PAGE1')
        self.assertEqual(result['title'], 'Actual title')
        self.assertTrue(result['visibleText'].startswith('real text'))
        self.assertLessEqual(len(result['visibleText']), 12000)
        cdp = Cdp('http://127.0.0.1/secret')
        with self.assertRaises(dispatcher.DispatchError): dispatcher.snapshot(cdp, 'SESSION', 'PAGE1')
        self.assertNotIn('Accessibility.getFullAXTree', cdp.methods)

    def test_no_running_owned_chromium_is_not_runtime_ready(self):
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaises(dispatcher.DispatchError) as error:
                dispatcher.verify_runtime(self.payload['profilePath'], Path(directory))
            self.assertEqual(error.exception.code, 'runtime_not_ready')

    def test_transport_cli_invalid_payload_has_sanitized_error(self):
        result = dispatcher.run_payload(base64.urlsafe_b64encode(json.dumps({'secret': 'do-not-echo'}).encode()).decode())
        self.assertEqual(result, {'version': 1, 'ok': False, 'code': 'invalid_payload'})

    def test_duplicate_fields_and_invalid_json_are_rejected_before_dispatch(self):
        raw = json.dumps(self.payload)[:-1] + ',"timeoutMs":1}'
        for value in (raw, '{not json'):
            encoded = base64.urlsafe_b64encode(value.encode()).decode()
            with patch.object(dispatcher, 'dispatch', return_value={}) as dispatch:
                self.assertEqual(dispatcher.run_payload(encoded), {'version': 1, 'ok': False, 'code': 'invalid_payload'})
                dispatch.assert_not_called()

    def test_unsupported_capture_formats_never_fake_success(self):
        for action in ({'type': 'capture', 'request': {'type': 'pdf'}},
                       {'type': 'capture', 'request': {'type': 'screenshot', 'format': 'jpeg'}}):
            with self.assertRaises(dispatcher.DispatchError) as error:
                dispatcher.validate_action(action)
            self.assertEqual(error.exception.code, 'unsupported_action')

    def test_dispatch_identity_flags_actual_observation_and_fenced_release(self):
        class Cdp:
            def __init__(self, _): pass
            def close(self): pass
            def command(self, method, params=None, session=None):
                if method == 'Target.getTargets': return {'targetInfos': [{'type': 'page', 'targetId': 'PAGE1', 'url': 'about:blank'}]}
                if method == 'Target.getTargetInfo': return {'targetInfo': {'type': 'page', 'title': 'Actual', 'url': 'about:blank'}}
                if method == 'Target.attachToTarget': return {'sessionId': 'ATTACHED'}
                if method == 'Page.getFrameTree': return {'frameTree': {'frame': {'url': 'about:blank'}}}
                if method == 'Accessibility.getFullAXTree': return {'nodes': []}
                if method == 'Target.createTarget': return {'targetId': 'PAGE2'}
                if method == 'Target.closeTarget': return {'success': True}
                return {}
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            profile = base / 'chromium'
            profile.mkdir(mode=0o700)
            base.chmod(0o700)
            payload = {**self.payload, 'profilePath': str(profile), 'op': 'open'}
            payload.pop('action')
            with patch.object(dispatcher, 'safe_directory', side_effect=lambda p: Path(p)), patch.object(dispatcher, 'verify_runtime'), patch.object(dispatcher, 'Cdp', Cdp):
                result = dispatcher.dispatch(payload)
                self.assertTrue(result.get('ready'), 'open must confirm actual runtime readiness')
                self.assertTrue(result.get('cdpLoopback'))
                self.assertTrue(result.get('profileVerified'))
                with patch.object(dispatcher, 'allow_url'):
                    result = dispatcher.dispatch({**payload, 'op': 'execute', 'action': {'type': 'tab_create', 'url': 'https://example.com/'}})
                self.assertEqual(result['url'], 'about:blank')
                self.assertEqual(result['title'], 'Actual')
                self.assertEqual(result['visibleText'], '')
                self.assertEqual(result['pageReceipt'], {'selectedTargetId': 'PAGE1', 'createdTargetId': 'PAGE2', 'completed': True})
                with self.assertRaises(dispatcher.DispatchError):
                    dispatcher.dispatch({**payload, 'op': 'release', 'sessionId': '22222222-2222-4222-8222-222222222222'})
                with self.assertRaises(dispatcher.DispatchError) as error:
                    dispatcher.dispatch({**payload, 'op': 'checkpoint'})
                self.assertEqual(error.exception.code, 'checkpoint_unavailable')
                self.assertTrue(dispatcher.dispatch({**payload, 'op': 'release'})['released'])

    def test_failed_action_persists_unknown_and_never_replays(self):
        class Cdp:
            def __init__(self, _): pass
            def close(self): pass
            def command(self, *args, **kwargs): raise dispatcher.DispatchError('provider_action_failed')
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            profile = base / 'chromium'
            profile.mkdir(mode=0o700)
            base.chmod(0o700)
            payload = {**self.payload, 'profilePath': str(profile)}
            with dispatcher.Receipt(base) as receipt:
                receipt.write({'sessionId': payload['sessionId'], 'principalHash': payload['principalHash'], 'selected': 'PAGE1', 'owned': ['PAGE1'], 'uncertain': False})
            with patch.object(dispatcher, 'safe_directory', side_effect=lambda p: Path(p)), patch.object(dispatcher, 'verify_runtime'), patch.object(dispatcher, 'Cdp', Cdp):
                with self.assertRaises(dispatcher.DispatchError): dispatcher.dispatch(payload)
                with self.assertRaises(dispatcher.DispatchError) as error: dispatcher.dispatch(payload)
                self.assertEqual(error.exception.code, 'effect_unknown')

    def test_checkpoint_is_exact_mission_fenced_and_resets_only_new_owned_blank_targets(self):
        self.assertTrue(hasattr(dispatcher, 'control_request'), 'trusted local supervisor checkpoint is missing')
        class Cdp:
            def __init__(self, _): pass
            def close(self): pass
            def command(self, method, params=None, session=None):
                if method == 'Target.getTargets': return {'targetInfos': [{'type': 'page', 'targetId': 'NEWBLANK', 'url': 'about:blank'}]}
                return {}
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory); base.chmod(0o700); profile = base / 'chromium'; profile.mkdir(mode=0o700)
            payload = {**self.payload, 'profilePath': str(profile), 'op': 'checkpoint'}; payload.pop('action')
            with dispatcher.Receipt(base) as receipt:
                receipt.write({'sessionId': payload['sessionId'], 'principalHash': payload['principalHash'], 'selected': 'OLDPAGE', 'owned': ['OLDPAGE'], 'uncertain': False})
            calls = []
            def control(request, deadline, expected_pid=None):
                calls.append(request)
                with dispatcher.Receipt(base) as receipt:
                    self.fail('Dispatcher must hold the exact mission receipt lock throughout checkpoint')
            def confirmed(request, deadline, expected_pid=None):
                calls.append(request)
                self.assertEqual(request['sessionId'], payload['sessionId']); self.assertEqual(request['principalHash'], payload['principalHash'])
                with open(base / 'mission.json') as stream: self.assertTrue(json.load(stream)['uncertain'])
                self.assertEqual(expected_pid, 101)
                return {'checkpointed': True, 'gracefulClosed': True, 'keyringSessionRetained': True, 'browserPidBefore': 101, 'browserPidAfter': 102, 'supervisorPid': 100, 'profileKey': payload['profileKey'], 'profilePath': str(profile), 'sessionId': payload['sessionId'], 'principalHash': payload['principalHash'], 'cdpLoopback': True, 'profileVerified': True}
            with patch.object(dispatcher, 'safe_directory', side_effect=lambda p: Path(p)), patch.object(dispatcher, 'verify_runtime', side_effect=[101, 102]), patch.object(dispatcher, 'Cdp', Cdp), patch.object(dispatcher, 'control_request', side_effect=confirmed):
                result = dispatcher.dispatch(payload)
            self.assertTrue(result['checkpointed']); self.assertTrue(result['tabsReset'])
            with dispatcher.Receipt(base) as receipt:
                state = receipt.require(payload['sessionId'], payload['principalHash'])
                self.assertEqual(state['owned'], ['NEWBLANK']); self.assertEqual(state['selected'], 'NEWBLANK'); self.assertFalse(state['uncertain'])
            self.assertEqual(len(calls), 1)

    def test_unknown_checkpoint_retains_fence_and_cannot_replay(self):
        self.assertTrue(hasattr(dispatcher, 'control_request'), 'trusted local supervisor checkpoint is missing')
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory); base.chmod(0o700); profile = base / 'chromium'; profile.mkdir(mode=0o700)
            payload = {**self.payload, 'profilePath': str(profile), 'op': 'checkpoint'}; payload.pop('action')
            with dispatcher.Receipt(base) as receipt: receipt.write({'sessionId': payload['sessionId'], 'principalHash': payload['principalHash'], 'selected': 'PAGE1', 'owned': ['PAGE1'], 'uncertain': False})
            with patch.object(dispatcher, 'safe_directory', side_effect=lambda p: Path(p)), patch.object(dispatcher, 'verify_runtime', return_value=101), patch.object(dispatcher, 'control_request', side_effect=dispatcher.DispatchError('checkpoint_unknown')) as control:
                with self.assertRaises(dispatcher.DispatchError): dispatcher.dispatch(payload)
                with self.assertRaises(dispatcher.DispatchError) as error: dispatcher.dispatch(payload)
                self.assertEqual(error.exception.code, 'effect_unknown'); self.assertEqual(control.call_count, 1)
            with dispatcher.Receipt(base) as receipt: self.assertTrue(receipt.read()['uncertain'])

    def test_probe_checkpoint_readiness_is_real_exact_profile_status_not_global(self):
        class Cdp:
            def __init__(self, _): pass
            def close(self): pass
            def command(self, *args): return {}
        payload = {name: value for name, value in self.payload.items() if name not in ('sessionId', 'action')}
        payload['op'] = 'probe'
        status = {'profileKey': payload['profileKey'], 'profilePath': payload['profilePath'], 'checkpointReady': True, 'browserPid': 101, 'supervisorPid': 100, 'cdpLoopback': True, 'profileVerified': True, 'encryptedKeyringUnlocked': True}
        with patch.object(dispatcher, 'safe_directory', side_effect=lambda p: Path(p)), patch.object(dispatcher, 'verify_runtime', return_value=101), patch.object(dispatcher, 'Cdp', Cdp), patch.object(dispatcher, 'control_request', return_value=status):
            result = dispatcher.dispatch(payload)
            self.assertTrue(result['checkpointReady']); self.assertEqual(result['browserPid'], 101)
            status['profileKey'] = 'foreign-profile'
            self.assertFalse(dispatcher.dispatch(payload)['checkpointReady'])

    def test_snapshot_rejects_private_subframes_and_populated_blank_page(self):
        class Cdp:
            def __init__(self, private): self.private = private
            def command(self, method, params=None, session=None):
                if method == 'Page.getFrameTree':
                    return {'frameTree': {'frame': {'url': 'https://example.com/' if self.private else 'about:blank'},
                                          'childFrames': [{'frame': {'url': 'http://127.0.0.1/private'}}] if self.private else []}}
                if method == 'Target.getTargetInfo': return {'targetInfo': {'title': 'Actual'}}
                if method == 'Accessibility.getFullAXTree': return {'nodes': [{'role': {'value': 'StaticText'}, 'name': {'value': 'Not empty initial page'}}]}
                return {}
        with patch.object(dispatcher.socket, 'getaddrinfo', side_effect=lambda host, *a, **k: [(2, 1, 6, '', ('127.0.0.1' if host == '127.0.0.1' else '93.184.216.34', 443))]):
            for private in (False, True):
                with self.subTest(private=private), self.assertRaises(dispatcher.DispatchError):
                    dispatcher.snapshot(Cdp(private), 'ATTACHED', 'PAGE1')

    def test_select_verifies_actual_native_value_instead_of_dispatch_ack(self):
        class Cdp:
            def command(self, method, params=None, session=None):
                if method == 'Target.getTargetInfo': return {'targetInfo': {'type': 'page', 'url': 'about:blank'}}
                if method == 'Target.attachToTarget': return {'sessionId': 'ATTACHED'}
                if method == 'Page.getFrameTree': return {'frameTree': {'frame': {'url': 'about:blank'}}}
                if method == 'DOM.getDocument': return {'root': {'nodeId': 1}}
                if method == 'DOM.querySelector': return {'nodeId': 2}
                if method == 'DOM.describeNode': return {'node': {'nodeName': 'SELECT', 'backendNodeId': 22, 'children': [
                    {'nodeName': 'OPTION', 'attributes': ['value', 'a'], 'children': [{'nodeValue': 'Alpha'}]},
                    {'nodeName': 'OPTION', 'attributes': ['value', 'b'], 'children': [{'nodeValue': 'Beta'}]}]}}
                if method == 'Accessibility.getPartialAXTree': return {'nodes': [{'backendDOMNodeId': 22, 'value': {'value': 'Alpha'}}]}
                return {}
        with self.assertRaises(dispatcher.DispatchError) as error:
            dispatcher.execute(Cdp(), {'selected': 'PAGE1', 'owned': ['PAGE1']}, {'type': 'select', 'selector': '#choice', 'value': 'b'})
        self.assertEqual(error.exception.code, 'select_postcondition_failed')

    def test_real_sandboxed_chromium_loopback_profile_identity_and_logical_mission(self):
        binary = shutil.which('chromium') or shutil.which('chromium-browser')
        if not binary:
            self.skipTest('Chromium is not installed; no real-browser proof available')
        # Disposable, unauthenticated local browser only; no URL navigation or provider calls.
        with tempfile.TemporaryDirectory(prefix='otc-dispatcher-canary-') as directory:
            root = Path(directory)
            root.chmod(0o700)
            base = root / 'cto-test'
            base.mkdir(mode=0o700)
            profile = base / 'chromium'
            profile.mkdir(mode=0o700)
            process = subprocess.Popen([binary, '--headless', '--disable-gpu', '--no-first-run',
                '--no-default-browser-check', '--remote-debugging-address=127.0.0.1',
                '--remote-debugging-port=9222', '--user-data-dir=' + str(profile), 'about:blank'],
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
            try:
                deadline = time.monotonic() + 6
                while True:
                    try:
                        dispatcher.verify_runtime(str(profile))
                        break
                    except dispatcher.DispatchError:
                        if process.poll() is not None or time.monotonic() >= deadline:
                            self.fail('Sandboxed disposable Chromium did not expose its owned loopback socket')
                        time.sleep(0.05)
                payload = {**self.payload, 'profilePath': str(profile), 'op': 'open'}
                payload.pop('action')
                def invoke(value):
                    encoded = base64.urlsafe_b64encode(json.dumps(value).encode()).decode().rstrip('=')
                    return dispatcher.run_payload(encoded)
                with patch.object(dispatcher, 'ROOT', root):
                    opened = invoke(payload)
                    self.assertTrue(opened.get('ok'), opened.get('code'))
                    self.assertEqual(opened['result'], {'ready': True, 'cdpLoopback': True, 'profileVerified': True})
                    observed = invoke({**payload, 'op': 'execute', 'action': {'type': 'snapshot'}})
                    self.assertTrue(observed.get('ok'), observed.get('code'))
                    self.assertEqual(observed['result']['url'], 'about:blank')
                    self.assertEqual(observed['result']['visibleText'], '')
                    released = invoke({**payload, 'op': 'release'})
                    self.assertTrue(released.get('ok'), released.get('code'))
                    self.assertTrue(released['result']['released'])
                    self.assertIsNone(process.poll(), 'Logical release must not stop Chromium')
            finally:
                os.killpg(process.pid, signal.SIGTERM)
                try: process.wait(timeout=4)
                except subprocess.TimeoutExpired:
                    os.killpg(process.pid, signal.SIGKILL)
                    process.wait(timeout=4)
                time.sleep(0.2)  # Chromium's child processes finish their disposable-profile writes.


if __name__ == '__main__':
    unittest.main()
