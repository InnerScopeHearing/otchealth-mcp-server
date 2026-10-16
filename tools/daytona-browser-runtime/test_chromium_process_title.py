import importlib.util
from pathlib import Path
from types import SimpleNamespace
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('title_dispatcher', Path(__file__).with_name('browser-dispatcher.py'))
dispatcher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(dispatcher)


class ChromiumProcessTitleTests(unittest.TestCase):
    profile = '/home/otcbrowser/.local/share/otchealth-browser/company-browser/chromium'

    def verify(self, raw):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            process = root / '123'
            (process / 'fd').mkdir(parents=True)
            (process / 'cmdline').write_bytes(raw)
            (process / 'exe').symlink_to('/usr/lib/chromium/chromium')
            (process / 'fd' / '7').symlink_to('socket:[77]')
            (root / 'net').mkdir()
            (root / 'net' / 'tcp').write_text('header\n0: 0100007F:2406 00000000:0000 0A 0 0 0 1234 0 77\n')
            with patch.object(dispatcher.os, 'getuid', return_value=1234), patch.object(Path, 'stat', return_value=SimpleNamespace(st_uid=1234)):
                return dispatcher.verify_runtime(self.profile, root)

    def test_native_and_flattened_titles_verify_the_same_owned_listener(self):
        args = ['/usr/lib/chromium/chromium', '--user-data-dir=' + self.profile,
                '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=9222', 'about:blank']
        self.assertEqual(self.verify(b'\0'.join(arg.encode() for arg in args) + b'\0'), 123)
        self.assertEqual(self.verify(' '.join(args).encode() + b'\0'), 123)

    def test_flattened_titles_preserve_exact_profile_and_unsafe_flag_rejections(self):
        prefix = '/usr/lib/chromium/chromium --user-data-dir=' + self.profile
        suffix = ' --remote-debugging-address=127.0.0.1 --remote-debugging-port=9222'
        for text in (prefix + '-other' + suffix, prefix + ' --user-data-dir=' + self.profile + suffix,
                     prefix + suffix + ' --no-sandbox', prefix + suffix + ' --remote-allow-origins=*',
                     prefix + suffix + ' --type=renderer', prefix + suffix + " '"):
            with self.subTest(text=text), self.assertRaises(dispatcher.DispatchError):
                self.verify(text.encode() + b'\0')


if __name__ == '__main__': unittest.main()
