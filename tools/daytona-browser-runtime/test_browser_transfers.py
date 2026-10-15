import base64
import hashlib
import importlib.util
import os
from pathlib import Path
import shutil
import signal
import subprocess
import tempfile
import time
import unittest
import sys
from unittest.mock import patch
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).parent))
dispatcher_spec = importlib.util.spec_from_file_location('file_dispatcher', Path(__file__).with_name('browser-dispatcher.py'))
dispatcher = importlib.util.module_from_spec(dispatcher_spec)
dispatcher_spec.loader.exec_module(dispatcher)

PATH = Path(__file__).with_name('browser_transfers.py')
spec = importlib.util.spec_from_file_location('browser_transfers', PATH)
transfer = importlib.util.module_from_spec(spec) if PATH.exists() else None
if transfer: spec.loader.exec_module(transfer)

class Transfers(unittest.TestCase):
    def setUp(self):
        self.assertIsNotNone(transfer, 'Native upload/capture implementation is missing')
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name); self.base.chmod(0o700)
        (self.base/'uploads').mkdir(mode=0o700)
        self.data = b'public file bytes\n'
        self.file = dict(relativePath='notes.txt', filename='notes.txt', contentType='text/plain', byteLength=len(self.data), sha256=hashlib.sha256(self.data).hexdigest())
        self.descriptor = dict(phase='prepare',transferId='11111111-1111-4111-8111-111111111111',directory=False,files=[self.file])

    def test_preparation_creates_only_private_generated_tree_and_never_overwrites(self):
        root = transfer.prepare_upload_tree(self.base, self.descriptor)
        self.assertEqual(root.parent, self.base/'uploads'); self.assertEqual(root.stat().st_mode & 0o777, 0o700)
        with self.assertRaises(transfer.TransferError): transfer.prepare_upload_tree(self.base, self.descriptor)
        for path in ('../escape.txt','/etc/passwd','fixture/.secret.txt','fixture\\evil.txt'):
            with self.subTest(path=path), self.assertRaises(transfer.TransferError):
                transfer.validate_descriptor(dict(self.descriptor, files=[dict(self.file,relativePath=path)]))
        for fields in ({'filename':None},{'contentType':[]},{'byteLength':True},{'sha256':None}):
            with self.subTest(fields=fields),self.assertRaises(transfer.TransferError): transfer.validate_descriptor(dict(self.descriptor,files=[dict(self.file,**fields)]))

    def test_exact_files_are_verified_without_symlinks_wrong_bytes_or_extra_directory_files(self):
        root = transfer.prepare_upload_tree(self.base, self.descriptor)
        (root/'notes.txt').write_bytes(self.data); (root/'notes.txt').chmod(0o600)
        self.assertEqual(transfer.verify_upload_tree(self.base,self.descriptor), [str(root/'notes.txt')])
        (root/'notes.txt').write_bytes(b'changed')
        with self.assertRaises(transfer.TransferError): transfer.verify_upload_tree(self.base,self.descriptor)
        (root/'notes.txt').unlink(); (root/'notes.txt').symlink_to('/etc/hostname')
        with self.assertRaises(transfer.TransferError): transfer.verify_upload_tree(self.base,self.descriptor)

    def test_directory_manifest_uses_real_native_relative_tree_and_rejects_single_file_contract(self):
        directory = dict(self.descriptor, directory=True, files=[dict(self.file, relativePath='fixture/nested/notes.txt')])
        root = transfer.prepare_upload_tree(self.base, directory)
        path = root/'fixture/nested/notes.txt'; path.write_bytes(self.data); path.chmod(0o600)
        self.assertEqual(transfer.verify_upload_tree(self.base,directory), [str(root/'fixture')])
        extra = root/'fixture/extra.txt'; extra.write_bytes(b'extra'); extra.chmod(0o600)
        with self.assertRaises(transfer.TransferError): transfer.verify_upload_tree(self.base,directory)
        with self.assertRaises(transfer.TransferError): transfer.validate_descriptor(dict(directory,directory=False))

    def test_private_upload_quota_and_free_space_checked_before_new_transfer_effects(self):
        reserve = self.base/'uploads'/'previous.txt'; reserve.touch(mode=0o600)
        with reserve.open('wb') as stream: stream.truncate(128*1024*1024)
        with self.assertRaises(transfer.TransferError): transfer.prepare_upload_tree(self.base,self.descriptor)
        self.assertFalse((self.base/'uploads'/self.descriptor['transferId']).exists())
        reserve.unlink()
        with patch.object(transfer.os,'fstatvfs',return_value=SimpleNamespace(f_bavail=256*1024*1024,f_frsize=1)):
            with self.assertRaises(transfer.TransferError): transfer.prepare_upload_tree(self.base,self.descriptor)
        self.assertFalse((self.base/'uploads'/self.descriptor['transferId']).exists())

    def test_capture_uses_actual_fixed_page_command_and_rejects_missing_or_oversize_data(self):
        class Cdp:
            def __init__(self, data): self.data, self.calls = data, []
            def command(self, method, params, session): self.calls.append((method,params,session)); return {'data':self.data}
        data = base64.b64encode(b'png bytes verified structurally at server').decode()
        cdp = Cdp(data); result = transfer.capture_png(cdp,'owned-session')
        self.assertEqual(cdp.calls, [('Page.captureScreenshot', {'format':'png','fromSurface':True,'captureBeyondViewport':False}, 'owned-session')])
        self.assertEqual(result, {'capture':{'contentType':'image/png','data':data}})
        for invalid in ('', 'not base64!', base64.b64encode(b'x'*(4*1024*1024+1)).decode()):
            with self.assertRaises(transfer.TransferError): transfer.capture_png(Cdp(invalid),'owned-session')

    def test_dispatcher_accepts_only_typed_png_capture_or_upload_with_trusted_manifest(self):
        payload = dict(version=1, op='execute',profileKey='profile-one',profilePath='/home/otcbrowser/.local/share/otchealth-browser/profile-one/chromium',timeoutMs=1000, sessionId='11111111-1111-4111-8111-111111111111',principalHash='a'*64)
        capture = dict(payload, action={'type':'capture','request':{'type':'screenshot','format':'png'}})
        try: validated = dispatcher.validate_payload(capture)
        except dispatcher.DispatchError as error: self.fail('Typed PNG capture is not implemented: '+error.code)
        self.assertEqual(validated, capture)
        upload = dict(payload, action={'type':'upload','selector':'#file','fileId':'11111111-1111-4111-8111-111111111111'},upload=self.descriptor)
        self.assertEqual(dispatcher.validate_payload(upload), upload)
        upload.pop('upload')
        with self.assertRaises(dispatcher.DispatchError): dispatcher.validate_payload(upload)

    def test_only_fixed_capture_command_has_bounded_base64_transport_allowance(self):
        cdp=object.__new__(dispatcher.Cdp); cdp.identifier=0; cdp.send=lambda *_:None
        limits=[]
        def message(limit=dispatcher.MAX_FRAME):
            limits.append(limit); return {'id':cdp.identifier,'result':{}}
        cdp.message=message
        cdp.command('Target.getTargets'); cdp.command('Page.captureScreenshot',{'format':'png'},'owned'); cdp.command('Accessibility.getFullAXTree',{},'owned')
        self.assertEqual(limits,[4*1024*1024,6*1024*1024,4*1024*1024])

    def test_actual_sandboxed_chromium_native_single_file_directory_paths_and_png(self):
        binary = shutil.which('chromium') or shutil.which('chromium-browser')
        if not binary: self.skipTest('Chromium absent; no native directory/capture proof')
        profile = self.base/'chromium'; profile.mkdir(mode=0o700)
        process = subprocess.Popen([binary,'--headless','--disable-gpu','--no-first-run','--no-default-browser-check','--remote-debugging-address=127.0.0.1','--remote-debugging-port=9222','--user-data-dir='+str(profile),'about:blank'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,start_new_session=True)
        cdp = None
        try:
            deadline = time.monotonic()+6
            while True:
                try: dispatcher.verify_runtime(str(profile)); break
                except dispatcher.DispatchError:
                    if process.poll() is not None or time.monotonic()>deadline: self.fail('Disposable sandboxed Chromium unavailable')
                    time.sleep(0.05)
            cdp = dispatcher.Cdp(time.monotonic()+15)
            target = next(item['targetId'] for item in cdp.command('Target.getTargets')['targetInfos'] if item['type']=='page')
            session = cdp.command('Target.attachToTarget',{'targetId':target,'flatten':True})['sessionId']
            # Known, local public fixture only. Direct helper checks native mechanics;
            # production dispatcher separately enforces public-page/output guards.
            cdp.command('Runtime.evaluate',{'expression':'document.body.innerHTML="<input id=single type=file><input id=folder type=file webkitdirectory>"'},session)
            root = transfer.prepare_upload_tree(self.base,self.descriptor)
            (root/'notes.txt').write_bytes(self.data); (root/'notes.txt').chmod(0o600)
            node = transfer.file_input(cdp,session,'#single',self.descriptor)
            result = transfer.attach_upload(cdp,session,node,self.base,self.descriptor)
            self.assertEqual(result['fileReceipt']['sha256'],self.file['sha256'])
            directory = dict(self.descriptor,transferId='22222222-2222-4222-8222-222222222222',directory=True,files=[dict(self.file,relativePath='fixture/nested/notes.txt')])
            root = transfer.prepare_upload_tree(self.base,directory)
            path = root/'fixture/nested/notes.txt'; path.write_bytes(self.data); path.chmod(0o600)
            with self.assertRaises(transfer.TransferError): transfer.file_input(cdp,session,'#folder',self.descriptor)
            node = transfer.file_input(cdp,session,'#folder',directory)
            result = transfer.attach_upload(cdp,session,node,self.base,directory)
            self.assertEqual(result['directoryReceipt']['files'][0]['relativePath'],'fixture/nested/notes.txt')
            png = base64.b64decode(transfer.capture_png(cdp,session)['capture']['data'],validate=True)
            self.assertTrue(png.startswith(b'\x89PNG\r\n\x1a\n')); self.assertTrue(png.endswith(b'IEND\xaeB`\x82'))
            cdp.command('Runtime.evaluate',{'expression':'document.getElementById("single").onchange=function(){this.value="";}'},session)
            node = transfer.file_input(cdp,session,'#single',self.descriptor)
            # A change handler clearing the files prevents a false attached receipt.
            cdp.command('DOM.setFileInputFiles',{'nodeId':node,'files':[]},session)
            with self.assertRaises(transfer.TransferError): transfer.attach_upload(cdp,session,node,self.base,self.descriptor)
        finally:
            if cdp: cdp.close()
            os.killpg(process.pid,signal.SIGTERM)
            try: process.wait(timeout=4)
            except subprocess.TimeoutExpired: os.killpg(process.pid,signal.SIGKILL); process.wait(timeout=4)
            time.sleep(0.2)

if __name__ == '__main__': unittest.main()
