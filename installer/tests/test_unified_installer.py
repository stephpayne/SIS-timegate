"""Behavior contracts shared by the CLI and native launcher adapters."""
import json
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import unittest
from unittest import mock
import zipfile

from test_packaging import (
    PROJECT_ROOT, INSTALLER_DIR, SEAT_TIME_INVALID_CONFIG_CASES,
    _write_synthetic_package, _write_synthetic_scorm_2004_package,
)
from core.package import build_package, InstrumentationError
from core.config import load_timegate_config

CLI = INSTALLER_DIR / 'timegate.py'


def archive_course(root, dest):
    with zipfile.ZipFile(dest, 'w') as z:
        for p in root.rglob('*'):
            if p.is_file():
                z.write(p, p.relative_to(root))


def contents(path):
    with zipfile.ZipFile(path) as z:
        return {name: z.read(name) for name in z.namelist()}


class UnifiedInstallerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.course = self.root / 'course'
        _write_synthetic_package(self.course)
        self.source = self.root / 'course.zip'
        archive_course(self.course, self.source)

    def cli(self, *args):
        return subprocess.run([sys.executable, '-B', str(CLI), *map(str,args)], capture_output=True, text=True)

    def test_default_contract_matches_browser(self):
        # Evaluate only the literal fallback defaults, never the browser runtime.
        # Time limits are course inputs; the runtime separately requires valid config.
        js = (PROJECT_ROOT / 'src/timegate.js').read_text()
        literal = re.search(r'var DEFAULT_CONFIG = (\{.*?\n  \});', js, re.S).group(1)
        result = subprocess.check_output(['node', '-e', 'console.log(JSON.stringify('+literal+'))'], text=True)
        config = load_timegate_config(PROJECT_ROOT / 'src/timegate.config.json')
        for key, value in json.loads(result).items():
            if key not in {"minRequiredMinutes", "maxAllowedMinutes"}:
                self.assertEqual(config[key], value, key)
        self.assertEqual(json.loads(self.cli('defaults').stdout), config)

    def test_all_entry_points_produce_equivalent_content(self):
        for writer in (_write_synthetic_package, _write_synthetic_scorm_2004_package):
            # All inputs have the same immutable course identity, regardless of file name.
            root = self.root / writer.__name__
            writer(root)
            source = self.root / (writer.__name__ + '.zip')
            archive_course(root, source)
            reference = self.root / (writer.__name__ + '-reference.zip')
            result = self.cli('build', source, '--output', reference, '--minutes', 30,
                              '--maximum', 90, '--storage', 'localStorage')
            self.assertEqual(result.returncode, 0, result.stderr)
            expected = contents(reference)
            if os.name != 'nt':
                for wrapper in ['launchers/mac.command', 'launchers/raycast.sh']:
                    wrapped = self.root / (writer.__name__ + '-' + Path(wrapper).name + '.zip')
                    env = {**os.environ, 'TIMEGATE_PROJECT_ROOT': str(PROJECT_ROOT)}
                    r = subprocess.run(['bash', str(INSTALLER_DIR / wrapper), 'build', str(source),
                                        '--output', str(wrapped), '--minutes', '30', '--maximum', '90',
                                        '--storage', 'localStorage'], env=env, capture_output=True, text=True)
                    self.assertEqual(r.returncode, 0, r.stderr)
                    self.assertEqual(contents(wrapped), expected)
            pwsh = shutil.which('pwsh') or shutil.which('powershell.exe')
            if pwsh:
                wrapped = self.root / (writer.__name__ + '-windows.zip')
                r = subprocess.run([pwsh, '-NoProfile', '-File', str(INSTALLER_DIR / 'launchers/windows.ps1'),
                                    '-Cli', 'build', str(source), '--output', str(wrapped), '--minutes', '30',
                                    '--maximum', '90', '--storage', 'localStorage'], capture_output=True, text=True)
                self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
                self.assertEqual(contents(wrapped), expected)
            for name, value in contents(source).items():
                if name not in {'imsmanifest.xml', 'scormdriver/indexAPI.html'}:
                    self.assertEqual(expected[name], value)
            self.assertFalse(any('observability' in name for name in expected))

    def test_publish_requires_explicit_replace_and_preserves_source(self):
        before = self.source.read_bytes()
        result = build_package(self.source, PROJECT_ROOT)
        output = Path(result['output'])
        saved = output.read_bytes()
        with self.assertRaisesRegex(InstrumentationError, 'already exists'):
            build_package(self.source, PROJECT_ROOT)
        self.assertEqual(output.read_bytes(), saved)
        build_package(self.source, PROJECT_ROOT, replace=True, overrides={'storageMode':'localStorage'})
        self.assertEqual(self.source.read_bytes(), before)
        self.assertFalse((self.course / 'timegate').exists())
        self.assertTrue(result['verified'])

    def test_failed_validation_does_not_publish_or_mutate_source(self):
        before = self.source.read_bytes()
        output = self.root / 'existing.zip'
        output.write_bytes(b'preserve this output')
        with mock.patch('core.package._verify_rendered', side_effect=InstrumentationError('injected failure')):
            with self.assertRaisesRegex(InstrumentationError, 'injected failure'):
                build_package(self.source, PROJECT_ROOT, output, replace=True)
        self.assertEqual(output.read_bytes(), b'preserve this output')
        self.assertEqual(before, self.source.read_bytes())
        self.assertFalse(list(self.root.glob('.timegate-*')))

    def test_archive_path_ambiguities_are_rejected(self):
        for names in [('../escape',), ('/absolute',), ('C:/drive',), ('a\\b',),
                      ('same', 'same'), ('FILE', 'file')]:
            source = self.root / 'unsafe.zip'
            with zipfile.ZipFile(source, 'w') as z:
                for name in names: z.writestr(name, 'payload')
            with self.subTest(names=names), self.assertRaises(InstrumentationError):
                build_package(source, PROJECT_ROOT)
            self.assertFalse((self.root / 'unsafe-timegate.zip').exists())
        with zipfile.ZipFile(source, 'w') as z:
            entry = zipfile.ZipInfo('link'); entry.create_system = 3
            entry.external_attr = (stat.S_IFLNK | 0o777) << 16
            z.writestr(entry, '../outside')
        with self.assertRaises(InstrumentationError): build_package(source, PROJECT_ROOT)

    def test_mode_switches_preserve_identity_and_do_not_duplicate_tags(self):
        previous = self.source
        key = None
        for index, mode in enumerate(['localStorage', 'dual', 'localStorage']):
            output = self.root / f'output-{index}.zip'
            result = build_package(previous, PROJECT_ROOT, output, overrides={'storageMode': mode})
            data = contents(output)
            config = json.loads(data['timegate/timegate.config.json'])
            if key is not None: self.assertEqual(config['courseKey'], key)
            key = config['courseKey']
            launch = data['scormdriver/indexAPI.html'].decode()
            self.assertEqual(launch.count('data-timegate-storage-mode="localStorage"'), int(mode == 'localStorage'))
            self.assertEqual(launch.count('src="../timegate/timegate.js"'), 1)
            previous = output

    def test_shared_validator_covers_removed_powershell_cases(self):
        for label, config, error in SEAT_TIME_INVALID_CONFIG_CASES:
            path = self.root / 'bad.json'; path.write_text(json.dumps(config))
            result = self.cli('validate', path)
            self.assertNotEqual(result.returncode, 0, label)
            self.assertIn(error, result.stderr)
        for config in [[], {'minRequiredMinutes':1,'audioCuesEnabled':'true'},
                       {'minRequiredMinutes':1,'storageMode':'invalid'},
                       {'minRequiredMinutes':1,'enforceCompletion':'false'}]:
            path.write_text(json.dumps(config))
            self.assertNotEqual(self.cli('validate', path).returncode, 0)

    def test_profile_is_explicit_redacted_and_preserves_relay_on_resume_package(self):
        profile = self.root / 'profile.json'
        settings = {'seatTimeReportingEnabled': True, 'seatTimeRelayUrl':'https://relay.example.test/ingest',
                    'seatTimeRelayKey':'private-test-key', 'courseId':'test-course'}
        profile.write_text(json.dumps({'timegate':settings}))
        preview = self.cli('preview', self.source, '--profile', profile)
        self.assertEqual(preview.returncode, 0, preview.stderr)
        self.assertNotIn('private-test-key', preview.stdout)
        result = self.cli('build', self.source, '--profile', profile)
        self.assertEqual(result.returncode, 0, result.stderr)
        output = Path(json.loads(result.stdout)['output'])
        update = self.root / 'updated.zip'
        build_package(output, PROJECT_ROOT, update, overrides={'minRequiredMinutes':30})
        config = json.loads(contents(update)['timegate/timegate.config.json'])
        for key, value in settings.items(): self.assertEqual(config[key],value)

    def test_observability_opt_in_and_scorm_2004_rejection(self):
        telemetry = dict(endpoint='https://worker.example.test/ingestScormTelemetry',source_key_id='rise-pilot',
                         pilot_token='pilot-token-12345',paycom_course_id='course-123')
        result = build_package(self.source, PROJECT_ROOT, telemetry=telemetry)
        self.assertTrue(result['telemetryEnabled'])
        self.assertNotIn(telemetry['pilot_token'], json.dumps(result))
        self.assertIn('timegate/observability/host.js', contents(Path(result['output'])))
        root = self.root/'scorm2004';_write_synthetic_scorm_2004_package(root)
        from core.observability import DescriptorError
        with self.assertRaises(DescriptorError): build_package(root,PROJECT_ROOT,telemetry=telemetry)
        self.assertFalse((self.root/'scorm2004-timegate.zip').exists())

    @unittest.skipIf(os.name == 'nt', 'Mac shell adapter contract')
    def test_actual_registered_raycast_launcher_reaches_storage_choice_and_cancel(self):
        launcher = Path.home()/'Downloads/time-gate-installer.sh'
        if not launcher.exists(): launcher = INSTALLER_DIR/'launchers/raycast.sh'
        tools = self.root/'bin';tools.mkdir()
        log = self.root/'dialogs.txt'
        fake = tools/'osascript'
        fake.write_text('''#!/bin/bash
body="$(cat)"
printf '%s\\n' "$body" >> "$DIALOG_LOG"
case "$body" in
 *"Choose the original SCORM ZIP"*) printf '%s' "$SOURCE_ZIP" ;;
 *"Minimum required time in minutes:"*) printf '30' ;;
 *"Maximum active time in minutes"*) printf '90' ;;
 *"Where should Timegate save"*) printf 'Cancel' ;;
 *) exit 9 ;;
esac
''');fake.chmod(0o755)
        env = {k:v for k,v in os.environ.items() if not k.startswith('TIMEGATE_')}
        env.update(PATH=str(tools)+os.pathsep+env['PATH'],SOURCE_ZIP=str(self.source),DIALOG_LOG=str(log),TIMEGATE_PROJECT_ROOT=str(PROJECT_ROOT))
        r = subprocess.run(['bash',str(launcher)],env=env,capture_output=True,text=True)
        self.assertEqual(r.returncode,0,r.stderr)
        self.assertIn('Local storage only',log.read_text())
        self.assertFalse((self.root/'course-timegate.zip').exists())

    @unittest.skipIf(os.name == 'nt', 'Mac dialog adapter contract')
    def test_mac_review_cancel_and_confirmed_build(self):
        tools = self.root / 'dialog-tools'
        tools.mkdir()
        fake = tools / 'osascript'
        fake.write_text('''#!/bin/bash
body="$(cat)"
printf '%s\\n' "$@" >> "$DIALOG_LOG"
case "$body" in
 *"Choose the original SCORM ZIP"*) printf '%s' "$SOURCE_ZIP" ;;
 *"Minimum required time in minutes:"*) printf '30' ;;
 *"Maximum active time in minutes"*) printf '90' ;;
 *"Where should Timegate save"*) printf 'Local storage only' ;;
 *"Use standard settings"*) printf '' ;;
 *"Create Package"*) printf '%s' "$REVIEW_DECISION" ;;
 *'buttons {"OK"}'*) printf 'OK' ;;
 *) exit 9 ;;
esac
''')
        fake.chmod(0o755)
        reveal = tools / 'open'
        reveal.write_text('#!/bin/bash\nexit 0\n')
        reveal.chmod(0o755)
        env = {k:v for k,v in os.environ.items() if not k.startswith('TIMEGATE_')}
        log = self.root / 'review.txt'
        env.update(PATH=str(tools)+os.pathsep+env['PATH'], SOURCE_ZIP=str(self.source),
                   DIALOG_LOG=str(log), TIMEGATE_PROJECT_ROOT=str(PROJECT_ROOT))
        output = self.root / 'course-timegate.zip'
        for decision in ['Cancel', 'Create Package']:
            env['REVIEW_DECISION'] = decision
            result = subprocess.run(['bash', str(INSTALLER_DIR/'launchers/mac.command')],
                                    env=env, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(output.exists(), decision == 'Create Package')
        self.assertIn('Persistence: localStorage', log.read_text())
        self.assertIn('Telemetry: off', log.read_text())
        config = json.loads(contents(output)['timegate/timegate.config.json'])
        self.assertEqual(config['storageMode'], 'localStorage')
        self.assertEqual(config['minRequiredMinutes'], 30)
        self.assertEqual(config['maxAllowedMinutes'], 90)

    def test_nested_source_build_and_legacy_update_keep_correct_root(self):
        wrapper = self.root / 'nested'
        package = wrapper / 'export'
        _write_synthetic_package(package)
        zipped = self.root / 'nested.zip'
        archive_course(wrapper, zipped)
        result = build_package(zipped, PROJECT_ROOT)
        self.assertIn('imsmanifest.xml', contents(Path(result['output'])))
        self.assertFalse((package / 'timegate').exists())
        build_package(wrapper, PROJECT_ROOT, self.root / 'legacy.zip', in_place=True)
        self.assertTrue((package / 'timegate/timegate.config.json').is_file())
        self.assertFalse((wrapper / 'timegate').exists())
