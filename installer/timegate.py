#!/usr/bin/env python3
"""Single Timegate installer CLI. Python 3.10+; standard library only."""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import sys
import zipfile
import xml.etree.ElementTree as ET

from core.config import load_timegate_config, validate_timegate_config
from core.package import build_package, inspect_package, extract_source
import tempfile

ROOT = Path(__file__).resolve().parent.parent


def settings(args):
    overrides = {}
    telemetry = None
    if args.profile:
        profile = json.loads(args.profile.read_text(encoding='utf-8-sig'))
        if not isinstance(profile, dict) or set(profile) - {'timegate', 'observability'}:
            raise ValueError('Advanced profile accepts only timegate and observability objects')
        overrides = profile.get('timegate', {})
        if not isinstance(overrides, dict):
            raise ValueError('timegate must be an object')
        telemetry = profile.get('observability')
        if telemetry is not None and (not isinstance(telemetry, dict) or set(telemetry) != {'endpoint', 'source_key_id', 'pilot_token', 'paycom_course_id'}):
            raise ValueError('observability requires endpoint, source_key_id, pilot_token, and paycom_course_id')
    overrides = dict(overrides)
    for arg, key in [('minutes', 'minRequiredMinutes'), ('maximum', 'maxAllowedMinutes'), ('storage', 'storageMode')]:
        value = getattr(args, arg)
        if value is not None:
            overrides[key] = None if value == 'none' else value
    if args.observability:
        telemetry = dict(endpoint=args.telemetry_endpoint, source_key_id=args.source_key_id,
                         pilot_token=args.pilot_token, paycom_course_id=args.paycom_course_id)
    return overrides, telemetry


def parser():
    p = argparse.ArgumentParser(description=__doc__)
    sub = p.add_subparsers(dest='command', required=True)
    sub.add_parser('defaults', help='Show canonical package defaults')
    validate = sub.add_parser('validate', help='Validate a Timegate configuration')
    validate.add_argument('config', type=Path)
    inspect = sub.add_parser('inspect', help='Read course identity without changing it')
    inspect.add_argument('source', type=Path)
    for command in ['preview', 'build']:
        b = sub.add_parser(command)
        b.add_argument('source', type=Path, help='Original ZIP or unpacked course directory')
        b.add_argument('--source-root', type=Path, default=ROOT, help=argparse.SUPPRESS)
        b.add_argument('--output', type=Path)
        b.add_argument('--minutes', type=float)
        b.add_argument('--maximum', type=lambda x: 'none' if x.lower() in {'none', 'null'} else float(x))
        b.add_argument('--storage', choices=['localStorage', 'dual', 'suspend_data'])
        b.add_argument('--config', '--timegate-config', type=Path)
        b.add_argument('--profile', type=Path, help='Advanced JSON profile; may explicitly enable observability')
        b.add_argument('--replace', action='store_true')
        b.add_argument('--in-place', action='store_true', help='Legacy: update unpacked input after verifying output')
        b.add_argument('--observability', action='store_true', help='Explicitly enable the SCORM 1.2 telemetry pilot')
        b.add_argument('--telemetry-endpoint', default=os.getenv('SCORM_TELEMETRY_ENDPOINT', ''))
        b.add_argument('--source-key-id', default=os.getenv('SCORM_SOURCE_KEY_ID', ''))
        b.add_argument('--pilot-token', default=os.getenv('SCORM_PILOT_TOKEN', ''), help=argparse.SUPPRESS)
        b.add_argument('--paycom-course-id', default=os.getenv('PAYCOM_COURSE_ID', ''))
    return p


def main(argv=None):
    args = parser().parse_args(argv)
    try:
        if args.command == 'defaults':
            result = load_timegate_config(ROOT / 'src/timegate.config.json')
        elif args.command == 'validate':
            load_timegate_config(args.config)
            result = {'valid': True}
        elif args.command == 'inspect':
            result = inspect_package(args.source)
        else:
            overrides, telemetry = settings(args)
            if args.command == 'preview':
                info = inspect_package(args.source)
                with tempfile.TemporaryDirectory() as d:
                    root = extract_source(args.source.resolve(), Path(d))
                    existing = root / 'timegate/timegate.config.json'
                    chosen = args.config or (existing if existing.exists() else args.source_root / 'src/timegate.config.json')
                    effective = {**load_timegate_config(args.source_root / 'src/timegate.config.json'),
                                 **load_timegate_config(chosen), **overrides}
                    validate_timegate_config(effective)
                if telemetry:
                    from core.package import _validate_endpoint, _validate_identifier, _validate_token
                    _validate_endpoint(telemetry['endpoint'])
                    _validate_identifier('Source-key ID', telemetry['source_key_id'], 64)
                    _validate_identifier('Paycom Course ID', telemetry['paycom_course_id'])
                    _validate_token(telemetry['pilot_token'])
                    if info['scormVersion'] != '1.2':
                        raise ValueError('Observability currently supports SCORM 1.2 only')
                result = {**info, 'settings': {k:v for k,v in effective.items() if k not in {'seatTimeRelayKey','seatTimeRelayUrl'}},
                          'telemetryEnabled': bool(telemetry),
                          'output': str((args.output or args.source.with_name(args.source.stem + '-timegate.zip')).absolute())}
            else:
                result = build_package(args.source, args.source_root, args.output, replace=args.replace,
                                       config_path=args.config, overrides=overrides, telemetry=telemetry, in_place=args.in_place)
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0
    except (OSError, ValueError, TypeError, KeyError, zipfile.BadZipFile, ET.ParseError) as exc:
        print(f'Timegate: {exc}', file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
