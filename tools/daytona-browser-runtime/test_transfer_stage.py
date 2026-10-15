"""Harmless local fixed-helper tests; no provider or user-profile reads."""
import base64
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
import sys
import subprocess
from unittest.mock import patch
from types import SimpleNamespace
sys.path.insert(0,str(Path(__file__).parent))

PATH = Path(__file__).with_name('transfer-stage.py')
spec = importlib.util.spec_from_file_location('transfer_stage', PATH)
stage = importlib.util.module_from_spec(spec) if PATH.exists() else None
if stage: spec.loader.exec_module(stage)

class StageTests(unittest.TestCase):
    def setUp(self):
        self.assertIsNotNone(stage, 'Fixed staging helper missing')
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name); self.root.chmod(0o700)
        self.profiles = self.root/'profiles'; self.profiles.mkdir(mode=0o700)
        self.base = self.profiles/'profile-one'; self.base.mkdir(mode=0o700)
        self.upload = self.base/'uploads'; self.upload.mkdir(mode=0o700)
        self.transfer = '11111111-1111-4111-8111-111111111111'; (self.upload/self.transfer).mkdir(mode=0o700)
        self.session = '22222222-2222-4222-8222-222222222222'
        self.staging = self.root/'staging'; self.staging.mkdir(mode=0o700)
        self.staging_id = '33333333-3333-4333-8333-333333333333'
        self.source = self.staging/('otc-browser-upload-'+self.staging_id); self.source.mkdir(mode=0o700)
        self.body = b'public controlled fixture\n'; (self.source/'payload.bin').write_bytes(self.body); (self.source/'payload.bin').chmod(0o600)
        self.mission = dict(sessionId=self.session,principalHash='a'*64,selected='A'*32,owned=['A'*32],uncertain=False)
        self.receipt = self.base/'mission.json'; self.receipt.write_text(json.dumps(self.mission)); self.receipt.chmod(0o600)
        self.lock = self.base/'mission.lock'; self.lock.touch(mode=0o600)
        self.payload = dict(version=1,profileKey='profile-one',sessionId=self.session,principalHash='a'*64,transferId=self.transfer,relativePath='notes.txt',stagingId=self.staging_id,byteLength=len(self.body),sha256=hashlib.sha256(self.body).hexdigest())
    def promote(self, payload=None):
        return stage.promote(payload or self.payload, profiles=self.profiles, staging=self.staging, browser_uid=os.getuid(),browser_gid=os.getgid(),source_uids={os.getuid()})
    def test_exact_bytes_owned_private_file_and_no_overwrite(self):
        result = self.promote(); target = self.upload/self.transfer/'notes.txt'
        self.assertEqual(target.read_bytes(),self.body); self.assertEqual(target.stat().st_mode&0o777,0o600)
        self.assertFalse(self.source.exists(), 'Confirmed promotion must remove only its exact private SDK spool')
        self.assertEqual(result,dict(version=1,ok=True,staged=True,sha256=self.payload['sha256'],byteLength=len(self.body),profileKey='profile-one',sessionId=self.session))
        with self.assertRaises(stage.StageError): self.promote()
        self.assertEqual(target.read_bytes(),self.body)
    def test_nested_paths_preserved_only_inside_prepared_directory(self):
        (self.upload/self.transfer/'fixture').mkdir(mode=0o700)
        (self.upload/self.transfer/'fixture'/'nested').mkdir(mode=0o700)
        self.promote(dict(self.payload,relativePath='fixture/nested/notes.txt'))
        self.assertEqual((self.upload/self.transfer/'fixture/nested/notes.txt').read_bytes(),self.body)
    def test_hash_size_modes_symlinks_and_mission_mismatch_fail_before_target_write(self):
        for updates in ({'sha256':'b'*64},{'byteLength':len(self.body)+1},{'sessionId':self.transfer},{'principalHash':'b'*64},{'relativePath':'../../etc/passwd'},{'path':'/etc/passwd'}):
            with self.subTest(updates=updates),self.assertRaises(stage.StageError): self.promote(dict(self.payload,**updates))
        self.assertFalse((self.upload/self.transfer/'notes.txt').exists())
        (self.source/'payload.bin').chmod(0o644)
        with self.assertRaises(stage.StageError): self.promote()
        (self.source/'payload.bin').unlink(); (self.source/'payload.bin').symlink_to('/etc/hostname')
        with self.assertRaises(stage.StageError): self.promote()
    def test_busy_uncertain_or_replaced_target_directory_fail_closed(self):
        with self.lock.open('r+') as lock:
            fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
            with self.assertRaises(stage.StageError): self.promote()
        self.receipt.write_text(json.dumps(dict(self.mission,uncertain=True)))
        with self.assertRaises(stage.StageError): self.promote()
        self.receipt.write_text(json.dumps(self.mission)); (self.upload/self.transfer).rmdir(); (self.upload/self.transfer).symlink_to(self.source,target_is_directory=True)
        with self.assertRaises(stage.StageError): self.promote()
    def test_capacity_is_rechecked_under_mission_lock_before_creating_target_file(self):
        reserve=self.upload/'previous.txt'; reserve.touch(mode=0o600)
        with reserve.open('wb') as stream: stream.truncate(128*1024*1024)
        with self.assertRaises(stage.StageError): self.promote()
        self.assertFalse((self.upload/self.transfer/'notes.txt').exists()); self.assertTrue(self.source.exists())
        reserve.unlink()
        with patch.object(stage.os,'fstatvfs',return_value=SimpleNamespace(f_bavail=256*1024*1024,f_frsize=1)):
            with self.assertRaises(stage.StageError): self.promote()
        self.assertFalse((self.upload/self.transfer/'notes.txt').exists())
    def test_cli_requires_root_and_bounded_fixed_payload_and_never_leaks_error(self):
        result = stage.run_payload(base64.urlsafe_b64encode(json.dumps(dict(self.payload,unexpected='PRIVATE')).encode()).decode())
        self.assertFalse(result['ok']); self.assertNotIn('PRIVATE',json.dumps(result))
        self.assertEqual(stage.run_payload('not-json'),dict(version=1,ok=False,code='invalid_stage_payload'))
    def test_actual_isolated_root_helper_uses_only_owned_sibling_capacity_module(self):
        code='''import importlib.util,json,os,sys,types
sys.modules['browser_transfers']=types.ModuleType('browser_transfers')
spec=importlib.util.spec_from_file_location('owned_stage',sys.argv[1]); module=importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
values=json.load(sys.stdin)
print(json.dumps(module.promote(values['payload'],profiles=values['profiles'],staging=values['staging'],browser_uid=os.getuid(),browser_gid=os.getgid(),source_uids={os.getuid()})))
'''
        result=subprocess.run([sys.executable,'-I','-c',code,str(PATH)],input=json.dumps(dict(payload=self.payload,profiles=str(self.profiles),staging=str(self.staging))),text=True,capture_output=True,cwd=self.root,env={**os.environ,'PYTHONPATH':str(self.root)},timeout=5)
        self.assertEqual(result.returncode,0,result.stderr)
        self.assertTrue(json.loads(result.stdout)['staged']); self.assertFalse(self.source.exists())
        self.assertEqual((self.upload/self.transfer/'notes.txt').read_bytes(),self.body)

    def registry(self):
        return dict(version=2,uncertain=None,human=None,missions=[dict(self.mission),dict(sessionId='44444444-4444-4444-8444-444444444444',principalHash='b'*64,selected='B'*32,owned=['B'*32],uncertain=False)])
    def write_registry(self,value):
        path=self.base/'missions-v2.json';path.write_text(json.dumps(value));path.chmod(0o600)
        return path
    def test_v2_matches_only_exact_member_under_global_automation_gate_and_keeps_other_members_untouched(self):
        self.receipt.unlink();registry=self.registry();path=self.write_registry(registry)
        try:result=self.promote(dict(self.payload,runtimeProtocol=2))
        except stage.StageError:self.fail('Trusted V2 promotion is not implemented')
        self.assertEqual(result['runtimeProtocol'],2);self.assertTrue(result['staged'])
        self.assertEqual(json.loads(path.read_text()),registry);self.assertEqual((self.upload/self.transfer/'notes.txt').read_bytes(),self.body)
    def test_v2_missing_foreign_human_unknown_and_mixed_protocol_states_have_zero_target_effects(self):
        self.receipt.unlink()
        for mode in ('missing','foreign','human','unknown','own-unknown','legacy','symlink','mode'):
            with self.subTest(mode=mode):
                registry=self.registry();path=self.base/'missions-v2.json'
                if path.exists() or path.is_symlink():path.unlink()
                if self.receipt.exists():self.receipt.unlink()
                if mode=='foreign':registry['missions'][0]['principalHash']='c'*64
                if mode=='human':registry['human']={key:registry['missions'][1][key] for key in ('sessionId','principalHash')}
                if mode in ('unknown','own-unknown'):
                    entry=registry['missions'][0 if mode=='own-unknown' else 1];entry['uncertain']=True
                    registry['uncertain']=dict(sessionId=entry['sessionId'],principalHash=entry['principalHash'],operation='action')
                if mode!='missing':self.write_registry(registry)
                if mode=='legacy':self.receipt.write_text(json.dumps(self.mission));self.receipt.chmod(0o600)
                if mode=='symlink':path.unlink();path.symlink_to(self.receipt)
                if mode=='mode':path.chmod(0o644)
                with self.assertRaises(stage.StageError):self.promote(dict(self.payload,runtimeProtocol=2))
                self.assertFalse((self.upload/self.transfer/'notes.txt').exists());self.assertTrue(self.source.exists())
    def test_legacy_payload_cannot_ignore_existing_v2_global_fences_or_accept_invalid_protocol(self):
        self.write_registry(self.registry())
        with self.assertRaises(stage.StageError):self.promote()
        for value in (None,True,1,3,'2'):
            with self.subTest(value=value),self.assertRaises(stage.StageError):stage.validate(dict(self.payload,runtimeProtocol=value))
        self.assertFalse((self.upload/self.transfer/'notes.txt').exists())
    def test_v2_real_isolated_root_helper_ignores_ambient_registry_modules(self):
        self.receipt.unlink();self.write_registry(self.registry())
        code='''import importlib.util,json,os,sys,types
sys.modules['mission_registry']=types.ModuleType('mission_registry')
sys.modules['browser_transfers']=types.ModuleType('browser_transfers')
spec=importlib.util.spec_from_file_location('owned_stage',sys.argv[1]); module=importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
values=json.load(sys.stdin)
print(json.dumps(module.promote(values['payload'],profiles=values['profiles'],staging=values['staging'],browser_uid=os.getuid(),browser_gid=os.getgid(),source_uids={os.getuid()})))
'''
        result=subprocess.run([sys.executable,'-I','-c',code,str(PATH)],input=json.dumps(dict(payload=dict(self.payload,runtimeProtocol=2),profiles=str(self.profiles),staging=str(self.staging))),text=True,capture_output=True,cwd=self.root,env={**os.environ,'PYTHONPATH':str(self.root)},timeout=5)
        self.assertEqual(result.returncode,0,result.stderr);self.assertEqual(json.loads(result.stdout)['runtimeProtocol'],2)
        self.assertEqual((self.upload/self.transfer/'notes.txt').read_bytes(),self.body)

if __name__ == '__main__': unittest.main()
