import importlib.util
import json
import os
from pathlib import Path
import signal
import shutil
import socket
import stat
import subprocess
import tempfile
import threading
import time
import unittest
from unittest.mock import patch


BASE = Path(__file__).parent


def load(name, filename):
    path = BASE / filename
    if not path.exists(): return None
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


control = load('checkpoint_control', 'checkpoint-control.py')
runtime = load('checkpoint_runtime', 'runtime.py')
dispatcher = load('checkpoint_dispatcher', 'browser-dispatcher.py')


class Browser:
    def __init__(self, pid): self.pid, self.returncode = pid, None
    def poll(self): return self.returncode
    def wait(self, timeout):
        if self.returncode is None: raise subprocess.TimeoutExpired('chromium', timeout)
        return self.returncode


class CheckpointTests(unittest.TestCase):
    def setUp(self):
        self.assertIsNotNone(control, 'Warm checkpoint control is not implemented')
        self.assertIsNotNone(runtime, 'Keyring-retaining supervisor is not implemented')
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.root.chmod(0o700)
        self.profile = runtime.prepare_profile(self.root, 'cto-test')
        self.request = {'version': 1, 'op': 'checkpoint', 'profileKey': 'cto-test',
                        'profilePath': str(self.profile['chromium']), 'timeoutMs': 14000,
                        'sessionId': '11111111-1111-4111-8111-111111111111',
                        'principalHash': 'a' * 64, 'expectedBrowserPid': 1001}
        self.receipt = self.profile['base'] / 'mission.json'
        self.receipt.write_text(json.dumps({'sessionId': self.request['sessionId'], 'principalHash': self.request['principalHash'],
                                          'selected': 'OLD', 'owned': ['OLD'], 'uncertain': True}))
        self.receipt.chmod(0o600)
        self.browsers, self.healthy, self.commands = [], True, []
        test = self
        class Cdp:
            def __init__(self, deadline): pass
            def command(self, method):
                test.commands.append(method)
                if method != 'Browser.close': raise AssertionError('Only graceful browser close is authorized')
                test.browsers[-1].returncode = 0
                return {}
            def close(self): pass
        class Dispatcher:
            def verify_runtime(self, path):
                test.assertEqual(path, str(test.profile['chromium']))
                return test.browsers[-1].pid
        Dispatcher.Cdp = Cdp
        def launch():
            browser = Browser(1001 + len(self.browsers))
            self.browsers.append(browser)
            return browser
        self.supervisor = control.WarmSupervisor(self.profile, launch, lambda deadline: self.healthy, Dispatcher())
        self.supervisor.start()
        self.addCleanup(self.supervisor.close)

    def test_strict_requests_reject_foreign_identity_paths_and_commands(self):
        control.validate_request(self.request, self.profile)
        for change in ({'shell': 'id'}, {'op': 'execute'}, {'timeoutMs': 14001}, {'expectedBrowserPid': True},
                       {'profileKey': '../other'}, {'profilePath': '/tmp/foreign'}, {'sessionId': 'bad'}, {'principalHash': 'secret'}):
            with self.subTest(change=change), self.assertRaises(control.ControlError):
                control.validate_request({**self.request, **change}, self.profile)

    def test_status_requires_real_keyring_and_exact_owned_running_process(self):
        status = self.supervisor.status(time.monotonic() + 2)
        self.assertTrue(status['checkpointReady'])
        self.assertEqual(status['browserPid'], 1001)
        self.assertEqual(status['supervisorPid'], os.getpid())
        self.healthy = False
        self.assertFalse(self.supervisor.status(time.monotonic() + 2)['checkpointReady'])

    def test_checkpoint_closes_exact_process_and_reopens_same_profile_with_same_supervisor(self):
        result = self.supervisor.checkpoint(self.request, time.monotonic() + 2)
        self.assertEqual(self.commands, ['Browser.close'])
        self.assertEqual(self.browsers[0].returncode, 0)
        self.assertEqual(result['browserPidBefore'], 1001)
        self.assertEqual(result['browserPidAfter'], 1002)
        self.assertEqual(result['supervisorPid'], os.getpid())
        for name in ('checkpointed', 'gracefulClosed', 'keyringSessionRetained', 'cdpLoopback', 'profileVerified'):
            self.assertTrue(result[name])
        self.assertEqual(result['sessionId'], self.request['sessionId'])
        self.assertEqual(result['principalHash'], self.request['principalHash'])

    def test_foreign_session_principal_or_pid_never_closes_browser(self):
        for change in ({'sessionId': '22222222-2222-4222-8222-222222222222'}, {'principalHash': 'b' * 64}, {'expectedBrowserPid': 2000}):
            with self.subTest(change=change), self.assertRaises(control.ControlError):
                self.supervisor.checkpoint({**self.request, **change}, time.monotonic() + 2)
        self.assertEqual(self.commands, [])
        self.assertEqual(len(self.browsers), 1)

    def test_lost_keyring_fails_before_effect_and_deadline_never_closes(self):
        self.healthy = False
        with self.assertRaises(control.ControlError): self.supervisor.checkpoint(self.request, time.monotonic() + 2)
        self.healthy = True
        with self.assertRaises(control.ControlError): self.supervisor.checkpoint(self.request, time.monotonic() - 1)
        self.assertEqual(self.commands, [])

    def test_mission_receipt_symlink_never_authorizes_checkpoint(self):
        target = self.profile['base'] / 'outside.json'
        self.receipt.rename(target)
        self.receipt.symlink_to(target)
        with self.assertRaises(control.ControlError): self.supervisor.checkpoint(self.request, time.monotonic() + 2)
        self.assertEqual(self.commands, [])

    def test_private_socket_real_peer_roundtrip_and_mismatched_peer_pid_rejected(self):
        self.supervisor.listen()
        socket_path = control.control_socket_path(self.profile['chromium'])
        self.assertTrue(stat.S_ISSOCK(socket_path.stat().st_mode))
        self.assertEqual(socket_path.stat().st_mode & 0o777, 0o600)
        payload = {key: value for key, value in self.request.items() if key not in ('sessionId', 'principalHash', 'expectedBrowserPid')}
        payload['op'] = 'status'
        def serve(): self.supervisor.serve_once(2)
        with patch.object(control, 'STATE_ROOT', self.root):
            thread = threading.Thread(target=serve)
            thread.start()
            try:
                result = control.request_control(str(self.profile['chromium']), payload, time.monotonic() + 2)
                self.assertEqual(result['supervisorPid'], os.getpid())
                self.assertTrue(result['checkpointReady'])
            finally: thread.join(timeout=3)
        self.assertFalse(thread.is_alive())

    def test_real_private_socket_checkpoint_roundtrip_preserves_wire_deadline_and_identity(self):
        self.supervisor.listen()
        thread = threading.Thread(target=lambda: self.supervisor.serve_once(2))
        thread.start()
        try:
            with patch.object(control, 'STATE_ROOT', self.root):
                result = control.request_control(str(self.profile['chromium']), self.request, time.monotonic() + 2)
            self.assertTrue(result['checkpointed'])
            self.assertEqual(result['browserPidBefore'], 1001)
            self.assertEqual(result['browserPidAfter'], 1002)
            self.assertEqual(result['sessionId'], self.request['sessionId'])
            self.assertEqual(result['principalHash'], self.request['principalHash'])
            self.assertEqual(result['supervisorPid'], os.getpid())
            self.assertEqual(self.commands, ['Browser.close'])
        finally: thread.join(timeout=3)
        self.assertFalse(thread.is_alive())

    def test_longest_profile_key_uses_short_collision_resistant_private_socket_path(self):
        first = runtime.prepare_profile(self.root, 'c' * 96)
        second = runtime.prepare_profile(self.root, 'd' * 96)
        self.assertTrue(hasattr(control, 'control_socket_path'), 'Control socket must not exceed AF_UNIX pathname bounds')
        a = control.control_socket_path(first['chromium'])
        b = control.control_socket_path(second['chromium'])
        self.assertNotEqual(a, b)
        self.assertLessEqual(len(os.fsencode(a)), 107)
        self.assertEqual(a.parent, self.root / '.control')

    def test_connection_loss_is_accepted_only_after_exact_process_clean_exit(self):
        test = self
        class Lost:
            def __init__(self, deadline): pass
            def command(self, method):
                test.browsers[-1].returncode = 9
                raise ConnectionResetError()
            def close(self): pass
        self.supervisor.dispatcher.Cdp = Lost
        with self.assertRaises(control.ControlError) as error:
            self.supervisor.checkpoint(self.request, time.monotonic() + 2)
        self.assertEqual(error.exception.code, 'checkpoint_close_unconfirmed')
        self.assertEqual(len(self.browsers), 1)
        self.assertTrue(self.supervisor.faulted)
        with self.assertRaises(control.ControlError): self.supervisor.checkpoint(self.request, time.monotonic() + 2)
        self.assertEqual(len(self.browsers), 1)

    def test_keyring_loss_after_graceful_close_never_restarts_browser(self):
        test = self
        class Lost:
            def __init__(self, deadline): pass
            def command(self, method):
                test.browsers[-1].returncode = 0
                test.healthy = False
                return {}
            def close(self): pass
        self.supervisor.dispatcher.Cdp = Lost
        with self.assertRaises(control.ControlError) as error:
            self.supervisor.checkpoint(self.request, time.monotonic() + 2)
        self.assertEqual(error.exception.code, 'keyring_not_ready')
        self.assertEqual(len(self.browsers), 1)

    def test_control_client_clamps_wire_deadline_and_rejects_spoofed_supervisor_pid(self):
        self.supervisor.listen()
        path = control.control_socket_path(self.profile['chromium'])
        self.supervisor.listener.close()
        self.supervisor.listener = None
        path.unlink()
        listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        listener.bind(str(path))
        path.chmod(0o600)
        listener.listen()
        self.addCleanup(listener.close)
        seen = []
        def serve():
            connection, _ = listener.accept()
            with connection:
                request = control.read_message(connection, time.monotonic() + 2)
                seen.append(request)
                result = self.supervisor.status(time.monotonic() + 2)
                result['supervisorPid'] = os.getpid() + 1
                control.write_message(connection, {'version': 1, 'ok': True, 'result': result}, time.monotonic() + 2)
        thread = threading.Thread(target=serve)
        thread.start()
        payload = {key: value for key, value in self.request.items() if key not in ('sessionId', 'principalHash', 'expectedBrowserPid')}
        payload['op'] = 'status'
        with patch.object(control, 'STATE_ROOT', self.root), self.assertRaises(control.ControlError) as error:
            control.request_control(str(self.profile['chromium']), payload, time.monotonic() + 0.5)
        thread.join(timeout=3)
        self.assertEqual(error.exception.code, 'control_peer_forbidden')
        self.assertLessEqual(seen[0]['timeoutMs'], 500)
        self.assertIn('deadlineMonotonicMs', seen[0])

    def test_queued_expired_checkpoint_is_rejected_without_browser_close(self):
        self.supervisor.listen()
        path = control.control_socket_path(self.profile['chromium'])
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
            connection.connect(str(path))
            payload = {**self.request, 'deadlineMonotonicMs': int((time.monotonic() - 1) * 1000)}
            control.write_message(connection, payload, time.monotonic() + 2)
            self.supervisor.serve_once(0)
            result = control.read_message(connection, time.monotonic() + 2)
        self.assertEqual(result, {'version': 1, 'ok': False, 'code': 'checkpoint_timeout'})
        self.assertEqual(self.commands, [])

    def test_plaintext_keyring_and_provider_environment_are_not_trusted(self):
        directory = self.profile['data'] / 'keyrings'
        directory.mkdir()
        (directory / 'login.keyring').write_text('[keyring]\npassword=\n')
        self.assertFalse(runtime.has_encrypted_keyring(self.profile))
        command = runtime.browser_command('/usr/bin/chromium', self.profile)
        self.assertIn('--password-store=gnome-libsecret', command)
        self.assertNotIn('--no-sandbox', command)
        self.assertNotIn('--password-store=basic', command)
        env = runtime.browser_environment(self.profile, {'DAYTONA_API_KEY': 'no', 'AWS_SECRET_ACCESS_KEY': 'no', 'DBUS_SESSION_BUS_ADDRESS': 'foreign'})
        self.assertNotIn('DAYTONA_API_KEY', env)
        self.assertNotIn('AWS_SECRET_ACCESS_KEY', env)
        self.assertNotIn('DBUS_SESSION_BUS_ADDRESS', env)

    def test_real_cookie_flush_and_reopen_with_injected_health_is_not_libsecret_proof(self):
        binary = shutil.which('chromium') or shutil.which('chromium-browser')
        if not binary: self.skipTest('No Chromium; no real checkpoint proof')
        with socket.socket() as probe:
            probe.settimeout(0.1)
            if probe.connect_ex(('127.0.0.1', 9222)) == 0: self.skipTest('CDP port already occupied; do not interfere with another browser')
        launched = []
        env = runtime.browser_environment(self.profile, os.environ)
        def launch():
            command = runtime.browser_command(binary, self.profile)
            command[-1:-1] = ['--headless', '--disable-gpu']
            browser = subprocess.Popen(command, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
            launched.append(browser)
            return browser
        # The host lacks libsecret/keyring binaries. This callback is an explicit test dependency,
        # NOT a production bypass or proof of encrypted-keyring readiness/password persistence.
        supervisor = control.WarmSupervisor(self.profile, launch, lambda deadline: True, dispatcher)
        def connection():
            cdp = dispatcher.Cdp(time.monotonic() + 3)
            pages = [page for page in cdp.command('Target.getTargets')['targetInfos'] if page['type'] == 'page']
            session = cdp.command('Target.attachToTarget', {'targetId': pages[0]['targetId'], 'flatten': True})['sessionId']
            return cdp, session
        try:
            with runtime.exclusive_lock(self.root / 'desktop.lock'), runtime.exclusive_lock(self.profile['base'] / 'profile.lock'):
                supervisor.start()
                cdp, session = connection()
                try:
                    result = cdp.command('Network.setCookie', {'url': 'https://example.test/', 'name': 'otc_checkpoint_canary',
                        'value': 'synthetic-nonsecret-canary', 'expires': int(time.time()) + 3600}, session)
                    self.assertTrue(result['success'])
                    result = cdp.command('Network.setCookie', {'url': 'https://example.test/', 'name': 'otc_session_checkpoint_canary',
                        'value': 'synthetic-session-nonsecret-canary'}, session)
                    self.assertTrue(result['success'])
                    cookies = cdp.command('Network.getCookies', {'urls': ['https://example.test/']}, session)['cookies']
                    self.assertEqual([cookie['session'] for cookie in cookies if cookie['name'] == 'otc_session_checkpoint_canary'], [True])
                finally: cdp.close()
                payload = {**self.request, 'expectedBrowserPid': supervisor.browser.pid}
                result = supervisor.checkpoint(payload, time.monotonic() + 10)
                self.assertTrue(result['checkpointed'])
                self.assertTrue(result['gracefulClosed'])
                self.assertEqual(launched[0].returncode, 0)
                self.assertEqual(len(launched), 2)
                self.assertNotEqual(launched[0].pid, launched[1].pid)
                self.assertEqual(result['supervisorPid'], os.getpid())
                for path in (self.root / 'desktop.lock', self.profile['base'] / 'profile.lock'):
                    with self.assertRaises(runtime.RuntimeBusy):
                        with runtime.exclusive_lock(path): self.fail('Checkpoint released an outer write lease')
                cdp, session = connection()
                try:
                    cookies = cdp.command('Network.getCookies', {'urls': ['https://example.test/']}, session)['cookies']
                    self.assertEqual([cookie['value'] for cookie in cookies if cookie['name'] == 'otc_checkpoint_canary'], ['synthetic-nonsecret-canary'])
                    self.assertEqual([(cookie['value'], cookie['session']) for cookie in cookies if cookie['name'] == 'otc_session_checkpoint_canary'], [('synthetic-session-nonsecret-canary', True)])
                    try: cdp.command('Browser.close')
                    except dispatcher.DispatchError as error:
                        if error.code != 'provider_connection_lost': raise
                finally: cdp.close()
                self.assertEqual(supervisor.browser.wait(timeout=3), 0)
        finally:
            supervisor.close()
            for browser in launched:
                if browser.poll() is None:
                    os.killpg(browser.pid, signal.SIGTERM)
                    try: browser.wait(timeout=3)
                    except subprocess.TimeoutExpired:
                        os.killpg(browser.pid, signal.SIGKILL)
                        browser.wait(timeout=3)
            time.sleep(0.2)


if __name__ == '__main__': unittest.main()
