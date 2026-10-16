import importlib.util
import os
from pathlib import Path
import socket
import struct
import tempfile
import threading
import unittest

spec=importlib.util.spec_from_file_location('role_helper',Path(__file__).with_name('role-browser-helper.py'))
helper=importlib.util.module_from_spec(spec);spec.loader.exec_module(helper)

class RoleHelperTests(unittest.TestCase):
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
