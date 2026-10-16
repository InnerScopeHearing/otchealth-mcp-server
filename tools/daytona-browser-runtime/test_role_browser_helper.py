import importlib.util
import ast
import os
from pathlib import Path
import socket
import struct
import tempfile
import threading
import unittest
from types import SimpleNamespace
from unittest.mock import Mock

spec=importlib.util.spec_from_file_location('role_helper',Path(__file__).with_name('role-browser-helper.py'))
helper=importlib.util.module_from_spec(spec);spec.loader.exec_module(helper)

class RoleHelperTests(unittest.TestCase):
 def observed_supervisor(self,responses):
  source=ast.parse(Path(helper.__file__).read_text())
  definition=next(node for node in ast.walk(source) if isinstance(node,ast.ClassDef) and node.name=='ObservedSupervisor')
  calls=[];clock=SimpleNamespace(now=100.0)
  def sleep(seconds):self.assertGreater(seconds,0);clock.now+=seconds
  class Base:
   def listen(self):calls.append('listen')
   def status(self,deadline):
    calls.append(('status',deadline))
    return responses.pop(0) if len(responses)>1 else responses[0]
  namespace={'base':Base,'time':SimpleNamespace(monotonic=lambda:clock.now,sleep=sleep),'need':helper.need,
             'event':Mock(),'payload':{'role':'developer','sandboxId':'fixture','operationId':'fixture','profileKey':'company-browser'},'profile':Path('/fixture')}
  exec(compile(ast.fix_missing_locations(ast.Module(body=[definition],type_ignores=[])),str(helper.__file__),'exec'),namespace)
  return namespace['ObservedSupervisor'](),calls,clock,namespace

 def test_readiness_reobserves_false_status_without_relaunch_or_unlock(self):
  ready={'checkpointReady':True,'encryptedKeyringUnlocked':True,'browserPid':101,'supervisorPid':102}
  supervisor,calls,clock,namespace=self.observed_supervisor([{**ready,'checkpointReady':False},ready])
  supervisor.listen()
  self.assertEqual(calls,['listen',('status',105.0),('status',105.0)])
  self.assertLess(clock.now,105.0);namespace['event'].assert_called_once_with('runtime_ready',role='developer',sandboxId='fixture',operationId='fixture',profileKey='company-browser',profilePath='/fixture/chromium',browserPid=101,supervisorPid=102)

 def test_readiness_never_reports_locked_keyring_or_unverified_browser_ready(self):
  for proof in ({'checkpointReady':False,'encryptedKeyringUnlocked':True},{'checkpointReady':True,'encryptedKeyringUnlocked':False}):
   with self.subTest(proof=proof):
    supervisor,calls,clock,namespace=self.observed_supervisor([proof])
    with self.assertRaises(ValueError):supervisor.listen()
    namespace['event'].assert_not_called();self.assertEqual(calls.count('listen'),1)
    self.assertEqual({call[1] for call in calls if isinstance(call,tuple)},{105.0})
    self.assertAlmostEqual(clock.now,105.0)

 def test_readiness_status_exception_is_not_retried(self):
  supervisor,calls,clock,namespace=self.observed_supervisor([])
  supervisor.status=Mock(side_effect=ValueError('terminal'))
  with self.assertRaisesRegex(ValueError,'terminal'):supervisor.listen()
  supervisor.status.assert_called_once();namespace['event'].assert_not_called();self.assertEqual(calls,['listen'])

 def test_exact_gnome_op1_wire_no_newline_or_change_operation(self):
  key=b'a'*43
  self.assertEqual(helper.packet(key),struct.pack('>III',55,1,43)+key)
  for key in (b'a'*42,b'a'*44,b'a'*42+b'\n'):
   with self.assertRaises(ValueError):helper.packet(key)

 def test_real_private_unix_peer_and_fragmented_ack(self):
  with tempfile.TemporaryDirectory() as directory:
   parent=Path(directory);control=parent/'keyring';control.mkdir(mode=0o700)
   with socket.socket(socket.AF_UNIX,socket.SOCK_STREAM) as server:
    server.bind(str(control/'control'));os.chmod(control/'control',0o755);server.listen(1);received=[]
    def respond():
     with server.accept()[0] as peer:
      packet=b''
      while len(packet)<56:packet+=peer.recv(56-len(packet))
      received.append(packet);peer.sendall(struct.pack('>I',8));peer.sendall(struct.pack('>I',0))
    thread=threading.Thread(target=respond);thread.start()
    helper.unlock(control,os.getpid(),helper.identity(os.getpid())[1],b'a'*43)
    thread.join(2);self.assertFalse(thread.is_alive());self.assertEqual(received,[b'\0'+helper.packet(b'a'*43)])

 def test_foreign_peer_receives_no_credential_or_secret(self):
  with tempfile.TemporaryDirectory() as directory:
   control=Path(directory)/'keyring';control.mkdir(mode=0o700)
   with socket.socket(socket.AF_UNIX,socket.SOCK_STREAM) as server:
    server.bind(str(control/'control'));os.chmod(control/'control',0o700);server.listen(1);received=[]
    def respond():
     with server.accept()[0] as peer:received.append(peer.recv(128))
    thread=threading.Thread(target=respond);thread.start()
    with self.assertRaises(ValueError):helper.unlock(control,os.getpid()+1,helper.identity(os.getpid())[1],b'a'*43)
    thread.join(2);self.assertEqual(received,[b''])

 def test_close_probe_is_outside_same_registry_lock_and_no_browser_sudo(self):
  source=Path(helper.__file__).read_text();close=source.split("if op=='close':",1)[1]
  self.assertLess(close.index("probe=child(payload,'_probe'"),close.index('fcntl.flock(lock'))
  self.assertNotIn("subprocess.run(['sudo'",source)

if __name__=='__main__':unittest.main()
