"""RED-first real-Chromium V2 observed-locator acceptance on a synthetic fixture.

Only fixed example.test URLs are served, locally, with Fetch.fulfillRequest. No
provider site, campaign data, or page-world Runtime.evaluate is used. This test
is intentionally separate from test_locator_live.py so its accepted headline
fixture remains unchanged.
"""
import base64
import importlib.util
import json
from pathlib import Path
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest

HERE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location('navigation_dispatcher', HERE / 'browser-dispatcher.py')
dispatcher = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(dispatcher)

SESSION = '44444444-4444-4444-8444-444444444444'
PRINCIPAL = 'd' * 64
HOST = 'browser-fixture.example.test'
START = f'https://{HOST}/nav/start'
LANDING = f'https://{HOST}/nav/landed'
HTML_START = '''<!doctype html><html><head><meta charset="utf-8"><title>Synthetic nav fixture</title>
<style>#mobile-nav{display:none}html.mobile-layout #desktop-nav{display:none}html.mobile-layout #mobile-nav{display:block}</style>
</head><body>
<nav id="desktop-nav"><button><span aria-hidden="true">◆</span><span>Highlights</span></button><button><span aria-hidden="true">◆</span><span>Team</span></button><button><span aria-hidden="true">◆</span><span>Deck &amp; Memo</span></button><button><span aria-hidden="true">◆</span><span>Preview</span></button><button><span aria-hidden="true">›</span><span>Next</span></button></nav>
<nav id="mobile-nav"><button><span aria-hidden="true">◆</span><span>Highlights</span></button><button><span aria-hidden="true">◆</span><span>Team</span></button><button><span aria-hidden="true">◆</span><span>Deck &amp; Memo</span></button><button><span aria-hidden="true">◆</span><span>Preview</span></button><button><span aria-hidden="true">›</span><span>Next</span></button></nav>
<button id="duplicate" onclick="addDuplicate()">Add duplicate</button>
<button id="rerender" onclick="rerenderNext()">Re-render Next</button>
<button id="toggle-overlay" onclick="toggleNextOverlay()">Toggle Next overlay</button>
<button id="toggle-layout" onclick="toggleLayout()">Toggle responsive layout</button>
<output id="duplicate-result"></output>
<div id="editable" contenteditable="true" aria-label="Synthetic notes">Old synthetic notes</div>
<label>Observation-only attachment <input type="file" aria-label="Synthetic attachment"></label>
<output id="viewport-state"></output>
<output id="events"></output>
<script>
const editable=document.querySelector('#editable'), events=document.querySelector('#events');
function viewportState(){document.querySelector('#viewport-state').textContent=document.documentElement.classList.contains('mobile-layout')?'MOBILE_VIEWPORT':'DESKTOP_VIEWPORT';}
function toggleLayout(){document.documentElement.classList.toggle('mobile-layout');viewportState();}
viewportState();
function record(e){sessionStorage.setItem('fixture-notes',editable.textContent);let log=(sessionStorage.getItem('fixture-events')||'')+' '+e;sessionStorage.setItem('fixture-events',log);events.textContent=log;}
editable.addEventListener('input',()=>record('input'));editable.addEventListener('blur',()=>record('blur'));
function fixtureNext(nav){return Array.from(nav.querySelectorAll('button')).find(b=>b.textContent.replace('›','').trim()==='Next');}
function bindNext(nav){fixtureNext(nav).addEventListener('click',()=>location.href='/nav/landed');}
bindNext(document.querySelector('#desktop-nav'));bindNext(document.querySelector('#mobile-nav'));
function addDuplicate(){const b=document.createElement('button');b.innerHTML='<span aria-hidden="true">◆</span><span>Preview</span>';b.addEventListener('click',()=>document.querySelector('#duplicate-result').textContent='duplicate-clicked');document.querySelector('#desktop-nav').append(b);}
function rerenderNext(){const nav=document.querySelector('#desktop-nav'),old=fixtureNext(nav),b=document.createElement('button');b.innerHTML='<span aria-hidden="true">›</span><span>Next</span>';b.addEventListener('click',()=>location.href='/nav/landed');old.replaceWith(b);}
let nextOverlay=null;function toggleNextOverlay(){if(nextOverlay){nextOverlay.remove();nextOverlay=null;return;}const r=fixtureNext(document.querySelector('#desktop-nav')).getBoundingClientRect();nextOverlay=document.createElement('div');nextOverlay.setAttribute('aria-hidden','true');Object.assign(nextOverlay.style,{position:'fixed',left:r.left+'px',top:r.top+'px',width:r.width+'px',height:r.height+'px',background:'transparent',zIndex:'999999'});document.body.append(nextOverlay);}
addEventListener('pageshow',()=>{editable.textContent=sessionStorage.getItem('fixture-notes')||editable.textContent;events.textContent=sessionStorage.getItem('fixture-events')||'';});
</script></body></html>'''
HTML_LANDING = '''<!doctype html><html><head><title>Synthetic destination</title></head><body>
<h1>Synthetic navigation completed</h1><p>Highlights · Team · Deck &amp; Memo · Preview · Next</p>
<button id="unsafe-nav" onclick="location.href='http://127.0.0.1:9/nope'">Blocked synthetic destination</button>
</body></html>'''


class LiveNavigationFixture(unittest.TestCase):
    def test_real_chromium_opaque_handles_responsive_rerender_and_safe_navigation(self):
        binary = shutil.which('chromium') or shutil.which('chromium-browser')
        self.assertIsNotNone(binary, 'Actual Chromium is required for live navigation acceptance')
        with socket.socket() as probe:
            self.assertNotEqual(probe.connect_ex(('127.0.0.1', 9222)), 0,
                                'Another worker owns Chromium port 9222; do not interfere')
        with tempfile.TemporaryDirectory(prefix='otc-nav-fixture-') as temp:
            root = Path(temp); root.chmod(0o700)
            base = root / 'company-browser'; base.mkdir(mode=0o700)
            profile = base / 'chromium'; profile.mkdir(mode=0o700)
            browser = subprocess.Popen([
                binary, '--headless=new', '--remote-debugging-address=127.0.0.1',
                '--remote-debugging-port=9222', '--user-data-dir=' + str(profile),
                '--no-first-run', '--no-default-browser-check', 'about:blank'],
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            cdp = None
            try:
                until = time.monotonic() + 10
                while True:
                    try: pid = dispatcher.verify_runtime(str(profile)); break
                    except dispatcher.DispatchError:
                        self.assertIsNone(browser.poll(), 'Chromium exited before ready')
                        if time.monotonic() >= until: self.fail('Chromium readiness timed out')
                        time.sleep(.05)
                self.assertEqual(pid, browser.pid)
                script = str((HERE / 'browser-dispatcher.py').resolve())
                runner = ("import importlib.util,json,sys;from pathlib import Path;"
                          "s=importlib.util.spec_from_file_location('d',sys.argv[1]);"
                          "d=importlib.util.module_from_spec(s);s.loader.exec_module(d);"
                          "d.ROOT=Path(sys.argv[2]);old=d.socket.getaddrinfo;"
                          f"d.socket.getaddrinfo=lambda h,*a,**k:[(2,1,6,'',('93.184.216.34',443))] if h=='{HOST}' else old(h,*a,**k);"
                          "r=d.run_payload(sys.argv[3]);print(json.dumps(r));"
                          "sys.exit(0 if r.get('ok') or r.get('beforeEffect') else 1)")

                def call(op='execute', action=None, session_id=SESSION, principal_hash=PRINCIPAL):
                    payload = {'version': 1, 'runtimeProtocol': 2, 'op': op,
                               'profileKey': base.name, 'profilePath': str(profile),
                               'timeoutMs': 8000, 'sessionId': session_id,
                               'principalHash': principal_hash}
                    if action is not None: payload['action'] = action
                    encoded = base64.urlsafe_b64encode(json.dumps(payload).encode()).decode()
                    proc = subprocess.run([sys.executable, '-I', '-c', runner, script,
                                           str(root), encoded], capture_output=True, timeout=12)
                    self.assertLess(len(proc.stdout), 65536)
                    self.assertTrue(proc.stdout, proc.stderr.decode('utf-8', 'replace'))
                    return json.loads(proc.stdout)

                def click_with_fulfillment(cdp_connection, attached_session, selector,
                                           session_id=SESSION, principal_hash=PRINCIPAL):
                    outcome, failure = {}, []
                    def invoke():
                        try:
                            outcome['result'] = call(action={'type': 'click', 'selector': selector},
                                                     session_id=session_id, principal_hash=principal_hash)
                        except BaseException as error:
                            failure.append(error)
                    worker = threading.Thread(target=invoke, daemon=True)
                    worker.start()
                    try:
                        self._fulfill(cdp_connection, attached_session, LANDING)
                    finally:
                        worker.join(timeout=13)
                    self.assertFalse(worker.is_alive(), 'bounded dispatcher click did not finish')
                    if failure: raise failure[0]
                    return outcome['result']

                opened = call('open')
                self.assertTrue(opened.get('ok'), opened)
                state = json.loads((base / 'missions-v2.json').read_text())
                target = state['missions'][0]['selected']
                cdp = dispatcher.Cdp(time.monotonic() + 30)
                attached = cdp.command('Target.attachToTarget',
                                       {'targetId': target, 'flatten': True})['sessionId']
                cdp.command('Fetch.enable', {'patterns': [
                    {'urlPattern': f'https://{HOST}/nav/*'}]}, attached)
                self._navigate_and_fulfill(cdp, attached, START)

                # Responsive twins have identical accessible labels and no
                # distinguishing attributes. Exactly the visible twin gets a
                # handle; a visible ambiguity must not get an actionable one.
                desktop = call(action={'type': 'snapshot'})
                self.assertTrue(desktop.get('ok'), desktop)
                desktop_text = desktop['result']['visibleText']
                self.assertIn('DESKTOP_VIEWPORT', desktop_text)
                next_handle = self._handle(desktop_text, 'Next')
                for label in ('Highlights', 'Team', 'Deck & Memo', 'Preview'):
                    self.assertEqual(len(self._handles(desktop_text, label)), 1, desktop_text)
                self.assertTrue(call(action={'type': 'click', 'selector': '#toggle-layout'}).get('ok'))
                mobile = call(action={'type': 'snapshot'})
                self.assertTrue(mobile.get('ok'), mobile)
                mobile_text = mobile['result']['visibleText']
                self.assertIn('MOBILE_VIEWPORT', mobile_text)
                mobile_handle = self._handle(mobile_text, 'Next')
                self.assertNotEqual(next_handle, mobile_handle,
                                    f'locator handle must bind current responsive node; mobile snapshot: {mobile_text}')
                self.assertEqual(len(self._handles(mobile_text, 'Highlights')), 1, mobile_text)

                self.assertTrue(call(action={'type': 'click', 'selector': '#toggle-layout'}).get('ok'))
                pre_overlay = call(action={'type': 'snapshot'})
                pre_overlay_handle = self._handle(pre_overlay['result']['visibleText'], 'Next')
                self.assertTrue(call(action={'type': 'click', 'selector': '#toggle-overlay'}).get('ok'))
                covered = call(action={'type': 'snapshot'})
                self.assertEqual(self._handles(covered['result']['visibleText'], 'Next'), [])
                self.assertIn("Locator unavailable for button label='Next'", covered['result']['visibleText'])
                covered_click = call(action={'type': 'click', 'selector': pre_overlay_handle})
                self._before_effect_ack(covered_click, 'selector_not_found')
                self.assertTrue(call(action={'type': 'click', 'selector': '#toggle-overlay'}).get('ok'))
                # Two visible same-name controls get distinct per-node opaque
                # handles; choosing the new one must click only that element.
                self.assertTrue(call(action={'type': 'click', 'selector': '#duplicate'}).get('ok'))
                duplicate = call(action={'type': 'snapshot'})
                self.assertTrue(duplicate.get('ok'), duplicate)
                preview_handles = self._handles(duplicate['result']['visibleText'], 'Preview')
                self.assertEqual(len(preview_handles), 2, duplicate)
                self.assertEqual(len(set(preview_handles)), 2, duplicate)
                duplicate_click = call(action={'type': 'click', 'selector': preview_handles[1]})
                self.assertTrue(duplicate_click.get('ok'), duplicate_click)
                after_duplicate_click = call(action={'type': 'snapshot'})
                self.assertIn('duplicate-clicked', after_duplicate_click['result']['visibleText'])

                # Snapshot a fresh target, change that exact DOM node in-page,
                # then prove the old handle is stale and cannot click. Obtain a
                # fresh locator from the re-rendered node and navigate once.
                before = call(action={'type': 'snapshot'})
                old_handle = self._handle(before['result']['visibleText'], 'Next')
                self.assertTrue(call(action={'type': 'click', 'selector': '#rerender'}).get('ok'))
                stale = call(action={'type': 'click', 'selector': old_handle})
                self._before_effect_ack(stale, 'selector_not_found')
                after = call(action={'type': 'snapshot'})
                fresh_handle = self._handle(after['result']['visibleText'], 'Next')
                self.assertNotEqual(old_handle, fresh_handle)

                # Native keyboard replacement on contenteditable; file input
                # remains observational only (no path/value may escape).
                self.assertTrue(call(action={'type': 'focus', 'selector': '#editable'}).get('ok'))
                self.assertTrue(call(action={'type': 'press_key', 'key': 'KeyA', 'modifiers': 2}).get('ok'))
                self.assertTrue(call(action={'type': 'press_key', 'key': 'Backspace'}).get('ok'))
                cleared = call(action={'type': 'snapshot'})
                self.assertTrue(cleared.get('ok'), cleared)
                self.assertNotIn('Old synthetic notes', cleared['result']['visibleText'])
                self.assertIn('input', cleared['result']['visibleText'])
                # Insert is a distinct later action: interruption after clear
                # is observable as empty and is never silently retried.
                self.assertTrue(call(action={'type': 'type', 'selector': '#editable',
                                             'text': 'Synthetic replacement note'}).get('ok'))
                self.assertTrue(call(action={'type': 'press_key', 'key': 'Tab'}).get('ok'))
                observed = call(action={'type': 'snapshot'})
                self.assertTrue(observed.get('ok'), observed)
                self.assertIn('Synthetic replacement note', observed['result']['visibleText'])
                self.assertIn("File input selector='input[type=\"file\" i]' options=",
                              observed['result']['visibleText'])
                self.assertNotIn('fakepath', observed['result']['visibleText'].lower())

                # The accepted fresh handle performs one actual click/navigation;
                # only the fixed synthetic route is fulfilled from local bytes.
                clicked = click_with_fulfillment(cdp, attached, fresh_handle)
                self.assertTrue(clicked.get('ok'), clicked)
                landed = call(action={'type': 'snapshot'})
                self.assertTrue(landed.get('ok'), landed)
                self.assertEqual(landed['result']['url'], LANDING, landed)
                self.assertIn('Synthetic navigation completed', landed['result']['visibleText'])

                # Direct private navigation is denied; because current V2 has
                # no separate exact ACK class for this error, the test preserves
                # UNKNOWN and does not attempt any follow-up action except release.
                private = call(action={'type': 'navigate', 'url': 'http://127.0.0.1:9/nope'})
                self.assertFalse(private.get('ok'), private)
                self.assertIn(private.get('code'), ('destination_forbidden',
                              'destination_forbidden_requested_navigation_port'), private)
                self.assertNotIn('beforeEffect', private, private)
                fenced = call(action={'type': 'snapshot'})
                self.assertFalse(fenced.get('ok'), fenced)
                self.assertEqual(fenced.get('code'), 'effect_unknown', fenced)
                self.assertTrue(call('release').get('ok'))

                # A second isolated mission exercises the distinct post-click
                # boundary. Network.setBlockedURLs prevents even a loopback
                # connection; the fixture-owned click causes the attempted
                # transition, which must not be represented as pre-effect ACK.
                session2 = '55555555-5555-4555-8555-555555555555'
                principal2 = 'e' * 64
                opened2 = call('open', session_id=session2, principal_hash=principal2)
                self.assertTrue(opened2.get('ok'), opened2)
                state2 = json.loads((base / 'missions-v2.json').read_text())
                target2 = next(m['selected'] for m in state2['missions'] if m['sessionId'] == session2)
                cdp.close()
                cdp = dispatcher.Cdp(time.monotonic() + 30)
                attached2 = cdp.command('Target.attachToTarget',
                                        {'targetId': target2, 'flatten': True})['sessionId']
                cdp.command('Fetch.enable', {'patterns': [
                    {'urlPattern': f'https://{HOST}/nav/*'}]}, attached2)
                cdp.command('Network.enable', {}, attached2)
                cdp.command('Network.setBlockedURLs', {'urls': ['http://127.0.0.1:9/*']}, attached2)
                self._navigate_and_fulfill(cdp, attached2, START)
                second_start = call(action={'type': 'snapshot'}, session_id=session2, principal_hash=principal2)
                second_next = self._handle(second_start['result']['visibleText'], 'Next')
                second_clicked = click_with_fulfillment(cdp, attached2, second_next,
                                                        session_id=session2, principal_hash=principal2)
                self.assertTrue(second_clicked.get('ok'), second_clicked)
                post_click = call(action={'type': 'click', 'selector': '#unsafe-nav'},
                                  session_id=session2, principal_hash=principal2)
                self.assertFalse(post_click.get('ok'), post_click)
                self.assertNotIn('beforeEffect', post_click, post_click)
                self.assertIn(post_click.get('code'), (
                    'destination_forbidden', 'destination_forbidden_observed_main_port',
                    'destination_forbidden_observed_child_port',
                    'destination_forbidden_observed_main_scheme_or_credentials', 'navigation_changed',
                    'provider_context_destroyed'), post_click)
                after_effect_fence = call(action={'type': 'snapshot'},
                                          session_id=session2, principal_hash=principal2)
                self.assertFalse(after_effect_fence.get('ok'), after_effect_fence)
                self.assertEqual(after_effect_fence.get('code'), 'effect_unknown', after_effect_fence)
                self.assertTrue(call('release', session_id=session2, principal_hash=principal2).get('ok'))
            finally:
                if cdp is not None: cdp.close()
                if browser.poll() is None:
                    browser.terminate(); browser.wait(timeout=10)

    @staticmethod
    def _handle(visible_text, label):
        matches = LiveNavigationFixture._handles(visible_text, label)
        if len(matches) != 1:
            raise AssertionError(f'expected one observed handle for {label!r}, found {len(matches)}: {visible_text}')
        return matches[0]

    @staticmethod
    def _handles(visible_text, label):
        found = []
        for line in visible_text.splitlines():
            if not line.startswith('Action button selector=') or f'label={label!r}' not in line:
                continue
            match = re.search(r"selector='(otc-observed:[0-9a-f]{32})'", line)
            if match: found.append(match.group(1))
        return found

    @staticmethod
    def _before_effect_ack(result, code):
        expected = {'version', 'ok', 'code', 'beforeEffect', 'profileKey', 'sessionId', 'principalHash'}
        if result.get('ok') is True:
            raise AssertionError(f'expected pre-effect rejection, got {result}')
        if set(result) != expected or result.get('version') != 1 or result.get('code') != code or result.get('beforeEffect') is not True:
            raise AssertionError(f'not an exact V2 before-effect acknowledgment: {result}')
        if (result.get('sessionId'), result.get('principalHash')) != (SESSION, PRINCIPAL):
            raise AssertionError(f'ack is not bound to fixture mission: {result}')
        if result.get('profileKey') != 'company-browser':
            raise AssertionError(f'ack is not bound to fixture profile: {result}')

    @staticmethod
    def _navigate_and_fulfill(cdp, attached, url):
        cdp.identifier += 1
        cdp.send(1, json.dumps({'id': cdp.identifier, 'method': 'Page.navigate',
                                'params': {'url': url}, 'sessionId': attached}).encode())
        LiveNavigationFixture._fulfill(cdp, attached, url)

    @staticmethod
    def _fulfill(cdp, attached, expected_url):
        deadline = time.monotonic() + 8
        while time.monotonic() < deadline:
            event = cdp.message()
            if event.get('method') != 'Fetch.requestPaused' or event.get('sessionId') != attached:
                continue
            params = event.get('params', {})
            request_url = params.get('request', {}).get('url')
            if request_url != expected_url:
                raise AssertionError(f'unexpected fixture request blocked: {request_url!r}')
            body = HTML_START if expected_url == START else HTML_LANDING
            cdp.command('Fetch.fulfillRequest', {
                'requestId': params['requestId'], 'responseCode': 200,
                'responseHeaders': [{'name': 'Content-Type', 'value': 'text/html; charset=utf-8'}],
                'body': base64.b64encode(body.encode()).decode()}, attached)
            return
        raise AssertionError(f'fixed synthetic fixture request was not intercepted: {expected_url}')


if __name__ == '__main__':
    unittest.main()
