#!/usr/bin/env python3
"""Offline EG2 provisioning from an exact companion lock; pi-tuck's setup downloads and assembles the companion first."""
import argparse
import json
import os
import pathlib
import platform
import runpy
import shutil
import signal
import subprocess

RUNTIME = runpy.run_path(str(pathlib.Path(__file__).with_name('eg2-runtime.py')))
RESERVE = 5 * 1024**3


def verify_assets(root, lock):
    if lock.get('format') != 1 or lock.get('platform') != 'darwin-arm64' or lock.get('python') not in ('3.12', '3.13'):
        raise RuntimeError('Unsupported companion lock')
    manifest = lock['files']
    RUNTIME['validate_manifest'](manifest)
    if lock.get('wheel') not in manifest:
        raise RuntimeError('Missing pinned wheel')
    actual = set()
    for path in root.rglob('*'):
        if path.is_symlink() or not (path.is_file() or path.is_dir()):
            raise RuntimeError('Companion contains a link or unsupported member')
        if path.is_file():
            actual.add(str(path.relative_to(root)))
    if actual != set(manifest):
        raise RuntimeError('Exact companion membership differs')
    RUNTIME['verify_files'](root, manifest)
    pins = RUNTIME['read_json'](root / 'pins.json')
    RUNTIME['validate_pins'](pins, manifest)
    RUNTIME['validate_requirements'](root, manifest)
    RUNTIME['verify_gguf'](root / 'model.gguf', pins['backend']['artifact'])


def outside(base, path):
    return base != path and base not in path.parents


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('destination', type=pathlib.Path, help='NEW absolute external immutable asset root')
    parser.add_argument('--assets', required=True, type=pathlib.Path, help='extracted exact companion directory')
    parser.add_argument('--lock', required=True, type=pathlib.Path, help='format-1 lock binding every companion file to its SHA-256')
    parser.add_argument('--python', required=True, type=pathlib.Path, help='absolute native arm64 Python 3.12 or 3.13 with venv/ensurepip')
    parser.add_argument('--environment-directory', type=pathlib.Path, help='NEW permanent venv path; default destination/env; never relocate')
    parser.add_argument('--index-directory', required=True, type=pathlib.Path, help='absolute external disposable cache, outside runtime/project')
    parser.add_argument('--scratch-directory', type=pathlib.Path, help='external mutable parent; default index sibling')
    args = parser.parse_args()
    if platform.system() != 'Darwin' or platform.machine() != 'arm64':
        raise RuntimeError('Only Darwin arm64 is qualified')
    paths = [args.destination, args.assets, args.lock, args.python, args.index_directory]
    paths += [p for p in (args.environment_directory, args.scratch_directory) if p is not None]
    if not all(p.is_absolute() for p in paths):
        raise RuntimeError('Use absolute paths')
    if os.path.lexists(args.destination):
        raise RuntimeError('Destination already exists; no overwrite/repair')
    target, assets, index = args.destination.resolve(), args.assets.resolve(), args.index_directory.resolve()
    environment = args.environment_directory or target / 'env'
    if args.environment_directory is not None and os.path.lexists(environment):
        raise RuntimeError('Environment already exists; no overwrite/repair')
    environment = environment.resolve()
    scratch = (args.scratch_directory or index.parent).resolve()
    if (not outside(target, index) or not outside(target, scratch) or not outside(target, assets)
            or not outside(environment, index) or not outside(environment, scratch)
            or (args.environment_directory is not None and (not outside(target, environment) or not outside(environment, target)))):
        raise RuntimeError('Assets/environment/cache/scratch must not overlap software destinations')
    for path in (args.destination, args.index_directory, args.environment_directory, args.scratch_directory):
        if path is not None and any(p.is_symlink() for p in (path, *path.parents)):
            raise RuntimeError('Destination/cache/scratch symlink forbidden')
    probe = json.loads(subprocess.check_output([str(args.python), '-I', '-B', '-c', 'import sys,platform,json; print(json.dumps([list(sys.version_info[:2]),platform.machine()]))'], text=True))
    RUNTIME['python_supported'](probe[0])
    if probe[1] != 'arm64':
        raise RuntimeError('Native arm64 Python required')
    lock = RUNTIME['read_json'](args.lock)
    verify_assets(assets, lock)
    if '.'.join(map(str, probe[0])) != lock['python']:
        raise RuntimeError('Python differs from the exact companion lock')
    ancestor = target.parent
    while not ancestor.exists():
        ancestor = ancestor.parent
    size = sum((assets / name).stat().st_size for name in lock['files'])
    if shutil.disk_usage(ancestor).free < RESERVE + size + 256 * 1024**2:
        raise RuntimeError('5 GiB reserve plus setup headroom required')
    # Only newly created destinations are rollback-owned. Never copy an existing venv.
    target.parent.mkdir(parents=True, exist_ok=True)
    target.mkdir(mode=0o700)
    complete = False
    environment_owned = False
    def interrupted(signum, frame):
        raise KeyboardInterrupt('Setup interrupted')
    previous = signal.signal(signal.SIGTERM, interrupted)
    try:
        for name in lock['files']:
            output = target / name
            output.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(assets / name, output)
        RUNTIME['verify_files'](target, lock['files'])
        (target / 'native/llama-server').chmod(0o755)
        if args.environment_directory is not None:
            environment.parent.mkdir(parents=True, exist_ok=True)
            environment.mkdir(mode=0o700)
            environment_owned = True
        subprocess.run([str(args.python), '-I', '-B', '-m', 'venv', str(environment)], check=True)
        python = str(environment / 'bin/python')
        subprocess.run([python, '-I', '-B', '-m', 'pip', '--isolated', 'install', '--no-index', '--no-cache-dir', '--no-compile', '--no-deps', '--only-binary=:all:', '--require-hashes', '--find-links', str(target / 'wheels'), '-r', str(target / 'requirements.lock')], check=True)
        subprocess.run([python, '-I', '-B', '-m', 'pip', '--isolated', 'check'], check=True)
        # ensurepip explicitly compiles its seed even under -B. No installed
        # bytecode may remain; -B alone does not prohibit loading existing pyc.
        for path in environment.rglob('*'):
            if path.is_file() and path.suffix in ('.pyc', '.pyo'):
                path.unlink()
        for path in sorted(environment.rglob('__pycache__'), reverse=True):
            if path.is_dir(): shutil.rmtree(path)
        # The retained exact wheels verify the entire utility closure membership/bytes.
        (target / 'assets.sha256.json').write_text(json.dumps(lock['files'], indent=2) + '\n')
        check = 'import runpy,sys,pathlib; m=runpy.run_path(sys.argv[1]); root=pathlib.Path(sys.argv[2]); m["python_supported"](); m["verify_runtime"](root); m["verify_tokenizers"](root); from tokenizers import Tokenizer; Tokenizer.from_file(str(root/"models/embedding/tokenizer.json"))'
        subprocess.run([python, '-I', '-B', '-c', check, str(pathlib.Path(__file__).with_name('eg2-runtime.py')), str(target)], check=True)
        config = target / 'semantic-recall.json'
        value = {'pythonPath': python, 'runtimeRoot': str(target), 'indexDirectory': str(index), 'queryWaitMs': 30000}
        if args.scratch_directory is not None:
            value['scratchDirectory'] = str(scratch)
        config.write_text(json.dumps(value, indent=2) + '\n')
        config.chmod(0o600)
        complete = True
        print(str(config))
    finally:
        signal.signal(signal.SIGTERM, previous)
        if not complete:
            if environment_owned:
                shutil.rmtree(environment)
            shutil.rmtree(target)


if __name__ == '__main__':
    main()
