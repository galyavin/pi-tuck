"""Mechanical source/effect tests; fixture weights/native/wheel are not model qualification."""
import copy
import importlib.util
import json
import pathlib
import platform
import runpy
import sys
import tempfile
import unittest
import zipfile
from unittest.mock import patch

SCRIPTS = pathlib.Path(__file__).resolve().parent.parent / 'scripts'
UTILITY = runpy.run_path(str(SCRIPTS / 'eg2-runtime.py'))
PROVISION = runpy.run_path(str(SCRIPTS / 'provision-eg2.py'))


def utility_version(name):
    return '0.4.6' if name == 'colorama' else UTILITY['UTILITIES'][name][0]


def fixture_model(artifact):
    import struct
    def string(value):
        data = value.encode(); return struct.pack('<Q', len(data)) + data
    filetype = {'Q4_0': 2, 'Q4_K_S': 14, 'Q4_K_M': 15, 'Q8_0': 7, 'BF16': 32}[artifact]
    return (b'GGUF' + struct.pack('<IQQ', 3, 1, 2) + string('general.architecture') + struct.pack('<I', 8)
            + string('gemma-embedding2') + string('general.file_type') + struct.pack('<II', 4, filetype) + b'fixture tensor bytes')


def fixture(root, artifact='Q8_0', wheel_name='tokenizers-0.23.2-cp310-abi3-macosx_11_0_arm64.whl', windows=None):
    windows = sys.platform == 'win32' if windows is None else windows
    files = {'model.gguf': fixture_model(artifact), 'models/embedding/tokenizer.json': b'{}',
             ('native/llama-server.exe' if windows else 'native/llama-server'): b'fixture executable'}
    for name, data in files.items():
        path = root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
    package = root.parent / 'site' / 'tokenizers'
    package.mkdir(parents=True, exist_ok=True)
    (package / '__init__.py').write_text('# fixture utility\n')
    wheel = 'wheels/' + wheel_name
    (root / 'wheels').mkdir(exist_ok=True)
    with zipfile.ZipFile(root / wheel, 'w') as archive:
        archive.write(package / '__init__.py', 'tokenizers/__init__.py')
    sha = UTILITY['digest'](root / wheel)
    requirements = ['tokenizers==0.23.2 --hash=sha256:' + sha]
    for name, (version, members) in UTILITY['utility_versions'](files).items():
        if name == 'tokenizers': continue
        payload = members[0] if members[0].endswith('.py') else members[0] + '/__init__.py'
        installed = package.parent / payload; installed.parent.mkdir(parents=True, exist_ok=True)
        installed.write_bytes(b'# fixture dependency\n')
        dependency = root / 'wheels' / (name.replace('-', '_') + '-' + version + '-py3-none-any.whl')
        with zipfile.ZipFile(dependency, 'w') as archive: archive.write(installed, payload)
        requirements.append(name + '==' + version + ' --hash=sha256:' + UTILITY['digest'](dependency))
    (root / 'requirements.lock').write_text('\n'.join(requirements) + '\n')
    pins = {'embedding': {'model': 'google/embeddinggemma-2', 'revision': UTILITY['OFFICIAL_REVISION'],
                         'dimensions': 768, 'maxTokens': 8192, 'queryInstruction': 'task: search result | query: ',
                         'documentInstruction': 'title: none | text: ', 'pooling': UTILITY['POOLING'], 'dtype': artifact},
            'runtime': {'tokenizers': '0.23.2'},
            'backend': {'name': 'llama.cpp', 'commit': UTILITY['NATIVE_COMMIT'], 'artifact': artifact,
                        'modelSHA256': UTILITY['digest'](root / 'model.gguf'), 'gpuLayers': 0,
                        'compute': UTILITY['COMPUTE'], 'computePrecision': 'float32',
                        'modelRepository': 'unsloth/embeddinggemma-2-GGUF', 'modelRevision': '0' * 40}}
    (root / 'pins.json').write_text(json.dumps(pins))
    manifest = {name: UTILITY['digest'](path) for path in root.rglob('*') if path.is_file() for name in [path.relative_to(root).as_posix()]}
    return pins, manifest, package, wheel


class RuntimeTests(unittest.TestCase):
    def test_exact_ready_identities_fp32_and_invalidation(self):
        with tempfile.TemporaryDirectory(prefix='pi-eg2-schema-') as directory:
            root = pathlib.Path(directory).resolve() / 'runtime'
            identities = []
            history = root.parent / 'original-history.json'; history.write_text('{"source":"original evidence"}')
            previous_identity = None
            for artifact in ('Q4_0', 'Q4_K_S', 'Q4_K_M', 'Q8_0', 'BF16'):
                # Recreate fixture to avoid admitting stale manifest files.
                import shutil
                shutil.rmtree(root, ignore_errors=True)
                pins, manifest, package, wheel = fixture(root, artifact)
                (root / 'assets.sha256.json').write_text(json.dumps(manifest))
                with patch.dict('os.environ', {'PI_SEMANTIC_RUNTIME_ROOT': str(root)}), patch.object(sys, 'version_info', (3, 13, 9)):
                    source = (SCRIPTS / 'semantic-worker.py').read_text().split('\ntry:\n while True:')[0]
                    ns = {'__file__': str(SCRIPTS / 'semantic-worker.py')}
                    exec(compile(source, ns['__file__'], 'exec'), ns)
                spec = importlib.util.spec_from_file_location('tokenizers', package / '__init__.py')
                with patch.object(sys, 'version_info', (3, 13, 9)), patch('importlib.metadata.version', side_effect=utility_version), patch('importlib.util.find_spec', return_value=spec):
                    ready = ns['run']({'op': 'ready'})
                    self.assertEqual(ready['dtype'], artifact)
                    self.assertEqual(ready['computePrecision'], 'float32')
                    # Native launch effect: no FP16/GPU, f32 K/V for every weight identity.
                    from unittest.mock import Mock
                    server = Mock(); server.poll.return_value = None
                    with patch('subprocess.Popen', return_value=server) as launch:
                        ns['request'] = lambda *args: {'status': 'ok'}
                        ns['load']()
                        command = launch.call_args.args[0]
                        for key, value in (('--n-gpu-layers', '0'), ('--cache-type-k', 'f32'), ('--cache-type-v', 'f32'), ('--flash-attn', 'off')):
                            self.assertEqual(command[command.index(key) + 1], value)
                        self.assertIn(str(root / 'model.gguf'), command)
                        ns['close_native']()
                    # Identity is source-bound, not just precision labels.
                    identities.append(ready['identity'])
                    # Actual SQLite effect: changing configuration loses only old derived rows.
                    index = {'path': str(root.parent / 'index.sqlite'), 'projectDirectory': str(root.parent / 'project'), 'identity': ready['identity']}
                    if previous_identity is not None:
                        self.assertEqual(ns['index']({**index, 'action': 'status', 'keys': ['same-source']})['coveredKeys'], [])
                        self.assertEqual(ns['index']({**index, 'action': 'reconcile', 'keys': ['same-source']})['removed'], 1)
                    ns['index']({**index, 'action': 'upsert', 'rows': [{'key': 'same-source', 'entryId': 'original', 'start': 0, 'end': 1, 'inputSha': 'same', 'vector': [1.0] + [0.0] * 767}]})
                    previous_identity = ready['identity']
                    self.assertEqual(history.read_text(), '{"source":"original evidence"}')
                    original = UTILITY['configuration_identity'](root, SCRIPTS / 'semantic-worker.py')
                    (root / 'pins.json').write_text(json.dumps({**pins, 'vision': {'selection': 'separate-consumer'}}))
                    self.assertNotEqual(original, UTILITY['configuration_identity'](root, SCRIPTS / 'semantic-worker.py'))
                    with self.assertRaisesRegex(ValueError, 'asset_integrity_failure'):
                        UTILITY['verify_runtime'](root)
                # The metadata identity includes the actual Python utility version.
                with patch.object(sys, 'version_info', (3, 12, 13)):
                    old = UTILITY['configuration_identity'](root, SCRIPTS / 'semantic-worker.py')
                with patch.object(sys, 'version_info', (3, 13, 9)):
                    self.assertNotEqual(old, UTILITY['configuration_identity'](root, SCRIPTS / 'semantic-worker.py'))
            self.assertEqual(len(set(identities)), 5)

    def test_pin_manifest_and_dependency_rejections(self):
        with tempfile.TemporaryDirectory(prefix='pi-eg2-integrity-') as directory:
            root = pathlib.Path(directory).resolve() / 'runtime'
            pins, manifest, package, wheel = fixture(root)
            for section, key, value in [('backend', 'artifact', 'F16'), ('backend', 'computePrecision', 'float16'),
                                         ('backend', 'modelSHA256', 'f' * 64), ('backend', 'commit', 'f' * 40),
                                         ('backend', 'gpuLayers', 1), ('embedding', 'revision', 'f' * 40),
                                         ('embedding', 'dtype', 'BF16'), ('runtime', 'tokenizers', '0.23.1')]:
                changed = copy.deepcopy(pins); changed[section][key] = value
                with self.assertRaises(ValueError): UTILITY['validate_pins'](changed, manifest)
            for bad in ({**manifest, '../outside': '0' * 64}, {**manifest, 'absolute': 'invalid'},
                        {k: v for k, v in manifest.items() if k != 'pins.json'}):
                with self.assertRaises(ValueError): UTILITY['validate_manifest'](bad)
            (root / 'assets.sha256.json').write_text(json.dumps(manifest))
            UTILITY['verify_runtime'](root)
            with self.assertRaisesRegex(ValueError, 'gguf_pin_mismatch'): UTILITY['verify_gguf'](root / 'model.gguf', 'BF16')
            spec = importlib.util.spec_from_file_location('tokenizers', package / '__init__.py')
            with patch('importlib.metadata.version', side_effect=utility_version), patch('importlib.util.find_spec', return_value=spec):
                UTILITY['verify_tokenizers'](root)
                (package / '__init__.py').write_text('# mutated installed utility\n')
                with self.assertRaisesRegex(ValueError, 'tokenizers_integrity_failure'): UTILITY['verify_tokenizers'](root)
            (root / 'model.gguf').write_bytes(b'changed')
            with self.assertRaisesRegex(ValueError, 'asset_integrity_failure'): UTILITY['verify_runtime'](root)
            (root / 'model.gguf').unlink(); (root / 'model.gguf').symlink_to(package / '__init__.py')
            with self.assertRaisesRegex(ValueError, 'asset_path_failure'): UTILITY['verify_files'](root, manifest)
            for value in ('tokenizers==0.23.1', 'tokenizers==0.23.2', 'tokenizers==0.23.2 --hash=sha256:' + manifest[wheel] + '\nother==1.0'):
                (root / 'requirements.lock').write_text(value)
                with self.assertRaises(ValueError): UTILITY['validate_requirements'](root, manifest)

    def test_portable_wheels_and_exact_native_inventory(self):
        candidates = ('tokenizers-0.23.2-cp39-abi3-win_amd64.whl',
                      'tokenizers-0.23.2-cp310-abi3-manylinux_2_17_x86_64.whl',
                      'tokenizers-0.23.2-cp310-abi3-macosx_10_12_x86_64.whl',
                      'tokenizers-0.23.2-cp310-abi3-macosx_11_0_arm64.whl')
        for wheel_name in candidates:
            with self.subTest(wheel=wheel_name), tempfile.TemporaryDirectory(prefix='pi-eg2-wheel-') as directory:
                root = pathlib.Path(directory).resolve() / 'runtime'
                pins, manifest, package, wheel = fixture(root, wheel_name=wheel_name, windows='win_' in wheel_name)
                # Fixtures are bytes only: they never import or execute the native modules.
                members = {'tokenizers/native.pyd': b'pyd', 'tokenizers/native.dll': b'dll',
                           'tokenizers.libs/support.dll': b'support', 'tokenizers/api.pyi': b'types'}
                for name, data in members.items():
                    path = package.parent / name; path.parent.mkdir(parents=True, exist_ok=True); path.write_bytes(data)
                with zipfile.ZipFile(root / wheel, 'a') as archive:
                    for name, data in members.items(): archive.writestr(name, data)
                sha = UTILITY['digest'](root / wheel); manifest[wheel] = sha
                lock = root / 'requirements.lock'
                lock.write_text('\n'.join('tokenizers==0.23.2 --hash=sha256:' + sha if line.startswith('tokenizers==') else line for line in lock.read_text().splitlines()) + '\n')
                manifest['requirements.lock'] = UTILITY['digest'](root / 'requirements.lock')
                (root / 'assets.sha256.json').write_text(json.dumps(manifest))
                UTILITY['verify_runtime'](root)
                other_native = 'native/llama-server' if 'win_' in wheel_name else 'native/llama-server.exe'
                with self.assertRaisesRegex(ValueError, 'invalid_native_server_inventory'):
                    UTILITY['validate_manifest']({**manifest, other_native: '0' * 64})
                spec = importlib.util.spec_from_file_location('tokenizers', package / '__init__.py')
                with patch('importlib.metadata.version', side_effect=utility_version), patch('importlib.util.find_spec', return_value=spec):
                    UTILITY['verify_tokenizers'](root)
                    extra = package / 'unmanifested.dll'; extra.write_bytes(b'extra')
                    with self.assertRaisesRegex(ValueError, 'tokenizers_membership_failure'): UTILITY['verify_tokenizers'](root)
                    extra.unlink(); (package / 'native.pyd').write_bytes(b'mutated')
                    with self.assertRaisesRegex(ValueError, 'tokenizers_integrity_failure'): UTILITY['verify_tokenizers'](root)
                    (package / 'native.pyd').write_bytes(b'pyd')
                    (package / 'old.pyc').write_bytes(b'bytecode')
                    with self.assertRaisesRegex(ValueError, 'tokenizers_membership_failure'): UTILITY['verify_tokenizers'](root)
                    (package / 'old.pyc').unlink()
                    (root / wheel).write_bytes(b'unlocked wheel')
                    with self.assertRaisesRegex(ValueError, 'tokenizers_integrity_failure'): UTILITY['verify_tokenizers'](root)
                for name in ('wheels/not-tokenizers-0.23.2-cp39-abi3-win_amd64.whl', 'wheels/tokenizers-0.23.1-cp39-abi3-win_amd64.whl'):
                    changed = {k: v for k, v in manifest.items() if k != wheel}; changed[name] = sha
                    with self.assertRaisesRegex(ValueError, 'invalid_requirements_lock'): UTILITY['validate_requirements'](root, changed)
                for name in ('C:/absolute', 'native\\bad.dll', './alias', 'native//bad.dll'):
                    with self.assertRaisesRegex(ValueError, 'asset_path_failure'): UTILITY['validate_manifest']({**manifest, name: '0' * 64})

    def test_installed_windows_inventory_uses_posix_metadata_and_hashes(self):
        with tempfile.TemporaryDirectory(prefix='pi-eg2-installed-') as directory:
            root = pathlib.Path(directory).resolve() / 'runtime'
            pins, manifest, package, wheel = fixture(root, windows=True)
            installed = root / 'env/Lib/site-packages/tokenizers'; installed.mkdir(parents=True)
            for name, data in {'__init__.py': b'# utility', 'native.pyd': b'extension', 'support.dll': b'dll'}.items():
                path = installed / name; path.write_bytes(data)
                manifest[path.relative_to(root).as_posix()] = UTILITY['digest'](path)
            import shutil
            for item in package.parent.iterdir():
                if item.name == 'tokenizers': continue
                output = installed.parent / item.name
                if item.is_dir(): shutil.copytree(item, output)
                else: shutil.copyfile(item, output)
                for path in ([output] if output.is_file() else output.rglob('*')):
                    if path.is_file(): manifest[path.relative_to(root).as_posix()] = UTILITY['digest'](path)
            manifest = {name: sha for name, sha in manifest.items() if not name.startswith('wheels/')}
            (root / 'assets.sha256.json').write_text(json.dumps(manifest))
            spec = importlib.util.spec_from_file_location('tokenizers', installed / '__init__.py')
            with patch('importlib.metadata.version', side_effect=utility_version), patch('importlib.util.find_spec', return_value=spec):
                UTILITY['verify_tokenizers'](root)
                (installed / 'support.dll').write_bytes(b'changed')
                with self.assertRaisesRegex(ValueError, 'tokenizers_integrity_failure'): UTILITY['verify_tokenizers'](root)
                (installed / 'support.dll').write_bytes(b'dll'); (installed / 'extra.so').write_bytes(b'extra')
                with self.assertRaisesRegex(ValueError, 'tokenizers_membership_failure'): UTILITY['verify_tokenizers'](root)

    def test_windows_authenticated_loopback_native_launch_and_request_failures(self):
        import http.server
        import threading
        from unittest.mock import Mock
        with tempfile.TemporaryDirectory(prefix='pi-eg2-loopback-') as directory:
            root = pathlib.Path(directory).resolve() / 'runtime'
            pins, manifest, package, wheel = fixture(root, windows=True)
            (root / 'assets.sha256.json').write_text(json.dumps(manifest))
            with patch.dict('os.environ', {'PI_SEMANTIC_RUNTIME_ROOT': str(root)}), patch('signal.signal'):
                source = (SCRIPTS / 'semantic-worker.py').read_text().split('\ntry:\n while True:')[0]
                ns = {'__file__': str(SCRIPTS / 'semantic-worker.py')}
                exec(compile(source, ns['__file__'], 'exec'), ns)
            ns['WINDOWS'] = False
            with patch.object(sys, 'version_info', (3, 13, 9)), patch('subprocess.Popen') as no_launch:
                with self.assertRaisesRegex(ns['Refusal'], 'native_target_failure'): ns['run']({'op': 'ready'})
                self.assertFalse(ns['verified']); no_launch.assert_not_called()
            ns['WINDOWS'] = True; ns['verify'] = lambda: None
            with self.assertRaisesRegex(ns['Refusal'], 'native_transport_unavailable'): ns['request']('/health')
            requests = []; token = None; httpd = None; thread = None; mode = 'normal'
            class Handler(http.server.BaseHTTPRequestHandler):
                def do_GET(self):
                    requests.append((self.path, self.headers.get('Authorization')))
                    allowed = self.path == '/health' or self.headers.get('Authorization') == 'Bearer ' + token
                    status = 200 if allowed else 401
                    body = b'{"status":"ok"}' if mode == 'normal' else b'x' * (16 * 1024 * 1024 + 1)
                    self.send_response(status); self.send_header('Content-Length', str(len(body))); self.end_headers(); self.wfile.write(body)
                def log_message(self, *args): pass
            def launch(command, **kwargs):
                nonlocal token, httpd, thread
                self.assertEqual(command[0], str(root / 'native/llama-server.exe'))
                self.assertEqual(command[command.index('--host') + 1], '127.0.0.1')
                token = kwargs['env']['LLAMA_API_KEY']; self.assertEqual(len(token), 64)
                self.assertNotIn(token, command); self.assertNotIn('LLAMA_ARG_HOST', kwargs['env'])
                httpd = http.server.HTTPServer(('127.0.0.1', int(command[command.index('--port') + 1])), Handler)
                thread = threading.Thread(target=httpd.serve_forever); thread.start()
                child = Mock(); child.poll.return_value = None
                return child
            try:
                with patch.dict('os.environ', {'LLAMA_ARG_HOST': '0.0.0.0', 'LLAMA_API_KEY': 'ambient'}), patch('subprocess.Popen', side_effect=launch): ns['load']()
                self.assertEqual([path for path, _ in requests], ['/health', '/props'])
                self.assertTrue(all(auth == 'Bearer ' + token for _, auth in requests))
                ns['encoder_token'] = 'wrong'
                with self.assertRaisesRegex(ns['Refusal'], 'native_request_failure'): ns['request']('/props')
                ns['encoder_token'] = token; mode = 'oversized'
                with self.assertRaisesRegex(ns['Refusal'], 'native_response_bound'): ns['request']('/props')
                with self.assertRaisesRegex(ns['Refusal'], 'native_path_failure'): ns['request']('http://elsewhere/')
                ns['close_native'](); self.assertIsNone(ns['encoder_token']); self.assertIsNone(ns['encoder_port'])
            finally:
                if httpd: httpd.shutdown(); httpd.server_close()
                if thread: thread.join(timeout=2); self.assertFalse(thread.is_alive())

    def test_entire_dependency_closure_rejects_omission_mutation_and_wrong_versions(self):
        with tempfile.TemporaryDirectory(prefix='pi-eg2-closure-') as directory:
            root = pathlib.Path(directory).resolve() / 'runtime'
            _, manifest, package, wheel = fixture(root)
            (root / 'assets.sha256.json').write_text(json.dumps(manifest))
            lock = root / 'requirements.lock'; original = lock.read_text()
            for changed in (original + original.splitlines()[0] + '\n',
                            '\n'.join(line for line in original.splitlines() if not line.startswith('huggingface-hub==')),
                            original.replace('huggingface-hub==1.33.0', 'huggingface-hub==0.36.0')):
                lock.write_text(changed)
                with self.assertRaisesRegex(ValueError, 'invalid_requirements_lock'):
                    UTILITY['validate_requirements'](root, manifest)
            lock.write_text(original)
            missing = {name: sha for name, sha in manifest.items() if 'hf_xet-' not in name}
            with self.assertRaisesRegex(ValueError, 'invalid_requirements_lock'):
                UTILITY['validate_requirements'](root, missing)
            spec = importlib.util.spec_from_file_location('tokenizers', package / '__init__.py')
            with patch('importlib.metadata.version', side_effect=utility_version), patch('importlib.util.find_spec', return_value=spec):
                UTILITY['verify_tokenizers'](root)
                for name in ('huggingface_hub/__init__.py', 'hf_xet/__init__.py', 'typing_extensions.py'):
                    path = package.parent / name; data = path.read_bytes(); path.write_bytes(b'# altered dependency')
                    with self.assertRaisesRegex(ValueError, 'tokenizers_integrity_failure'):
                        UTILITY['verify_tokenizers'](root)
                    path.write_bytes(data)
                with patch('importlib.metadata.version', side_effect=lambda name: '0.36.0' if name == 'huggingface-hub' else utility_version(name)):
                    with self.assertRaisesRegex(ValueError, 'runtime_version_mismatch'):
                        UTILITY['verify_tokenizers'](root)

    def test_python_check(self):
        for version in ((3, 12), (3, 13)): UTILITY['python_supported'](version)
        for version in ((3, 11), (3, 14), (2, 7)):
            with self.assertRaisesRegex(ValueError, 'python_3_12_or_3_13_required'): UTILITY['python_supported'](version)

    @unittest.skipUnless(sys.platform == 'darwin' and platform.machine() == 'arm64', 'The bundled companion provisions only on Darwin arm64')
    def test_publisher_lock_provision_and_rollback(self):
        with tempfile.TemporaryDirectory(prefix='pi-eg2-provision-') as directory:
            base = pathlib.Path(directory).resolve(); assets = base / 'assets'
            pins, manifest, package, wheel = fixture(assets, 'BF16')
            lock = {'format': 1, 'platform': 'darwin-arm64', 'python': '3.13', 'wheel': wheel, 'files': manifest}
            lock_path = base / 'publisher-lock.json'; lock_path.write_text(json.dumps(lock))
            PROVISION['verify_assets'](assets, lock)
            for kind in ('extra', 'link', 'corrupt'):
                path = assets / 'extra'
                if kind == 'link': path.symlink_to(assets / 'model.gguf')
                elif kind == 'extra': path.write_bytes(b'extra')
                else: (assets / 'model.gguf').write_bytes(b'corrupt')
                with self.assertRaises((RuntimeError, ValueError)): PROVISION['verify_assets'](assets, lock)
                if path.exists(): path.unlink()
            (assets / 'model.gguf').write_bytes(fixture_model('BF16'))
            target, environment, index, scratch = (base / name for name in ('runtime', 'permanent-env', 'index', 'scratch'))
            argv = ['provision', str(target), '--assets', str(assets), '--lock', str(lock_path), '--python', sys.executable,
                    '--environment-directory', str(environment), '--index-directory', str(index), '--scratch-directory', str(scratch)]
            with patch.object(sys, 'argv', argv), patch('platform.system', return_value='Darwin'), patch('platform.machine', return_value='arm64'), patch('subprocess.check_output', return_value='[[3, 13], "arm64"]'):
                for failure_at in (1, 2, 3, 4):
                    count = 0
                    def failed(command, **kwargs):
                        nonlocal count
                        count += 1
                        if count == failure_at: raise RuntimeError('effect failure')
                    with patch('subprocess.run', side_effect=failed):
                        with self.assertRaisesRegex(RuntimeError, 'effect failure'): PROVISION['main']()
                    self.assertFalse(target.exists()); self.assertFalse(environment.exists())
                    self.assertEqual((assets / 'model.gguf').read_bytes(), fixture_model('BF16'))
                with patch('subprocess.run') as calls:
                    PROVISION['main']()
                    config = json.loads((target / 'semantic-recall.json').read_text())
                    self.assertEqual(config, {'pythonPath': str(environment / 'bin/python'), 'runtimeRoot': str(target),
                                              'indexDirectory': str(index), 'scratchDirectory': str(scratch), 'queryWaitMs': 30000})
                    self.assertEqual(json.loads((target / 'assets.sha256.json').read_text()), manifest)
                    self.assertEqual((target / 'pins.json').read_bytes(), (assets / 'pins.json').read_bytes())
                    self.assertIn(str(environment), calls.call_args_list[0].args[0])
                    pip = calls.call_args_list[1].args[0]
                    self.assertTrue(all(flag in pip for flag in ('--no-compile', '--require-hashes', '--no-index', '--no-deps')))
                    self.assertFalse((target / 'env').exists())
                sentinel = target / 'user'; sentinel.write_bytes(b'keep')
                with self.assertRaisesRegex(RuntimeError, 'Destination already exists'): PROVISION['main']()
                self.assertEqual(sentinel.read_bytes(), b'keep')

    @unittest.skipUnless(sys.platform == 'win32', 'Actual Windows host refusal boundary')
    def test_windows_refuses_darwin_companion_before_provisioning(self):
        with tempfile.TemporaryDirectory(prefix='pi-eg2-foreign-companion-') as directory:
            base = pathlib.Path(directory).resolve(); assets = base / 'assets'; assets.mkdir()
            sentinel = assets / 'original'; sentinel.write_bytes(b'untouched companion bytes')
            target, environment, index, scratch = (base / name for name in ('runtime', 'permanent-env', 'index', 'scratch'))
            argv = ['provision', str(target), '--assets', str(assets), '--lock', str(assets / 'lock.json'), '--python', sys.executable,
                    '--environment-directory', str(environment), '--index-directory', str(index), '--scratch-directory', str(scratch)]
            with patch.object(sys, 'argv', argv), patch('subprocess.check_output') as probe, patch('subprocess.run') as effect:
                with self.assertRaisesRegex(RuntimeError, 'Only Darwin arm64 is qualified'): PROVISION['main']()
                probe.assert_not_called(); effect.assert_not_called()
            self.assertEqual(sentinel.read_bytes(), b'untouched companion bytes')
            self.assertEqual({path.relative_to(base).as_posix() for path in base.rglob('*')}, {'assets', 'assets/original'})


if __name__ == '__main__': unittest.main()
