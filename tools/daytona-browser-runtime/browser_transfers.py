"""Fixed native file-input/capture operations; no arbitrary paths, scripts or content exports."""
import base64
import hashlib
import os
from pathlib import Path
import re
import stat
import time

MAX_BYTES = 10 * 1024 * 1024
MAX_CAPTURE = 4 * 1024 * 1024
UUID = re.compile(r'[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\Z', re.I)
MIMES = {'text/plain': ('txt',), 'text/csv': ('csv',), 'application/pdf': ('pdf',), 'image/png': ('png',), 'image/jpeg': ('jpg', 'jpeg')}


class TransferError(ValueError):
    def __init__(self, code): self.code = code; super().__init__(code)


def fail(code): raise TransferError(code)


def component(value):
    return isinstance(value, str) and 0 < len(value) <= 128 and re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._ -]*', value) and '..' not in value and not value.endswith(('.', ' '))


def validate_descriptor(value):
    if not isinstance(value, dict) or set(value) != {'phase', 'transferId', 'directory', 'files'} or value['phase'] not in ('prepare', 'attach') or not isinstance(value['transferId'], str) or not UUID.fullmatch(value['transferId']) or type(value['directory']) is not bool:
        fail('invalid_upload_descriptor')
    files = value['files']
    if not isinstance(files, list) or not 1 <= len(files) <= 32 or (not value['directory'] and len(files) != 1): fail('invalid_upload_descriptor')
    paths, roots, total = set(), set(), 0
    for entry in files:
        if not isinstance(entry, dict) or set(entry) != {'relativePath', 'filename', 'contentType', 'byteLength', 'sha256'}: fail('invalid_upload_descriptor')
        relative = entry['relativePath']
        if not isinstance(relative, str) or len(relative) > 512: fail('invalid_upload_descriptor')
        parts = relative.split('/')
        if not 1 <= len(parts) <= 8 or any(not component(part) for part in parts) or relative in paths or parts[-1] != entry['filename']: fail('invalid_upload_descriptor')
        if bool(len(parts) > 1) != value['directory']: fail('daytona_directory_manifest_required')
        if not isinstance(entry['contentType'], str) or entry['contentType'] not in MIMES or not isinstance(entry['filename'], str) or entry['filename'].split('.')[-1].lower() not in MIMES[entry['contentType']]: fail('invalid_upload_descriptor')
        if type(entry['byteLength']) is not int or not 1 <= entry['byteLength'] <= MAX_BYTES or not isinstance(entry['sha256'], str) or not re.fullmatch('[a-f0-9]{64}', entry['sha256']): fail('invalid_upload_descriptor')
        total += entry['byteLength']; paths.add(relative); roots.add(parts[0])
    if total > MAX_BYTES or (value['directory'] and len(roots) != 1): fail('invalid_upload_descriptor')
    return value


def private_directory(path):
    path = Path(path)
    info = path.lstat()
    if path.resolve() != path or not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077: fail('upload_path_unavailable')
    return path


def upload_root(base, descriptor):
    validate_descriptor(descriptor)
    base = private_directory(base)
    uploads = private_directory(base / 'uploads')
    return uploads / descriptor['transferId']


def check_upload_capacity(directory, additional, uid=None):
    """Metadata-only bounded walk. Never follows, removes or reads user files."""
    uid=os.getuid() if uid is None else uid
    total=0; count=0
    def walk(fd,depth):
        nonlocal total,count
        if depth>9: fail('upload_capacity_unavailable')
        info=os.fstat(fd)
        if not stat.S_ISDIR(info.st_mode) or info.st_uid!=uid or info.st_mode&0o077: fail('upload_capacity_unavailable')
        with os.scandir(fd) as entries:
            for entry in entries:
                count+=1
                if count>4096: fail('upload_capacity_unavailable')
                info=entry.stat(follow_symlinks=False)
                if info.st_uid!=uid or info.st_mode&0o077: fail('upload_capacity_unavailable')
                if stat.S_ISDIR(info.st_mode):
                    child=os.open(entry.name,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=fd)
                    try: walk(child,depth+1)
                    finally: os.close(child)
                elif stat.S_ISREG(info.st_mode) and info.st_nlink==1:
                    total+=info.st_size
                    if total+additional>128*1024*1024: fail('upload_quota_exceeded')
                else: fail('upload_capacity_unavailable')
    walk(directory,0)
    free=os.fstatvfs(directory)
    if free.f_bavail*free.f_frsize-additional<256*1024*1024: fail('upload_capacity_unavailable')


def prepare_upload_tree(base, descriptor):
    root = upload_root(base, descriptor)
    directory=os.open(root.parent,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
    try: check_upload_capacity(directory,sum(file['byteLength'] for file in descriptor['files']))
    finally: os.close(directory)
    try: root.mkdir(mode=0o700)
    except FileExistsError: fail('upload_transfer_exists')
    for entry in descriptor['files']:
        parent = root
        for part in entry['relativePath'].split('/')[:-1]:
            parent = parent / part
            try: parent.mkdir(mode=0o700)
            except FileExistsError: pass
            private_directory(parent)
    for directory in (root, root.parent):
        fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try: os.fsync(fd)
        finally: os.close(fd)
    return root


def verify_upload_tree(base, descriptor):
    root = private_directory(upload_root(base, descriptor))
    expected = set()
    for entry in descriptor['files']:
        parts = entry['relativePath'].split('/')
        parent = root
        for part in parts[:-1]: parent = private_directory(parent / part)
        path = parent / parts[-1]; expected.add(str(path))
        try: fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
        except OSError: fail('file_integrity_failed')
        try:
            info = os.fstat(fd)
            if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_nlink != 1 or info.st_mode & 0o077 or info.st_size != entry['byteLength']: fail('file_integrity_failed')
            actual = hashlib.sha256()
            with os.fdopen(fd, 'rb') as stream:
                fd = None
                while True:
                    chunk = stream.read(262144)
                    if not chunk: break
                    actual.update(chunk)
            if actual.hexdigest() != entry['sha256']: fail('file_integrity_failed')
        finally:
            if fd is not None: os.close(fd)
    found = set()
    for parent, directories, files in os.walk(root, followlinks=False):
        for directory in directories: private_directory(Path(parent) / directory)
        for filename in files: found.add(str(Path(parent) / filename))
    if found != expected: fail('file_integrity_failed')
    return [str(root / descriptor['files'][0]['relativePath'].split('/')[0])] if descriptor['directory'] else sorted(expected)


def file_input(cdp, session, selector, descriptor):
    cdp.command('DOM.enable', {}, session)
    document = cdp.command('DOM.getDocument', {'depth': 0}, session)
    node = cdp.command('DOM.querySelector', {'nodeId': document['root']['nodeId'], 'selector': selector}, session).get('nodeId')
    if type(node) is not int or node < 1: fail('file_input_missing')
    description = cdp.command('DOM.describeNode', {'nodeId': node}, session).get('node', {})
    raw = description.get('attributes', []); attrs = dict(zip(raw[::2], raw[1::2]))
    if description.get('nodeName') != 'INPUT' or attrs.get('type', '').lower() != 'file' or 'disabled' in attrs: fail('file_input_invalid')
    directory = 'webkitdirectory' in attrs
    if directory != descriptor['directory']: fail('daytona_directory_manifest_required' if directory else 'directory_input_required')
    accept = attrs.get('accept', '').lower().split(',')
    if any(accept):
        for entry in descriptor['files']:
            extension = '.' + entry['filename'].split('.')[-1].lower()
            if not any(token.strip() in (entry['contentType'], extension, entry['contentType'].split('/')[0] + '/*') for token in accept): fail('file_input_accept_mismatch')
    return node


def remote_value(result):
    if result.get('exceptionDetails') or not isinstance(result.get('result'), dict): fail('file_readback_failed')
    return result['result']


def attach_upload(cdp, session, node, base, descriptor):
    paths = verify_upload_tree(base, descriptor)
    frame = cdp.command('Page.getFrameTree', {}, session).get('frameTree', {}).get('frame', {}).get('id')
    if not isinstance(frame, str): fail('file_readback_failed')
    context = cdp.command('Page.createIsolatedWorld', {'frameId': frame, 'worldName': 'otc-native-file-verification'}, session).get('executionContextId')
    if type(context) is not int: fail('file_readback_failed')
    resolved = cdp.command('DOM.resolveNode', {'nodeId': node, 'executionContextId': context}, session).get('object', {}).get('objectId')
    if not isinstance(resolved, str): fail('file_readback_failed')
    remote_value(cdp.command('Runtime.callFunctionOn', {'objectId': resolved, 'functionDeclaration': 'function(){this.__otcNativeFileChange=false;this.addEventListener("change",()=>{this.__otcNativeFileChange=true;},{once:true});return true;}', 'returnByValue': True}, session))
    cdp.command('DOM.setFileInputFiles', {'nodeId': node, 'files': paths}, session)
    # Native File objects and native read-only webkitRelativePath, never synthetic File/expando fields.
    expected = {entry['relativePath'] if descriptor['directory'] else entry['filename']: entry for entry in descriptor['files']}
    deadline = time.monotonic() + 1
    while True:
        observed = remote_value(cdp.command('Runtime.callFunctionOn', {'objectId': resolved, 'functionDeclaration': 'function(){return {changed:this.__otcNativeFileChange===true,files:Array.from(this.files,f=>({name:f.name,type:f.type,size:f.size,relativePath:f.webkitRelativePath}))};}', 'returnByValue': True}, session)).get('value')
        metadata = observed.get('files') if isinstance(observed, dict) else None
        if isinstance(observed, dict) and observed.get('changed') is True and isinstance(metadata, list) and len(metadata) == len(expected): break
        if time.monotonic() >= deadline: fail('file_readback_failed')
        cdp.remaining(); time.sleep(min(0.02, cdp.remaining()))
    if not isinstance(metadata, list) or len(metadata) != len(expected): fail('file_readback_failed')
    seen = set()
    for index, file in enumerate(metadata):
        relative = file.get('relativePath') if descriptor['directory'] else file.get('name')
        entry = expected.get(relative)
        if not entry or relative in seen or file.get('name') != entry['filename'] or file.get('size') != entry['byteLength'] or file.get('type') != entry['contentType'] or (not descriptor['directory'] and file.get('relativePath') != ''): fail('file_readback_failed')
        seen.add(relative)
        file_object = remote_value(cdp.command('Runtime.callFunctionOn', {'objectId': resolved, 'functionDeclaration': 'function(index){return this.files[index];}', 'arguments': [{'value': index}]}, session)).get('objectId')
        if not isinstance(file_object, str): fail('file_readback_failed')
        actual = hashlib.sha256()
        try:
            for offset in range(0, entry['byteLength'], 1048576):
                length = min(1048576, entry['byteLength'] - offset)
                part = remote_value(cdp.command('Runtime.callFunctionOn', {'objectId': file_object, 'functionDeclaration': 'function(offset,length){return this.slice(offset,offset+length).arrayBuffer().then(buffer=>{const b=new Uint8Array(buffer),p=[];for(let i=0;i<b.length;i+=8192)p.push(String.fromCharCode(...b.subarray(i,i+8192)));return btoa(p.join(""));});}', 'arguments': [{'value': offset}, {'value': length}], 'awaitPromise': True, 'returnByValue': True}, session)).get('value')
                try: decoded = base64.b64decode(part, validate=True)
                except (ValueError, TypeError): fail('file_readback_failed')
                if len(decoded) != length or base64.b64encode(decoded).decode() != part: fail('file_readback_failed')
                actual.update(decoded)
            if actual.hexdigest() != entry['sha256']: fail('file_readback_failed')
        finally: cdp.command('Runtime.releaseObject', {'objectId': file_object}, session)
    cdp.command('Runtime.releaseObject', {'objectId': resolved}, session)
    if descriptor['directory']:
        return {'directoryReceipt': {'status': 'attached', 'directory': True, 'fileCount': len(expected), 'byteLength': sum(entry['byteLength'] for entry in descriptor['files']), 'files': descriptor['files']}}
    entry = descriptor['files'][0]
    return {'fileReceipt': {'status': 'attached', 'filename': entry['filename'], 'contentType': entry['contentType'], 'byteLength': entry['byteLength'], 'sha256': entry['sha256']}}


def capture_png(cdp, session):
    result = cdp.command('Page.captureScreenshot', {'format': 'png', 'fromSurface': True, 'captureBeyondViewport': False}, session)
    data = result.get('data')
    if not isinstance(data, str) or not data or len(data) > ((MAX_CAPTURE + 2) // 3) * 4: fail('capture_invalid')
    try: decoded = base64.b64decode(data, validate=True)
    except ValueError: fail('capture_invalid')
    if not 1 <= len(decoded) <= MAX_CAPTURE or base64.b64encode(decoded).decode() != data: fail('capture_invalid')
    return {'capture': {'contentType': 'image/png', 'data': data}}


def capture_pdf(cdp, session, request):
    if not isinstance(request,dict) or request.get('type')!='pdf' or not request.keys()<={'type','landscape','printBackground'} or any(key in request and type(request[key]) is not bool for key in ('landscape','printBackground')): fail('capture_invalid')
    result=cdp.command('Page.printToPDF',{'landscape':request.get('landscape',False),'printBackground':request.get('printBackground',False),'transferMode':'ReturnAsBase64'},session)
    data=result.get('data')
    if not isinstance(data,str) or not data or len(data)>((MAX_CAPTURE+2)//3)*4: fail('capture_invalid')
    try: decoded=base64.b64decode(data,validate=True)
    except ValueError: fail('capture_invalid')
    if not 1<=len(decoded)<=MAX_CAPTURE or base64.b64encode(decoded).decode()!=data: fail('capture_invalid')
    return {'capture':{'contentType':'application/pdf','data':data}}
