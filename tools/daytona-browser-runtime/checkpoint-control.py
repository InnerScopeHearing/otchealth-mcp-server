#!/usr/bin/env python3
"""Private, exact-profile warm checkpoint control. No HTTP/provider/shell API."""

import base64
import errno
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import select
import socket
import stat
import struct
import subprocess
import time


STATE_ROOT = Path('/home/otcbrowser/.local/share/otchealth-browser')
PROFILE_KEY = re.compile(r'[a-z0-9][a-z0-9_-]{0,95}\Z')
UUID = re.compile(r'[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\Z')
HASH = re.compile(r'[0-9a-f]{64}\Z')
MAX_MESSAGE = 8192


class ControlError(Exception):
    def __init__(self, code):
        self.code = code
        super().__init__(code)


def fail(code): raise ControlError(code)


def remaining(deadline):
    value = deadline - time.monotonic()
    if value <= 0: fail('checkpoint_timeout')
    return value


def integer(value, minimum=2, maximum=2 ** 31 - 1):
    return type(value) is int and minimum <= value <= maximum


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result: fail('invalid_control_request')
        result[key] = value
    return result


def decode(data):
    try:
        return json.loads(data, object_pairs_hook=unique_object, parse_constant=lambda _: fail('invalid_control_request'))
    except (ValueError, UnicodeError): fail('invalid_control_request')


def private_directory(path):
    path = Path(path)
    try:
        info = path.stat()
        if not path.is_absolute() or path.resolve() != path or not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
            fail('control_unavailable')
    except OSError: fail('control_unavailable')
    return path


def control_socket_path(profile_path):
    profile_path = Path(profile_path)
    key = profile_path.parent.name
    if not PROFILE_KEY.fullmatch(key) or profile_path.name != 'chromium': fail('profile_not_owned')
    digest = base64.urlsafe_b64encode(hashlib.sha256(os.fsencode(profile_path)).digest()).decode().rstrip('=')
    path = profile_path.parent.parent / '.control' / (digest + '.sock')
    if len(os.fsencode(path)) > 107: fail('control_unavailable')
    return path


def validate_request(payload, profile, wire=False):
    required = {'version', 'op', 'profileKey', 'profilePath', 'timeoutMs'}
    if wire: required.add('deadlineMonotonicMs')
    mission_fields = {'sessionId', 'principalHash', 'expectedBrowserPid'}
    optional = mission_fields | {'runtimeProtocol'}
    if not isinstance(payload, dict) or not required <= payload.keys() or not payload.keys() <= required | optional:
        fail('invalid_control_request')
    if type(payload['version']) is not int or payload['version'] != 1 or payload['op'] not in ('status', 'checkpoint'):
        fail('invalid_control_request')
    key = profile['base'].name
    if not PROFILE_KEY.fullmatch(key) or payload['profileKey'] != key or payload['profilePath'] != str(profile['chromium']):
        fail('profile_not_owned')
    if not integer(payload['timeoutMs'], 1, 14000): fail('invalid_control_request')
    if wire and not integer(payload['deadlineMonotonicMs'], 1, 2 ** 63 - 1): fail('invalid_control_request')
    if payload['op'] == 'checkpoint' and not mission_fields <= payload.keys(): fail('invalid_control_request')
    if 'runtimeProtocol' in payload and (type(payload['runtimeProtocol']) is not int or payload['runtimeProtocol'] != 2): fail('invalid_control_request')
    if 'sessionId' in payload and not (isinstance(payload['sessionId'], str) and UUID.fullmatch(payload['sessionId'])):
        fail('invalid_control_request')
    if 'principalHash' in payload and not (isinstance(payload['principalHash'], str) and HASH.fullmatch(payload['principalHash'])):
        fail('invalid_control_request')
    if 'expectedBrowserPid' in payload and not integer(payload['expectedBrowserPid']): fail('invalid_control_request')
    return payload


def read_message(connection, deadline):
    data = b''
    while b'\n' not in data:
        connection.settimeout(remaining(deadline))
        chunk = connection.recv(MAX_MESSAGE + 1 - len(data))
        if not chunk: fail('control_connection_lost')
        data += chunk
        if len(data) > MAX_MESSAGE: fail('control_message_too_large')
    if not data.endswith(b'\n') or data.count(b'\n') != 1: fail('invalid_control_request')
    return decode(data[:-1])


def write_message(connection, value, deadline):
    data = json.dumps(value, separators=(',', ':'), allow_nan=False).encode() + b'\n'
    if len(data) > MAX_MESSAGE: fail('control_message_too_large')
    connection.settimeout(remaining(deadline))
    connection.sendall(data)


def peer_credentials(connection):
    pid, uid, gid = struct.unpack('3i', connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize('3i')))
    if uid != os.getuid() or uid == 0 or not integer(pid): fail('control_peer_forbidden')
    return pid, uid, gid


def validate_result(result, payload, peer_pid):
    common = {'profileKey', 'profilePath', 'supervisorPid', 'cdpLoopback', 'profileVerified'}
    status = {'checkpointReady', 'browserPid', 'encryptedKeyringUnlocked'}
    checkpoint = {'checkpointed', 'gracefulClosed', 'keyringSessionRetained', 'browserPidBefore', 'browserPidAfter', 'sessionId', 'principalHash'}
    expected = common | (status if payload['op'] == 'status' else checkpoint)
    if not isinstance(result, dict) or result.keys() != expected: fail('invalid_control_response')
    if result['supervisorPid'] != peer_pid or not integer(result['supervisorPid']): fail('control_peer_forbidden')
    if result['profileKey'] != payload['profileKey'] or result['profilePath'] != payload['profilePath'] or result['profileVerified'] is not True:
        fail('invalid_control_response')
    if type(result['cdpLoopback']) is not bool: fail('invalid_control_response')
    if payload['op'] == 'status':
        if not integer(result['browserPid']) or type(result['checkpointReady']) is not bool or type(result['encryptedKeyringUnlocked']) is not bool:
            fail('invalid_control_response')
        if result['checkpointReady'] and not (result['cdpLoopback'] and result['encryptedKeyringUnlocked']): fail('invalid_control_response')
    else:
        if any(result[name] is not True for name in ('checkpointed', 'gracefulClosed', 'keyringSessionRetained', 'cdpLoopback')):
            fail('invalid_control_response')
        if result['sessionId'] != payload['sessionId'] or result['principalHash'] != payload['principalHash']:
            fail('invalid_control_response')
        if result['browserPidBefore'] != payload['expectedBrowserPid'] or not integer(result['browserPidAfter']) or result['browserPidAfter'] == result['browserPidBefore']:
            fail('invalid_control_response')
    return result


def request_control(profile_path, payload, deadline):
    """One bounded request, never retrying an uncertain close/reopen operation."""
    profile_path = Path(profile_path)
    key = profile_path.parent.name
    if not PROFILE_KEY.fullmatch(key) or profile_path != STATE_ROOT / key / 'chromium': fail('profile_not_owned')
    profile = {'base': profile_path.parent, 'chromium': profile_path}
    validate_request(payload, profile)
    deadline = min(deadline, time.monotonic() + payload['timeoutMs'] / 1000)
    remaining(deadline)
    private_directory(STATE_ROOT)
    private_directory(profile['base'])
    private_directory(profile_path)
    path = control_socket_path(profile_path)
    private_directory(path.parent)
    try:
        info = path.lstat()
        if not stat.S_ISSOCK(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o777 != 0o600:
            fail('control_unavailable')
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
            connection.settimeout(remaining(deadline))
            connection.connect(str(path))
            peer_pid, _, _ = peer_credentials(connection)
            current = path.lstat()
            if (current.st_dev, current.st_ino) != (info.st_dev, info.st_ino): fail('control_peer_forbidden')
            wire_payload = {**payload, 'timeoutMs': min(payload['timeoutMs'], int(remaining(deadline) * 1000)),
                            'deadlineMonotonicMs': int(deadline * 1000)}
            if wire_payload['timeoutMs'] < 1: fail('checkpoint_timeout')
            write_message(connection, wire_payload, deadline)
            envelope = read_message(connection, deadline)
            if not isinstance(envelope, dict) or type(envelope.get('version')) is not int or envelope.get('version') != 1:
                fail('invalid_control_response')
            if envelope.get('ok') is False and envelope.keys() == {'version', 'ok', 'code'}:
                code = envelope['code']
                if not isinstance(code, str) or not re.fullmatch(r'[a-z_]{1,64}', code): fail('invalid_control_response')
                fail(code)
            if envelope.keys() != {'version', 'ok', 'result'} or envelope.get('ok') is not True:
                fail('invalid_control_response')
            return validate_result(envelope['result'], payload, peer_pid)
    except ControlError: raise
    except (TimeoutError, socket.timeout): fail('checkpoint_timeout')
    except OSError: fail('control_unavailable')


class WarmSupervisor:
    """Internal process owner; all callbacks are fixed trusted runtime code, not RPC input."""
    def __init__(self, profile, launch_browser, keyring_healthy, dispatcher):
        self.profile, self.launch_browser = profile, launch_browser
        self.keyring_healthy, self.dispatcher = keyring_healthy, dispatcher
        self.browser, self.listener, self.socket_identity, self.socket_path = None, None, None, None
        self.faulted = False

    def identity(self):
        return {'profileKey': self.profile['base'].name, 'profilePath': str(self.profile['chromium']),
                'supervisorPid': os.getpid(), 'profileVerified': True}

    def start(self):
        deadline = time.monotonic() + 14
        if self.browser is not None or not self.keyring_healthy(deadline): fail('keyring_not_ready')
        self.browser = self.launch_browser()
        self.wait_ready(deadline)

    def wait_ready(self, deadline):
        while True:
            remaining(deadline)
            if self.browser.poll() is not None: fail('browser_not_ready')
            try:
                pid = self.dispatcher.verify_runtime(str(self.profile['chromium']))
                if pid == self.browser.pid:
                    remaining(deadline)
                    return
            except Exception: pass
            time.sleep(min(0.05, remaining(deadline)))

    def status(self, deadline):
        remaining(deadline)
        healthy = bool(self.keyring_healthy(deadline))
        verified = False
        if self.browser is not None and self.browser.poll() is None:
            try: verified = self.dispatcher.verify_runtime(str(self.profile['chromium'])) == self.browser.pid
            except Exception: pass
        remaining(deadline)
        return {**self.identity(), 'browserPid': self.browser.pid, 'cdpLoopback': verified,
                'encryptedKeyringUnlocked': healthy, 'checkpointReady': healthy and verified and not self.faulted}

    def mission_owned(self, payload):
        if payload.get('runtimeProtocol') == 2:
            # The dispatcher holds the same mission.lock throughout this call.
            path = Path(__file__).resolve(strict=True).with_name('mission-registry.py')
            if path.is_symlink(): fail('mission_not_owned')
            spec = importlib.util.spec_from_file_location('_otc_checkpoint_registry', path)
            if not spec or not spec.loader: fail('mission_not_owned')
            module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
            fd = os.open(self.profile['base'], os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
            try:
                value = module.read_registry_at(fd, os.getuid())
                mission = module.require_mission(value, payload['sessionId'], payload['principalHash'])
                expected = {'sessionId': payload['sessionId'], 'principalHash': payload['principalHash'], 'operation': 'checkpoint'}
                if len(value['missions']) != 1 or not mission['uncertain'] or value['uncertain'] != expected: fail('mission_not_owned')
                if value['human'] not in (None, {'sessionId': payload['sessionId'], 'principalHash': payload['principalHash']}): fail('mission_not_owned')
                if os.path.lexists(self.profile['base'] / 'mission.json'): fail('mission_not_owned')
                return
            except module.RegistryError: fail('mission_not_owned')
            finally: os.close(fd)
        path = self.profile['base'] / 'mission.json'
        try:
            fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
            with os.fdopen(fd, 'rb') as stream:
                info = os.fstat(stream.fileno())
                if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077 or info.st_nlink != 1 or info.st_size > 65536:
                    fail('mission_not_owned')
                value = decode(stream.read(65537))
            if not isinstance(value, dict) or value.get('sessionId') != payload['sessionId'] or value.get('principalHash') != payload['principalHash'] or value.get('uncertain') is not True:
                fail('mission_not_owned')
        except ControlError: raise
        except (OSError, ValueError): fail('mission_not_owned')

    def checkpoint(self, payload, deadline):
        validate_request(payload, self.profile, wire='deadlineMonotonicMs' in payload)
        remaining(deadline)
        self.mission_owned(payload)  # Dispatcher owns the mission.lock; do not deadlock by reacquiring it.
        if self.faulted or self.browser is None or self.browser.poll() is not None or payload['expectedBrowserPid'] != self.browser.pid:
            fail('browser_not_owned')
        before = self.browser.pid
        if not self.keyring_healthy(deadline): fail('keyring_not_ready')
        if self.dispatcher.verify_runtime(str(self.profile['chromium'])) != before: fail('browser_not_owned')
        remaining(deadline)
        # From this point, any uncertain result freezes checkpoint authority until operator cleanup.
        self.faulted = True
        cdp = self.dispatcher.Cdp(deadline)
        try:
            try: cdp.command('Browser.close')
            except Exception as error:
                if getattr(error, 'code', None) != 'provider_connection_lost' and not isinstance(error, (ConnectionResetError, BrokenPipeError)):
                    fail('checkpoint_close_unconfirmed')
        finally: cdp.close()
        try: code = self.browser.wait(timeout=remaining(deadline))
        except subprocess.TimeoutExpired: fail('checkpoint_close_unconfirmed')
        if code != 0: fail('checkpoint_close_unconfirmed')
        if not self.keyring_healthy(deadline): fail('keyring_not_ready')
        remaining(deadline)
        self.browser = self.launch_browser()
        if self.browser.pid == before: fail('browser_not_owned')
        self.wait_ready(deadline)
        if not self.keyring_healthy(deadline): fail('keyring_not_ready')
        remaining(deadline)
        self.faulted = False
        return {**self.identity(), 'checkpointed': True, 'gracefulClosed': True, 'keyringSessionRetained': True,
                'browserPidBefore': before, 'browserPidAfter': self.browser.pid, 'cdpLoopback': True,
                'sessionId': payload['sessionId'], 'principalHash': payload['principalHash']}

    def listen(self):
        if self.listener is not None: fail('control_busy')
        private_directory(self.profile['base'])
        path = control_socket_path(self.profile['chromium'])
        path.parent.mkdir(mode=0o700, exist_ok=True)
        private_directory(path.parent)
        try:
            existing = path.lstat()
            if not stat.S_ISSOCK(existing.st_mode) or existing.st_uid != os.getuid() or existing.st_mode & 0o777 != 0o600:
                fail('control_unavailable')
            with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as probe:
                probe.settimeout(0.2)
                try:
                    probe.connect(str(path))
                    fail('control_busy')
                except OSError as error:
                    if error.errno != errno.ECONNREFUSED: fail('control_unavailable')
            current = path.lstat()
            if (current.st_dev, current.st_ino) != (existing.st_dev, existing.st_ino): fail('control_unavailable')
            path.unlink()
        except FileNotFoundError: pass
        listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        try:
            old_mask = os.umask(0o177)
            try: listener.bind(str(path))
            finally: os.umask(old_mask)
            os.chmod(path, 0o600, follow_symlinks=False)
            info = path.lstat()
            self.socket_identity = (info.st_dev, info.st_ino)
            self.socket_path = path
            listener.listen(4)
            self.listener = listener
        except Exception:
            listener.close()
            raise

    def serve_once(self, timeout=0.2):
        if self.listener is None: fail('control_unavailable')
        if not select.select([self.listener], [], [], timeout)[0]: return
        connection, _ = self.listener.accept()
        started = time.monotonic()
        deadline = started + 14
        with connection:
            try:
                peer_credentials(connection)
                payload = validate_request(read_message(connection, started + 1), self.profile, wire=True)
                deadline = min(started + payload['timeoutMs'] / 1000, payload['deadlineMonotonicMs'] / 1000)
                remaining(deadline)
                result = self.status(deadline) if payload['op'] == 'status' else self.checkpoint(payload, deadline)
                write_message(connection, {'version': 1, 'ok': True, 'result': result}, deadline)
            except Exception as error:
                code = error.code if isinstance(error, ControlError) else 'control_operation_failed'
                try: write_message(connection, {'version': 1, 'ok': False, 'code': code}, min(started + 14, time.monotonic() + 0.1))
                except Exception: pass

    def close(self):
        if self.listener is not None:
            self.listener.close()
            self.listener = None
        path = self.socket_path
        if self.socket_identity is not None:
            try:
                info = path.lstat()
                if (info.st_dev, info.st_ino) == self.socket_identity and stat.S_ISSOCK(info.st_mode): path.unlink()
            except FileNotFoundError: pass
            self.socket_identity = None
