#!/usr/bin/env python3
"""Private per-sandbox lifecycle adapter. Runtime assets and browser flags stay pinned.

No API/master key in argv/env/files/logs. GNOME's source-verified existing-daemon
UNLOCK op1 receives a private stdin frame only after a controlled READY event.
There is no reset/change-password operation or unencrypted fallback.
"""
import argparse
import base64
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import pwd
import re
import select
import socket
import stat
import struct
import subprocess
import sys
import time
from types import FunctionType, SimpleNamespace

ROOT=Path('/opt/otchealth-browser')
STATE=Path('/home/otcbrowser/.local/share/otchealth-browser')
ENROLLMENT=ROOT/'.role-browser-enrollment.json'
ROLES={'cto','cfo','coo','cro','clo','developer','wefunder-campaign-director'}
UUID=re.compile(r'[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\Z')
KEY=re.compile(r'[a-z0-9][a-z0-9_-]{0,95}\Z')
PINS={
 'browser-dispatcher.py':'61e3c2e8242d8c7b7b9b73a30957f1d8470fa962ea1325a12f894e2062c9f7f2',
 'browser_transfers.py':'94656ffae38bebfc3b6c14c406108bf99b02f821e46919e1f8df832746ab9e4a',
 'checkpoint-control.py':'d643d3799b810181ca7d9398d365de26f20365b67343a87fbc474a4953980046',
 'clamd.conf':'a1e8ecbb432ad2246c694cca4bf7ee8e55d6891382241e1a0ab9b7c7f548840f',
 'freshclam.conf':'b2447f0fde447f830c6636718a618e97684bd8c84fab489a5e301f55640506aa',
 'mission-registry.py':'ad7639a1ebf5ea8d41476e93eb07e47af07f2693a93b9523ff2262fdb52ceba1',
 'mission_clipboard.py':'cac755d2f0ef0f459113981905bb75a8c9343c637f60076861985a1f1d00cde9',
 'probe.py':'3f6d9cca15b847c43e6394e99d1e13a6d406d67f32f8346fd8ca43af34459090',
 'runtime.py':'c46a839da60e9adeca30a78c2cf63414ee4e28f575d70622ba2328b091e60c95',
 'supervisord.conf':'04e7caddeeb4c2464308bebf2af29fef8dac37706f4ee905e4eea4c3f6686905',
 'transfer-stage.py':'7b85b486c61abe61ab854fc9989d45137739c7ec5c0346fc84f0d2f4dbc3ab41',
 'viewer_control.py':'da90b560b04b76233dffb0bbd7cc4acfb272dc1edcceec16eb7f0e203ce59131'}
HEADER=b'GnomeKeyring\n\r\0\n'
PHASE='boot'

def need(value,code='role_lifecycle_guard_failed'):
 if not value:raise ValueError(code)
def canonical(value):return json.dumps(value,sort_keys=True,separators=(',',':'),allow_nan=False).encode()
def event(name,**value):print('OTC_ROLE_EVENT='+canonical({'event':name,**value}).decode(),flush=True)
def read(path,uid,mode=None,limit=131072):
 fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
 with os.fdopen(fd,'rb') as stream:
  info=os.fstat(stream.fileno());need(stat.S_ISREG(info.st_mode) and info.st_uid==uid and info.st_nlink==1 and info.st_size<=limit)
  if mode is not None:need(stat.S_IMODE(info.st_mode)==mode)
  return stream.read(limit+1)
def directory(path,uid):
 info=path.lstat();need(stat.S_ISDIR(info.st_mode) and path.resolve()==path and info.st_uid==uid and stat.S_IMODE(info.st_mode)==0o700)
def sync_root():
 fd=os.open(ROOT,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
 try:os.fsync(fd)
 finally:os.close(fd)
def module(name):
 path=ROOT/name;spec=importlib.util.spec_from_file_location('_role_'+name.replace('.','_').replace('-','_'),path);value=importlib.util.module_from_spec(spec);sys.modules[spec.name]=value;spec.loader.exec_module(value);return value
def checked(payload):
 need(isinstance(payload,dict) and set(payload)=={'version','op','role','sandboxId','profileKey','operationId'} and payload['version']==1 and payload['role'] in ROLES and UUID.fullmatch(payload['sandboxId']) and KEY.fullmatch(payload['profileKey']) and UUID.fullmatch(payload['operationId']))
 need(payload['op'] in {'prepare','launch','_session','status','_probe','commit','close','_close','native'})
 enrollment=json.loads(read(ENROLLMENT,0,0o644,8192))
 need(enrollment['role']==payload['role'] and enrollment['sandboxId']==payload['sandboxId'] and enrollment['profileKey']==payload['profileKey'] and enrollment['organizationId']=='501db94e-10ee-4bc8-9cca-23c793c67524' and enrollment['vaultMode'] in {'fresh','existing'})
 need(ROOT.resolve()==ROOT and ROOT.stat().st_uid==0 and ROOT.stat().st_mode&0o022==0)
 for name,digest in {**PINS,'role-browser-helper.py':enrollment['helperSha256']}.items():need(hashlib.sha256(read(ROOT/name,0,0o755 if name.endswith('.py') else 0o644)).hexdigest()==digest)
 return enrollment,pwd.getpwnam('otcbrowser'),STATE/payload['profileKey']
def packet(secret):
 need(isinstance(secret,(bytes,bytearray)) and re.fullmatch(rb'[A-Za-z0-9_-]{43}',secret));return struct.pack('>III',12+len(secret),1,len(secret))+secret
def unlock(control,pid,ticks,secret):
 for parent in (control,control.parent):directory(parent,os.geteuid())
 path=control/'control';info=path.lstat();need(stat.S_ISSOCK(info.st_mode) and path.resolve()==path and info.st_uid==os.geteuid() and stat.S_IMODE(info.st_mode) in {0o600,0o700,0o755})
 with socket.socket(socket.AF_UNIX,socket.SOCK_STREAM) as peer:
  peer.settimeout(5);peer.connect(str(path));actual,uid,_=struct.unpack('3i',peer.getsockopt(socket.SOL_SOCKET,socket.SO_PEERCRED,12))
  need(actual==pid and uid==os.geteuid() and identity(pid)[1]==ticks and (path.lstat().st_dev,path.lstat().st_ino)==(info.st_dev,info.st_ino))
  peer.sendall(b'\0');peer.sendall(packet(secret));reply=b''
  while len(reply)<8:
   part=peer.recv(8-len(reply));need(part);reply+=part
  need(reply==struct.pack('>II',8,0))
def identity(pid):
 path=Path('/proc')/str(pid);fields=(path/'stat').read_text().rsplit(')',1)[1].split();return path.stat().st_uid,int(fields[19]),int(fields[1]),fields[0]
def bus(env,dest,path,method,*args):
 response=subprocess.run(['/usr/bin/gdbus','call','--session','--dest',dest,'--object-path',path,'--method',method,*args],env=env,stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,timeout=3,check=False)
 need(response.returncode==0 and len(response.stdout)<=4096);return response.stdout.decode('ascii').strip()
def owner(env,pid):
 value=bus(env,'org.freedesktop.DBus','/org/freedesktop/DBus','org.freedesktop.DBus.GetNameOwner','org.freedesktop.secrets');match=re.fullmatch(r"\('(:[0-9]+\.[0-9]+)',\)",value);need(match);name=match[1]
 need(bus(env,'org.freedesktop.DBus','/org/freedesktop/DBus','org.freedesktop.DBus.GetConnectionUnixProcessID',name)==f'(uint32 {pid},)' and bus(env,'org.freedesktop.DBus','/org/freedesktop/DBus','org.freedesktop.DBus.GetConnectionUnixUser',name)==f'(uint32 {os.geteuid()},)');return name
def alias(env,name,which):
 value=bus(env,name,'/org/freedesktop/secrets','org.freedesktop.Secret.Service.ReadAlias',which);match=re.fullmatch(r"\(objectpath '(/[^']*)',\)",value);need(match);return match[1]
def vault(profile,uid,empty=False):
 path=profile/'data'/'keyrings'
 if not path.exists():need(empty);return
 directory(path,uid);entries={p.name:p for p in path.iterdir()}
 if empty:need(not entries);return
 need({'login.keyring','user.keystore'}<=set(entries)<={'login.keyring','user.keystore','default'})
 for name,value in entries.items():
  fd=os.open(value,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
  with os.fdopen(fd,'rb') as stream:
   info=os.fstat(stream.fileno());need(stat.S_ISREG(info.st_mode) and info.st_uid==uid and info.st_nlink==1 and stat.S_IMODE(info.st_mode) in ({0o600,0o644} if name=='default' else {0o600}))
   if name=='login.keyring':need(stream.read(len(HEADER))==HEADER)
   if name=='default':need(info.st_size<=32 and stream.read(33).strip()==b'login')
def native_zero():
 viewer=module('viewer_control.py');pid,clients=viewer.execute(viewer.query_command());viewer.verify_server_process(pid);need(clients==0);return pid
def encode(payload):return base64.urlsafe_b64encode(canonical(payload)).decode().rstrip('=')
def child(payload,action,timeout=10):
 account=pwd.getpwnam('otcbrowser');request={**payload,'op':action}
 return subprocess.run(['/usr/bin/python3','-I','-B',str(ROOT/'role-browser-helper.py'),'--payload',encode(request)],user=account.pw_uid,group=account.pw_gid,extra_groups=[],env={'PATH':'/usr/local/bin:/usr/bin:/bin','HOME':account.pw_dir,'LANG':'C.UTF-8','DISPLAY':':0'},capture_output=True,timeout=timeout,check=False)
def local_registry(profile,uid):
 directory(profile,uid);fd=os.open(profile,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
 try:return module('mission-registry.py').read_registry_at(fd,uid)
 finally:os.close(fd)
def no_work(profile,uid):
 value=local_registry(profile,uid);need(not os.path.lexists(profile/'mission.json') and value['human'] is None and value['uncertain'] is None and not value['missions'])
def session(payload,enrollment,account,profile):
 need(os.getuid()==account.pw_uid and os.getuid()!=0);runtime=module('runtime.py');paths=runtime.prepare_profile(STATE,payload['profileKey']);original_module=runtime.trusted_module
 def automatic_run(args,*extra,**kwargs):
  global PHASE
  if args!=['seahorse']:return subprocess.run(args,*extra,**kwargs)
  PHASE='gnome_owner'
  env=kwargs['env'];control=Path(env['GNOME_KEYRING_CONTROL']);directory(control,account.pw_uid);directory(control.parent,account.pw_uid)
  rows=[]
  for entry in Path('/proc').iterdir():
   if not entry.name.isdigit():continue
   try:
    pid=int(entry.name);uid,ticks,parent,state=identity(pid)
    if uid==account.pw_uid and parent==os.getpid() and state not in {'Z','X'} and (entry/'exe').resolve()==Path('/usr/bin/gnome-keyring-daemon'):rows.append((pid,ticks))
   except (OSError,ValueError):continue
  need(len(rows)==1);pid,ticks=rows[0];service=owner(env,pid)
  version=subprocess.run(['/usr/bin/gnome-keyring-daemon','--version'],capture_output=True,timeout=3,check=False);need(version.returncode==0 and re.search(rb'(?m)^gnome-keyring-daemon: (42\.1|48\.0)$',version.stdout))
  PHASE='vault_files';marker=ROOT/'.role-keyring-managed.json';managed=os.path.lexists(marker)
  if managed:
   proof=json.loads(read(marker,0,0o644,8192));need(proof['role']==payload['role'] and proof['sandboxId']==payload['sandboxId'] and proof['profileKey']==payload['profileKey']);vault(profile,account.pw_uid)
  elif enrollment['vaultMode']=='existing':vault(profile,account.pw_uid)
  else:vault(profile,account.pw_uid,empty=True);need(alias(env,service,'login')=='/' and alias(env,service,'default')=='/')
  if managed or enrollment['vaultMode']=='existing':
   need(alias(env,service,'login')=='/org/freedesktop/secrets/collection/login');need(bus(env,service,'/org/freedesktop/secrets/collection/login','org.freedesktop.DBus.Properties.Get','org.freedesktop.Secret.Collection','Locked')=='(<true>,)')
  # The caller waits for this exact event before its one suppress-echo input.
  PHASE='receiver_ready';event('receiver_ready',role=payload['role'],sandboxId=payload['sandboxId'],operationId=payload['operationId'],daemonPid=pid)
  need(select.select([sys.stdin],[],[],20)[0]);raw=sys.stdin.buffer.readline(45);need(re.fullmatch(rb'[A-Za-z0-9_-]{43}\n',raw));secret=bytearray(raw[:-1]);raw=None
  try:
   PHASE='before_unlock'
   # The privileged controller confirms fixed native-zero immediately BEFORE
   # its sole stdin send. The browser user never obtains sudo/root authority.
   no_work(profile,account.pw_uid)
   need(identity(pid)[:2]==(account.pw_uid,ticks) and owner(env,pid)==service)
   if not managed and enrollment['vaultMode']=='fresh':vault(profile,account.pw_uid,empty=True);need(alias(env,service,'login')=='/' and alias(env,service,'default')=='/')
   unlock(control,pid,ticks,secret);PHASE='unlock_ack'
  finally:secret[:]=b'\0'*len(secret)
  PHASE='default_alias';need(owner(env,pid)==service);vault(profile,account.pw_uid);login=alias(env,service,'login');need(login=='/org/freedesktop/secrets/collection/login');default=alias(env,service,'default');need(default in {'/',login})
  if default=='/':need(bus(env,service,'/org/freedesktop/secrets','org.freedesktop.Secret.Service.SetAlias','default',login)=='()')
  need(alias(env,service,'default')==login and bus(env,service,login,'org.freedesktop.DBus.Properties.Get','org.freedesktop.Secret.Collection','Locked')=='(<false>,)');event('vault_unlocked',role=payload['role'],sandboxId=payload['sandboxId'],operationId=payload['operationId'])
  return subprocess.CompletedProcess(args,0)
 def trusted(name,module_name):
  value=original_module(name,module_name)
  if name=='checkpoint-control.py':
   base=value.WarmSupervisor
   class ObservedSupervisor(base):
    def listen(self):
     global PHASE
     PHASE='runtime_readiness';super().listen();deadline=time.monotonic()+5
     # Startup /proc observations can race Chromium descriptor churn. Reobserve
     # status only; never relaunch Chrome, unlock again, or relax positive proof.
     while True:
      need(time.monotonic()<deadline);proof=self.status(deadline)
      if proof.get('checkpointReady') is True and proof.get('encryptedKeyringUnlocked') is True:
       need(time.monotonic()<deadline);break
      time.sleep(min(0.05,max(0,deadline-time.monotonic())))
     event('runtime_ready',role=payload['role'],sandboxId=payload['sandboxId'],operationId=payload['operationId'],profileKey=payload['profileKey'],profilePath=str(profile/'chromium'),browserPid=proof['browserPid'],supervisorPid=proof['supervisorPid'])
   value.WarmSupervisor=ObservedSupervisor
  return value
 proxy=SimpleNamespace(**{**vars(subprocess),'run':automatic_run})
 def quiet(*args,**kwargs):
  if args and args[0]=='Create or unlock the encrypted default keyring in Passwords and Keys, then close that window.':return
  return print(*args,**kwargs)
 return FunctionType(runtime.session.__code__,{**runtime.session.__globals__,'subprocess':proxy,'trusted_module':trusted,'print':quiet},'role_private_session')(paths)
def main(payload):
 global PHASE
 PHASE='asset_binding_preflight'
 enrollment,account,profile=checked(payload);op=payload['op']
 if op=='native':need(os.geteuid()==0);native_zero();return {'ok':True,'nativeZero':True}
 if op=='_session':return session(payload,enrollment,account,profile)
 if op=='_probe':
  need(os.getuid()==account.pw_uid and os.getuid()!=0);d=module('browser-dispatcher.py');return d.dispatch({'version':1,'op':'probe','profileKey':payload['profileKey'],'profilePath':str(profile/'chromium'),'timeoutMs':5000})
 need(os.geteuid()==0)
 if op=='status':
  response=child(payload,'_probe',10)
  if response.returncode!=0:return {'ok':False,'code':'role_runtime_not_ready'}
  return json.loads(response.stdout)
 if op=='prepare':
  if enrollment['vaultMode']=='fresh':need(not profile.exists(),'role_existing_profile_not_overwritten')
  source='import importlib.util;from pathlib import Path;p=Path(\'/opt/otchealth-browser/runtime.py\');s=importlib.util.spec_from_file_location(\"r\",p);r=importlib.util.module_from_spec(s);s.loader.exec_module(r);r.prepare_profile(r.STATE_ROOT,'+repr(payload['profileKey'])+')'
  response=subprocess.run(['/usr/bin/python3','-I','-B','-c',source],user=account.pw_uid,group=account.pw_gid,extra_groups=[],check=False,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=10);need(response.returncode==0);return {'ok':True,'prepared':True}
 if op=='commit':
  vault(profile,account.pw_uid);marker=ROOT/'.role-keyring-managed.json';receipt={'role':payload['role'],'sandboxId':payload['sandboxId'],'profileKey':payload['profileKey']}
  try:
   fd=os.open(marker,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o644)
   with os.fdopen(fd,'wb') as stream:stream.write(canonical(receipt));stream.flush();os.fsync(stream.fileno())
  except FileExistsError:need(json.loads(read(marker,0,0o644,8192))==receipt)
  sync_root()
  return {'ok':True,'managedVault':True}
 native_zero();no_work(profile,account.pw_uid)
 if op=='launch':
  PHASE='launch_intent'
  intent=ROOT/('.role-launch-'+payload['operationId']+'.intent.json');fd=os.open(intent,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o644)
  with os.fdopen(fd,'wb') as stream:stream.write(canonical({'role':payload['role'],'sandboxId':payload['sandboxId'],'profileKey':payload['profileKey'],'operationId':payload['operationId'],'pid':os.getpid(),'startTicks':identity(os.getpid())[1],'uid':account.pw_uid}));stream.flush();os.fsync(stream.fileno())
  sync_root()
  request={**payload,'op':'_session'};env={'PATH':'/usr/local/bin:/usr/bin:/bin','LANG':'C.UTF-8','HOME':str(profile/'home'),'DISPLAY':':0'}
  if os.environ.get('XAUTHORITY'):env['XAUTHORITY']=os.environ['XAUTHORITY']
  os.setgroups([]);os.setgid(account.pw_gid);os.setuid(account.pw_uid);os.execve('/usr/bin/dbus-run-session',['dbus-run-session','--','/usr/bin/python3','-I','-B',str(ROOT/'role-browser-helper.py'),'--payload',encode(request)],env)
 if op=='close':
  PHASE='idle_close'
  # Full dispatcher probe takes mission.lock internally: do it BEFORE our
  # exclusive admission fence. _close re-verifies the exact owned browser PID.
  probe=child(payload,'_probe',10);need(probe.returncode==0);status=json.loads(probe.stdout);need(status.get('ready') is True and status.get('checkpointReady') is True)
  lock=os.open(profile/'mission.lock',os.O_RDWR|os.O_NOFOLLOW)
  try:
   info=os.fstat(lock);need(info.st_uid==account.pw_uid and stat.S_IMODE(info.st_mode)==0o600 and info.st_nlink==1);fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB);no_work(profile,account.pw_uid)
   native_zero()
   intent=ROOT/('.role-close-'+payload['operationId']+'.intent.json');fd=os.open(intent,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o644)
   with os.fdopen(fd,'wb') as stream:stream.write(canonical({'role':payload['role'],'sandboxId':payload['sandboxId'],'profileKey':payload['profileKey'],'operationId':payload['operationId'],'browserPid':status['browserPid']}));stream.flush();os.fsync(stream.fileno())
   sync_root()
   response=child(payload,'_close',22);need(response.returncode==0);result=json.loads(response.stdout)
   until=time.monotonic()+12
   while time.monotonic()<until and Path('/proc',str(status['supervisorPid'])).exists():time.sleep(0.1)
   need(not Path('/proc',str(status['supervisorPid'])).exists())
   # Normal runtime exit has now reaped its own daemon and released both writer
   # leases. Do not SDK-stop a still-running supervisor or another writer.
   for path in (STATE/'desktop.lock',profile/'profile.lock'):
    fd=os.open(path,os.O_RDWR|os.O_NOFOLLOW)
    try:
     info=os.fstat(fd);need(stat.S_ISREG(info.st_mode) and info.st_uid==account.pw_uid and stat.S_IMODE(info.st_mode)==0o600 and info.st_nlink==1);fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
    finally:os.close(fd)
   native_zero();no_work(profile,account.pw_uid);vault(profile,account.pw_uid)
   return {**result,'supervisorExited':True,'writerLocksFree':True,'encryptedVaultPreserved':True}
  finally:os.close(lock)
 if op=='_close':raise ValueError('invalid_close_identity')
 raise ValueError('unsupported_lifecycle_operation')

if __name__=='__main__':
 try:
  parser=argparse.ArgumentParser();parser.add_argument('--payload',required=True);args=parser.parse_args();need(len(args.payload)<=8192);payload=json.loads(base64.urlsafe_b64decode(args.payload+'='*(-len(args.payload)%4)))
  if payload.get('op')=='_close':
   enrollment,account,profile=checked(payload);need(os.getuid()==account.pw_uid and os.getuid()!=0);d=module('browser-dispatcher.py');pid=d.verify_runtime(str(profile/'chromium'));cdp=d.Cdp(time.monotonic()+10)
   intent=json.loads(read(ROOT/('.role-close-'+payload['operationId']+'.intent.json'),0,0o644,8192));need(intent=={'role':payload['role'],'sandboxId':payload['sandboxId'],'profileKey':payload['profileKey'],'operationId':payload['operationId'],'browserPid':pid})
   try:
    try:cdp.command('Browser.close')
    except d.DispatchError as error:need(error.code=='provider_connection_lost')
   finally:cdp.close()
   until=time.monotonic()+15
   while time.monotonic()<until and Path('/proc',str(pid)).exists():time.sleep(0.1)
   need(not Path('/proc',str(pid)).exists());result={'ok':True,'browserClosed':True,'browserPid':pid}
  else:result=main(payload)
  if isinstance(result,dict):print(json.dumps(result,sort_keys=True))
  raise SystemExit(result if type(result) is int else 0)
 except Exception:
  event('failure',phase=PHASE,code='role_lifecycle_guard_or_effect_unconfirmed');raise SystemExit(1)
