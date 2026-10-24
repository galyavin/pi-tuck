"""Bounded publisher metadata/target-marker evidence, not foreign native acceptance.

Run with AB1_PACKAGING_LOCK and AB1_PUBLISHER_INPUTS pointing to operator pins/cache.
No downloads, resolver, package execution, or credentials. Every target variant
must be present and hash-validated; parsing foreign wheels is source evidence only.
"""
import email
import hashlib
import json
import os
import pathlib
import runpy
import unittest
import zipfile

UTILITY = runpy.run_path(str(pathlib.Path(__file__).resolve().parent.parent / 'scripts/eg2-runtime.py'))


@unittest.skipUnless(os.environ.get('AB1_PACKAGING_LOCK') and os.environ.get('AB1_PUBLISHER_INPUTS'), 'explicit publisher metadata inputs required')
class MetadataTests(unittest.TestCase):
    def test_exact_small_closure_and_target_markers(self):
        from pip._vendor.packaging.requirements import Requirement
        lock = json.loads(pathlib.Path(os.environ['AB1_PACKAGING_LOCK']).read_text())
        cache = pathlib.Path(os.environ['AB1_PUBLISHER_INPUTS'])

        def resolve(value):
            if not isinstance(value, str): return value
            result = lock
            for part in value[2:].split('/'):
                result = result[int(part)] if isinstance(result, list) else result[part]
            self.assertNotIsInstance(result, str)
            return result

        def key(wheel): return UTILITY['normalized'](wheel['name'].split('-')[0])
        for target, recipe in lock['targets'].items():
            with self.subTest(target=target):
                windows = recipe['platform'] == 'win32'
                expected = UTILITY['utility_versions']({'native/llama-server.exe': ''} if windows else {})
                wheels = {key(resolve(w)): resolve(w) for w in recipe['eg2']['wheels']}
                self.assertEqual(len(wheels), len(recipe['eg2']['wheels']))
                self.assertEqual(wheels.keys(), expected.keys())
                layout = {key(resolve(w)): resolve(w) for w in recipe['layout']['wheels'] if 'name' in resolve(w)}
                environment = dict(python_version='3.13', python_full_version='3.13.15', extra='',
                                   platform_machine='arm64' if recipe['arch'] == 'arm64' else ('AMD64' if windows else 'x86_64'),
                                   platform_system='Windows' if windows else ('Darwin' if recipe['platform'] == 'darwin' else 'Linux'),
                                   sys_platform=recipe['platform'], os_name='nt' if windows else 'posix',
                                   implementation_name='cpython', platform_python_implementation='CPython')
                reached = {'tokenizers'}
                pending = ['tokenizers']
                while pending:
                    name = pending.pop()
                    pin = wheels[name]
                    self.assertEqual(pin, layout[name])  # reuse exact native target variant/hash
                    self.assertEqual(pin['name'].split('-')[1], expected[name][0])
                    path = cache / pin['sha256']
                    self.assertTrue(path.is_file(), 'Missing actual target wheel: ' + pin['name'])
                    self.assertEqual(path.stat().st_size, pin['size'])
                    self.assertEqual(hashlib.sha256(path.read_bytes()).hexdigest(), pin['sha256'])
                    with zipfile.ZipFile(path) as archive:
                        members = archive.namelist()
                        self.assertEqual(len(members), len(set(members)))
                        payload = set(expected[name][1]) | {name.replace('-', '_') + '.libs', name.replace('-', '_') + '-' + expected[name][0] + '.dist-info'}
                        self.assertLessEqual({member.split('/')[0] for member in members}, payload)
                        metadata = email.message_from_bytes(archive.read(next(n for n in members if n.endswith('/METADATA'))))
                        self.assertEqual(UTILITY['normalized'](metadata['Name']), name)
                        self.assertEqual(metadata['Version'], expected[name][0])
                    for declaration in metadata.get_all('Requires-Dist', []):
                        dependency = Requirement(declaration)
                        if dependency.marker and not dependency.marker.evaluate(environment): continue
                        self.assertFalse(dependency.extras)
                        self.assertIsNone(dependency.url)
                        dependency_name = UTILITY['normalized'](dependency.name)
                        self.assertIn(dependency_name, wheels, declaration)
                        self.assertTrue(dependency.specifier.contains(expected[dependency_name][0]), declaration)
                        if dependency_name not in reached:
                            reached.add(dependency_name); pending.append(dependency_name)
                self.assertEqual(reached, wheels.keys())  # no extra layout/Torch or unnecessary library
                self.assertEqual('colorama' in reached, windows)
                self.assertNotIn('tomli', reached)  # Python <3.11 marker is false

    def test_bundled_companion_has_same_new_closure_identity(self):
        lock = json.loads(pathlib.Path(os.environ['AB1_PACKAGING_LOCK']).read_text())
        companion = json.loads((pathlib.Path(__file__).resolve().parent.parent / 'scripts/eg2-assets.lock.json').read_text())
        wheels = []
        for reference in lock['targets']['darwin-arm64-macos14']['eg2']['wheels']:
            wheels.append(lock['layout']['wheels'][int(reference.rsplit('/', 1)[1])])
        requirement = ''.join(w['requirement'] + ' --hash=sha256:' + w['sha256'] + '\n' for w in wheels)
        self.assertEqual(companion['python'], '3.13')
        self.assertEqual(companion['files']['requirements.lock'], hashlib.sha256(requirement.encode()).hexdigest())
        self.assertEqual({name: sha for name, sha in companion['files'].items() if name.startswith('wheels/')},
                         {'wheels/' + w['name']: w['sha256'] for w in wheels})


if __name__ == '__main__': unittest.main()
