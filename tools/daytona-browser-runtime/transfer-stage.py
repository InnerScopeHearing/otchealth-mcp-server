"""Fixed root-only promotion of scanned immutable SDK staging bytes. No arbitrary paths."""
import argparse
import base64
import fcntl
import hashlib
import json
import os
from pathlib import Path
import pwd
import re
import signal
import stat
import sys

MAX_BYTES = 10 * 1024 * 1024
UUID = re.compile(r'[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\Z',re.I)
FIELDS = {'version','profileKey','sessionId','principalHash','transferId','relativePath','stagingId','byteLength','sha256'}
class StageError(ValueError): pass
def fail(): raise StageError('stage_unconfirmed')

def validate(value):
    if not isinstance(value,dict) or set(value)!=FIELDS or type(value['version']) is not int or value['version']!=1: fail()
    if not isinstance(value['profileKey'],str) or not re.fullmatch('[a-z0-9][a-z0-9_-]{0,95}',value['profileKey']): fail()
    if any(not isinstance(value[key],str) or not UUID.fullmatch(value[key]) for key in ('sessionId','transferId','stagingId')): fail()
    if any(not isinstance(value[key],str) or not re.fullmatch('[a-f0-9]{64}',value[key]) for key in ('principalHash','sha256')): fail()
    if type(value['byteLength']) is not int or not 1<=value['byteLength']<=MAX_BYTES: fail()
    relative=value['relativePath']
    if not isinstance(relative,str) or len(relative)>512: fail()
    parts=relative.split('/')
    if not 1<=len(parts)<=8 or any(not 1<=len(part)<=128 or not re.fullmatch('[A-Za-z0-9][A-Za-z0-9._ -]*',part) or '..' in part or part.endswith(('.', ' ')) for part in parts): fail()
    return value

def open_directory(path):
    """Walk every ancestor with O_NOFOLLOW; no privileged symlink traversal."""
    path=Path(path)
    if not path.is_absolute() or '..' in path.parts: fail()
    fd=os.open('/',os.O_RDONLY|os.O_DIRECTORY)
    try:
        for part in path.parts[1:]:
            child=os.open(part,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=fd)
            os.close(fd); fd=child
        return fd
    except BaseException: os.close(fd); raise

def private(fd,uid,directory=False):
    info=os.fstat(fd)
    if info.st_uid not in uid or info.st_mode&0o077 or (not stat.S_ISDIR(info.st_mode) if directory else not stat.S_ISREG(info.st_mode)) or (not directory and info.st_nlink!=1): fail()
    return info

def read_file(directory,name,uids,maximum):
    fd=os.open(name,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=directory)
    try:
        info=private(fd,uids)
        if info.st_size>maximum: fail()
        chunks=[]; size=0
        while True:
            part=os.read(fd,min(262144,maximum+1-size))
            if not part: break
            size+=len(part)
            if size>maximum: fail()
            chunks.append(part)
        return b''.join(chunks)
    finally: os.close(fd)

def promote(value,*,profiles,staging,browser_uid,browser_gid,source_uids):
    """Arguments are trusted local test seams; CLI never accepts root paths or UIDs."""
    value=validate(value); opened=[]
    try:
        staging_root=open_directory(staging); opened.append(staging_root)
        source=os.open('otc-browser-upload-'+value['stagingId'],os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=staging_root); opened.append(source); source_info=private(source,source_uids,True)
        body=read_file(source,'payload.bin',source_uids,MAX_BYTES)
        if len(body)!=value['byteLength'] or hashlib.sha256(body).hexdigest()!=value['sha256']: fail()
        profiles_fd=open_directory(profiles); opened.append(profiles_fd); private(profiles_fd,{browser_uid},True)
        base=os.open(value['profileKey'],os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=profiles_fd); opened.append(base); private(base,{browser_uid},True)
        lock=os.open('mission.lock',os.O_RDWR|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=base); opened.append(lock); private(lock,{browser_uid})
        try: fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        except BlockingIOError: fail()
        receipt=json.loads(read_file(base,'mission.json',{browser_uid},65536),object_pairs_hook=unique_object)
        if not isinstance(receipt,dict) or receipt.get('sessionId')!=value['sessionId'] or receipt.get('principalHash')!=value['principalHash'] or receipt.get('uncertain') is not False: fail()
        parent=os.open('uploads',os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=base); opened.append(parent); private(parent,{browser_uid},True)
        from browser_transfers import check_upload_capacity
        check_upload_capacity(parent,value['byteLength'],browser_uid)
        for part in [value['transferId']]+value['relativePath'].split('/')[:-1]:
            parent=os.open(part,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=parent); opened.append(parent); private(parent,{browser_uid},True)
        target=os.open(value['relativePath'].split('/')[-1],os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600,dir_fd=parent); opened.append(target)
        os.fchown(target,browser_uid,browser_gid); os.fchmod(target,0o600)
        remaining=memoryview(body)
        while remaining:
            wrote=os.write(target,remaining)
            if wrote<1: fail()
            remaining=remaining[wrote:]
        os.fsync(target); os.fsync(parent)
        # Only this exact generated spool. Never recursively clean a profile or
        # an unrecognized path; private native upload targets remain readable.
        current=os.stat('otc-browser-upload-'+value['stagingId'],dir_fd=staging_root,follow_symlinks=False)
        if (current.st_dev,current.st_ino)!=(source_info.st_dev,source_info.st_ino): fail()
        os.unlink('payload.bin',dir_fd=source); os.fsync(source)
        os.rmdir('otc-browser-upload-'+value['stagingId'],dir_fd=staging_root); os.fsync(staging_root)
        return dict(version=1,ok=True,staged=True,sha256=value['sha256'],byteLength=len(body),profileKey=value['profileKey'],sessionId=value['sessionId'])
    except (OSError,ValueError,TypeError,KeyError): fail()
    finally:
        for fd in reversed(opened): os.close(fd)

def unique_object(pairs):
    value={}
    for key,item in pairs:
        if key in value: fail()
        value[key]=item
    return value

def run_payload(encoded):
    try:
        if not isinstance(encoded,str) or len(encoded)>4096 or not re.fullmatch('[A-Za-z0-9_-]+={0,2}',encoded): fail()
        value=validate(json.loads(base64.b64decode(encoded+'='*(-len(encoded)%4),altchars=b'-_',validate=True),object_pairs_hook=unique_object))
    except (ValueError,TypeError,UnicodeError): return dict(version=1,ok=False,code='invalid_stage_payload')
    try:
        if os.geteuid()!=0: fail()
        account=pwd.getpwnam('otcbrowser')
        return promote(value,profiles=Path('/home/otcbrowser/.local/share/otchealth-browser'),staging=Path('/tmp'),browser_uid=account.pw_uid,browser_gid=account.pw_gid,source_uids={0,1001})
    except Exception: return dict(version=1,ok=False,code='stage_unconfirmed')

def main():
    parser=argparse.ArgumentParser(description=__doc__); parser.add_argument('--payload',required=True); args=parser.parse_args()
    def timeout(*_): fail()
    signal.signal(signal.SIGALRM,timeout); signal.alarm(20)
    try: result=run_payload(args.payload)
    finally: signal.alarm(0)
    print(json.dumps(result,separators=(',',':')))
    return 0 if result['ok'] else 1
if __name__=='__main__': sys.exit(main())
