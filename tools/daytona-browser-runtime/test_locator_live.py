"""Real Chromium acceptance for safe locator-driven synthetic form replacement.

The only page is served by Chromium's Fetch.fulfillRequest from this test. No
request reaches a remote host and no page-world script is injected by the test.
"""
import base64
import importlib.util
import json
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import unittest

HERE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location('locator_dispatcher', HERE / 'browser-dispatcher.py')
dispatcher = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(dispatcher)

SESSION = '33333333-3333-4333-8333-333333333333'
PRINCIPAL = 'c' * 64
URL = 'https://browser-fixture.example.test/form'
HTML = '''<!doctype html><html><head><title>Synthetic Locator Form</title></head>
<body><form><label for="campaign-day">Synthetic current day</label>
<input id="campaign-day" value="Old synthetic copy">
<input class="duplicate" value="first duplicate">
<input class="duplicate" value="second duplicate">
<input id="hidden-copy" type="hidden" value="hidden synthetic copy">
<input id="css-hidden-copy" style="display:none" value="css hidden synthetic copy">
<input id="readonly-copy" readonly value="readonly synthetic copy">
<output id="event-state">none</output></form>
<script>
const field=document.querySelector('#campaign-day');
const state=document.querySelector('#event-state');
function record(name){sessionStorage.setItem('synthetic-value',field.value);const log=(sessionStorage.getItem('event-log')||'')+' '+name;sessionStorage.setItem('event-log',log);state.textContent=log;}
field.addEventListener('input',()=>record('input'));
field.addEventListener('change',()=>record('change'));
field.addEventListener('blur',()=>record('blur'));
addEventListener('pageshow',()=>{field.value=sessionStorage.getItem('synthetic-value')||field.value;state.textContent=sessionStorage.getItem('event-log')||'none';});
</script></body></html>'''


class LiveLocatorFixture(unittest.TestCase):
    def test_real_chromium_safe_locator_replace_events_and_reload_readback(self):
        binary = shutil.which('chromium') or shutil.which('chromium-browser')
        self.assertIsNotNone(binary, 'Actual Chromium is required for live locator acceptance')
        with socket.socket() as probe:
            self.assertNotEqual(probe.connect_ex(('127.0.0.1', 9222)), 0,
                                'Another worker owns Chromium port 9222; do not interfere')
        with tempfile.TemporaryDirectory(prefix='otc-locator-fixture-') as temp:
            root = Path(temp); root.chmod(0o700)
            base = root / 'company-browser'; base.mkdir(mode=0o700)
            profile = base / 'chromium'; profile.mkdir(mode=0o700)
            browser = subprocess.Popen([
                binary, '--headless=new', '--remote-debugging-address=127.0.0.1',
                '--remote-debugging-port=9222', '--user-data-dir=' + str(profile),
                '--no-first-run', '--no-default-browser-check', 'about:blank'],
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            try:
                until = time.monotonic() + 10
                while True:
                    try:
                        pid = dispatcher.verify_runtime(str(profile)); break
                    except dispatcher.DispatchError:
                        self.assertIsNone(browser.poll(), 'Chromium exited before ready')
                        if time.monotonic() >= until: self.fail('Chromium readiness timed out')
                        time.sleep(.05)
                self.assertEqual(pid, browser.pid)
                script = str((HERE / 'browser-dispatcher.py').resolve())
                # Only this synthetic hostname resolves. The response body is
                # fulfilled locally by the actual browser Fetch domain.
                runner = ("import importlib.util,json,sys;from pathlib import Path;"
                          "s=importlib.util.spec_from_file_location('d',sys.argv[1]);"
                          "d=importlib.util.module_from_spec(s);s.loader.exec_module(d);"
                          "d.ROOT=Path(sys.argv[2]);old=d.socket.getaddrinfo;"
                          "d.socket.getaddrinfo=lambda h,*a,**k:[(2,1,6,'',('93.184.216.34',443))] "
                          "if h=='browser-fixture.example.test' else old(h,*a,**k);"
                          "r=d.run_payload(sys.argv[3]);print(json.dumps(r));"
                          "sys.exit(0 if r.get('ok') or r.get('beforeEffect') else 1)")

                def call(op='execute', action=None):
                    payload = {'version': 1, 'runtimeProtocol': 2, 'op': op,
                               'profileKey': base.name, 'profilePath': str(profile),
                               'timeoutMs': 8000, 'sessionId': SESSION,
                               'principalHash': PRINCIPAL}
                    if action is not None: payload['action'] = action
                    encoded = base64.urlsafe_b64encode(json.dumps(payload).encode()).decode()
                    proc = subprocess.run([sys.executable, '-I', '-c', runner, script,
                                           str(root), encoded], capture_output=True, timeout=12)
                    self.assertLess(len(proc.stdout), 65536)
                    return json.loads(proc.stdout)

                opened = call('open')
                self.assertTrue(opened.get('ok'), opened)
                state = json.loads((base / 'missions-v2.json').read_text())
                target = state['missions'][0]['selected']
                cdp = dispatcher.Cdp(time.monotonic() + 15)
                try:
                    attached = cdp.command('Target.attachToTarget',
                                           {'targetId': target, 'flatten': True})['sessionId']
                    cdp.command('Fetch.enable', {'patterns': [
                        {'urlPattern': 'https://browser-fixture.example.test/*'}]}, attached)
                    cdp.identifier += 1
                    cdp.send(1, json.dumps({'id': cdp.identifier, 'method': 'Page.navigate',
                                            'params': {'url': URL}, 'sessionId': attached}).encode())
                    self._fulfill(cdp, attached)
                    self.assertTrue(call(action={'type': 'focus', 'selector': '#campaign-day'}).get('ok'))
                    # Native Ctrl+A + Backspace clears, then native insertText replaces.
                    self.assertTrue(call(action={'type': 'press_key', 'key': 'KeyA', 'modifiers': 2}).get('ok'))
                    self.assertTrue(call(action={'type': 'press_key', 'key': 'Backspace'}).get('ok'))
                    self.assertTrue(call(action={'type': 'type', 'selector': '#campaign-day',
                                                 'text': 'Synthetic replacement 17 Oct'}).get('ok'))
                    self.assertTrue(call(action={'type': 'press_key', 'key': 'Tab'}).get('ok'))
                    for action_type, selector in (('focus', '#hidden-copy'), ('type', '#hidden-copy'),
                                                  ('focus', '#css-hidden-copy'), ('type', '#css-hidden-copy'),
                                                  ('type', '#readonly-copy')):
                        action = {'type': action_type, 'selector': selector}
                        if action_type == 'type': action['text'] = 'not allowed'
                        rejected = call(action=action)
                        self.assertFalse(rejected.get('ok'), rejected)
                        self.assertEqual(rejected.get('code'), 'selector_not_interactable', rejected)
                        self.assertTrue(rejected.get('beforeEffect'), rejected)
                        self.assertEqual((rejected.get('profileKey'), rejected.get('sessionId'), rejected.get('principalHash')),
                                         (base.name, SESSION, PRINCIPAL), rejected)
                    bad = call(action={'type': 'type', 'selector': '.duplicate', 'text': 'not allowed'})
                    self.assertFalse(bad.get('ok'), bad)
                    self.assertEqual(set(bad), {'version', 'ok', 'code', 'beforeEffect',
                                                'profileKey', 'sessionId', 'principalHash'}, bad)
                    self.assertIn(bad['code'], ('selector_not_found', 'selector_not_interactable'), bad)
                    self.assertTrue(bad['beforeEffect'], bad)
                    self.assertEqual((bad['profileKey'], bad['sessionId'], bad['principalHash']),
                                     (base.name, SESSION, PRINCIPAL), bad)
                    stale = call(action={'type': 'type', 'selector': '#stale-field', 'text': 'not allowed'})
                    self.assertFalse(stale.get('ok'), stale)
                    self.assertEqual(set(stale), {'version', 'ok', 'code', 'beforeEffect',
                                                  'profileKey', 'sessionId', 'principalHash'}, stale)
                    self.assertEqual(stale['code'], 'selector_not_found', stale)
                    self.assertTrue(stale['beforeEffect'], stale)
                    self.assertEqual((stale['profileKey'], stale['sessionId'], stale['principalHash']),
                                     (base.name, SESSION, PRINCIPAL), stale)
                    # Exercise a real browser reload on the fixture and fulfill
                    # its document again locally; dispatcher then reads back.
                    cdp.command('Page.reload', {}, attached)
                    self._fulfill(cdp, attached)
                    observed = call(action={'type': 'snapshot'})
                    self.assertTrue(observed.get('ok'), observed)
                    visible = observed.get('result', {}).get('visibleText', '')
                    self.assertIn('Synthetic replacement 17 Oct', visible, observed)
                    for event_name in ('input', 'change', 'blur'):
                        self.assertIn(event_name, visible, observed)
                    serialized = json.dumps(observed)
                    self.assertNotIn('Old synthetic copy', serialized)
                    self.assertNotIn('hidden synthetic copy', serialized)
                    self.assertNotIn('not allowed', serialized)
                    self.assertTrue(call('release').get('ok'))
                finally:
                    cdp.close()
            finally:
                if browser.poll() is None:
                    browser.terminate(); browser.wait(timeout=10)

    @staticmethod
    def _fulfill(cdp, attached):
        deadline = time.monotonic() + 8
        while time.monotonic() < deadline:
            event = cdp.message()
            if event.get('method') == 'Fetch.requestPaused' and event.get('sessionId') == attached:
                cdp.command('Fetch.fulfillRequest', {
                    'requestId': event['params']['requestId'], 'responseCode': 200,
                    'responseHeaders': [{'name': 'Content-Type', 'value': 'text/html; charset=utf-8'}],
                    'body': base64.b64encode(HTML.encode()).decode()}, attached)
                return
        raise AssertionError('Synthetic fixture request was not intercepted')


if __name__ == '__main__':
    unittest.main()
