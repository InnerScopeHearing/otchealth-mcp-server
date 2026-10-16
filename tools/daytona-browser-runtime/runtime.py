#!/usr/bin/env python3
"""Local desktop supervisor retaining its encrypted keyring and locks across warm checkpoints."""

import argparse
from contextlib import contextmanager
import errno
import fcntl
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
import time


STATE_ROOT = Path('/home/otcbrowser/.local/share/otchealth-browser')
PROFILE_KEY = re.compile(r'[a-z0-9][a-z0-9_-]{0,95}\Z')
KEYRING_HEADER = b'GnomeKeyring\n\r\x00\n'


class RuntimeBusy(RuntimeError): pass


def private_directory(path):
    path = Path(path)
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    if path.resolve() != path or not path.is_dir() or path.stat().st_uid != os.getuid():
        raise ValueError('Browser directory is not an owned real directory')
    path.chmod(0o700)
    return path


def prepare_profile(root, profile_key):
    if not isinstance(profile_key, str) or not PROFILE_KEY.fullmatch(profile_key): raise ValueError('Invalid controller-generated profile key')
    root = Path(root)
    if not root.is_absolute() or root.resolve() != root: raise ValueError('State root must be an absolute non-symlink path')
    private_directory(root)
    base = private_directory(root / profile_key)
    return {'base': base, **{name: private_directory(base / name) for name in ('chromium', 'data', 'config', 'home', 'uploads', 'downloads')}}


def initialize_preferences(profile):
    default = private_directory(profile['chromium'] / 'Default')
    try: fd = os.open(default / 'Preferences', os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    except FileExistsError: return
    with os.fdopen(fd, 'w') as output:
        json.dump({'download': {'default_directory': str(profile['downloads']), 'prompt_for_download': True}}, output)


def browser_command(binary, profile):
    return [binary, '--user-data-dir=' + str(profile['chromium']), '--password-store=gnome-libsecret',
            '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=9222',
            '--no-first-run', '--no-default-browser-check', '--start-maximized', 'about:blank']


def browser_environment(profile, inherited):
    env = {'PATH': '/usr/local/bin:/usr/bin:/bin', 'LANG': 'C.UTF-8', 'DISPLAY': ':0',
           'HOME': str(profile['home']), 'XDG_DATA_HOME': str(profile['data']), 'XDG_CONFIG_HOME': str(profile['config'])}
    if inherited.get('XAUTHORITY'): env['XAUTHORITY'] = inherited['XAUTHORITY']
    return env


def has_encrypted_keyring(profile):
    directory = profile['data'] / 'keyrings'
    if directory.is_symlink() or not directory.is_dir(): return False
    files = list(directory.glob('*.keyring'))
    if not files or len(files) > 100: return False
    for path in files:
        try:
            fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
            with os.fdopen(fd, 'rb') as stream:
                info = os.fstat(stream.fileno())
                if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077 or info.st_nlink != 1 or stream.read(len(KEYRING_HEADER)) != KEYRING_HEADER:
                    return False
        except OSError: return False
    return True


@contextmanager
def exclusive_lock(path):
    fd = os.open(path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077 or info.st_nlink != 1:
            raise ValueError('Lock must be a private owned regular file')
        try: fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error: raise RuntimeBusy('Desktop/profile already has an active writer') from error
        yield
    finally: os.close(fd)


def should_restart(returncode, failures):
    return returncode not in (0, -signal.SIGTERM, -signal.SIGINT) and failures < 3


def secret_service_unlocked(deadline=None):
    def call(*args):
        timeout = 5 if deadline is None else min(5, deadline - time.monotonic())
        if timeout <= 0: return ''
        result = subprocess.run(['gdbus', 'call', '--session', '--dest', 'org.freedesktop.secrets', *args],
                                capture_output=True, text=True, timeout=timeout, check=False)
        return result.stdout.strip() if result.returncode == 0 else ''
    try:
        alias = call('--object-path', '/org/freedesktop/secrets', '--method', 'org.freedesktop.Secret.Service.ReadAlias', 'default')
        match = re.fullmatch(r"\(objectpath '(/org/freedesktop/secrets/collection/[A-Za-z0-9_]+)',\)", alias)
        if not match: return False
        return call('--object-path', match.group(1), '--method', 'org.freedesktop.DBus.Properties.Get',
                    'org.freedesktop.Secret.Collection', 'Locked') == '(<false>,)'
    except (OSError, subprocess.TimeoutExpired): return False


def trusted_module(filename, name):
    path = Path(__file__).resolve().with_name(filename)
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022 or path.resolve() != path:
        raise ValueError('Browser controller code is not root-owned immutable runtime code')
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def startup_failure_diagnostic(supervisor, profile, error):
    """Finite metadata only, before cleanup; never change verifier or process state."""
    def error_code(value):
        return {errno.EACCES: 'EACCES', errno.EPERM: 'EPERM', errno.ENOENT: 'ENOENT', errno.ESRCH: 'ESRCH'}.get(getattr(value, 'errno', None), 'OTHER')
    def attempt(operation):
        try: return operation(), 'NONE'
        except OSError as failure: return None, error_code(failure)
        except Exception: return None, 'OTHER'
    errors = {'checkpoint_timeout', 'keyring_not_ready', 'runtime_not_ready', 'browser_not_owned', 'browser_not_ready', 'control_unavailable'}
    code = getattr(error, 'code', None)
    result = {'event': 'browser_startup_failure_diagnostic_v1', 'supervisor_pid': os.getpid(),
              'checkpoint_error': code if type(code) is str and code in errors else 'OTHER', 'browser_pid': None, 'browser_poll': None,
              'process_present': None, 'ppid': None, 'real_uid_matches': None, 'effective_uid_matches': None,
              'procdir_uid_matches': None, 'procdir_errno': 'NONE', 'status_errno': 'NONE',
              'profile_arg_matches': None, 'non_type_process': None, 'debug_address_matches': None,
              'debug_port_matches': None, 'sandbox_flags_safe': None, 'cmdline_errno': 'NONE',
              'exe_basename': 'UNAVAILABLE', 'exe_errno': 'NONE', 'fd_errno': 'NONE',
              'tcp4_errno': 'NONE', 'tcp6_errno': 'NONE', 'listeners': [],
              'verifier_result': 'UNCONFIRMED', 'verified_pid': None}
    try:
        browser = supervisor.browser
        if browser is not None:
            pid = browser.pid
            if type(pid) is int and 1 < pid <= 2**31 - 1:
                result['browser_pid'] = pid
                poll, _ = attempt(browser.poll)
                if poll is None or type(poll) is int and -255 <= poll <= 255: result['browser_poll'] = poll
                path = Path('/proc') / str(pid)
                info, result['procdir_errno'] = attempt(path.stat)
                result['process_present'] = True if info is not None else False if result['procdir_errno'] in {'ENOENT', 'ESRCH'} else None
                if info is not None: result['procdir_uid_matches'] = info.st_uid == os.getuid()
                raw, result['status_errno'] = attempt(lambda: (path / 'status').read_text()[:16384])
                if raw is not None:
                    fields = {line.split(':', 1)[0]: line.split(':', 1)[1].strip() for line in raw.splitlines() if ':' in line}
                    ids = fields.get('Uid', '').split()
                    if len(ids) == 4 and all(item.isdigit() for item in ids):
                        result['real_uid_matches'] = int(ids[0]) == os.getuid()
                        result['effective_uid_matches'] = int(ids[1]) == os.getuid()
                    parent = fields.get('PPid', '')
                    if parent.isdigit() and 0 <= int(parent) <= 2**31 - 1: result['ppid'] = int(parent)
                args, result['cmdline_errno'] = attempt(lambda: (path / 'cmdline').read_bytes()[:65536].split(b'\0'))
                if args is not None:
                    result.update(profile_arg_matches=args.count(os.fsencode('--user-data-dir=' + str(profile['chromium']))) == 1,
                                  non_type_process=not any(arg.startswith(b'--type=') for arg in args),
                                  debug_address_matches=b'--remote-debugging-address=127.0.0.1' in args,
                                  debug_port_matches=b'--remote-debugging-port=9222' in args,
                                  sandbox_flags_safe=not any(arg == b'--no-sandbox' or arg.startswith(b'--remote-allow-origins=') for arg in args))
                executable, result['exe_errno'] = attempt(lambda: Path(os.readlink(path / 'exe')).name)
                if executable is not None: result['exe_basename'] = executable if executable in {'chromium', 'chromium-browser', 'chrome', 'google-chrome', 'sh', 'dash', 'bash', 'python3', 'python3.13'} else 'OTHER'
                def descriptors():
                    entries = list((path / 'fd').iterdir())
                    if len(entries) > 4096: raise ValueError('bounded')
                    return {os.readlink(entry) for entry in entries}
                owned, result['fd_errno'] = attempt(descriptors)
            else: owned = None
        else: owned = None
        for version in (4, 6):
            table = Path('/proc/net/tcp' + ('6' if version == 6 else ''))
            raw, result['tcp' + str(version) + '_errno'] = attempt(lambda: table.read_text()[:1048576])
            if raw is None: continue
            for line in raw.splitlines()[1:]:
                row = line.split()
                if len(row) <= 9 or row[3] != '0A' or row[1].rsplit(':', 1)[-1] != '2406': continue
                address = row[1].split(':', 1)[0]
                kind = ({'0100007F': 'LOOPBACK_V4', '00000000': 'ANY_V4'} if version == 4 else
                        {'00000000000000000000000001000000': 'LOOPBACK_V6', '00000000000000000000000000000000': 'ANY_V6'}).get(address, 'OTHER')
                inode = int(row[9]) if row[9].isdigit() and len(row[9]) <= 20 else None
                result['listeners'].append({'address': kind, 'inode': inode, 'uid_matches': row[7].isdigit() and int(row[7]) == os.getuid(),
                                            'owned_by_browser_fd': None if owned is None else 'socket:[' + row[9] + ']' in owned})
                if len(result['listeners']) >= 16: break
        try:
            verified = supervisor.dispatcher.verify_runtime(str(profile['chromium']))
            result['verifier_result'] = 'OWNED_PID' if verified == result['browser_pid'] else 'OTHER_PID'
            if type(verified) is int and 1 < verified <= 2**31 - 1: result['verified_pid'] = verified
        except Exception as failure:
            result['verifier_result'] = 'runtime_not_ready' if getattr(failure, 'code', None) == 'runtime_not_ready' else 'OTHER'
    except Exception: result['verifier_result'] = 'DIAGNOSTIC_INCOMPLETE'
    try: print(json.dumps(result, sort_keys=True, separators=(',', ':'), allow_nan=False), file=sys.stderr, flush=True)
    except Exception: pass  # Diagnostic failures must never replace the original startup failure.


def session(profile):
    if os.getuid() == 0: raise ValueError('Browser must run as the non-root otcbrowser user; sandbox disabling is forbidden')
    binary = shutil.which('chromium') or shutil.which('chromium-browser') or shutil.which('google-chrome')
    if not binary: raise ValueError('Default desktop snapshot has no supported Chromium browser')
    control = trusted_module('checkpoint-control.py', 'otc_checkpoint_control')
    dispatcher = trusted_module('browser-dispatcher.py', 'otc_browser_dispatcher')
    with exclusive_lock(STATE_ROOT / 'desktop.lock'), exclusive_lock(profile['base'] / 'profile.lock'):
        initialize_preferences(profile)
        with tempfile.TemporaryDirectory(prefix='otc-browser-') as runtime_dir:
            os.environ['XDG_RUNTIME_DIR'] = runtime_dir
            os.environ['GNOME_KEYRING_CONTROL'] = str(Path(runtime_dir) / 'keyring')
            env = browser_environment(profile, os.environ)
            for key in ('DBUS_SESSION_BUS_ADDRESS', 'XDG_RUNTIME_DIR', 'GNOME_KEYRING_CONTROL'):
                if os.environ.get(key): env[key] = os.environ[key]
            fd = os.open(profile['base'] / 'runtime.log', os.O_WRONLY | os.O_CREAT | os.O_APPEND | os.O_NOFOLLOW, 0o600)
            with os.fdopen(fd, 'ab', buffering=0) as log:
                daemon = subprocess.Popen(['gnome-keyring-daemon', '--foreground', '--components=secrets',
                    '--control-directory=' + env['GNOME_KEYRING_CONTROL']], stdout=log, stderr=log, env=env)
                def healthy(deadline):
                    return daemon.poll() is None and has_encrypted_keyring(profile) and secret_service_unlocked(deadline)
                def launch():
                    return subprocess.Popen(browser_command(binary, profile), stdout=log, stderr=log, env=env)
                supervisor = control.WarmSupervisor(profile, launch, healthy, dispatcher)
                stopping = False
                def stop_browser(*_):
                    nonlocal stopping
                    stopping = True
                    if supervisor.browser is not None and supervisor.browser.poll() is None: supervisor.browser.terminate()
                old_term, old_int = signal.signal(signal.SIGTERM, stop_browser), signal.signal(signal.SIGINT, stop_browser)
                startup_complete = False
                try:
                    time.sleep(0.3)
                    if not healthy(time.monotonic() + 10):
                        print('Create or unlock the encrypted default keyring in Passwords and Keys, then close that window.', flush=True)
                        subprocess.run(['seahorse'], stdout=log, stderr=log, timeout=900, check=True, env=env)
                    if not healthy(time.monotonic() + 10): raise ValueError('Encrypted default keyring must be unlocked; browser was not started')
                    supervisor.start()
                    supervisor.listen()
                    startup_complete = True
                    print('Browser started; desktop/profile write lease held.', flush=True)
                    failures = 0
                    while not stopping:
                        supervisor.serve_once(0.2)
                        if daemon.poll() is not None: raise ValueError('Secret Service unavailable; browser control stopped')
                        if supervisor.faulted:
                            continue  # Preserve unknown-effect fences and keyring/bus; never replay a checkpoint.
                        code = supervisor.browser.poll()
                        if code is None: continue
                        if not should_restart(code, failures): return code if code >= 0 else 128 - code
                        failures += 1
                        time.sleep(min(failures, 3))
                        if not healthy(time.monotonic() + 10): raise ValueError('Secret Service unavailable or locked; browser was not restarted')
                        supervisor.browser = launch()
                        supervisor.wait_ready(time.monotonic() + 14)
                    return 0
                except Exception as error:
                    if not startup_complete: startup_failure_diagnostic(supervisor, profile, error)
                    raise
                finally:
                    supervisor.close()
                    signal.signal(signal.SIGTERM, old_term)
                    signal.signal(signal.SIGINT, old_int)
                    if supervisor.browser is not None and supervisor.browser.poll() is None:
                        supervisor.browser.terminate()
                        try: supervisor.browser.wait(timeout=15)
                        except subprocess.TimeoutExpired:
                            supervisor.browser.kill()
                            supervisor.browser.wait()
                    daemon.terminate()
                    try: daemon.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        daemon.kill()
                        daemon.wait()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('operation', choices=('paths', 'run', '_session'))
    parser.add_argument('--profile-key', required=True)
    args = parser.parse_args()
    profile = prepare_profile(STATE_ROOT, args.profile_key)
    if args.operation == 'paths':
        print(json.dumps({name: str(path) for name, path in profile.items()}, sort_keys=True))
        return 0
    if args.operation == '_session': return session(profile)
    return subprocess.call(['dbus-run-session', '--', sys.executable, str(Path(__file__).resolve()), '_session',
                            '--profile-key', args.profile_key], env=browser_environment(profile, os.environ))


if __name__ == '__main__':
    try: sys.exit(main())
    except Exception:
        print('Browser runtime operation failed; no checkpoint success is implied.', file=sys.stderr)
        sys.exit(1)
