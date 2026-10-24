"""Worker close ordering against a controllable fake llama-server; no native, model or wheel is used."""
import os
import pathlib
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

SCRIPTS = pathlib.Path(__file__).resolve().parent.parent / 'scripts'
# Logs every SIGTERM. 'exit' shuts down 0.4 s after the first one, as llama-server does; a second SIGTERM in that window is logged too.
FAKE = '''import signal, sys, time
log, mode = sys.argv[1:3]
def term(*_):
    open(log, "a").write("TERM\\n")
    if mode == "exit": time.sleep(.4); sys.exit(0)
signal.signal(signal.SIGTERM, term)
print("ready", flush=True)
while True: time.sleep(.05)
'''


class Recorded(subprocess.Popen):
    def terminate(self): self.calls.append('terminate'); self.times.append(time.monotonic()); super().terminate()
    def kill(self): self.calls.append('kill'); self.times.append(time.monotonic()); super().kill()


class WorkerCloseTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory(prefix='pi-eg2-close-'); self.addCleanup(directory.cleanup)
        self.base = pathlib.Path(directory.name).resolve(); root = self.base / 'runtime'; root.mkdir()
        for name, text in (('pins.json', '{}'), ('requirements.lock', ''), ('assets.sha256.json', '{}')): (root / name).write_text(text)
        for sig in (signal.SIGTERM, signal.SIGINT): self.addCleanup(signal.signal, sig, signal.getsignal(sig))
        with patch.dict('os.environ', {'PI_SEMANTIC_RUNTIME_ROOT': str(root)}):
            source = (SCRIPTS / 'semantic-worker.py').read_text().split('\ntry:\n while True:')[0]
            self.ns = {'__file__': str(SCRIPTS / 'semantic-worker.py')}
            exec(compile(source, self.ns['__file__'], 'exec'), self.ns)

    def fake(self, mode):
        self.log = self.base / 'term.log'
        server = Recorded([sys.executable, '-c', FAKE, str(self.log), mode], stdout=subprocess.PIPE, text=True)
        server.calls, server.times = [], []
        self.addCleanup(lambda: (server.poll() is None and server.kill(), server.wait(), server.stdout.close()))
        self.assertEqual(server.stdout.readline().strip(), 'ready')
        self.ns['server'] = server
        return server

    def group_signal(self, server):
        # The package's process-group SIGTERM reaches llama-server directly; wait until it is handling it.
        os.kill(server.pid, signal.SIGTERM)
        deadline = time.monotonic() + 5
        while not self.log.exists() and time.monotonic() < deadline: time.sleep(.01)
        self.assertTrue(self.log.exists())

    def terms(self): return self.log.read_text().split() if self.log.exists() else []

    def test_signal_close_sends_no_second_signal_when_server_exits_by_itself(self):
        server = self.fake('exit'); self.group_signal(server)
        with self.assertRaises(SystemExit) as raised: self.ns['terminate'](signal.SIGTERM, None)
        self.assertEqual(raised.exception.code, 128 + signal.SIGTERM)
        self.assertEqual(server.calls, [])
        self.assertEqual(self.terms(), ['TERM'])
        self.assertEqual(server.poll(), 0); self.assertIsNone(self.ns['server'])

    def test_signal_close_terminates_after_grace_then_kills_a_server_that_ignores_sigterm(self):
        server = self.fake('ignore'); self.group_signal(server); self.ns['SERVER_EXIT_GRACE_S'] = .5
        started = time.monotonic()
        with self.assertRaises(SystemExit): self.ns['terminate'](signal.SIGTERM, None)
        self.assertEqual(server.calls, ['terminate', 'kill'])
        self.assertGreaterEqual(server.times[0] - started, .5)
        self.assertEqual(self.terms(), ['TERM', 'TERM'])
        self.assertEqual(server.poll(), -signal.SIGKILL); self.assertIsNone(self.ns['server'])

    def test_the_grace_outlasts_the_package_escalation_to_sigkill_at_one_second(self):
        # A shorter grace would send llama-server a second SIGTERM while it is still shutting down, in the window before the package's SIGKILL of the group: the crash this test file guards against.
        self.assertGreaterEqual(self.ns['SERVER_EXIT_GRACE_S'], 1.0)

    def test_close_without_a_signal_terminates_at_once(self):
        server = self.fake('exit'); self.ns['SERVER_EXIT_GRACE_S'] = 5
        started = time.monotonic(); self.ns['close_native']()
        self.assertEqual(server.calls, ['terminate'])
        self.assertLess(time.monotonic() - started, 2)
        self.assertEqual(self.terms(), ['TERM']); self.assertEqual(server.poll(), 0)


if __name__ == '__main__': unittest.main()
