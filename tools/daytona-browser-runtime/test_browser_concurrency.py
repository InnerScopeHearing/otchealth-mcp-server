import base64
import importlib.util
import json
from pathlib import Path
import tempfile
import time
import unittest
import os
import shutil
import socket
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor
import threading
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('concurrent_dispatcher', Path(__file__).with_name('browser-dispatcher.py'))
dispatcher = importlib.util.module_from_spec(spec); spec.loader.exec_module(dispatcher)
A, B = '11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'

class Cdp:
    targets, actions, next_id = {'UNOWNED': 'about:blank'}, [], 0
    def __init__(self, _): pass
    def close(self): pass
    def command(self, method, params=None, session=None):
        params = params or {}; self.actions.append((method, params, session))
        if method == 'Target.createTarget':
            Cdp.next_id += 1; target = 'OWNED' + str(Cdp.next_id); self.targets[target] = params['url']; return {'targetId': target}
        if method == 'Target.getTargets': return {'targetInfos': [{'targetId': key, 'type': 'page', 'url': url} for key, url in self.targets.items()]}
        if method == 'Target.getTargetInfo': return {'targetInfo': {'type': 'page', 'url': self.targets[params['targetId']], 'title': ''}}
        if method == 'Target.attachToTarget': return {'sessionId': params['targetId']}
        if method == 'Target.closeTarget': del self.targets[params['targetId']]; return {'success': True}
        if method == 'Page.getFrameTree': return {'frameTree': {'frame': {'id': 'FRAME_' + session, 'loaderId': 'LOADER_' + session, 'url': self.targets[session]}}}
        if method == 'DOM.getDocument': return {'root': {'nodeId': 1, 'backendNodeId': 1}}
        if method == 'DOM.querySelectorAll': return {'nodeIds': [7] if params.get('selector') == '#public' else []}
        if method == 'DOM.describeNode': return {'node': {'nodeId': 7, 'backendNodeId': 7, 'nodeName': 'BUTTON', 'attributes': ['id', 'public']}}
        if method == 'DOM.getContentQuads': return {'quads': [[0, 0, 10, 0, 10, 10, 0, 10]]}
        if method == 'Accessibility.getFullAXTree': return {'nodes': []}
        return {}

class ConcurrencyTests(unittest.TestCase):
    def setUp(self):
        self.assertTrue(hasattr(dispatcher, 'dispatch_v2'), 'Native V2 dispatcher is missing')
        self.directory = tempfile.TemporaryDirectory(); self.addCleanup(self.directory.cleanup)
        self.base = Path(self.directory.name); self.base.chmod(0o700); self.profile = self.base / 'chromium'; self.profile.mkdir(mode=0o700)
        Cdp.targets, Cdp.actions, Cdp.next_id = {'UNOWNED': 'about:blank'}, [], 0
        for patcher in (patch.object(dispatcher, 'safe_directory', side_effect=lambda p: Path(p)), patch.object(dispatcher, 'verify_runtime', return_value=101), patch.object(dispatcher, 'Cdp', Cdp)):
            patcher.start(); self.addCleanup(patcher.stop)
    def payload(self, session=A, principal='a' * 64, op='open', action=None):
        result = {'version': 1, 'runtimeProtocol': 2, 'op': op, 'profileKey': 'company-browser', 'profilePath': str(self.profile), 'timeoutMs': 1000, 'sessionId': session, 'principalHash': principal}
        if action: result['action'] = action
        return result
    def call(self, *args, **kwargs): return dispatcher.dispatch(self.payload(*args, **kwargs))

    def test_explicit_v2_wire_is_validated_and_legacy_does_not_gain_new_human_operations(self):
        value = self.payload(); value['profilePath'] = str(dispatcher.ROOT / 'company-browser' / 'chromium')
        self.assertEqual(dispatcher.validate_payload(value)['runtimeProtocol'], 2)
        with self.assertRaises(dispatcher.DispatchError): dispatcher.validate_payload({**value, 'runtimeProtocol': 3})
        value.pop('runtimeProtocol'); value['op'] = 'human_pause'
        with self.assertRaises(dispatcher.DispatchError): dispatcher.validate_payload(value)

    def test_two_missions_receive_new_disjoint_tabs_and_foreign_target_cannot_select(self):
        self.call(); self.call(B, 'b' * 64)
        state = json.loads((self.base / 'missions-v2.json').read_text())
        self.assertEqual([mission['selected'] for mission in state['missions']], ['OWNED1', 'OWNED2'])
        before = len(Cdp.actions)
        with self.assertRaises(dispatcher.DispatchError): self.call(op='execute', action={'type': 'tab_select', 'targetId': 'OWNED2'})
        self.assertFalse(any(method == 'Target.activateTarget' for method, _, _ in Cdp.actions[before:]))

    def test_checkpoint_and_human_pause_refuse_other_mission_without_effect(self):
        self.call(); self.call(B, 'b' * 64)
        for op in ('checkpoint', 'human_pause'):
            with self.assertRaises(dispatcher.DispatchError) as error: self.call(op=op)
            self.assertEqual(error.exception.code, 'other_missions_active'); self.assertTrue(error.exception.before_effect)
        self.assertNotIn('Browser.close', [method for method, _, _ in Cdp.actions])
        self.assertIsNone(json.loads((self.base / 'missions-v2.json').read_text())['uncertain'])

    def test_human_pause_blocks_new_mission_and_every_action_until_exact_resume(self):
        self.call(); self.assertEqual(self.call(op='human_pause'), {'paused': True})
        with self.assertRaises(dispatcher.DispatchError) as error: self.call(B, 'b' * 64)
        self.assertEqual(error.exception.code, 'human_active')
        with self.assertRaises(dispatcher.DispatchError): self.call(op='execute', action={'type': 'snapshot'})
        with self.assertRaises(dispatcher.DispatchError): self.call(B, 'b' * 64, op='human_resume')
        self.assertEqual(self.call(op='human_resume'), {'resumed': True})
        self.call(B, 'b' * 64)

    def test_stop_closes_only_owned_tabs_and_keeps_other_mission_and_browser(self):
        self.call(); self.call(B, 'b' * 64)
        self.assertTrue(self.call(op='release')['released'])
        self.assertNotIn('OWNED1', Cdp.targets); self.assertIn('OWNED2', Cdp.targets); self.assertIn('UNOWNED', Cdp.targets)
        self.assertEqual(len(json.loads((self.base / 'missions-v2.json').read_text())['missions']), 1)
        self.call(B, 'b' * 64, op='execute', action={'type': 'snapshot'})

    def test_last_mission_release_preserves_a_blank_parking_target_instead_of_closing_chromium(self):
        self.call(); del Cdp.targets['UNOWNED']
        self.assertTrue(self.call(op='release')['released'])
        self.assertEqual(len(Cdp.targets), 1)
        self.assertEqual(list(Cdp.targets.values()), ['about:blank'])

    def test_ordinary_tab_close_of_last_page_preserves_retained_chromium_without_adopting_parking(self):
        self.call(); del Cdp.targets['UNOWNED']
        result = self.call(op='execute', action={'type': 'tab_close', 'targetId': 'OWNED1'})
        self.assertTrue(result['pageReceipt']['completed']); self.assertIsNone(result['pageReceipt']['selectedTargetId'])
        self.assertEqual(list(Cdp.targets.values()), ['about:blank'])
        state = json.loads((self.base / 'missions-v2.json').read_text())
        self.assertEqual(state['missions'][0]['owned'], [])

    def test_unknown_native_effect_freezes_other_mission_and_release_across_new_dispatch(self):
        self.call(); self.call(B, 'b' * 64)
        with patch.object(dispatcher, 'execute', side_effect=dispatcher.DispatchError('provider_connection_lost')):
            with self.assertRaises(dispatcher.DispatchError): self.call(op='execute', action={'type': 'click', 'selector': '#public'})
        with self.assertRaises(dispatcher.DispatchError) as error: self.call(B, 'b' * 64, op='execute', action={'type': 'snapshot'})
        self.assertEqual(error.exception.code, 'effect_unknown')
        self.assertTrue(self.call(op='release')['released'])
        state = json.loads((self.base / 'missions-v2.json').read_text())
        self.assertIsNone(state['uncertain']); self.assertEqual([mission['sessionId'] for mission in state['missions']], [B])
        self.call(B, 'b' * 64, op='execute', action={'type': 'snapshot'})

    def test_v2_clipboard_routes_only_owned_buffer_and_never_returns_its_text(self):
        self.call(); self.call(B, 'b' * 64)
        calls = []
        class Clipboard:
            class ClipboardError(Exception): pass
            @staticmethod
            def handle_clipboard(cdp, attached, action, text):
                calls.append((attached, text)); return {'clipboardText': 'private-nonsecret-canary', 'changed': True}
        self.assertTrue(hasattr(dispatcher, 'trusted_clipboard'), 'Private clipboard integration is missing')
        with patch.object(dispatcher, 'trusted_clipboard', return_value=Clipboard):
            result = self.call(op='execute', action={'type': 'press_key', 'key': 'KeyC', 'modifiers': 2})
        self.assertEqual(calls, [('OWNED1', '')]); self.assertNotIn('private-nonsecret-canary', json.dumps(result))
        state = json.loads((self.base / 'missions-v2.json').read_text())
        self.assertEqual(state['missions'][0]['clipboardText'], 'private-nonsecret-canary'); self.assertNotIn('clipboardText', state['missions'][1])

class NativeConcurrencyTests(unittest.TestCase):
    def test_real_sandboxed_chromium_two_principals_native_input_click_and_tab_survival(self):
        binary = shutil.which('chromium') or shutil.which('chromium-browser')
        self.assertIsNotNone(binary, 'Actual Chromium is required for concurrency acceptance')
        with socket.socket() as probe:
            self.assertNotEqual(probe.connect_ex(('127.0.0.1', 9222)), 0, 'Another worker owns9222; coordinate instead of interfering')
        with tempfile.TemporaryDirectory(prefix='otc-two-principals-') as directory:
            root = Path(directory); root.chmod(0o700); base = root / 'company-browser'; base.mkdir(mode=0o700)
            profile = base / 'chromium'; profile.mkdir(mode=0o700)
            browser = subprocess.Popen([binary, '--headless=new', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=9222', '--user-data-dir=' + str(profile), '--no-first-run', '--no-default-browser-check', 'about:blank'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            try:
                until = time.monotonic() + 10
                while True:
                    try: pid = dispatcher.verify_runtime(str(profile)); break
                    except dispatcher.DispatchError:
                        self.assertIsNone(browser.poll(), 'Sandboxed Chromium exited before readiness')
                        if time.monotonic() >= until: self.fail('Sandboxed Chromium never became ready')
                        time.sleep(0.05)
                self.assertEqual(pid, browser.pid)
                script = str(Path(dispatcher.__file__).resolve())
                # The fixture is fulfilled inside Chromium before any network
                # request. Only its synthetic hostname has injected public DNS;
                # production URL guards and all actual loopback CDP stay intact.
                harness = "import importlib.util,json,sys;from pathlib import Path;s=importlib.util.spec_from_file_location('d',sys.argv[1]);d=importlib.util.module_from_spec(s);s.loader.exec_module(d);d.ROOT=Path(sys.argv[2]);lookup=d.socket.getaddrinfo;d.socket.getaddrinfo=lambda host,*a,**k:[(2,1,6,'',('93.184.216.34',443))] if host=='browser-fixture.example.test' else lookup(host,*a,**k);r=d.run_payload(sys.argv[3]);print(json.dumps(r));sys.exit(0 if r['ok'] or r.get('beforeEffect') else 1)"
                def call(session=A, principal='a' * 64, op='open', action=None):
                    payload = {'version': 1, 'runtimeProtocol': 2, 'op': op, 'profileKey': base.name, 'profilePath': str(profile), 'timeoutMs': 8000, 'sessionId': session, 'principalHash': principal}
                    if action: payload['action'] = action
                    encoded = base64.urlsafe_b64encode(json.dumps(payload).encode()).decode()
                    result = subprocess.run([sys.executable, '-I', '-c', harness, script, str(root), encoded], capture_output=True, timeout=10)
                    self.assertLess(len(result.stdout), 65536)
                    receipt = json.loads(result.stdout)
                    if receipt.get('code') == 'runtime_not_ready':
                        evidence = {'browser_exited': browser.poll(), 'directory_modes': [oct(path.stat().st_mode & 0o777) for path in (root, base, profile)]}
                        try: evidence['parent_verified_pid'] = dispatcher.verify_runtime(str(profile))
                        except dispatcher.DispatchError as error: evidence['parent_verify_error'] = error.code
                        self.fail(str({'receipt': receipt, 'evidence': evidence}))
                    return receipt
                self.assertTrue(call()['ok']); self.assertTrue(call(B, 'b' * 64)['ok'])
                state = json.loads((base / 'missions-v2.json').read_text())
                targets = {mission['sessionId']: mission['selected'] for mission in state['missions']}
                self.assertNotEqual(targets[A], targets[B])
                cdp = dispatcher.Cdp(time.monotonic() + 15)
                def attachment(target): return cdp.command('Target.attachToTarget', {'targetId': target, 'flatten': True})['sessionId']
                try:
                    for session_id, label in [(A, 'Alpha'), (B, 'Beta')]:
                        attached = attachment(targets[session_id])
                        html = '<html><head><title>' + label + '</title></head><body><input id="value"><button id="go" style="width:40px;height:40px" onclick="counter.value=String(Number(counter.value)+1)"></button><input id="counter" value="0"><input id="paste"></body></html>'
                        url = 'https://browser-fixture.example.test/' + label.lower()
                        cdp.command('Fetch.enable', {'patterns': [{'urlPattern': 'https://browser-fixture.example.test/*'}]}, attached)
                        cdp.identifier += 1
                        cdp.send(1, json.dumps({'id': cdp.identifier, 'method': 'Page.navigate', 'params': {'url': url}, 'sessionId': attached}).encode())
                        while True:
                            event = cdp.message()
                            if event.get('method') == 'Fetch.requestPaused' and event.get('sessionId') == attached:
                                cdp.command('Fetch.fulfillRequest', {'requestId': event['params']['requestId'], 'responseCode': 200, 'responseHeaders': [{'name': 'Content-Type', 'value': 'text/html'}], 'body': base64.b64encode(html.encode()).decode()}, attached); break
                        while cdp.command('Page.getFrameTree', {}, attached)['frameTree']['frame']['url'] != url: cdp.remaining()
                        cdp.command('Fetch.disable', {}, attached)
                    barrier = threading.Barrier(2)
                    def work(session_id, principal, marker):
                        barrier.wait(timeout=2)
                        label = 'alpha' if session_id == A else 'beta'
                        result = call(session_id, principal, 'execute', {'type': 'navigate', 'url': 'https://browser-fixture.example.test/' + label + '#owned-navigation'}); self.assertTrue(result['ok'], result)
                        result = call(session_id, principal, 'execute', {'type': 'type', 'selector': '#value', 'text': marker}); self.assertTrue(result['ok'], result)
                        for _ in range(3):
                            result = call(session_id, principal, 'execute', {'type': 'click', 'selector': '#go'}); self.assertTrue(result['ok'], result)
                    with ThreadPoolExecutor(max_workers=2) as pool:
                        jobs = [pool.submit(work, A, 'a' * 64, 'alpha-nonsecret-canary'), pool.submit(work, B, 'b' * 64, 'beta-nonsecret-canary')]
                        for job in jobs: job.result(timeout=15)
                    def fields(target):
                        attached = attachment(target)
                        context = cdp.command('Page.createIsolatedWorld', {'frameId': cdp.command('Page.getFrameTree', {}, attached)['frameTree']['frame']['id'], 'worldName': 'otc-test-native-values', 'grantUniveralAccess': False}, attached)['executionContextId']
                        result = cdp.command('Runtime.evaluate', {'expression': 'JSON.stringify([document.getElementById("value").value,document.getElementById("counter").value])', 'returnByValue': True, 'contextId': context}, attached)
                        return json.loads(result['result']['value'])
                    self.assertEqual(fields(targets[A]), ['alpha-nonsecret-canary', '3'])
                    self.assertEqual(fields(targets[B]), ['beta-nonsecret-canary', '3'])
                    # Page-world substitutions must not become copied bytes or
                    # fake the native paste proof in the isolated world.
                    for target in targets.values():
                        attached = attachment(target)
                        cdp.command('Runtime.evaluate', {'expression': 'Object.defineProperty(HTMLInputElement.prototype,"value",{get(){return "HOSTILE_PAGE_VALUE"},configurable:true});Document.prototype.getSelection=function(){return {toString(){return "HOSTILE_SELECTION"}}}', 'returnByValue': True}, attached)
                    for session_id, principal in [(A, 'a' * 64), (B, 'b' * 64)]:
                        self.assertTrue(call(session_id, principal, 'execute', {'type': 'focus', 'selector': '#value'})['ok'])
                        self.assertTrue(call(session_id, principal, 'execute', {'type': 'press_key', 'key': 'KeyA', 'modifiers': 2})['ok'])
                        copied = call(session_id, principal, 'execute', {'type': 'press_key', 'key': 'KeyC', 'modifiers': 2})
                        self.assertTrue(copied['ok'], copied); self.assertNotIn('nonsecret-canary', json.dumps(copied))
                    with ThreadPoolExecutor(max_workers=2) as pool:
                        def paste(session_id, principal):
                            self.assertTrue(call(session_id, principal, 'execute', {'type': 'focus', 'selector': '#paste'})['ok'])
                            result = call(session_id, principal, 'execute', {'type': 'press_key', 'key': 'KeyV', 'modifiers': 2})
                            self.assertTrue(result['ok'], result); self.assertNotIn('nonsecret-canary', json.dumps(result))
                        for job in [pool.submit(paste, A, 'a' * 64), pool.submit(paste, B, 'b' * 64)]: job.result(timeout=10)
                    for session_id, expected in [(A, 'alpha-nonsecret-canary'), (B, 'beta-nonsecret-canary')]:
                        attached = attachment(targets[session_id]); frame = cdp.command('Page.getFrameTree', {}, attached)['frameTree']['frame']['id']
                        context = cdp.command('Page.createIsolatedWorld', {'frameId': frame, 'worldName': 'otc-test-native-values', 'grantUniveralAccess': False}, attached)['executionContextId']
                        pasted = cdp.command('Runtime.evaluate', {'expression': 'document.getElementById("paste").value', 'returnByValue': True, 'contextId': context}, attached)
                        self.assertEqual(pasted['result']['value'], expected)
                    rejected = call(op='checkpoint'); self.assertEqual(rejected, {'version': 1, 'ok': False, 'code': 'other_missions_active', 'beforeEffect': True})
                    self.assertIsNone(browser.poll()); self.assertEqual(dispatcher.verify_runtime(str(profile)), pid)
                    self.assertTrue(call(op='release')['ok'])
                    self.assertNotIn('alpha-nonsecret-canary', (base / 'missions-v2.json').read_text())
                    infos = cdp.command('Target.getTargets')['targetInfos']; ids = [item['targetId'] for item in infos]
                    self.assertNotIn(targets[A], ids); self.assertIn(targets[B], ids)
                    self.assertEqual(fields(targets[B]), ['beta-nonsecret-canary', '3'])
                    self.assertTrue(call(B, 'b' * 64, 'human_pause')['ok'])
                    self.assertEqual(call(B, 'b' * 64, 'execute', {'type': 'snapshot'})['code'], 'human_active')
                    self.assertEqual(call()['code'], 'human_active')
                    self.assertTrue(call(B, 'b' * 64, 'human_resume')['ok'])
                    self.assertTrue(call(B, 'b' * 64, 'release')['ok']); self.assertIsNone(browser.poll())
                finally: cdp.close()
            finally:
                if browser.poll() is None: browser.terminate(); browser.wait(timeout=10)
                time.sleep(0.2)

if __name__ == '__main__': unittest.main()
