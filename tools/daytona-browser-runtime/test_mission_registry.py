import importlib.util
import json
import os
from pathlib import Path
import tempfile
import time
import unittest
import subprocess
import sys

FILE = Path(__file__).with_name('mission-registry.py')
registry = None
if FILE.exists():
    spec = importlib.util.spec_from_file_location('mission_registry_tested', FILE)
    registry = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(registry)

A = '11111111-1111-4111-8111-111111111111'
B = '22222222-2222-4222-8222-222222222222'

def state():
    return {'version': 2, 'uncertain': None, 'human': None,
            'missions': [{'sessionId': A, 'principalHash': 'a' * 64, 'selected': 'PAGE_A', 'owned': ['PAGE_A'], 'uncertain': False},
                         {'sessionId': B, 'principalHash': 'b' * 64, 'selected': 'PAGE_B', 'owned': ['PAGE_B'], 'uncertain': False}]}

class RegistryTests(unittest.TestCase):
    def setUp(self): self.assertIsNotNone(registry, 'V2 shared mission registry is missing')

    def test_exact_principal_and_disjoint_target_ownership(self):
        value = registry.validate_registry(state())
        self.assertEqual(registry.require_automation(value, A, 'a' * 64)['owned'], ['PAGE_A'])
        with self.assertRaises(registry.RegistryError): registry.require_automation(value, A, 'b' * 64)
        value['missions'][1]['owned'].append('PAGE_A')
        with self.assertRaises(registry.RegistryError): registry.validate_registry(value)

    def test_unknown_fields_limits_and_invalid_global_owner_fail_closed(self):
        cases = []
        value = state(); value['extra'] = 'secret'; cases.append(value)
        value = state(); value['missions'][0]['owned'] = ['A', 'B', 'C', 'D', 'E']; cases.append(value)
        value = state(); value['human'] = {'sessionId': B, 'principalHash': 'a' * 64}; cases.append(value)
        value = state(); value['uncertain'] = {'sessionId': A, 'principalHash': 'a' * 64, 'operation': 'arbitrary_shell'}; cases.append(value)
        for value in cases:
            with self.subTest(value=value), self.assertRaises(registry.RegistryError): registry.validate_registry(value)

    def test_observed_locator_map_is_bounded_private_and_strict(self):
        locator = {'handle': 'otc-observed:' + 'a' * 32, 'target': 'PAGE_A', 'frameId': 'FRAME',
                   'loaderId': 'LOADER', 'documentBackendNodeId': 4, 'browserEpoch': 123, 'backendDOMNodeId': 77,
                   'role': 'button', 'tag': 'button', 'nameHash': 'b' * 64}
        value = state(); value['missions'][0]['observedLocators'] = [locator]
        self.assertEqual(registry.validate_registry(value)['missions'][0]['observedLocators'], [locator])
        invalid = []
        changed = dict(value); changed['missions'] = [dict(value['missions'][0])]
        changed['missions'][0]['observedLocators'] = [dict(locator, plaintextLabel='Preview')]; invalid.append(changed)
        changed = dict(value); changed['missions'] = [dict(value['missions'][0])]
        changed['missions'][0]['observedLocators'] = [dict(locator, target='PAGE_B')]; invalid.append(changed)
        changed = dict(value); changed['missions'] = [dict(value['missions'][0])]
        changed['missions'][0]['observedLocators'] = [dict(locator, nameHash='Preview')]; invalid.append(changed)
        changed = dict(value); changed['missions'] = [dict(value['missions'][0])]
        changed['missions'][0]['observedLocators'] = [dict(locator, backendDOMNodeId=0)]; invalid.append(changed)
        changed = dict(value); changed['missions'] = [dict(value['missions'][0])]
        changed['missions'][0]['observedLocators'] = [dict(locator) for _ in range(11)]; invalid.append(changed)
        for candidate in invalid:
            with self.subTest(candidate=candidate), self.assertRaises(registry.RegistryError): registry.validate_registry(candidate)

    def test_human_pause_blocks_every_mission_and_unknown_never_expires(self):
        value = state(); value['human'] = {'sessionId': A, 'principalHash': 'a' * 64}
        for session, principal in [(A, 'a' * 64), (B, 'b' * 64)]:
            with self.assertRaises(registry.RegistryError) as error: registry.require_automation(value, session, principal)
            self.assertEqual(error.exception.code, 'human_active'); self.assertTrue(error.exception.before_effect)
        value['human'] = None; value['missions'][0]['uncertain'] = True
        value['uncertain'] = {'sessionId': A, 'principalHash': 'a' * 64, 'operation': 'action'}
        with self.assertRaises(registry.RegistryError) as error: registry.require_automation(value, B, 'b' * 64)
        self.assertEqual(error.exception.code, 'effect_unknown'); self.assertFalse(error.exception.before_effect)

    def test_private_atomic_receipt_survives_new_reader_and_exact_root_stage_fd(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory); base.chmod(0o700)
            with registry.Registry(base, time.monotonic() + 1) as receipt:
                self.assertEqual(receipt.load()['missions'], [])
                receipt.save(state())
            self.assertEqual((base / 'missions-v2.json').stat().st_mode & 0o777, 0o600)
            with registry.Registry(base, time.monotonic() + 1) as receipt:
                self.assertEqual(receipt.load(), state())
            fd = os.open(base, os.O_RDONLY | os.O_DIRECTORY)
            try: self.assertEqual(registry.read_registry_at(fd, os.getuid()), state())
            finally: os.close(fd)

    def test_symlink_hardlink_duplicate_json_and_foreign_mode_are_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory); base.chmod(0o700); path = base / 'missions-v2.json'
            path.symlink_to(base / 'elsewhere')
            with self.assertRaises(registry.RegistryError):
                with registry.Registry(base, time.monotonic() + 1) as receipt: receipt.load()
            path.unlink(); path.write_text(json.dumps(state())); path.chmod(0o644)
            with self.assertRaises(registry.RegistryError):
                with registry.Registry(base, time.monotonic() + 1) as receipt: receipt.load()
            path.chmod(0o600); os.link(path, base / 'second-link')
            with self.assertRaises(registry.RegistryError):
                with registry.Registry(base, time.monotonic() + 1) as receipt: receipt.load()
            (base / 'second-link').unlink(); path.write_text('{"version":2,"version":2,"missions":[],"human":null,"uncertain":null}')
            with self.assertRaises(registry.RegistryError):
                with registry.Registry(base, time.monotonic() + 1) as receipt: receipt.load()

    def test_bounded_mutex_contention_is_explicit_before_effect_and_never_reclaims(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory); base.chmod(0o700)
            with registry.Registry(base, time.monotonic() + 1):
                with self.assertRaises(registry.RegistryError) as error:
                    with registry.Registry(base, time.monotonic() + 0.025): self.fail('stole held mutex')
                self.assertEqual(error.exception.code, 'mission_busy'); self.assertTrue(error.exception.before_effect)

    def test_fifo_receipt_is_rejected_without_blocking_before_file_metadata_check(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory); base.chmod(0o700); os.mkfifo(base / 'missions-v2.json', 0o600)
            code = "import importlib.util,os,sys;s=importlib.util.spec_from_file_location('r',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m);fd=os.open(sys.argv[2],os.O_RDONLY|os.O_DIRECTORY);m.read_registry_at(fd,os.getuid())"
            process = subprocess.Popen([sys.executable, '-I', '-c', code, str(FILE), str(base)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            try:
                try: status = process.wait(timeout=0.5)
                except subprocess.TimeoutExpired: self.fail('FIFO metadata validation blocked instead of rejecting')
                self.assertNotEqual(status, 0)
            finally:
                if process.poll() is None: process.terminate(); process.wait(timeout=2)

    def test_private_per_mission_clipboards_bound_utf8_bytes_without_cross_member_alias(self):
        value = state(); value['missions'][0]['clipboardText'] = 'A' * 65536; value['missions'][1]['clipboardText'] = 'é' * 32768
        self.assertEqual(registry.validate_registry(value)['missions'][0]['clipboardText'], 'A' * 65536)
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory); base.chmod(0o700)
            with registry.Registry(base, time.monotonic() + 1) as receipt: receipt.save(value)
            self.assertGreater((base / 'missions-v2.json').stat().st_size, 65536)
            with registry.Registry(base, time.monotonic() + 1) as receipt: self.assertEqual(receipt.load(), value)
        for text in ['A' * 65537, 'é' * 32769, '\ud800']:
            invalid = state(); invalid['missions'][0]['clipboardText'] = text
            with self.assertRaises(registry.RegistryError): registry.validate_registry(invalid)

    def test_all_seven_valid_clipboards_roundtrip_even_at_worst_case_json_expansion(self):
        value = {'version': 2, 'human': None, 'uncertain': None, 'missions': []}
        for index in range(1, 8):
            target = 'PAGE_' + str(index)
            value['missions'].append({'sessionId': f'{index:08x}-1111-4111-8111-{index:012x}', 'principalHash': f'{index:064x}', 'selected': target, 'owned': [target], 'uncertain': False, 'clipboardText': '\x00' * 65536})
        registry.validate_registry(value)
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory); base.chmod(0o700)
            with registry.Registry(base, time.monotonic() + 1) as receipt: receipt.save(value)
            size = (base / 'missions-v2.json').stat().st_size
            self.assertGreater(size, 1048576); self.assertLess(size, 3 * 1048576)
            with registry.Registry(base, time.monotonic() + 1) as receipt: self.assertEqual(receipt.load(), value)

    def test_serialized_registry_exact_three_mib_boundary_and_one_over_are_enforced(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory); base.chmod(0o700); path = base / 'missions-v2.json'
            raw = json.dumps({'version': 2, 'missions': [], 'human': None, 'uncertain': None}).encode()
            path.write_bytes(raw + b' ' * (3 * 1048576 - len(raw))); path.chmod(0o600)
            with registry.Registry(base, time.monotonic() + 1) as receipt: self.assertEqual(receipt.load()['missions'], [])
            with path.open('ab') as stream: stream.write(b' ')
            with self.assertRaises(registry.RegistryError) as error:
                with registry.Registry(base, time.monotonic() + 1) as receipt: receipt.load()
            self.assertEqual(error.exception.code, 'registry_unavailable')

if __name__ == '__main__': unittest.main()
