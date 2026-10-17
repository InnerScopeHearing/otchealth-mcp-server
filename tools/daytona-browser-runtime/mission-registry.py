#!/usr/bin/env python3
"""Private V2 target ownership and physical action mutex. No provider/shell API."""
import fcntl
import json
import os
from pathlib import Path
import re
import stat
import tempfile
import time

UUID = re.compile(r'[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\Z')
HASH = re.compile(r'[0-9a-f]{64}\Z')
TARGET = re.compile(r'[A-Za-z0-9_-]{1,256}\Z')
OBSERVED_HANDLE = re.compile(r'otc-observed:[0-9a-f]{32}\Z')
LOCATOR_ROLES = {'button', 'link', 'textbox', 'text field', 'textfield', 'searchbox', 'combobox'}
LOCATOR_TAGS = {'button', 'a', 'input', 'textarea', 'select', 'div', 'span'}
MAX_MISSIONS, MAX_TABS, MAX_TOTAL_TABS = 7, 4, 28
# Seven64KiB UTF8 buffers can expand sixfold when JSON escapes controls.
# Reserve that bounded representation plus target/ownership metadata, while
# leaving per-mission plaintext limits unchanged.
MAX_REGISTRY_BYTES = 3 * 1048576
OPERATIONS = {'open', 'action', 'release', 'checkpoint', 'human_pause', 'human_resume'}

class RegistryError(Exception):
    def __init__(self, code, before_effect=False):
        self.code, self.before_effect = code, before_effect
        super().__init__(code)

def fail(code='registry_invalid', before_effect=False): raise RegistryError(code, before_effect)
def empty_registry(): return {'version': 2, 'uncertain': None, 'human': None, 'missions': []}

def exact(value, keys):
    if not isinstance(value, dict) or value.keys() != set(keys): fail()

def owner(value):
    exact(value, ('sessionId', 'principalHash'))
    if not isinstance(value['sessionId'], str) or not UUID.fullmatch(value['sessionId']) or not isinstance(value['principalHash'], str) or not HASH.fullmatch(value['principalHash']): fail()

def validate_registry(value):
    exact(value, ('version', 'uncertain', 'human', 'missions'))
    if type(value['version']) is not int or value['version'] != 2 or not isinstance(value['missions'], list) or len(value['missions']) > MAX_MISSIONS: fail()
    sessions, principals, targets = set(), set(), set()
    for mission in value['missions']:
        required = {'sessionId', 'principalHash', 'selected', 'owned', 'uncertain'}
        if not isinstance(mission, dict) or not required <= mission.keys() or not mission.keys() <= required | {'clipboardText', 'observedLocators'}: fail()
        if 'clipboardText' in mission:
            if not isinstance(mission['clipboardText'], str): fail()
            try: size = len(mission['clipboardText'].encode('utf8'))
            except UnicodeError: fail()
            if size > 65536: fail()
        if 'observedLocators' in mission:
            locators = mission['observedLocators']
            if not isinstance(locators, list) or len(locators) > 20: fail()
            seen_handles, seen_nodes = set(), set()
            for locator in locators:
                exact(locator, ('handle', 'target', 'frameId', 'loaderId', 'documentBackendNodeId', 'browserEpoch',
                                'backendDOMNodeId', 'role', 'tag', 'nameHash'))
                if (not isinstance(locator['handle'], str) or not OBSERVED_HANDLE.fullmatch(locator['handle'])
                    or locator['handle'] in seen_handles
                    or locator['target'] not in mission['owned']
                    or not isinstance(locator['frameId'], str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,256}', locator['frameId'])
                    or not isinstance(locator['loaderId'], str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,256}', locator['loaderId'])
                    or not type(locator['documentBackendNodeId']) is int or not 1 <= locator['documentBackendNodeId'] <= 2 ** 31
                    or not type(locator['browserEpoch']) is int or not 1 <= locator['browserEpoch'] <= 2 ** 31
                    or not type(locator['backendDOMNodeId']) is int or not 1 <= locator['backendDOMNodeId'] <= 2 ** 31
                    or locator['backendDOMNodeId'] in seen_nodes
                    or locator['role'] not in LOCATOR_ROLES or locator['tag'] not in LOCATOR_TAGS
                    or not isinstance(locator['nameHash'], str) or not HASH.fullmatch(locator['nameHash'])): fail()
                seen_handles.add(locator['handle']); seen_nodes.add(locator['backendDOMNodeId'])
        owner({key: mission[key] for key in ('sessionId', 'principalHash')})
        if mission['sessionId'] in sessions or mission['principalHash'] in principals: fail()
        sessions.add(mission['sessionId']); principals.add(mission['principalHash'])
        if not isinstance(mission['owned'], list) or len(mission['owned']) > MAX_TABS or type(mission['uncertain']) is not bool: fail()
        for target in mission['owned']:
            if not isinstance(target, str) or not TARGET.fullmatch(target) or target in targets: fail()
            targets.add(target)
        if mission['selected'] is not None and mission['selected'] not in mission['owned']: fail()
    if len(targets) > MAX_TOTAL_TABS: fail()
    for key in ('human', 'uncertain'):
        guard = value[key]
        if guard is None: continue
        if key == 'uncertain':
            exact(guard, ('sessionId', 'principalHash', 'operation'))
            if guard['operation'] not in OPERATIONS: fail()
        owner({field: guard.get(field) for field in ('sessionId', 'principalHash')})
        if key == 'human': exact(guard, ('sessionId', 'principalHash'))
        matches = [mission for mission in value['missions'] if mission['sessionId'] == guard['sessionId'] and mission['principalHash'] == guard['principalHash']]
        if len(matches) != 1 or (key == 'uncertain' and not matches[0]['uncertain']): fail()
    uncertain = [mission for mission in value['missions'] if mission['uncertain']]
    if len(uncertain) != (1 if value['uncertain'] else 0): fail()
    return value

def require_mission(value, session_id, principal):
    validate_registry(value)
    for mission in value['missions']:
        if mission['sessionId'] == session_id and mission['principalHash'] == principal: return mission
    fail('mission_not_owned')

def require_automation(value, session_id, principal):
    mission = require_mission(value, session_id, principal)
    if value['uncertain'] is not None: fail('effect_unknown')
    if value['human'] is not None: fail('human_active', True)
    return mission

def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result: fail()
        result[key] = value
    return result

def read_registry_at(base_fd, expected_uid):
    try:
        parent = os.fstat(base_fd)
        if not stat.S_ISDIR(parent.st_mode) or parent.st_uid != expected_uid or parent.st_mode & 0o077: fail('registry_unavailable')
        try: fd = os.open('missions-v2.json', os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=base_fd)
        except FileNotFoundError: return empty_registry()
        with os.fdopen(fd, 'rb') as stream:
            info = os.fstat(stream.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_uid != expected_uid or stat.S_IMODE(info.st_mode) != 0o600 or info.st_nlink != 1 or info.st_size > MAX_REGISTRY_BYTES: fail('registry_unavailable')
            raw = stream.read(MAX_REGISTRY_BYTES + 1)
        if len(raw) > MAX_REGISTRY_BYTES: fail('registry_unavailable')
        return validate_registry(json.loads(raw, object_pairs_hook=unique_object, parse_constant=lambda _: fail()))
    except RegistryError: raise
    except (OSError, ValueError, UnicodeError): fail('registry_unavailable')

class Registry:
    def __init__(self, base, deadline): self.base, self.deadline, self.fd, self.base_fd = Path(base), deadline, None, None
    def __enter__(self):
        try:
            if not self.base.is_absolute() or self.base.resolve() != self.base: fail('registry_unavailable')
            self.base_fd = os.open(self.base, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
            info = os.fstat(self.base_fd)
            if info.st_uid != os.getuid() or info.st_mode & 0o077: fail('registry_unavailable')
            self.fd = os.open('mission.lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600, dir_fd=self.base_fd)
            info = os.fstat(self.fd)
            if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o600 or info.st_nlink != 1: fail('registry_unavailable')
            while True:
                try: fcntl.flock(self.fd, fcntl.LOCK_EX | fcntl.LOCK_NB); break
                except BlockingIOError:
                    remaining = self.deadline - time.monotonic()
                    if remaining <= 0: fail('mission_busy', True)
                    time.sleep(min(0.01, remaining))
            return self
        except BaseException:
            self.__exit__(); raise
    def __exit__(self, *_):
        for name in ('fd', 'base_fd'):
            fd = getattr(self, name)
            if fd is not None: os.close(fd); setattr(self, name, None)
    def load(self): return read_registry_at(self.base_fd, os.getuid())
    def save(self, value):
        validate_registry(value)
        data = json.dumps(value, separators=(',', ':'), allow_nan=False, ensure_ascii=False).encode()
        if len(data) > MAX_REGISTRY_BYTES: fail()
        # Validate any existing destination before replacing it, even though
        # rename itself never follows symlinks.
        self.load()
        fd, path = tempfile.mkstemp(prefix='.missions-v2-', dir=self.base)
        try:
            with os.fdopen(fd, 'wb') as stream:
                os.fchmod(stream.fileno(), 0o600); stream.write(data); stream.flush(); os.fsync(stream.fileno())
            os.replace(path, self.base / 'missions-v2.json'); os.fsync(self.base_fd)
        finally:
            try: os.unlink(path)
            except FileNotFoundError: pass
