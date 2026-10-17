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
import select
import secrets
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
OBSERVED_HANDLE_PREFIX = 'otc-observed:'
OBSERVED_HANDLE = re.compile(r'otc-observed:[0-9a-f]{32}\Z')
LOCATOR_TAGS = {'button', 'a', 'input', 'textarea', 'select', 'div', 'span'}
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
        selector = payload['action'].get('selector') if isinstance(payload.get('action'), dict) else None
        if isinstance(selector, str) and selector.startswith(OBSERVED_HANDLE_PREFIX):
            if not OBSERVED_HANDLE.fullmatch(selector) or payload.get('runtimeProtocol') != 2 or payload['action']['type'] not in ('click', 'focus', 'type'):
                fail('invalid_action')
        elif isinstance(selector, str) and selector.startswith('otc-observed'):
            fail('invalid_action')
        if payload['action']['type'] == 'upload':
            try:
                trusted_transfers().validate_descriptor(payload.get('upload'))
            except (ImportError, ValueError): fail('invalid_upload_descriptor')
        elif 'upload' in payload: fail('invalid_payload')
    elif 'action' in payload: fail('invalid_payload')
    elif 'upload' in payload: fail('invalid_payload')
    return payload


DESTINATION_REASONS = {'invalid_url', 'scheme_or_credentials', 'port', 'dns_unavailable', 'nonpublic_address'}
DESTINATION_STAGES = {'requested_navigation', 'target_metadata', 'observed_main', 'observed_child'}


def destination_denied(stage, reason):
    if stage == 'populated_blank' and reason == 'blank_has_content':
        fail('destination_forbidden_populated_blank_blank_has_content')
    if stage in DESTINATION_STAGES and reason in DESTINATION_REASONS:
        fail(f'destination_forbidden_{stage}_{reason}')
    fail('destination_forbidden')


def allow_url(url, allow_blank=False, stage='requested_navigation'):
    if allow_blank and url == 'about:blank': return
    if not text(url, 1, 2048): destination_denied(stage, 'invalid_url')
    try:
        parsed = urlsplit(url)
        if not parsed.scheme: destination_denied(stage, 'invalid_url')
        if parsed.scheme not in ('http', 'https') or parsed.username is not None or parsed.password is not None:
            destination_denied(stage, 'scheme_or_credentials')
        if not parsed.hostname: destination_denied(stage, 'invalid_url')
        try: port = parsed.port or (443 if parsed.scheme == 'https' else 80)
        except ValueError: destination_denied(stage, 'port')
        if port not in (80, 443): destination_denied(stage, 'port')
        try: addresses = socket.getaddrinfo(parsed.hostname, port, type=socket.SOCK_STREAM)
        except OSError: destination_denied(stage, 'dns_unavailable')
        if not addresses: destination_denied(stage, 'dns_unavailable')
        try: resolved = [ipaddress.ip_address(entry[4][0].split('%')[0]) for entry in addresses]
        except (ValueError, IndexError, TypeError, AttributeError): destination_denied(stage, 'dns_unavailable')
        if not resolved or any(not address.is_global or address.is_multicast or address.is_reserved for address in resolved):
            destination_denied(stage, 'nonpublic_address')
    except DispatchError: raise
    except ValueError: destination_denied(stage, 'invalid_url')
    except OSError: destination_denied(stage, 'dns_unavailable')


def safe_directory(path):
    path = Path(path)
    if not path.is_absolute() or path.resolve() != path: fail('runtime_not_ready')
    info = path.stat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
        fail('runtime_not_ready')
    return path


def process_arguments(raw):
    decoded = [arg.decode('utf-8', errors='strict') for arg in raw.split(b'\0') if arg]
    if len(decoded) == 1:
        # Chromium's Linux SetProcessTitleFromCommandLine joins argv with literal
        # spaces, without shell quoting. Normalize only that single-field form;
        # ambiguous quoted/escaped/control-whitespace titles remain untrusted.
        title = decoded[0]
        if any(char in title for char in "'\"\\\t\r\n"):
            return []
        decoded = title.split(' ')
        if any(not arg for arg in decoded): return []
    return decoded


def verify_runtime(profile_path, proc_root=Path('/proc')):
    """Prove the loopback listening inode belongs to this exact profile's browser."""
    if os.getuid() == 0: fail('runtime_not_ready')
    candidates = []
    for entry in proc_root.iterdir():
        if not entry.name.isdigit(): continue
        try:
            if entry.stat().st_uid != os.getuid(): continue
            decoded = process_arguments((entry / 'cmdline').read_bytes())
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
        owned = set()
        for fd in (candidates[0] / 'fd').iterdir():
            try: owned.add(os.readlink(fd))
            except FileNotFoundError: continue  # A descriptor may close between readdir and readlink.
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
            if 'error' in message:
                error = message['error']
                # Only these read-side document/context teardown responses may
                # be retried. Never classify an input/navigation command as safe
                # to replay, and never release provider error text.
                if method in ('Page.getFrameTree', 'Accessibility.getFullAXTree', 'Target.getTargetInfo', 'Target.attachToTarget') and isinstance(error, dict) and type(error.get('code')) is int and error['code'] in (-32000, -32001) and error.get('message') in (
                    'Cannot find context with specified id', 'Execution context was destroyed.',
                    'Cannot find default execution context', 'Inspected target navigated or closed',
                    'Session with given id not found.'):
                    fail('provider_context_destroyed')
                fail('provider_action_failed')
            if not isinstance(message.get('result'), dict): fail('provider_protocol_error')
            return message['result']
    def close(self):
        if self.sock: self.sock.close()


def allow_observed_url(url):
    # Only CDP metadata may transiently omit a document URL during navigation.
    # User-supplied URLs still go directly through the unchanged allow_url.
    if url == '': fail('provider_document_pending')
    allow_url(url, allow_blank=True, stage='observed_main')


def current_url(cdp, session):
    result = cdp.command('Page.getFrameTree', {}, session)
    tree = result.get('frameTree', {})
    url = tree.get('frame', {}).get('url')
    pending, count = [tree], 0
    while pending:
        frame = pending.pop()
        count += 1
        if count > 256: fail('provider_response_too_large')
        frame_node = frame.get('frame', {})
        frame_url = frame_node.get('url')
        if frame is tree: allow_observed_url(frame_url)
        else:
            if frame_url == '': fail('provider_document_pending')
            allow_url(frame_url, allow_blank=True, stage='observed_child')
        pending.extend(frame.get('childFrames', []))
    return url


def document_identity(cdp, session):
    tree = cdp.command('Page.getFrameTree', {}, session).get('frameTree', {})
    frame = tree.get('frame', {}) if isinstance(tree, dict) else {}
    frame_id, loader_id = frame.get('id'), frame.get('loaderId')
    if not isinstance(frame_id, str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,256}', frame_id): fail('provider_document_pending')
    if not isinstance(loader_id, str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,256}', loader_id): fail('provider_document_pending')
    document = cdp.command('DOM.getDocument', {'depth': 0}, session).get('root', {})
    backend = document.get('backendNodeId') if isinstance(document, dict) else None
    if not integer(backend, 1, 2 ** 31): fail('provider_protocol_error')
    return frame_id, loader_id, backend


def locator_semantic_hash(role, tag, label, attrs):
    keys = ('id', 'name', 'aria-label', 'aria-disabled', 'title', 'placeholder', 'data-testid', 'type',
            'autocomplete', 'contenteditable', 'href', 'formaction', 'formmethod', 'formtarget',
            'form', 'formnovalidate', 'disabled', 'readonly', 'hidden')
    selected = {key: attrs[key] for key in keys if key in attrs}
    # Full routing attributes participate only in this private digest. Never
    # persist or emit their plaintext; omitting query/fragment data would let
    # a changed destination reuse an old observed handle.
    semantic = {'role': role, 'tag': tag, 'name': label, 'attrs': selected}
    serialized = json.dumps(semantic, sort_keys=True, separators=(',', ':'), ensure_ascii=False)
    return hashlib.sha256(serialized.encode('utf-8')).hexdigest()


def bounded_dom_subtree_backend_ids(node, max_depth=6, max_nodes=256):
    result, pending = set(), [(node, 0)]
    while pending:
        current, depth = pending.pop()
        if not isinstance(current, dict): continue
        backend = current.get('backendNodeId')
        if integer(backend, 1, 2 ** 31): result.add(backend)
        children = current.get('children', [])
        if depth < max_depth and isinstance(children, list):
            for child in children[:max_nodes]: pending.append((child, depth + 1))
        if len(result) + len(pending) > max_nodes: break
    return result


def authentication_node(node):
    """Detect sensitive auth controls from structural AX metadata only."""
    role = node.get('role', {}).get('value', '') if isinstance(node.get('role'), dict) else ''
    if role in ('password', 'PasswordText'):
        return True
    properties = node.get('properties', [])
    for prop in properties if isinstance(properties, list) else []:
        if not isinstance(prop, dict): continue
        name = prop.get('name')
        value = prop.get('value', {}).get('value') if isinstance(prop.get('value'), dict) else None
        if name == 'protected' and value is True:
            return True
        if name in ('autocomplete', 'htmlInputType', 'inputType') and isinstance(value, str):
            if value.strip().lower() in ('password', 'current-password', 'new-password', 'one-time-code'):
                return True
    return False


def editable_node(node):
    role = node.get('role', {}).get('value', '') if isinstance(node.get('role'), dict) else ''
    if isinstance(role, str) and role.lower() in ('textbox', 'text field', 'textfield', 'searchbox', 'combobox', 'password', 'passwordtext'):
        return True
    properties = node.get('properties', [])
    if not isinstance(properties, list): return False
    return any(isinstance(prop, dict) and prop.get('name') in ('editable', 'settable')
               and isinstance(prop.get('value'), dict) and prop['value'].get('value') is True
               for prop in properties)


AUTH_FIELD_SELECTORS = (
    ('password', 'input[type="password" i]', True),
    ('current_password', 'input[autocomplete~="current-password" i]', True),
    ('new_password', 'input[autocomplete~="new-password" i]', True),
    ('one_time_code', 'input[autocomplete~="one-time-code" i]', True),
    ('username', 'input[autocomplete~="username" i]', False),
    ('email', 'input[type="email" i]', False),
    ('text', 'input[type="text" i]', False),
    ('tel', 'input[type="tel" i]', False),
    ('submit', 'form button[type="submit" i], form button:not([type]), form input[type="submit" i]', False),
)


def authentication_fields(cdp, session):
    """Return only counts for fixed structural selectors; never read DOM values or labels."""
    cdp.command('DOM.enable', {}, session)
    document = cdp.command('DOM.getDocument', {'depth': 0}, session)
    root = document.get('root') if isinstance(document, dict) else None
    node_id = root.get('nodeId') if isinstance(root, dict) else None
    if not integer(node_id, 1, 2 ** 31): fail('provider_protocol_error')
    found, auth_detected = [], False
    for kind, selector, sensitive in AUTH_FIELD_SELECTORS:
        result = cdp.command('DOM.querySelectorAll', {'nodeId': node_id, 'selector': selector}, session)
        node_ids = result.get('nodeIds') if isinstance(result, dict) else None
        if not isinstance(node_ids, list) or len(node_ids) > 4096 or any(not integer(item, 1, 2 ** 31) for item in node_ids):
            fail('provider_protocol_error')
        if not node_ids: continue
        auth_detected = auth_detected or sensitive
        found.append({'kind': kind, 'selector': selector, 'count': len(node_ids)})
    return auth_detected, found


def dom_attributes(node):
    attrs = node.get('attributes', []) if isinstance(node, dict) else []
    if not isinstance(attrs, list) or len(attrs) % 2 or len(attrs) > 256: fail('provider_protocol_error')
    return dict(zip(attrs[::2], attrs[1::2]))


def has_visible_box(result):
    quad = result.get('model', {}).get('content') if isinstance(result, dict) else None
    if not isinstance(quad, list) or len(quad) != 8 or any(type(value) not in (int, float) or not math.isfinite(value) for value in quad): return False
    return max(quad[::2]) > min(quad[::2]) and max(quad[1::2]) > min(quad[1::2])


def has_content_quads(result):
    quads = result.get('quads') if isinstance(result, dict) else None
    if not isinstance(quads, list): fail('provider_protocol_error')
    return any(isinstance(q, list) and len(q) == 8 and all(type(v) in (int, float) and math.isfinite(v) for v in q)
               and max(q[::2]) > min(q[::2]) and max(q[1::2]) > min(q[1::2]) for q in quads)


def editable_observations(cdp, session, nodes, mission=None, target=None, browser_epoch=None, identity=None, previous_locators=()):
    """Describe only visible, writable, non-secret controls in the main frame."""
    candidates = [ax for ax in nodes if isinstance(ax, dict) and not ax.get('ignored') and (editable_node(ax) or
                  (isinstance(ax.get('role'), dict) and ax['role'].get('value') in ('button', 'link')))]
    candidates.sort(key=lambda ax: not editable_node(ax))
    if not candidates: return []
    document = cdp.command('DOM.getDocument', {'depth': 0}, session)
    root = document.get('root', {}).get('nodeId')
    if not integer(root, 1, 2 ** 31): fail('provider_protocol_error')
    observed, count, locators = [], 0, []
    seen_backends = set()
    editable_count, action_count = 0, 0
    for ax in candidates:
        if not isinstance(ax, dict) or ax.get('ignored') or authentication_node(ax): continue
        role = ax.get('role', {}).get('value', '') if isinstance(ax.get('role'), dict) else ''
        is_editable = editable_node(ax)
        is_action = role in ('button', 'link')
        if not (is_editable or is_action): continue
        if (is_editable and editable_count >= 10) or (is_action and action_count >= 10): continue
        backend = ax.get('backendDOMNodeId')
        if not integer(backend, 1, 2 ** 31): continue
        if backend in seen_backends: continue
        seen_backends.add(backend)
        count += 1
        if count > 80: break
        described = cdp.command('DOM.describeNode', {'backendNodeId': backend, 'depth': 6}, session).get('node', {})
        tag = described.get('nodeName', '').lower()
        attrs = dom_attributes(described)
        if is_editable and tag not in ('input', 'textarea') and not (attrs.get('contenteditable', '').lower() == 'true' or attrs.get('role') in ('textbox', 'combobox', 'searchbox')): continue
        if is_action and tag not in ('button', 'a', 'input'): continue
        if any(name in attrs for name in ('disabled', 'readonly', 'hidden')): continue
        input_type = attrs.get('type', 'text').lower()
        auto = attrs.get('autocomplete', '').lower()
        if is_editable and (input_type == 'hidden' or auto in ('current-password', 'new-password', 'one-time-code') or auto.endswith(' password')): continue
        pushed = cdp.command('DOM.pushNodesByBackendIdsToFrontend', {'backendNodeIds': [backend]}, session).get('nodeIds', [])
        if not isinstance(pushed, list) or len(pushed) != 1 or not integer(pushed[0], 1, 2 ** 31): continue
        node_id = pushed[0]
        try: model = cdp.command('DOM.getBoxModel', {'nodeId': node_id}, session)
        except DispatchError: continue
        if not has_visible_box(model): continue
        label = ax.get('name', {}).get('value', '') if isinstance(ax.get('name'), dict) else ''
        if not isinstance(label, str): label = ''
        semantic = ' '.join([label, *(attrs.get(k, '') for k in ('id', 'name', 'placeholder', 'aria-label', 'data-testid', 'autocomplete', 'type'))])
        if re.search(r'(?i)(password|passcode|one.?time|otp|token|secret|api[_ -]?key|credential|bearer)', semantic): continue
        def css_string(value):
            return '"' + re.sub(r'[\\"\n\r\f]', lambda m: '\\' + format(ord(m.group(0)), 'x') + ' ', value) + '"'
        selectors = []
        for key in ('id', 'name', 'aria-label', 'placeholder', 'data-testid'):
            value = attrs.get(key)
            if isinstance(value, str) and value and len(value) <= 120:
                candidate = f'[{key}={css_string(value)}]'
                if len(candidate) <= 256: selectors.append(candidate)
        selectors.append(tag)
        selector = None
        for candidate in selectors:
            matches = cdp.command('DOM.querySelectorAll', {'nodeId': root, 'selector': candidate}, session).get('nodeIds', [])
            if isinstance(matches, list) and len(matches) == 1 and matches[0] == node_id:
                selector = candidate
                break
        value = ax.get('value', {}).get('value', '') if is_editable and isinstance(ax.get('value'), dict) else ''
        if not isinstance(value, str): value = ''
        if is_editable and re.search(r'(?i)(sk_(?:live|test)_|xox[baprs]-|gh[pousr]_|bearer\s|eyJ[A-Za-z0-9_-]{10,}\.)', value): continue
        if not selector:
            # Opaque handles currently cover ordinary navigation/action
            # controls only. Keep existing verified CSS editable locators;
            # do not broaden anonymous text-input dispatch semantics.
            if not is_action or tag not in LOCATOR_TAGS:
                observed.append(f"Locator unavailable for {role} label={label[:120]!r}")
                continue
            if (mission is not None and isinstance(target, str) and integer(browser_epoch, 1, 2 ** 31)
                and isinstance(identity, tuple) and len(identity) == 3):
                quad = model.get('model', {}).get('content', [])
                x, y = round(sum(quad[::2]) / 4), round(sum(quad[1::2]) / 4)
                try:
                    hit = cdp.command('DOM.getNodeForLocation', {'x': x, 'y': y, 'includeUserAgentShadowDOM': False}, session)
                except DispatchError as error:
                    if error.code != 'provider_action_failed': raise
                    observed.append(f"Locator unavailable for {role} label={label[:120]!r}")
                    continue
                if (hit.get('frameId') != identity[0]
                    or hit.get('backendNodeId') not in bounded_dom_subtree_backend_ids(described)):
                    observed.append(f"Locator unavailable for {role} label={label[:120]!r}")
                    continue
                semantic_hash = locator_semantic_hash(role, tag, label, attrs)
                if semantic_hash is None:
                    observed.append(f"Locator unavailable for {role} label={label[:120]!r}")
                    continue
                fields = (target, identity[0], identity[1], identity[2], browser_epoch, backend, role, tag, semantic_hash)
                prior = next((item for item in previous_locators if (item.get('target'), item.get('frameId'), item.get('loaderId'),
                              item.get('documentBackendNodeId'), item.get('browserEpoch'), item.get('backendDOMNodeId'),
                              item.get('role'), item.get('tag'), item.get('nameHash')) == fields), None)
                handle = prior['handle'] if prior else OBSERVED_HANDLE_PREFIX + secrets.token_hex(16)
                locators.append({'handle': handle, 'target': target, 'frameId': identity[0], 'loaderId': identity[1],
                                 'documentBackendNodeId': identity[2], 'browserEpoch': browser_epoch,
                                 'backendDOMNodeId': backend, 'role': role, 'tag': tag, 'nameHash': semantic_hash})
                selector = handle
            else:
                observed.append(f"Locator unavailable for {role} label={label[:120]!r}")
                continue
        value_digest = hashlib.sha256(value.encode('utf-8')).hexdigest() if is_editable else ''
        safe_attrs = {key: attrs[key][:20] for key in ('type', 'name', 'placeholder', 'aria-label', 'data-testid') if isinstance(attrs.get(key), str)}
        observed.append(f"{'Editable' if is_editable else 'Action'} {tag} selector={selector!r} label={label[:60]!r} attrs={safe_attrs!r}" + (f" value={value[:80]!r} valueLength={len(value)} valueSha256={value_digest}" if is_editable else ''))
        if is_editable: editable_count += 1
        else: action_count += 1
    if mission is not None: mission['observedLocators'] = locators[:20]
    return observed


def preflight_target(cdp, session, selector):
    """Read-only uniqueness and visibility check before browser interaction."""
    cdp.command('DOM.enable', {}, session)
    document = cdp.command('DOM.getDocument', {'depth': 0}, session)
    root = document.get('root', {}).get('nodeId')
    if not integer(root, 1, 2 ** 31): fail('provider_protocol_error')
    matches = cdp.command('DOM.querySelectorAll', {'nodeId': root, 'selector': selector}, session).get('nodeIds', [])
    if not isinstance(matches, list) or len(matches) != 1 or not integer(matches[0], 1, 2 ** 31): fail('selector_not_found')
    node_id = matches[0]
    described = cdp.command('DOM.describeNode', {'nodeId': node_id, 'depth': 0}, session).get('node', {})
    attrs = dom_attributes(described)
    quads = cdp.command('DOM.getContentQuads', {'nodeId': node_id}, session)
    if not has_content_quads(quads): fail('selector_not_interactable')
    return node_id, described, attrs


def file_input_observations(cdp, session):
    """Report only fixed, read-only native file-control metadata, never its value/path."""
    document = cdp.command('DOM.getDocument', {'depth': 0}, session)
    root = document.get('root', {}).get('nodeId')
    if not integer(root, 1, 2 ** 31): fail('provider_protocol_error')
    result = cdp.command('DOM.querySelectorAll', {'nodeId': root, 'selector': 'input[type="file" i]'}, session)
    nodes = result.get('nodeIds', []) if isinstance(result, dict) else None
    if not isinstance(nodes, list) or len(nodes) > 100 or any(not integer(node, 1, 2 ** 31) for node in nodes): fail('provider_protocol_error')
    output = []
    for node_id in nodes[:10]:
        described = cdp.command('DOM.describeNode', {'nodeId': node_id, 'depth': 0}, session).get('node', {})
        attrs = dom_attributes(described)
        attrs.pop('value', None)
        if 'disabled' in attrs: continue
        if re.search(r'(?i)(password|passcode|one.?time|otp|token|secret|api[_ -]?key|credential|bearer)',
                     ' '.join(str(attrs.get(key, '')) for key in ('id', 'name', 'data-testid', 'accept'))): continue
        selector = None
        for key in ('id', 'name', 'data-testid'):
            value = attrs.get(key)
            if not isinstance(value, str) or not value or len(value) > 120: continue
            escaped = '"' + re.sub(r'[\\"\n\r\f]', lambda match: '\\' + format(ord(match.group(0)), 'x') + ' ', value) + '"'
            candidate = f'input[type="file" i][{key}={escaped}]'
            if len(candidate) > 256: continue
            matches = cdp.command('DOM.querySelectorAll', {'nodeId': root, 'selector': candidate}, session).get('nodeIds', [])
            if isinstance(matches, list) and len(matches) == 1 and matches[0] == node_id:
                selector = candidate; break
        if selector is None:
            candidate = 'input[type="file" i]'
            matches = cdp.command('DOM.querySelectorAll', {'nodeId': root, 'selector': candidate}, session).get('nodeIds', [])
            if isinstance(matches, list) and len(matches) == 1 and matches[0] == node_id:
                selector = candidate
        accept = attrs.get('accept', '')
        accept = accept[:120] if isinstance(accept, str) else ''
        options = {'accept': accept, 'multiple': 'multiple' in attrs,
                   'directory': 'webkitdirectory' in attrs or 'directory' in attrs}
        if selector:
            output.append(f'File input selector={selector!r} options={options!r}')
        else:
            output.append(f'File input locator unavailable options={options!r}')
    return output


def preflight_editable(cdp, session, selector):
    """Require a unique, visible, writable text control."""
    node_id, described, attrs = preflight_target(cdp, session, selector)
    tag = described.get('nodeName', '').lower()
    if tag not in ('input', 'textarea') and attrs.get('contenteditable', '').lower() != 'true': fail('selector_not_interactable')
    if any(name in attrs for name in ('disabled', 'readonly', 'hidden')): fail('selector_not_interactable')
    if attrs.get('type', '').lower() == 'hidden': fail('selector_not_interactable')
    return node_id


def observed_record(state, selector, browser_epoch):
    if not isinstance(selector, str) or not selector.startswith(OBSERVED_HANDLE_PREFIX): return None
    if not OBSERVED_HANDLE.fullmatch(selector): fail('selector_not_found')
    if not isinstance(state, dict) or not integer(browser_epoch, 1, 2 ** 31): fail('selector_not_found')
    for locator in state.get('observedLocators', []):
        if locator.get('handle') == selector and locator.get('target') == state.get('selected') and locator.get('target') in state.get('owned', []) and locator.get('browserEpoch') == browser_epoch:
            return locator
    fail('selector_not_found')


def preflight_observed(cdp, session, state, selector, browser_epoch, require_editable=False):
    locator = observed_record(state, selector, browser_epoch)
    if locator is None: return None
    cdp.command('DOM.enable', {}, session)
    if document_identity(cdp, session) != (locator['frameId'], locator['loaderId'], locator['documentBackendNodeId']): fail('selector_not_found')
    pushed = cdp.command('DOM.pushNodesByBackendIdsToFrontend', {'backendNodeIds': [locator['backendDOMNodeId']]}, session).get('nodeIds', [])
    if not isinstance(pushed, list) or len(pushed) != 1 or not integer(pushed[0], 1, 2 ** 31): fail('selector_not_found')
    node_id = pushed[0]
    described = cdp.command('DOM.describeNode', {'nodeId': node_id, 'depth': 6}, session).get('node', {})
    attrs = dom_attributes(described)
    tag = described.get('nodeName', '').lower()
    if tag != locator['tag'] or described.get('backendNodeId') != locator['backendDOMNodeId']: fail('selector_not_found')
    if any(name in attrs for name in ('disabled', 'hidden')): fail('selector_not_interactable')
    if require_editable and (tag not in ('input', 'textarea') and attrs.get('contenteditable', '').lower() != 'true' or 'readonly' in attrs or attrs.get('type', '').lower() == 'hidden'):
        fail('selector_not_interactable')
    quads = cdp.command('DOM.getContentQuads', {'nodeId': node_id}, session)
    if not has_content_quads(quads): fail('selector_not_interactable')
    quad = next(q for q in quads['quads'] if isinstance(q, list) and len(q) == 8 and all(type(v) in (int, float) and math.isfinite(v) for v in q)
                and max(q[::2]) > min(q[::2]) and max(q[1::2]) > min(q[1::2]))
    x, y = round(sum(quad[::2]) / 4), round(sum(quad[1::2]) / 4)
    hit = cdp.command('DOM.getNodeForLocation', {'x': x, 'y': y, 'includeUserAgentShadowDOM': False}, session)
    if (hit.get('frameId') != locator['frameId']
        or hit.get('backendNodeId') not in bounded_dom_subtree_backend_ids(described)):
        fail('selector_not_interactable')
    tree = cdp.command('Accessibility.getPartialAXTree', {'backendNodeId': locator['backendDOMNodeId'], 'fetchRelatives': False}, session)
    nodes = tree.get('nodes', []) if isinstance(tree, dict) else []
    matches = [node for node in nodes if isinstance(node, dict) and node.get('backendDOMNodeId') == locator['backendDOMNodeId']]
    if len(matches) != 1: fail('selector_not_found')
    node = matches[0]
    role = node.get('role', {}).get('value', '') if isinstance(node.get('role'), dict) else ''
    name = node.get('name', {}).get('value', '') if isinstance(node.get('name'), dict) else ''
    if (node.get('ignored') or role != locator['role'] or not isinstance(name, str)
        or locator_semantic_hash(role, tag, name, attrs) != locator['nameHash']): fail('selector_not_found')
    return node_id, described, attrs


def preflight_selector(cdp, session, state, selector, browser_epoch, require_editable=False):
    if isinstance(selector, str) and selector.startswith(OBSERVED_HANDLE_PREFIX):
        return preflight_observed(cdp, session, state, selector, browser_epoch, require_editable)
    if require_editable: return preflight_editable(cdp, session, selector), None, None
    return preflight_target(cdp, session, selector)


def snapshot(cdp, session, target, reject_auth=False, mission=None, browser_epoch=None):
    previous_locators = mission.get('observedLocators', []) if mission is not None else []
    if mission is not None: mission['observedLocators'] = []
    url = current_url(cdp, session)
    identity = document_identity(cdp, session) if mission is not None else None
    nodes = cdp.command('Accessibility.getFullAXTree', {}, session).get('nodes', [])
    if not isinstance(nodes, list): fail('provider_protocol_error')
    # Catch navigation that races the accessibility read before any blank-page guard.
    if current_url(cdp, session) != url: fail('navigation_changed')
    ax_auth = any(isinstance(node, dict) and authentication_node(node) for node in nodes)
    has_editable = any(isinstance(node, dict) and editable_node(node) for node in nodes)
    dom_auth, input_fields = authentication_fields(cdp, session) if (ax_auth or has_editable) else (False, [])
    auth_detected = ax_auth or dom_auth
    if auth_detected and reject_auth: fail('sensitive_output_suppressed')
    if auth_detected:
        if current_url(cdp, session) != url: fail('navigation_changed')
        parts = urlsplit(url)
        origin = f'{parts.scheme}://{parts.netloc}' if parts.scheme in ('http', 'https') and parts.netloc else ''
        structure = '\n'.join(f"{field['kind']} ({field['count']}): {field['selector']}" for field in input_fields)
        if any(field['count'] > 1 for field in input_fields):
            structure += ('\n' if structure else '') + 'Multiple matching fields or submit controls; selector disambiguation required.'
        visible = 'Authentication required.' + (('\n' + structure) if structure else '')
        return {'url': origin, 'title': '', 'visibleText': visible,
                'authenticationRequired': True}
    info = cdp.command('Target.getTargetInfo', {'targetId': target}).get('targetInfo', {})
    title = info.get('title', '')
    names = []
    for node in nodes:
        if not isinstance(node, dict): continue
        role = node.get('role', {}).get('value', '')
        properties = node.get('properties', [])
        if node.get('ignored') or role not in ('StaticText', 'heading', 'link', 'button'): continue
        name = node.get('name', {}).get('value')
        if isinstance(name, str): names.append(name[:2000])
    editable = editable_observations(cdp, session, nodes, mission, target, browser_epoch, identity, previous_locators)
    file_inputs = file_input_observations(cdp, session) if mission is not None else []
    # Guard again after all DOM/AX metadata reads, before releasing observations.
    if current_url(cdp, session) != url: fail('navigation_changed')
    # Keep complete locator lines (never a truncated opaque handle), then file
    # controls and text within the historical output bound.
    lines, used = [], 0
    for line in editable:
        if len(line) > 600: continue
        if used + len(line) + bool(lines) > 10000: break
        lines.append(line); used += len(line) + bool(lines)
    for line in file_inputs:
        if len(line) > 500 or used + len(line) + bool(lines) > 10500: continue
        lines.append(line); used += len(line) + bool(lines)
    for line in names:
        line = line[:2000]
        if used + len(line) + bool(lines) > 12000: break
        lines.append(line); used += len(line) + bool(lines)
    if mission is not None:
        emitted = '\n'.join(lines)
        mission['observedLocators'] = [item for item in mission.get('observedLocators', []) if item['handle'] in emitted]
        if mission['observedLocators']:
            instruction = 'Observed handles are mission and document bound; use the exact selector from the latest snapshot.'
            if len(instruction) + 1 + len(emitted) <= 12000: lines.insert(0, instruction)
    visible = '\n'.join(lines)
    if url == 'about:blank' and (visible.strip() or has_editable): destination_denied('populated_blank', 'blank_has_content')
    return {'url': url, 'title': title[:512] if isinstance(title, str) else '', 'visibleText': visible}


def selected(cdp, state):
    target = state.get('selected')
    if not target or target not in state['owned']: fail('target_not_owned')
    info = cdp.command('Target.getTargetInfo', {'targetId': target}).get('targetInfo', {})
    if info.get('type') != 'page': fail('target_not_owned')
    if info.get('url') == '': fail('provider_document_pending')
    allow_url(info.get('url'), allow_blank=True, stage='target_metadata')
    result = cdp.command('Target.attachToTarget', {'targetId': target, 'flatten': True})
    session = result.get('sessionId')
    if not text(session): fail('provider_protocol_error')
    current_url(cdp, session)
    return target, session


def post_action_snapshot(cdp, state, navigation=False, browser_epoch=None, v2=False):
    """Retry observations only after an acknowledged action, never the action."""
    deadline = min(cdp.deadline, time.monotonic() + 2) if navigation else None
    while True:
        try:
            target, session = selected(cdp, state)
            return snapshot(cdp, session, target, mission=state if v2 else None, browser_epoch=browser_epoch)
        except DispatchError as error:
            if not navigation or error.code not in ('provider_context_destroyed', 'navigation_changed', 'provider_document_pending'): raise
            remaining = min(cdp.remaining(), deadline - time.monotonic())
            if remaining <= 0: raise
            time.sleep(min(0.05, remaining))


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
    nodes = cdp.command('DOM.querySelectorAll', {'nodeId': document['root']['nodeId'], 'selector': selector}, session).get('nodeIds')
    if not isinstance(nodes, list) or any(not integer(node, 1, 2 ** 31) for node in nodes): fail('selector_not_found')
    if len(nodes) > 1: fail('selector_not_interactable')
    node = nodes[0] if nodes else None
    if not integer(node, 1, 2 ** 31): fail('selector_not_found')
    return node


def execute(cdp, state, action, browser_epoch=None, v2=False):
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
        allow_url(info.get('url'), allow_blank=True, stage='target_metadata')
        if kind == 'tab_select':
            cdp.command('Target.activateTarget', {'targetId': target})
            state['selected'] = target
            state.pop('observedLocators', None)
        else:
            if cdp.command('Target.closeTarget', {'targetId': target}).get('success') is not True: fail('target_operation_failed')
            state['owned'].remove(target)
            if state['selected'] == target:
                state['selected'] = None
                state.pop('observedLocators', None)
            elif isinstance(state.get('observedLocators'), list):
                state['observedLocators'] = [item for item in state['observedLocators'] if item.get('target') != target]
        return {'selectedTargetId': state['selected'], 'completed': True, **({'closedTargetId': target} if kind == 'tab_close' else {})}
    target, session = selected(cdp, state)
    if kind == 'snapshot': return snapshot(cdp, session, target, mission=state if v2 else None, browser_epoch=browser_epoch)
    if kind == 'navigate':
        allow_url(action['url'])
        result = cdp.command('Page.navigate', {'url': action['url']}, session)
        if result.get('errorText'): fail('navigation_failed')
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
                handle = isinstance(action.get('selector'), str) and action['selector'].startswith(OBSERVED_HANDLE_PREFIX)
                if handle:
                    resolved = preflight_observed(cdp, session, state, action['selector'], browser_epoch,
                                                  require_editable=kind == 'type')
                    node = resolved[0] if resolved else None
                else:
                    node = find_node(cdp, session, action['selector'])
                break
            except DispatchError as error:
                if kind != 'wait_for' or error.code != 'selector_not_found': raise
                cdp.remaining()
                time.sleep(min(0.1, cdp.remaining()))
        if kind == 'wait_for': pass
        elif kind in ('focus', 'type'):
            if not handle:
                node = preflight_editable(cdp, session, action['selector']) if kind == 'type' else preflight_target(cdp, session, action['selector'])[0]
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
            if handle:
                locator = observed_record(state, action['selector'], browser_epoch)
                fresh = preflight_observed(cdp, session, state, action['selector'], browser_epoch)
                if not locator or not fresh or fresh[1].get('backendNodeId') != locator['backendDOMNodeId']:
                    fail('selector_not_interactable')
                node = fresh[0]
            quad = cdp.command('DOM.getBoxModel', {'nodeId': node}, session).get('model', {}).get('content')
            if not isinstance(quad, list) or len(quad) != 8 or any(type(v) not in (int, float) or not math.isfinite(v) for v in quad): fail('selector_not_interactable')
            x, y = sum(quad[::2]) / 4, sum(quad[1::2]) / 4
            if handle:
                x, y = round(x), round(y)
                hit = cdp.command('DOM.getNodeForLocation', {'x': x, 'y': y, 'includeUserAgentShadowDOM': False}, session)
                if hit.get('frameId') != locator['frameId'] or hit.get('backendNodeId') not in bounded_dom_subtree_backend_ids(fresh[1]):
                    fail('selector_not_interactable')
            for count in range(1, action.get('clickCount', 1) + 1):
                params = {'x': x, 'y': y, 'button': action.get('button', 'left'), 'clickCount': count}
                try: cdp.command('Input.dispatchMouseEvent', {'type': 'mousePressed', **params}, session)
                finally: cdp.command('Input.dispatchMouseEvent', {'type': 'mouseReleased', **params}, session)
    # Navigation may destroy the attached document after the input ACK. The
    # caller performs guarded read-only reattachment/snapshot, not input replay.
    if kind not in ('navigate', 'click'): current_url(cdp, session)
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
        state.pop('observedLocators', None)
        receipt.write(state)
        return {**result, 'tabsReset': True}
    finally: cdp.close()


def perform_action(cdp, state, payload, profile, browser_epoch=None, v2=False):
    kind = payload['action']['type']
    if kind in ('capture', 'upload'):
        transfers = trusted_transfers()
        target, attached_session = selected(cdp, state)
        before_url = current_url(cdp, attached_session)
        try:
            if kind == 'capture':
                snapshot(cdp, attached_session, target, reject_auth=True)
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
    action_result = execute(cdp, state, payload['action'], browser_epoch, v2)
    if kind == 'snapshot': return action_result
    if state['selected'] is None: result = {'url': None, 'title': None, 'visibleText': ''}
    else:
        result = post_action_snapshot(cdp, state, kind in ('navigate', 'click'), browser_epoch, v2)
    if kind in ('tab_create', 'tab_select', 'tab_close'): result['pageReceipt'] = action_result
    return result


class V2Receipt:
    def __init__(self, receipt, value, mission, operation): self.receipt, self.value, self.mission, self.operation = receipt, value, mission, operation
    def write(self, state):
        self.value['uncertain'] = {'sessionId': state['sessionId'], 'principalHash': state['principalHash'], 'operation': self.operation} if state['uncertain'] else None
        self.receipt.save(self.value)


def target_infos(cdp):
    result = cdp.command('Target.getTargets')
    if not isinstance(result, dict) or not isinstance(result.get('targetInfos'), list): fail('provider_protocol_error')
    pages = result['targetInfos']
    for page in pages:
        if not isinstance(page, dict) or not isinstance(page.get('targetId'), str) or not TARGET.fullmatch(page['targetId']) or not isinstance(page.get('type'), str) or not page['type']:
            fail('provider_protocol_error')
    return pages


def wait_owned_targets_absent(cdp, owned, deadline):
    while True:
        pages = target_infos(cdp)
        if not any(page['targetId'] in owned for page in pages): return
        remaining = deadline - time.monotonic()
        if remaining <= 0: fail('target_operation_failed')
        time.sleep(min(0.05, remaining))


def preserve_retained_browser(cdp, closing):
    pages = target_infos(cdp)
    if not any(page.get('type') == 'page' and page.get('targetId') not in closing for page in pages):
        parked = cdp.command('Target.createTarget', {'url': 'about:blank'}).get('targetId')
        if not isinstance(parked, str) or not TARGET.fullmatch(parked): fail('target_create_uncertain')


def dispatch_v2(payload, deadline, profile, browser_pid):
    module = trusted_registry()
    try:
        with module.Registry(profile.parent, deadline - min(0.1, payload['timeoutMs'] / 10000)) as receipt:
            if os.path.lexists(profile.parent / 'mission.json'): fail('mission_busy', True)
            value = receipt.load(); op, session_id, principal = payload['op'], payload['sessionId'], payload['principalHash']
            if value['uncertain'] is not None:
                uncertain = value['uncertain']
                if op != 'release' or uncertain['sessionId'] != session_id or uncertain['principalHash'] != principal:
                    fail('effect_unknown')
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
            if op == 'human_pause': value['human'] = {'sessionId': session_id, 'principalHash': principal}
            cdp = Cdp(deadline)
            try:
                # A safe locator rejection must precede even tab activation and
                # the uncertain receipt write so V2 can acknowledge zero input effects.
                if op == 'execute' and payload['action']['type'] in ('focus', 'type', 'click'):
                    try:
                        target, attached = selected(cdp, mission)
                        action = payload['action']
                        preflight_selector(cdp, attached, mission, action['selector'], browser_pid,
                                           require_editable=action['type'] == 'type')
                    except DispatchError as error:
                        if error.code in ('selector_not_found', 'selector_not_interactable'):
                            error.before_effect = True
                        raise
                mission['uncertain'] = True
                adapter.write(mission)
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
                    preserve_retained_browser(cdp, mission['owned'])
                    pages = target_infos(cdp)
                    live_targets = {page['targetId'] for page in pages if page['type'] == 'page'}
                    for target in mission['owned']:
                        if target in live_targets and cdp.command('Target.closeTarget', {'targetId': target}).get('success') is not True: fail('target_operation_failed')
                    wait_owned_targets_absent(cdp, mission['owned'], deadline)
                    value['missions'].remove(mission); value['human'] = None; value['uncertain'] = None
                    receipt.save(value); return {'released': True, 'browserStopped': False}
                else:
                    # Browser-native focus belongs to the action, not the whole
                    # mission. No other dispatcher can input until this ends.
                    if mission['selected']: cdp.command('Target.activateTarget', {'targetId': mission['selected']})
                    action = payload['action']
                    if action['type'] == 'tab_close': preserve_retained_browser(cdp, [action['targetId']])
                    if action['type'] == 'press_key' and action['key'] in ('KeyC', 'KeyV') and action.get('modifiers') in (2, 4, 6):
                        target, attached = selected(cdp, mission)
                        observed = snapshot(cdp, attached, target, reject_auth=True)  # Private frames and protected/auth AX guard.
                        clipboard = trusted_clipboard()
                        try: private = clipboard.handle_clipboard(cdp, attached, action, mission.get('clipboardText', ''))
                        except clipboard.ClipboardError as error: fail(error.code)
                        if not isinstance(private, dict) or private.keys() != {'clipboardText', 'changed'} or type(private['changed']) is not bool or not isinstance(private['clipboardText'], str): fail('clipboard_provider_unavailable')
                        mission['clipboardText'] = private['clipboardText']
                        result = {'url': observed['url'], 'title': observed['title'], 'visibleText': ''}
                    else: result = perform_action(cdp, mission, payload, profile, browser_pid, True)
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
                allow_url(target.get('url'), allow_blank=True, stage='target_metadata')
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
                        snapshot(cdp, attached_session, target, reject_auth=True)  # Same private-frame/password-output guards.
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
                    result = post_action_snapshot(cdp, state, kind in ('navigate', 'click'))
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


def decode_public_input(encoded):
    if not isinstance(encoded, str) or not re.fullmatch(r'[A-Za-z0-9_-]+={0,2}', encoded) or len(encoded) > 32768:
        fail('invalid_private_input')
    try:
        decoded = base64.b64decode(encoded + '=' * (-len(encoded) % 4), altchars=b'-_', validate=True)
        value = json.loads(decoded, object_pairs_hook=unique_object)
    except (ValueError, UnicodeError):
        fail('invalid_private_input')
    expected = {'version', 'op', 'profileKey', 'profilePath', 'timeoutMs',
                'sessionId', 'principalHash', 'runtimeProtocol', 'actionType'}
    if not isinstance(value, dict) or value.keys() != expected:
        fail('invalid_private_input')
    action_type = value.get('actionType')
    if action_type not in ('type', 'select', 'dialog'):
        fail('invalid_private_input')
    payload = {key: item for key, item in value.items() if key != 'actionType'}
    placeholder = {'type': action_type}
    if action_type == 'type': placeholder.update(selector='#private-input', text='x')
    elif action_type == 'select': placeholder.update(selector='#private-input', value='x')
    else: placeholder.update(accept=False)
    try:
        validate_payload({**payload, 'action': placeholder})
    except DispatchError:
        fail('invalid_private_input')
    return value, action_type


def private_owner_preflight(payload, deadline):
    """Read-only, exact-owner check before allowing a caller to send private input."""
    profile = safe_directory(Path(payload['profilePath']))
    safe_directory(profile.parent)
    safe_directory(ROOT)
    module = trusted_registry()
    with module.Registry(profile.parent, deadline) as receipt:
        value = receipt.load()
        module.require_automation(value, payload['sessionId'], payload['principalHash'])
    return True


def read_private_input_line(fd, deadline):
    data = bytearray()
    while b'\n' not in data:
        remaining = deadline - time.monotonic()
        if remaining <= 0: fail('provider_timeout')
        if not select.select([fd], [], [], remaining)[0]: fail('provider_timeout')
        chunk = os.read(fd, min(4096, 8193 - len(data)))
        if not chunk: fail('invalid_private_input')
        data.extend(chunk)
        if len(data) > 8192: fail('invalid_private_input')
    if data[-1] != 0x0a or data.count(b'\n') != 1:
        fail('invalid_private_input')
    # Inspect only already-readable bytes; interactive session stdin may stay open.
    if select.select([fd], [], [], 0)[0]:
        try: trailing = os.read(fd, 8193)
        except BlockingIOError: trailing = b''
        if trailing: fail('invalid_private_input')
    return bytes(data[:-1])


def private_input_response(encoded, nonce, input_fd, ready_stream):
    """Receive one TLS-forwarded action privately, dispatch only after exact validation."""
    started = time.monotonic()
    if not isinstance(nonce, str) or not re.fullmatch(r'[0-9a-f]{32}', nonce):
        return {'version': 1, 'ok': False, 'code': 'invalid_private_input'}
    try:
        metadata, action_type = decode_public_input(encoded)
        deadline = started + metadata['timeoutMs'] / 1000
        if time.monotonic() >= deadline:
            return {'version': 1, 'ok': False, 'code': 'provider_timeout', 'beforeEffect': True}
        public_payload = {key: value for key, value in metadata.items() if key != 'actionType'}
        if private_owner_preflight(public_payload, deadline) is not True:
            fail('private_input_rejected')
    except DispatchError:
        if 'deadline' in locals() and time.monotonic() >= deadline:
            return {'version': 1, 'ok': False, 'code': 'provider_timeout', 'beforeEffect': True}
        return {'version': 1, 'ok': False, 'code': 'private_input_rejected'}
    except Exception:
        # Ownership failures and malformed public metadata share one non-oracular response.
        return {'version': 1, 'ok': False, 'code': 'private_input_rejected'}
    remaining_ms = int((deadline - time.monotonic()) * 1000)
    if remaining_ms <= 0:
        return {'version': 1, 'ok': False, 'code': 'provider_timeout', 'beforeEffect': True}

    ready = {'version': 1, 'event': 'input_ready', 'nonce': nonce,
             'sessionId': metadata['sessionId'], 'profileKey': metadata['profileKey'],
             'profilePath': metadata['profilePath'], 'principalHash': metadata['principalHash']}
    try:
        ready_stream.write(json.dumps(ready, separators=(',', ':')) + '\n')
        ready_stream.flush()
        line = read_private_input_line(input_fd, deadline)
        try:
            request = json.loads(line, object_pairs_hook=unique_object)
        except (ValueError, UnicodeError):
            fail('invalid_private_input')
        if not isinstance(request, dict) or request.keys() != {'nonce', 'payload'} or request['nonce'] != nonce:
            fail('invalid_private_input')
        payload = request['payload']
        if not isinstance(payload, dict) or not isinstance(payload.get('action'), dict):
            fail('invalid_private_input')
        if payload['action'].get('type') != action_type:
            fail('invalid_private_input')
        projection = {key: value for key, value in payload.items() if key != 'action'}
        projection['actionType'] = action_type
        if projection != metadata:
            fail('invalid_private_input')
        validate_payload(payload)
        if payload['op'] != 'execute' or payload.get('runtimeProtocol') != 2 or action_type not in ('type', 'select', 'dialog'):
            fail('invalid_private_input')
    except DispatchError as error:
        if error.code == 'provider_timeout':
            return {'version': 1, 'ok': False, 'code': 'provider_timeout', 'beforeEffect': True}
        return {'version': 1, 'ok': False, 'code': 'invalid_private_input'}
    except Exception:
        return {'version': 1, 'ok': False, 'code': 'invalid_private_input'}
    remaining_ms = int((deadline - time.monotonic()) * 1000)
    if remaining_ms <= 0:
        return {'version': 1, 'ok': False, 'code': 'provider_timeout', 'beforeEffect': True}
    payload['timeoutMs'] = min(payload['timeoutMs'], remaining_ms)

    # Keep the action result private: post-action observations could reflect the
    # submitted input. Dispatch is authorized again under the mission lock.
    previous_alarm = signal.signal(signal.SIGALRM, lambda *_: fail('provider_timeout'))
    signal.setitimer(signal.ITIMER_REAL, max(0.001, (deadline - time.monotonic())))
    try:
        dispatch(payload)
        response = {'version': 1, 'ok': True, 'profileKey': payload['profileKey'],
                    'profilePath': payload['profilePath'],
                    'result': {'inputProcessed': True, 'actionType': action_type},
                    'sessionId': payload['sessionId']}
        return response
    except DispatchError as error:
        response = {'version': 1, 'ok': False, 'code': error.code}
        if error.before_effect and error.code in ('mission_busy', 'human_active', 'other_missions_active'):
            response['beforeEffect'] = True
        elif error.before_effect and error.code in ('selector_not_found', 'selector_not_interactable'):
            response['beforeEffect'] = True
            response.update(profileKey=payload['profileKey'], sessionId=payload['sessionId'], principalHash=payload['principalHash'])
        return response
    except Exception:
        return {'version': 1, 'ok': False, 'code': 'provider_operation_failed'}
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, previous_alarm)


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
        if error.before_effect and error.code in ('mission_busy', 'human_active', 'other_missions_active'):
            result['beforeEffect'] = True
        elif error.before_effect and error.code in ('selector_not_found', 'selector_not_interactable') and payload.get('runtimeProtocol') == 2:
            result['beforeEffect'] = True
            result.update(profileKey=payload['profileKey'], sessionId=payload['sessionId'], principalHash=payload['principalHash'])
        return result
    except (socket.timeout, TimeoutError): return {'version': 1, 'ok': False, 'code': 'provider_timeout'}
    except Exception:
        return {'version': 1, 'ok': False, 'code': 'provider_operation_failed'}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--payload', required=True)
    parser.add_argument('--private-stdin')
    args = parser.parse_args()
    if args.private_stdin is None:
        result = run_payload(args.payload)
    else:
        result = private_input_response(args.payload, args.private_stdin, sys.stdin.fileno(), sys.stdout)
    print(json.dumps(result, separators=(',', ':')))
    return 0 if result['ok'] or result.get('beforeEffect') is True else 1


if __name__ == '__main__':
    sys.exit(main())
