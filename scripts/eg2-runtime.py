#!/usr/bin/env python3
"""Shared offline EG2 schema/byte verification; publisher authenticity belongs to the host."""
import hashlib
import json
import pathlib
import re
import sys

OFFICIAL_REVISION = '914f7f89142e33e77833254d9c9b90c3cef7303b'
NATIVE_COMMIT = '988190680d5a89fce97de3c20df2c2813731fd61'  # llama.cpp release b11476, what pi-tuck's setup installs
# Runtimes provisioned earlier with a source build of llama.cpp at 448147d stay valid.
NATIVE_COMMITS = (NATIVE_COMMIT, '448147d42a71d0147c6dc844f99f9ffe7419183a')
ARTIFACTS = ('Q4_0', 'Q4_K_S', 'Q4_K_M', 'Q8_0', 'BF16')
COMPUTE = 'CPU float32 with f32 KV; quantized weights where selected'
POOLING = 'mask-aware mean including prompt, projected token states, then float32 L2'
REQUIRED = {'model.gguf', 'models/embedding/tokenizer.json', 'pins.json', 'requirements.lock'}
NATIVE_SERVERS = {'native/llama-server', 'native/llama-server.exe'}
# Small mandatory tokenizers closure, derived from the pinned wheel METADATA.
# No extras, layout stack, network resolver, or alternate versions.
UTILITIES = {
    'tokenizers': ('0.23.2', ('tokenizers', 'tokenizers.libs')),
    'huggingface-hub': ('1.33.0', ('huggingface_hub',)),
    'anyio': ('4.15.1', ('anyio',)), 'certifi': ('2026.7.22', ('certifi',)),
    'click': ('8.5.0', ('click',)), 'filelock': ('4.0.12', ('filelock',)),
    'fsspec': ('2026.9.0', ('fsspec',)), 'h11': ('0.16.0', ('h11',)),
    'hf-xet': ('1.7.0', ('hf_xet',)), 'httpcore': ('1.0.9', ('httpcore',)),
    'httpx': ('0.28.1', ('httpx',)), 'idna': ('3.20', ('idna',)),
    'packaging': ('26.3', ('packaging',)), 'pyyaml': ('6.0.3', ('yaml', '_yaml')),
    'tqdm': ('4.70.1', ('tqdm',)),
    'typing-extensions': ('4.16.0', ('typing_extensions.py',)),
}


def utility_versions(manifest):
    result = dict(UTILITIES)
    if 'native/llama-server.exe' in manifest:
        result['colorama'] = ('0.4.6', ('colorama',))
    return result


def normalized(name):
    return re.sub('[-_.]+', '-', name).lower()


def digest(path):
    h = hashlib.sha256()
    with path.open('rb') as stream:
        while data := stream.read(1024 * 1024):
            h.update(data)
    return h.hexdigest()


def read_json(path):
    def unique(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError('duplicate_json_key')
            result[key] = value
        return result
    return json.loads(path.read_text(), object_pairs_hook=unique)


def python_supported(version=None):
    if tuple(sys.version_info[:2] if version is None else version) not in ((3, 12), (3, 13)):
        raise ValueError('python_3_12_or_3_13_required')


def validate_manifest(manifest):
    if not isinstance(manifest, dict) or not REQUIRED <= manifest.keys():
        raise ValueError('incomplete_asset_manifest')
    if len(NATIVE_SERVERS & manifest.keys()) != 1:
        raise ValueError('invalid_native_server_inventory')
    for name, sha in manifest.items():
        if not isinstance(name, str):
            raise ValueError('asset_path_failure')
        path = pathlib.PurePosixPath(name)
        if not name or path.is_absolute() or '..' in path.parts or path.as_posix() != name or '\\' in name or ':' in name:
            raise ValueError('asset_path_failure')
        if not isinstance(sha, str) or not re.fullmatch('[0-9a-f]{64}', sha):
            raise ValueError('invalid_asset_digest')


def validate_pins(pins, manifest):
    validate_manifest(manifest)
    e, b, r = (pins.get(name, {}) for name in ('embedding', 'backend', 'runtime'))
    if (e.get('model') != 'google/embeddinggemma-2' or e.get('revision') != OFFICIAL_REVISION
            or e.get('dimensions') != 768 or e.get('maxTokens') != 8192
            or e.get('queryInstruction') != 'task: search result | query: '
            or e.get('documentInstruction') != 'title: none | text: '
            or e.get('pooling') != POOLING):
        raise ValueError('invalid_embedding_pin')
    if (b.get('name') != 'llama.cpp' or b.get('commit') not in NATIVE_COMMITS
            or b.get('artifact') not in ARTIFACTS or e.get('dtype') != b.get('artifact')
            or b.get('modelSHA256') != manifest['model.gguf'] or b.get('gpuLayers') != 0
            or b.get('compute') != COMPUTE or b.get('computePrecision', 'float32') != 'float32'
            or b.get('modelRepository') != 'unsloth/embeddinggemma-2-GGUF'
            or not isinstance(b.get('modelRevision'), str)
            or not re.fullmatch('[0-9a-f]{40}', b['modelRevision'])):
        raise ValueError('invalid_backend_pin')
    if r.get('tokenizers') != '0.23.2':
        raise ValueError('runtime_version_mismatch')


def verify_files(root, manifest):
    validate_manifest(manifest)
    for name, expected in manifest.items():
        path = root / name
        if any(p.is_symlink() for p in (path, *path.parents)) or not path.is_file():
            raise ValueError('asset_path_failure')
        if digest(path) != expected:
            raise ValueError('asset_integrity_failure')


def verify_gguf(path, artifact):
    import struct
    types = {'Q4_0': 2, 'Q4_K_S': 14, 'Q4_K_M': 15, 'Q8_0': 7, 'BF16': 32}
    widths = {0: 1, 1: 1, 2: 2, 3: 2, 4: 4, 5: 4, 6: 4, 7: 1, 10: 8, 11: 8, 12: 8}
    size = path.stat().st_size
    with path.open('rb') as stream:
        def read(n):
            data = stream.read(n)
            if len(data) != n:
                raise ValueError('invalid_gguf_header')
            return data
        def number(fmt):
            return struct.unpack('<' + fmt, read(struct.calcsize(fmt)))[0]
        def string(keep=True):
            length = number('Q')
            if length > 16 * 1024 * 1024 or stream.tell() + length > size:
                raise ValueError('invalid_gguf_header')
            if keep:
                return read(length).decode('utf-8')
            stream.seek(length, 1)
        def value(kind, keep=False, depth=0):
            if kind == 8:
                return string(keep)
            if kind == 9 and depth == 0:
                element, count = number('I'), number('Q')
                if count > 2000000:
                    raise ValueError('invalid_gguf_header')
                if element in widths:
                    stream.seek(widths[element] * count, 1)
                else:
                    for _ in range(count): value(element, False, depth + 1)
            elif kind in widths:
                data = read(widths[kind])
                if keep and kind == 4:
                    return struct.unpack('<I', data)[0]
            else:
                raise ValueError('invalid_gguf_header')
            if stream.tell() > size:
                raise ValueError('invalid_gguf_header')
        if read(4) != b'GGUF' or number('I') != 3:
            raise ValueError('unsupported_gguf_format')
        tensors, count = number('Q'), number('Q')
        if not 1 <= tensors <= 100000 or not 1 <= count <= 10000:
            raise ValueError('invalid_gguf_header')
        found = {}
        for _ in range(count):
            name, kind = string(), number('I')
            wanted = name in ('general.architecture', 'general.file_type')
            data = value(kind, wanted)
            if wanted:
                if name in found:
                    raise ValueError('invalid_gguf_header')
                found[name] = data
        if found != {'general.architecture': 'gemma-embedding2', 'general.file_type': types[artifact]}:
            raise ValueError('gguf_pin_mismatch')


def verify_runtime(root):
    manifest = read_json(root / 'assets.sha256.json')
    verify_files(root, manifest)
    pins = read_json(root / 'pins.json')
    validate_pins(pins, manifest)
    validate_requirements(root, manifest)
    verify_gguf(root / 'model.gguf', pins['backend']['artifact'])
    return pins


def validate_requirements(root, manifest):
    expected = utility_versions(manifest)
    locked = {}
    for line in (root / 'requirements.lock').read_text().splitlines():
        match = re.fullmatch(r'([A-Za-z0-9_.-]+)==([A-Za-z0-9.+_-]+) --hash=sha256:([0-9a-f]{64})', line)
        if not match or normalized(match[1]) in locked:
            raise ValueError('invalid_requirements_lock')
        name = normalized(match[1])
        if name not in expected or match[2] != expected[name][0]:
            raise ValueError('invalid_requirements_lock')
        locked[name] = match[3]
    if locked.keys() != expected.keys():
        raise ValueError('invalid_requirements_lock')
    wheels = [name for name in manifest if name.startswith('wheels/') and name.endswith('.whl')]
    if wheels:
        found = set()
        for wheel in wheels:
            parts = pathlib.PurePosixPath(wheel).name[:-4].split('-')
            name = normalized(parts[0])
            if (len(parts) not in (5, 6) or name in found or name not in expected
                    or parts[1] != expected[name][0] or manifest[wheel] != locked[name]):
                raise ValueError('invalid_requirements_lock')
            found.add(name)
        if found != expected.keys():
            raise ValueError('invalid_requirements_lock')
    elif not any('/site-packages/tokenizers/' in name and name.endswith(('.so', '.pyd')) for name in manifest):
        raise ValueError('missing_exact_tokenizers_assets')
    return expected


def verify_tokenizers(root):
    import importlib.metadata
    import importlib.util
    import zipfile
    manifest = read_json(root / 'assets.sha256.json')
    validate_manifest(manifest)
    utilities = validate_requirements(root, manifest)
    for name, (version, _) in utilities.items():
        if importlib.metadata.version(name) != version:
            raise ValueError('runtime_version_mismatch')
    spec = importlib.util.find_spec('tokenizers')
    if spec is None or spec.origin is None:
        raise ValueError('tokenizers_origin_failure')
    package = pathlib.Path(spec.origin).parent
    wheels = [name for name in manifest if name.startswith('wheels/') and name.endswith('.whl')]
    for wheel in wheels:
        if digest(root / wheel) != manifest[wheel]:
            raise ValueError('tokenizers_integrity_failure')
    # Bind the whole utility payload, including Windows extensions and bundled DLLs.
    # Bytecode is not accepted: -B prevents writes but does not prevent loading old pyc.
    for _, members in utilities.values():
        if not any((package.parent / member).exists() for member in members):
            raise ValueError('tokenizers_membership_failure')
    payload = {member for _, members in utilities.values() for member in members} | {name.replace('-', '_') + '.libs' for name in utilities}
    metadata = {name.replace('-', '_') + '-' + version + '.dist-info' for name, (version, _) in utilities.items()}
    def utility_member(name):
        return name.split('/')[0] in payload | metadata
    actual = set()
    for tree in (package.parent / name for name in payload | metadata):
        if any(p.is_symlink() for p in (tree, *tree.parents)):
            raise ValueError('tokenizers_origin_failure')
        for path in ([tree] if tree.is_file() else tree.rglob('*')):
            if path.is_symlink():
                raise ValueError('tokenizers_origin_failure')
            if path.is_file():
                name = path.relative_to(package.parent).as_posix()
                if path.suffix in ('.pyc', '.pyo'):
                    raise ValueError('tokenizers_membership_failure')
                actual.add(name)
    if not wheels:
        # A managed runtime binds every installed library byte, including dependency
        # metadata/native companions and the signed interpreter's pip seed.
        actual = set()
        for path in package.parent.rglob('*'):
            if path.is_symlink():
                raise ValueError('tokenizers_origin_failure')
            if path.is_file():
                if path.suffix in ('.pyc', '.pyo'):
                    raise ValueError('tokenizers_membership_failure')
                actual.add(path.relative_to(package.parent).as_posix())
        try:
            prefix = package.parent.relative_to(root).as_posix() + '/'
        except ValueError:
            raise ValueError('tokenizers_origin_failure')
        names = {name[len(prefix):] for name in manifest if name.startswith(prefix)}
        if names != actual:
            raise ValueError('tokenizers_membership_failure')
        for name in names:
            if digest(package.parent / name) != manifest[prefix + name]:
                raise ValueError('tokenizers_integrity_failure')
    else:
        # pip rewrites RECORD and adds installation bookkeeping. Root admission
        # verifies their exact signed-pip parity; never treat editable RECORD as authority.
        generated = {directory + '/' + leaf for directory in metadata for leaf in ('RECORD', 'INSTALLER', 'REQUESTED')}
        names = set()
        for wheel in wheels:
            with zipfile.ZipFile(root / wheel) as archive:
                inventory = archive.namelist()
                if len(set(inventory)) != len(inventory):
                    raise ValueError('tokenizers_membership_failure')
                for name in inventory:
                    path = pathlib.PurePosixPath(name)
                    if (path.is_absolute() or '..' in path.parts or '\\' in name or ':' in name
                            or path.as_posix() != name.rstrip('/')):
                        raise ValueError('asset_path_failure')
                members = {name for name in inventory if utility_member(name) and not name.endswith('/') and name not in generated}
                if names & members:
                    raise ValueError('tokenizers_membership_failure')
                names.update(members)
                for name in members:
                    if not (package.parent / name).is_file() or (package.parent / name).read_bytes() != archive.read(name):
                        raise ValueError('tokenizers_integrity_failure')
        if names != actual - generated:
            raise ValueError('tokenizers_membership_failure')


def configuration_identity(root, worker_path):
    h = hashlib.sha256()
    # Raw bytes bind all publisher metadata, including optional vision/encoder configuration.
    for path in (root / 'pins.json', root / 'requirements.lock', root / 'assets.sha256.json',
                 pathlib.Path(worker_path), pathlib.Path(__file__)):
        data = path.read_bytes()
        h.update(len(data).to_bytes(8, 'big'))
        h.update(data)
    h.update(str(sys.version_info[:3]).encode())
    return h.hexdigest()
