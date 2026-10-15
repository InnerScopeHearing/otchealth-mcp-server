#!/usr/bin/env python3
"""Fixed, bounded local browser controls. No caller script, CDP method, or shell."""

import argparse
import base64
import fcntl
import hashlib
import http.client
import importlib.util
import ipaddress
import json
import math
import os
from pathlib import Path
import re
import signal
import socket
import stat
import struct
import sys
import tempfile
import time
from urllib.parse import urlsplit


ROOT = Path('/home/otcbrowser/.local/share/otchealth-browser')
KEY = re.compile(r'[a-z0-9][a-z0-9_-]{0,95}\Z')
UUID = re.compile(r'[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\Z')
HASH = re.compile(r'[0-9a-f]{64}\Z')
TARGET = re.compile(r'[A-Za-z0-9_-]{1,256}\Z')
KEYS = {'Enter': 13, 'Tab': 9, 'Escape': 27, 'Backspace': 8, 'Delete': 46,
        'Space': 32, 'ArrowUp': 38, 'ArrowDown': 40, 'ArrowLeft': 37, 'ArrowRight': 39,
        'Home': 36, 'End': 35, 'PageUp': 33, 'PageDown': 34, 'F5': 116,
        **{'Key' + letter: ord(letter) for letter in 'ACVPSFZ'}}
MAX_FRAME = 4 * 1024 * 1024


class DispatchError(Exception):
    def __init__(self, code, before_effect=False):
        self.code, self.before_effect = code, before_effect
        super().__init__(code)


def fail(code, before_effect=False):
    raise DispatchError(code, before_effect)


def trusted_transfers():
    # -I intentionally removes the script directory. Load only this installed,
    # root-owned sibling, never cwd, PYTHONPATH or an ambient sys.modules entry.
    path = Path(__file__).resolve(strict=True).with_name('browser_transfers.py')
    if path.is_symlink(): raise ImportError('transfer_module_unavailable')
    spec = importlib.util.spec_from_file_location('_otc_owned_browser_transfers', path)
    if not spec or not spec.loader: raise ImportError('transfer_module_unavailable')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def trusted_registry():
    path = Path(__file__).resolve(strict=True).with_name('mission-registry.py')
    if path.is_symlink(): fail('registry_unavailable')
    spec = importlib.util.spec_from_file_location('_otc_owned_mission_registry', path)
    if not spec or not spec.loader: fail('registry_unavailable')
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    return module


def trusted_clipboard():
    path = Path(__file__).resolve(strict=True).with_name('mission_clipboard.py')
    if path.is_symlink(): fail('clipboard_provider_unavailable')
    spec = importlib.util.spec_from_file_location('_otc_owned_mission_clipboard', path)
    if not spec or not spec.loader: fail('clipboard_provider_unavailable')
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    return module


def integer(value, low, high):
    return type(value) is int and low <= value <= high


def text(value, low=1, high=256):
    return isinstance(value, str) and low <= len(value) <= high and not re.search(r'[\x00-\x1f\x7f]', value)


def fields(value, required, optional=()):
    if not isinstance(value, dict) or not set(required) <= value.keys() or not value.keys() <= set(required) | set(optional):
        fail('invalid_payload')


def validate_action(action):
    if not isinstance(action, dict) or not isinstance(action.get('type'), str):
        fail('invalid_action')
    kind = action['type']
    if kind == 'capture':
        fields(action, ('type', 'request'))
        request = action['request']
        if not isinstance(request, dict) or 'type' not in request: fail('unsupported_action')
        if request['type'] == 'pdf':
            if not request.keys() <= {'type', 'landscape', 'printBackground'} or any(type(value) is not bool for key, value in request.items() if key != 'type'): fail('unsupported_action')
        elif request['type'] != 'screenshot' or not request.keys() <= {'type', 'format'} or request.get('format', 'png') != 'png': fail('unsupported_action')
        return action
    if kind == 'upload':
        fields(action, ('type', 'selector', 'fileId'))
        if not text(action['selector']) or not isinstance(action['fileId'], str) or not UUID.fullmatch(action['fileId']): fail('invalid_action')
        return action
    schemas = {
        'navigate': (('url',), ()), 'snapshot': ((), ()),
        'click': (('selector',), ('button', 'clickCount')), 'type': (('selector', 'text'), ()),
        'wait_for': (('selector',), ()), 'focus': (('selector',), ()), 'select': (('selector', 'value'), ()),
        'press_key': (('key',), ('modifiers',)),
        'scroll': (('x', 'y', 'deltaX', 'deltaY'), ()), 'mouse_move': (('x', 'y'), ()),
        'drag': (('fromX', 'fromY', 'toX', 'toY'), ('steps',)),
        'tab_create': (('url',), ()), 'tab_select': (('targetId',), ()), 'tab_close': (('targetId',), ()),
        'navigate_back': ((), ()), 'navigate_forward': ((), ()), 'reload': ((), ()),
        'dialog': (('accept',), ('promptText',)),
    }
    if kind not in schemas:
        fail('invalid_action')
    required, optional = schemas[kind]
    if not {'type', *required} <= action.keys() or not action.keys() <= {'type', *required, *optional}:
        fail('invalid_action')
    for name, value in action.items():
        if name == 'type': continue
        if name in ('x', 'y', 'fromX', 'fromY', 'toX', 'toY', 'deltaX', 'deltaY'):
            minimum = -10000 if name.startswith('delta') else 0
            valid = type(value) in (float, int) and math.isfinite(value) and minimum <= value <= 10000
        elif name == 'selector': valid = text(value)
        elif name == 'url': valid = text(value, 1, 2048)
        elif name in ('text', 'value', 'promptText'): valid = text(value, 1 if name == 'text' else 0, 1024)
        elif name == 'targetId': valid = isinstance(value, str) and TARGET.fullmatch(value)
        elif name == 'key': valid = isinstance(value, str) and value in KEYS
        elif name == 'modifiers': valid = integer(value, 0, 15)
        elif name == 'steps': valid = integer(value, 1, 20)
        elif name == 'clickCount': valid = integer(value, 1, 2)
        elif name == 'button': valid = value in ('left', 'right')
        elif name == 'accept': valid = type(value) is bool
        else: valid = False
        if not valid: fail('invalid_action')
    return action


def validate_payload(payload):
    fields(payload, ('version', 'op', 'profileKey', 'profilePath', 'timeoutMs'), ('sessionId', 'action', 'principalHash', 'upload', 'runtimeProtocol'))
    if 'runtimeProtocol' in payload and (type(payload['runtimeProtocol']) is not int or payload['runtimeProtocol'] != 2): fail('invalid_payload')
    operations = ('probe', 'open', 'execute', 'checkpoint', 'release') + (('human_pause', 'human_resume') if payload.get('runtimeProtocol') == 2 else ())
    if type(payload['version']) is not int or payload['version'] != 1 or payload['op'] not in operations:
        fail('invalid_payload')
    key = payload['profileKey']
    if not isinstance(key, str) or not KEY.fullmatch(key) or payload['profilePath'] != str(ROOT / key / 'chromium'):
        fail('invalid_payload')
    if not integer(payload['timeoutMs'], 1, 18000): fail('invalid_payload')
    if payload['op'] != 'probe' and not (isinstance(payload.get('sessionId'), str) and UUID.fullmatch(payload['sessionId'])):
        fail('invalid_payload')
    if 'sessionId' in payload and not (isinstance(payload['sessionId'], str) and UUID.fullmatch(payload['sessionId'])):
        fail('invalid_payload')
    if 'principalHash' in payload and not (isinstance(payload['principalHash'], str) and HASH.fullmatch(payload['principalHash'])):
        fail('invalid_payload')
    if payload.get('runtimeProtocol') == 2 and not (isinstance(payload.get('principalHash'), str) and HASH.fullmatch(payload['principalHash'])): fail('invalid_payload')
    if payload['op'] == 'execute':
        validate_action(payload.get('action'))
        if payload['action']['type'] == 'upload':
            try:
                trusted_transfers().validate_descriptor(payload.get('upload'))
            except (ImportError, ValueError): fail('invalid_upload_descriptor')
        elif 'upload' in payload: fail('invalid_payload')
    elif 'action' in payload: fail('invalid_payload')
    elif 'upload' in payload: fail('invalid_payload')
    return payload


def allow_url(url, allow_blank=False):
    if allow_blank and url == 'about:blank': return
    if not text(url, 1, 2048): fail('destination_forbidden')
    try:
        parsed = urlsplit(url)
        if parsed.scheme not in ('http', 'https') or not parsed.hostname or parsed.username is not None or parsed.password is not None:
            fail('destination_forbidden')
        port = parsed.port or (443 if parsed.scheme == 'https' else 80)
        if port not in (80, 443): fail('destination_forbidden')
        addresses = socket.getaddrinfo(parsed.hostname, port, type=socket.SOCK_STREAM)
        resolved = [ipaddress.ip_address(entry[4][0].split('%')[0]) for entry in addresses]
        if not resolved or any(not address.is_global or address.is_multicast or address.is_reserved for address in resolved):
            fail('destination_forbidden')
    except DispatchError: raise
    except (ValueError, OSError): fail('destination_forbidden')


def safe_directory(path):
    path = Path(path)
    if not path.is_absolute() or path.resolve() != path: fail('runtime_not_ready')
    info = path.stat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
        fail('runtime_not_ready')
    return path


def verify_runtime(profile_path, proc_root=Path('/proc')):
    """Prove the loopback listening inode belongs to this exact profile's browser."""
    if os.getuid() == 0: fail('runtime_not_ready')
    candidates = []
    for entry in proc_root.iterdir():
        if not entry.name.isdigit(): continue
        try:
            if entry.stat().st_uid != os.getuid(): continue
            args = (entry / 'cmdline').read_bytes().split(b'\0')
            decoded = [arg.decode('utf-8', errors='strict') for arg in args if arg]
            binary = Path(os.readlink(entry / 'exe')).name
            if binary not in ('chromium', 'chromium-browser', 'chrome', 'google-chrome'): continue
            if any(arg.startswith('--type=') for arg in decoded): continue
            if decoded.count('--user-data-dir=' + profile_path) != 1: continue
            if '--remote-debugging-address=127.0.0.1' not in decoded or '--remote-debugging-port=9222' not in decoded: continue
            if any(arg == '--no-sandbox' or arg.startswith('--remote-allow-origins=') for arg in decoded): continue
            candidates.append(entry)
        except (OSError, UnicodeError): continue
    if len(candidates) != 1: fail('runtime_not_ready')
    try:
        sockets = set()
        for line in (proc_root / 'net/tcp').read_text().splitlines()[1:]:
            row = line.split()
            if len(row) > 9 and row[1] == '0100007F:2406' and row[3] == '0A': sockets.add(row[9])
        owned = {os.readlink(fd) for fd in (candidates[0] / 'fd').iterdir()}
        if len(sockets) != 1 or not any('socket:[' + inode + ']' in owned for inode in sockets):
            fail('runtime_not_ready')
    except OSError: fail('runtime_not_ready')
    return int(candidates[0].name)


class Receipt:
    def __init__(self, base): self.base, self.fd = Path(base), None
    def __enter__(self):
        safe_directory(self.base)
        self.fd = os.open(self.base / 'mission.lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        info = os.fstat(self.fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
            os.close(self.fd)
            fail('receipt_unavailable')
        try: fcntl.flock(self.fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            os.close(self.fd)
            fail('mission_busy')
        return self
    def __exit__(self, *_): os.close(self.fd)
    def read(self):
        try:
            fd = os.open(self.base / 'mission.json', os.O_RDONLY | os.O_NOFOLLOW)
        except FileNotFoundError: return None
        except OSError: fail('receipt_unavailable')
        try:
            info = os.fstat(fd)
            if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077 or info.st_size > 65536:
                fail('receipt_unavailable')
            with os.fdopen(fd, 'r') as stream:
                fd = None
                value = json.load(stream)
            fields(value, ('sessionId', 'selected', 'owned', 'uncertain'), ('principalHash',))
            if not isinstance(value['sessionId'], str) or not UUID.fullmatch(value['sessionId']): fail('receipt_unavailable')
            if value['selected'] is not None and not (isinstance(value['selected'], str) and TARGET.fullmatch(value['selected'])): fail('receipt_unavailable')
            if not isinstance(value['owned'], list) or len(value['owned']) > 100 or any(not isinstance(v, str) or not TARGET.fullmatch(v) for v in value['owned']): fail('receipt_unavailable')
            if type(value['uncertain']) is not bool: fail('receipt_unavailable')
            return value
        except (ValueError, OSError): fail('receipt_unavailable')
        finally:
            if fd is not None: os.close(fd)
    def write(self, value):
        fd, temporary = tempfile.mkstemp(prefix='.mission-', dir=self.base)
        try:
            with os.fdopen(fd, 'w') as stream:
                json.dump(value, stream, separators=(',', ':'))
                stream.flush()
                os.fsync(stream.fileno())
            # Never follow an existing receipt symlink, even though replace itself is safe.
            if (self.base / 'mission.json').is_symlink(): fail('receipt_unavailable')
            os.replace(temporary, self.base / 'mission.json')
            directory = os.open(self.base, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
            try: os.fsync(directory)
            finally: os.close(directory)
        finally:
            try: os.unlink(temporary)
            except FileNotFoundError: pass
    def require(self, session_id, principal=None):
        value = self.read()
        if not value or value['sessionId'] != session_id or value.get('principalHash') != principal:
            fail('mission_not_owned')
        return value
    def release(self):
        os.unlink(self.base / 'mission.json')
        directory = os.open(self.base, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try: os.fsync(directory)
        finally: os.close(directory)


class Cdp:
    """Dependency-free RFC6455 client restricted to the verified loopback browser."""
    def __init__(self, deadline):
        self.deadline, self.identifier, self.sock, self.buffer = deadline, 0, None, b''
        connection = http.client.HTTPConnection('127.0.0.1', 9222, timeout=self.remaining())
        try:
            connection.request('GET', '/json/version')
            response = connection.getresponse()
            if response.status != 200: fail('runtime_not_ready')
            raw = response.read(65537)
            if len(raw) > 65536: fail('provider_protocol_error')
            version = json.loads(raw)
        finally: connection.close()
        url = urlsplit(version.get('webSocketDebuggerUrl', ''))
        if url.scheme != 'ws' or url.hostname not in ('127.0.0.1', 'localhost') or url.port != 9222 or not re.fullmatch(r'/devtools/browser/[A-Za-z0-9-]+', url.path) or url.query or url.fragment or url.username:
            fail('provider_protocol_error')
        self.sock = socket.create_connection(('127.0.0.1', 9222), timeout=self.remaining())
        nonce = base64.b64encode(os.urandom(16)).decode()
        request = ('GET ' + url.path + ' HTTP/1.1\r\nHost: 127.0.0.1:9222\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ' + nonce + '\r\nSec-WebSocket-Version: 13\r\n\r\n').encode()
        self.sock.sendall(request)
        while b'\r\n\r\n' not in self.buffer:
            self.buffer += self.sock.recv(4096)
            if len(self.buffer) > 16384: fail('provider_protocol_error')
            if not self.buffer: fail('provider_protocol_error')
        header, self.buffer = self.buffer.split(b'\r\n\r\n', 1)
        lines = header.decode('ascii').split('\r\n')
        headers = {line.split(':', 1)[0].lower(): line.split(':', 1)[1].strip() for line in lines[1:] if ':' in line}
        expected = base64.b64encode(hashlib.sha1((nonce + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').encode()).digest()).decode()
        if not lines[0].startswith('HTTP/1.1 101 ') or headers.get('sec-websocket-accept') != expected or headers.get('upgrade', '').lower() != 'websocket':
            fail('provider_protocol_error')
    def remaining(self):
        remaining = self.deadline - time.monotonic()
        if remaining <= 0: fail('provider_timeout')
        if self.sock: self.sock.settimeout(remaining)
        return remaining
    def read(self, count):
        while len(self.buffer) < count:
            self.remaining()
            data = self.sock.recv(min(65536, count - len(self.buffer)))
            if not data: fail('provider_connection_lost')
            self.buffer += data
        value, self.buffer = self.buffer[:count], self.buffer[count:]
        return value
    def send(self, opcode, value):
        self.remaining()
        mask = os.urandom(4)
        length = len(value)
        header = bytes([0x80 | opcode, 0x80 | (length if length < 126 else 126 if length < 65536 else 127)])
        if length >= 126: header += struct.pack('!H' if length < 65536 else '!Q', length)
        self.sock.sendall(header + mask + bytes(c ^ mask[i % 4] for i, c in enumerate(value)))
    def message(self, maximum=MAX_FRAME):
        result, active = b'', False
        while True:
            head = self.read(2)
            final, opcode, length = bool(head[0] & 0x80), head[0] & 15, head[1] & 127
            if head[0] & 0x70 or head[1] & 0x80: fail('provider_protocol_error')
            if length == 126: length = struct.unpack('!H', self.read(2))[0]
            elif length == 127: length = struct.unpack('!Q', self.read(8))[0]
            if length > maximum or len(result) + length > maximum: fail('provider_response_too_large')
            value = self.read(length)
            if opcode == 8: fail('provider_connection_lost')
            if opcode == 9:
                self.send(10, value)
                continue
            if opcode == 10: continue
            if opcode == 1 and not active: active = True
            elif opcode != 0 or not active: fail('provider_protocol_error')
            result += value
            if final: return json.loads(result)
    def command(self, method, params=None, session=None):
        self.identifier += 1
        payload = {'id': self.identifier, 'method': method, 'params': params or {}}
        if session: payload['sessionId'] = session
        self.send(1, json.dumps(payload, separators=(',', ':')).encode())
        while True:
            # A 4MiB PNG is base64 encoded in CDP. Ordinary observations retain
            # their original bound; no caller-supplied method reaches this API.
            message = self.message(6 * 1024 * 1024 if method in ('Page.captureScreenshot', 'Page.printToPDF') else MAX_FRAME)
            if message.get('id') != self.identifier: continue
            if 'error' in message: fail('provider_action_failed')
            if not isinstance(message.get('result'), dict): fail('provider_protocol_error')
            return message['result']
    def close(self):
        if self.sock: self.sock.close()


def current_url(cdp, session):
    result = cdp.command('Page.getFrameTree', {}, session)
    tree = result.get('frameTree', {})
    url = tree.get('frame', {}).get('url')
    pending, count = [tree], 0
    while pending:
        frame = pending.pop()
        count += 1
        if count > 256: fail('provider_response_too_large')
        allow_url(frame.get('frame', {}).get('url'), allow_blank=True)
        pending.extend(frame.get('childFrames', []))
    return url


def snapshot(cdp, session, target):
    url = current_url(cdp, session)
    info = cdp.command('Target.getTargetInfo', {'targetId': target}).get('targetInfo', {})
    title = info.get('title', '')
    nodes = cdp.command('Accessibility.getFullAXTree', {}, session).get('nodes', [])
    if not isinstance(nodes, list): fail('provider_protocol_error')
    names = []
    for node in nodes:
        if not isinstance(node, dict): continue
        role = node.get('role', {}).get('value', '')
        properties = node.get('properties', [])
        if role in ('password', 'PasswordText') or any(p.get('name') == 'protected' and p.get('value', {}).get('value') is True for p in properties if isinstance(p, dict)):
            fail('sensitive_output_suppressed')
        if node.get('ignored') or role not in ('StaticText', 'heading', 'link', 'button'): continue
        name = node.get('name', {}).get('value')
        if isinstance(name, str): names.append(name[:2000])
    if url == 'about:blank' and any(name.strip() for name in names):
        fail('destination_forbidden')
    # Guard again before releasing observations; this is not network interception/pinning.
    if current_url(cdp, session) != url: fail('navigation_changed')
    return {'url': url, 'title': title[:512] if isinstance(title, str) else '', 'visibleText': '\n'.join(names)[:12000]}


def selected(cdp, state):
    target = state.get('selected')
    if not target or target not in state['owned']: fail('target_not_owned')
    info = cdp.command('Target.getTargetInfo', {'targetId': target}).get('targetInfo', {})
    if info.get('type') != 'page': fail('target_not_owned')
    allow_url(info.get('url'), allow_blank=True)
    result = cdp.command('Target.attachToTarget', {'targetId': target, 'flatten': True})
    session = result.get('sessionId')
    if not text(session): fail('provider_protocol_error')
    current_url(cdp, session)
    return target, session


def key(cdp, session, name, modifiers=0):
    letter = name[3:] if name.startswith('Key') else None
    value = ' ' if name == 'Space' else (letter if modifiers & 8 else letter.lower()) if letter else name
    params = {'key': value, 'code': name, 'windowsVirtualKeyCode': KEYS[name], 'modifiers': modifiers}
    if not modifiers & 7 and (letter or name in ('Space', 'Enter')): params['text'] = '\r' if name == 'Enter' else value
    try: cdp.command('Input.dispatchKeyEvent', {**params, 'type': 'keyDown'}, session)
    finally: cdp.command('Input.dispatchKeyEvent', {**params, 'type': 'keyUp'}, session)


def find_node(cdp, session, selector):
    cdp.command('DOM.enable', {}, session)
    document = cdp.command('DOM.getDocument', {'depth': 0}, session)
    node = cdp.command('DOM.querySelector', {'nodeId': document['root']['nodeId'], 'selector': selector}, session).get('nodeId')
    if not integer(node, 1, 2 ** 31): fail('selector_not_found')
    return node


def execute(cdp, state, action):
    kind = action['type']
    if kind == 'tab_create':
        allow_url(action['url'])
        if len(state['owned']) >= 100: fail('target_limit')
        target = cdp.command('Target.createTarget', {'url': action['url']}).get('targetId')
        if not isinstance(target, str) or not TARGET.fullmatch(target): fail('target_create_uncertain')
        state['owned'].append(target)
        return {'createdTargetId': target, 'selectedTargetId': state['selected'], 'completed': True}
    if kind in ('tab_select', 'tab_close'):
        target = action['targetId']
        if target not in state['owned']: fail('target_not_owned')
        info = cdp.command('Target.getTargetInfo', {'targetId': target}).get('targetInfo', {})
        allow_url(info.get('url'), allow_blank=True)
        if kind == 'tab_select':
            cdp.command('Target.activateTarget', {'targetId': target})
            state['selected'] = target
        else:
            if cdp.command('Target.closeTarget', {'targetId': target}).get('success') is not True: fail('target_operation_failed')
            state['owned'].remove(target)
            if state['selected'] == target: state['selected'] = None
        return {'selectedTargetId': state['selected'], 'completed': True, **({'closedTargetId': target} if kind == 'tab_close' else {})}
    target, session = selected(cdp, state)
    if kind == 'snapshot': return snapshot(cdp, session, target)
    if kind == 'navigate':
        allow_url(action['url'])
        result = cdp.command('Page.navigate', {'url': action['url']}, session)
        if result.get('errorText'): fail('navigation_failed')
        current_url(cdp, session)
    elif kind in ('navigate_back', 'navigate_forward'):
        history = cdp.command('Page.getNavigationHistory', {}, session)
        entries, index = history.get('entries', []), history.get('currentIndex')
        if not integer(index, 0, len(entries) - 1): fail('navigation_unavailable')
        index += -1 if kind == 'navigate_back' else 1
        if not 0 <= index < len(entries): fail('navigation_unavailable')
        entry = entries[index]
        allow_url(entry.get('url'))
        if not integer(entry.get('id'), 0, 2 ** 31): fail('navigation_unavailable')
        cdp.command('Page.navigateToHistoryEntry', {'entryId': entry['id']}, session)
        current_url(cdp, session)
    elif kind == 'reload':
        cdp.command('Page.reload', {}, session)
        current_url(cdp, session)
    elif kind == 'dialog':
        cdp.command('Page.handleJavaScriptDialog', {k: v for k, v in action.items() if k != 'type'}, session)
    elif kind == 'press_key': key(cdp, session, action['key'], action.get('modifiers', 0))
    elif kind in ('scroll', 'mouse_move'):
        cdp.command('Input.dispatchMouseEvent', {'type': 'mouseWheel' if kind == 'scroll' else 'mouseMoved', **{k: v for k, v in action.items() if k != 'type'}}, session)
    elif kind == 'drag':
        x, y = action['fromX'], action['fromY']
        cdp.command('Input.dispatchMouseEvent', {'type': 'mouseMoved', 'x': x, 'y': y}, session)
        try:
            cdp.command('Input.dispatchMouseEvent', {'type': 'mousePressed', 'button': 'left', 'clickCount': 1, 'x': x, 'y': y}, session)
            steps = action.get('steps', 5)
            for step in range(1, steps + 1):
                x = action['fromX'] + (action['toX'] - action['fromX']) * step / steps
                y = action['fromY'] + (action['toY'] - action['fromY']) * step / steps
                cdp.command('Input.dispatchMouseEvent', {'type': 'mouseMoved', 'buttons': 1, 'x': x, 'y': y}, session)
        finally: cdp.command('Input.dispatchMouseEvent', {'type': 'mouseReleased', 'button': 'left', 'clickCount': 1, 'x': x, 'y': y}, session)
    else:
        while True:
            try:
                node = find_node(cdp, session, action['selector'])
                break
            except DispatchError as error:
                if kind != 'wait_for' or error.code != 'selector_not_found': raise
                cdp.remaining()
                time.sleep(min(0.1, cdp.remaining()))
        if kind == 'wait_for': pass
        elif kind in ('focus', 'type'):
            cdp.command('DOM.focus', {'nodeId': node}, session)
            if kind == 'type': cdp.command('Input.insertText', {'text': action['text']}, session)
        elif kind == 'select':
            described = cdp.command('DOM.describeNode', {'nodeId': node, 'depth': 2}, session).get('node', {})
            if described.get('nodeName') != 'SELECT' or 'multiple' in described.get('attributes', [])[::2]: fail('unsupported_select')
            options = described.get('children', [])
            values, labels = [], []
            for option in options:
                attrs = option.get('attributes', [])
                if option.get('nodeName') != 'OPTION' or 'disabled' in attrs[::2]: fail('unsupported_select')
                attrs = dict(zip(attrs[::2], attrs[1::2]))
                if 'value' not in attrs: fail('unsupported_select')
                values.append(attrs['value'])
                label = ''.join(child.get('nodeValue', '') for child in option.get('children', []) if isinstance(child.get('nodeValue', ''), str)).strip()
                if not label or label in labels: fail('unsupported_select')
                labels.append(label)
            if action['value'] not in values: fail('option_not_found')
            cdp.command('DOM.focus', {'nodeId': node}, session)
            key(cdp, session, 'Home')
            for _ in range(values.index(action['value'])): key(cdp, session, 'ArrowDown')
            backend = described.get('backendNodeId')
            if not integer(backend, 1, 2 ** 31): fail('select_postcondition_failed')
            tree = cdp.command('Accessibility.getPartialAXTree', {'backendNodeId': backend, 'fetchRelatives': False}, session)
            selected_value = [node.get('value', {}).get('value') for node in tree.get('nodes', []) if node.get('backendDOMNodeId') == backend]
            if selected_value != [labels[values.index(action['value'])]]: fail('select_postcondition_failed')
        elif kind == 'click':
            cdp.command('DOM.scrollIntoViewIfNeeded', {'nodeId': node}, session)
            quad = cdp.command('DOM.getBoxModel', {'nodeId': node}, session).get('model', {}).get('content')
            if not isinstance(quad, list) or len(quad) != 8 or any(type(v) not in (int, float) or not math.isfinite(v) for v in quad): fail('selector_not_interactable')
            x, y = sum(quad[::2]) / 4, sum(quad[1::2]) / 4
            for count in range(1, action.get('clickCount', 1) + 1):
                params = {'x': x, 'y': y, 'button': action.get('button', 'left'), 'clickCount': count}
                try: cdp.command('Input.dispatchMouseEvent', {'type': 'mousePressed', **params}, session)
                finally: cdp.command('Input.dispatchMouseEvent', {'type': 'mouseReleased', **params}, session)
    current_url(cdp, session)
    return {'completed': True, 'selectedTargetId': state['selected']}


def control_request(payload, deadline, expected_pid=None):
    """Only the fixed owned local supervisor; no caller-selected socket or operation."""
    module_path = Path(__file__).with_name('checkpoint-control.py')
    if not module_path.is_file() or module_path.is_symlink(): fail('checkpoint_unavailable')
    spec = importlib.util.spec_from_file_location('otc_checkpoint_control', module_path)
    if not spec or not spec.loader: fail('checkpoint_unavailable')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    remaining = min(14000, int((deadline - time.monotonic()) * 1000))
    if remaining < 1: fail('provider_timeout')
    request = {'version': 1, 'op': 'checkpoint' if expected_pid is not None else 'status',
               'profileKey': payload['profileKey'], 'profilePath': payload['profilePath'], 'timeoutMs': remaining}
    if payload.get('runtimeProtocol') == 2: request['runtimeProtocol'] = 2
    if expected_pid is not None:
        request.update(sessionId=payload['sessionId'], principalHash=payload['principalHash'], expectedBrowserPid=expected_pid)
    try:
        return module.request_control(payload['profilePath'], request, deadline)
    except module.ControlError:
        fail('checkpoint_unavailable' if expected_pid is None else 'checkpoint_unknown')


def checkpoint(receipt, state, payload, deadline, old_pid):
    if not integer(old_pid, 1, 2 ** 31): fail('checkpoint_unavailable')
    if not isinstance(payload.get('principalHash'), str): fail('mission_not_owned')
    if state['uncertain']: fail('effect_unknown')
    state['uncertain'] = True
    receipt.write(state)
    result = control_request(payload, deadline, old_pid)
    flags = ('checkpointed', 'gracefulClosed', 'keyringSessionRetained', 'cdpLoopback', 'profileVerified')
    if not isinstance(result, dict) or any(result.get(flag) is not True for flag in flags): fail('checkpoint_unverified')
    for name in ('profileKey', 'profilePath', 'sessionId', 'principalHash'):
        if result.get(name) != payload[name]: fail('checkpoint_unverified')
    after = result.get('browserPidAfter')
    if result.get('browserPidBefore') != old_pid or not integer(after, 1, 2 ** 31) or after == old_pid or not integer(result.get('supervisorPid'), 1, 2 ** 31): fail('checkpoint_unverified')
    if verify_runtime(payload['profilePath']) != after: fail('checkpoint_unverified')
    # Chrome target IDs do not survive restart. Never alias an old ID to a new tab.
    cdp = Cdp(deadline)
    try:
        targets = cdp.command('Target.getTargets').get('targetInfos', [])
        blanks = [target.get('targetId') for target in targets if isinstance(target, dict) and target.get('type') == 'page' and target.get('url') == 'about:blank' and isinstance(target.get('targetId'), str) and TARGET.fullmatch(target['targetId'])]
        target = blanks[0] if blanks else cdp.command('Target.createTarget', {'url': 'about:blank'}).get('targetId')
        if not isinstance(target, str) or not TARGET.fullmatch(target): fail('checkpoint_unverified')
        if not blanks:
            info = cdp.command('Target.getTargetInfo', {'targetId': target}).get('targetInfo', {})
            if info.get('type') != 'page' or info.get('url') != 'about:blank': fail('checkpoint_unverified')
        state['selected'], state['owned'], state['uncertain'] = target, [target], False
        receipt.write(state)
        return {**result, 'tabsReset': True}
    finally: cdp.close()


def perform_action(cdp, state, payload, profile):
    kind = payload['action']['type']
    if kind in ('capture', 'upload'):
        transfers = trusted_transfers()
        target, attached_session = selected(cdp, state)
        before_url = current_url(cdp, attached_session)
        try:
            if kind == 'capture':
                snapshot(cdp, attached_session, target)
                result = transfers.capture_pdf(cdp, attached_session, payload['action']['request']) if payload['action']['request']['type'] == 'pdf' else transfers.capture_png(cdp, attached_session)
            else:
                descriptor = payload['upload']
                node = transfers.file_input(cdp, attached_session, payload['action']['selector'], descriptor)
                if descriptor['phase'] == 'prepare':
                    transfers.prepare_upload_tree(profile.parent, descriptor); result = {'prepared': True}
                else: result = transfers.attach_upload(cdp, attached_session, node, profile.parent, descriptor)
            if current_url(cdp, attached_session) != before_url: fail('navigation_changed')
            return result
        except transfers.TransferError as error: fail(error.code)
    action_result = execute(cdp, state, payload['action'])
    if kind == 'snapshot': return action_result
    if state['selected'] is None: result = {'url': None, 'title': None, 'visibleText': ''}
    else:
        target, attached_session = selected(cdp, state); result = snapshot(cdp, attached_session, target)
    if kind in ('tab_create', 'tab_select', 'tab_close'): result['pageReceipt'] = action_result
    return result


class V2Receipt:
    def __init__(self, receipt, value, mission, operation): self.receipt, self.value, self.mission, self.operation = receipt, value, mission, operation
    def write(self, state):
        self.value['uncertain'] = {'sessionId': state['sessionId'], 'principalHash': state['principalHash'], 'operation': self.operation} if state['uncertain'] else None
        self.receipt.save(self.value)


def dispatch_v2(payload, deadline, profile, browser_pid):
    module = trusted_registry()
    try:
        with module.Registry(profile.parent, deadline - min(0.1, payload['timeoutMs'] / 10000)) as receipt:
            if os.path.lexists(profile.parent / 'mission.json'): fail('mission_busy', True)
            value = receipt.load(); op, session_id, principal = payload['op'], payload['sessionId'], payload['principalHash']
            if value['uncertain'] is not None: fail('effect_unknown')
            if op == 'open':
                if value['human'] is not None: fail('human_active', True)
                if len(value['missions']) >= module.MAX_MISSIONS or any(m['sessionId'] == session_id or m['principalHash'] == principal for m in value['missions']): fail('mission_busy', True)
                mission = {'sessionId': session_id, 'principalHash': principal, 'selected': None, 'owned': [], 'uncertain': True}
                value['missions'].append(mission)
            else: mission = module.require_mission(value, session_id, principal)
            if op in ('checkpoint', 'human_pause') and len(value['missions']) != 1: fail('other_missions_active', True)
            if op in ('execute', 'human_pause') and value['human'] is not None: fail('human_active', True)
            if op in ('human_resume', 'checkpoint', 'release') and value['human'] is not None and value['human'] != {'sessionId': session_id, 'principalHash': principal}: fail('human_active', True)
            if op == 'human_resume' and value['human'] != {'sessionId': session_id, 'principalHash': principal}: fail('human_not_owned')
            if op == 'execute':
                action = payload['action']
                if action['type'] in ('tab_select', 'tab_close') and action['targetId'] not in mission['owned']: fail('target_not_owned')
                if action['type'] == 'tab_create' and (len(mission['owned']) >= module.MAX_TABS or sum(len(m['owned']) for m in value['missions']) >= module.MAX_TOTAL_TABS): fail('target_limit')
                if action['type'] == 'press_key' and action.get('modifiers', 0) & 6 and action['key'] in ('KeyP', 'KeyS', 'KeyF'): fail('daytona_global_shortcut_unsupported')
                if action['type'] == 'press_key' and action.get('modifiers', 0) & 6 and action['key'] in ('KeyC', 'KeyV') and action.get('modifiers') not in (2, 4, 6): fail('daytona_clipboard_modifier_unsupported')
            adapter = V2Receipt(receipt, value, mission, 'action' if op == 'execute' else op)
            if op == 'checkpoint': return checkpoint(adapter, mission, payload, deadline, browser_pid)
            mission['uncertain'] = True
            if op == 'human_pause': value['human'] = {'sessionId': session_id, 'principalHash': principal}
            adapter.write(mission)
            cdp = Cdp(deadline)
            try:
                if op == 'open':
                    cdp.command('Browser.setDownloadBehavior', {'behavior': 'deny'})
                    target = cdp.command('Target.createTarget', {'url': 'about:blank'}).get('targetId')
                    if not isinstance(target, str) or not TARGET.fullmatch(target): fail('target_create_uncertain')
                    mission['selected'], mission['owned'] = target, [target]
                    result = {'ready': True, 'cdpLoopback': True, 'profileVerified': True}
                elif op == 'human_pause':
                    cdp.command('Browser.setDownloadBehavior', {'behavior': 'default'})
                    if mission['selected']: cdp.command('Target.activateTarget', {'targetId': mission['selected']})
                    result = {'paused': True}
                elif op == 'human_resume':
                    cdp.command('Browser.setDownloadBehavior', {'behavior': 'deny'}); value['human'] = None; result = {'resumed': True}
                elif op == 'release':
                    # A sole post-checkpoint mission may own the last page.
                    # Keep a new unowned blank parking tab so closing this
                    # logical mission cannot shut the retained browser down.
                    pages = cdp.command('Target.getTargets').get('targetInfos', [])
                    if not any(page.get('type') == 'page' and page.get('targetId') not in mission['owned'] for page in pages):
                        parked = cdp.command('Target.createTarget', {'url': 'about:blank'}).get('targetId')
                        if not isinstance(parked, str) or not TARGET.fullmatch(parked): fail('target_create_uncertain')
                    for target in mission['owned']:
                        if cdp.command('Target.closeTarget', {'targetId': target}).get('success') is not True: fail('target_operation_failed')
                    value['missions'].remove(mission); value['human'] = None; value['uncertain'] = None
                    receipt.save(value); return {'released': True, 'browserStopped': False}
                else:
                    # Browser-native focus belongs to the action, not the whole
                    # mission. No other dispatcher can input until this ends.
                    if mission['selected']: cdp.command('Target.activateTarget', {'targetId': mission['selected']})
                    action = payload['action']
                    if action['type'] == 'press_key' and action['key'] in ('KeyC', 'KeyV') and action.get('modifiers') in (2, 4, 6):
                        target, attached = selected(cdp, mission)
                        observed = snapshot(cdp, attached, target)  # Private frames and protected/password AX guard.
                        clipboard = trusted_clipboard()
                        try: private = clipboard.handle_clipboard(cdp, attached, action, mission.get('clipboardText', ''))
                        except clipboard.ClipboardError as error: fail(error.code)
                        if not isinstance(private, dict) or private.keys() != {'clipboardText', 'changed'} or type(private['changed']) is not bool or not isinstance(private['clipboardText'], str): fail('clipboard_provider_unavailable')
                        mission['clipboardText'] = private['clipboardText']
                        result = {'url': observed['url'], 'title': observed['title'], 'visibleText': ''}
                    else: result = perform_action(cdp, mission, payload, profile)
                mission['uncertain'] = False; adapter.write(mission); return result
            finally: cdp.close()
    except module.RegistryError as error: fail(error.code, error.before_effect)


def dispatch(payload):
    deadline = time.monotonic() + payload['timeoutMs'] / 1000
    profile = safe_directory(Path(payload['profilePath']))
    safe_directory(profile.parent)
    safe_directory(ROOT)
    browser_pid = verify_runtime(str(profile))  # Before any HTTP, WebSocket, or browser command.
    if payload['op'] == 'probe':
        cdp = Cdp(deadline)
        try: cdp.command('Target.getTargets')
        finally: cdp.close()
        result = {'ready': True, 'cdpLoopback': True, 'profileVerified': True, 'checkpointReady': False}
        try:
            status = control_request(payload, deadline)
            if status.get('checkpointReady') is True and status.get('encryptedKeyringUnlocked') is True and status.get('cdpLoopback') is True and status.get('profileVerified') is True and status.get('profileKey') == payload['profileKey'] and status.get('profilePath') == payload['profilePath'] and status.get('browserPid') == browser_pid and integer(status.get('supervisorPid'), 1, 2 ** 31):
                result.update(checkpointReady=True, profileKey=payload['profileKey'], profilePath=payload['profilePath'], encryptedKeyringUnlocked=True, browserPid=browser_pid, supervisorPid=status['supervisorPid'])
        except DispatchError:
            pass  # Ordinary browser capability is not encrypted warm-checkpoint readiness.
        module = trusted_registry()
        try:
            with module.Registry(profile.parent, deadline) as receipt:
                value = receipt.load()
                ready = not os.path.lexists(profile.parent / 'mission.json') and value['human'] is None and value['uncertain'] is None
                result.update(runtimeProtocol=2, multiMissionReady=ready, profileKey=payload['profileKey'], profilePath=payload['profilePath'])
        except module.RegistryError as error: fail(error.code, error.before_effect)
        return result
    if payload.get('runtimeProtocol') == 2: return dispatch_v2(payload, deadline, profile, browser_pid)
    with Receipt(profile.parent) as receipt:
        module = trusted_registry()
        base_fd = os.open(profile.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            module.read_registry_at(base_fd, os.getuid())
            if os.path.lexists(profile.parent / 'missions-v2.json'): fail('mission_busy')
        except module.RegistryError as error: fail(error.code)
        finally: os.close(base_fd)
        op, session_id, principal = payload['op'], payload['sessionId'], payload.get('principalHash')
        if op == 'release':
            receipt.require(session_id, principal)
            receipt.release()
            return {'released': True, 'browserStopped': False}
        if op == 'checkpoint':
            state = receipt.require(session_id, principal)
            return checkpoint(receipt, state, payload, deadline, browser_pid)
        state = receipt.read()
        if op == 'open' and state: fail('mission_busy')
        if op == 'execute':
            state = receipt.require(session_id, principal)
            if state['uncertain']: fail('effect_unknown')
        cdp = Cdp(deadline)
        try:
            if op == 'open':
                targets = cdp.command('Target.getTargets').get('targetInfos', [])
                pages = [target for target in targets if target.get('type') == 'page' and isinstance(target.get('targetId'), str) and TARGET.fullmatch(target['targetId'])]
                if not pages: fail('runtime_not_ready')
                target = pages[0]
                allow_url(target.get('url'), allow_blank=True)
                state = {'sessionId': session_id, 'selected': target['targetId'], 'owned': [target['targetId']], 'uncertain': False}
                if principal is not None: state['principalHash'] = principal
                receipt.write(state)
                return {'ready': True, 'cdpLoopback': True, 'profileVerified': True}
            state['uncertain'] = True
            receipt.write(state)
            kind = payload['action']['type']
            if kind in ('capture', 'upload'):
                transfers = trusted_transfers()
                target, attached_session = selected(cdp, state)
                before_url = current_url(cdp, attached_session)
                try:
                    if kind == 'capture':
                        snapshot(cdp, attached_session, target)  # Same private-frame/password-output guards.
                        result = transfers.capture_pdf(cdp, attached_session, payload['action']['request']) if payload['action']['request']['type'] == 'pdf' else transfers.capture_png(cdp, attached_session)
                    else:
                        descriptor = payload['upload']
                        node = transfers.file_input(cdp, attached_session, payload['action']['selector'], descriptor)
                        if descriptor['phase'] == 'prepare':
                            transfers.prepare_upload_tree(profile.parent, descriptor)
                            result = {'prepared': True}
                        else: result = transfers.attach_upload(cdp, attached_session, node, profile.parent, descriptor)
                    if current_url(cdp, attached_session) != before_url: fail('navigation_changed')
                except transfers.TransferError as error: fail(error.code)
            else: action_result = execute(cdp, state, payload['action'])
            if kind in ('capture', 'upload'): pass
            elif kind == 'snapshot': result = action_result
            else:
                if state['selected'] is None:
                    result = {'url': None, 'title': None, 'visibleText': ''}
                else:
                    target, attached_session = selected(cdp, state)
                    result = snapshot(cdp, attached_session, target)
                if payload['action']['type'] in ('tab_create', 'tab_select', 'tab_close'):
                    result['pageReceipt'] = action_result
            state['uncertain'] = False
            receipt.write(state)
            return result
        finally: cdp.close()


def unique_object(pairs):
    result = {}
    for name, value in pairs:
        if name in result: fail('invalid_payload')
        result[name] = value
    return result


def run_payload(encoded):
    try:
        if not isinstance(encoded, str) or not re.fullmatch(r'[A-Za-z0-9_-]+={0,2}', encoded) or len(encoded) > 32768: fail('invalid_payload')
        try:
            decoded = base64.b64decode(encoded + '=' * (-len(encoded) % 4), altchars=b'-_', validate=True)
            value = json.loads(decoded, object_pairs_hook=unique_object)
        except (ValueError, UnicodeError): fail('invalid_payload')
        payload = validate_payload(value)
        def timed_out(*_): fail('provider_timeout')
        previous = signal.signal(signal.SIGALRM, timed_out)
        signal.setitimer(signal.ITIMER_REAL, payload['timeoutMs'] / 1000)
        try: result = dispatch(payload)
        finally:
            signal.setitimer(signal.ITIMER_REAL, 0)
            signal.signal(signal.SIGALRM, previous)
        response = {'version': 1, 'ok': True, 'profileKey': payload['profileKey'], 'profilePath': payload['profilePath'], 'result': result}
        if 'sessionId' in payload: response['sessionId'] = payload['sessionId']
        return response
    except DispatchError as error:
        result = {'version': 1, 'ok': False, 'code': error.code}
        if error.before_effect and error.code in ('mission_busy', 'human_active', 'other_missions_active'): result['beforeEffect'] = True
        return result
    except (socket.timeout, TimeoutError): return {'version': 1, 'ok': False, 'code': 'provider_timeout'}
    except Exception:
        return {'version': 1, 'ok': False, 'code': 'provider_operation_failed'}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--payload', required=True)
    args = parser.parse_args()
    result = run_payload(args.payload)
    print(json.dumps(result, separators=(',', ':')))
    return 0 if result['ok'] or result.get('beforeEffect') is True else 1


if __name__ == '__main__':
    sys.exit(main())
