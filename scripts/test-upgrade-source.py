"""Linux/WSL control-flow tests. All Docker/network commands are fakes."""
import io
import json
import os
from pathlib import Path
import subprocess
import tarfile
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / 'deploy/upgrade-source.sh'
MOCK = r'''#!/usr/bin/env python3
import json, os, pathlib, shutil, sys
root=pathlib.Path(os.environ['FAKE_ROOT']); a=sys.argv[1:]
with (root/'calls').open('a') as f:f.write(json.dumps([pathlib.Path(sys.argv[0]).name]+a)+chr(10))
def done(text='',rc=0):
 print(text) if text else None
 sys.exit(rc)
if pathlib.Path(sys.argv[0]).name=='curl':
 if os.getenv('DOWNLOAD_FAIL'):done(rc=22)
 shutil.copyfile(root/'source.tar.gz',a[a.index('--output')+1]);done()
if a[0]=='info':done()
if a[0]=='inspect':
 if '--format' not in a:done((root/'inspect.json').read_text())
 fmt=a[a.index('--format')+1]
 if 'working_dir' in fmt:done(str(root/'old'))
 if 'com.docker.compose.project' in fmt:done('customer')
 if '.State.Running' in fmt:done('false' if os.getenv('DB_DEAD') else 'true')
 if '.Image' in fmt:done('sha256:oldimage')
if a[0] in ['start','logs','image']:done()
if a[0]=='ps':done('old-app-container')
if a[0]=='cp':shutil.copyfile(root/'dump',a[2]);done()
if a[0]=='exec':
 if 'psql' in a:done('180006|false' if 'server_version_num' in a[-1] else '9')
 if 'pg_dump' in a:(root/'dump').write_bytes(b'fake-custom-dump');done()
 if 'pg_restore' in a:done('fake archive contents')
 if 'node' in a and '-p' in a:done('1.6.10')
 done()
if a[0]=='compose':
 if 'version' in a:done('Compose 2.30')
 if 'config' in a:done((root/'config.json').read_text() if '--format' in a else '')
 if 'run' in a and os.getenv('MIGRATION_FAIL'):done('simulated migration error',4)
 if 'ps' in a:done('new-api' if 'api-gateway' in a else 'new-web')
 done()
done('unexpected mock command: '+repr(a),2)
'''


class UpgradeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        old = self.root/'old'
        old.mkdir()
        (old/'.env').write_text('COMPOSE_PROJECT_NAME=customer\n')
        services = {name:{'build':{'context':str(old/folder)},'environment':{'SAMPLE':'literal$secret'}}
                    for name,folder in [('api-gateway','api-gateway'),('migrator','api-gateway'),
                    ('collector-go','collector-go'),('notifier','collector-go'),
                    ('discovery-worker','collector-go'),('web-vue3','web-vue3')]}
        services['postgres']={'image':'postgres:18-alpine','environment':{'POSTGRES_PASSWORD':'p$a$$word'},
            'volumes':[{'type':'volume','source':'pg','target':'/var/lib/postgresql'}]}
        services['migrator']['volumes']=[{'type':'bind','source':str(old/'postgres'/name),'target':target}
              for name,target in [('schema.sql','/app/schema.sql'),('migrations','/app/migrations')]]
        self.config={'name':'customer','services':services,'volumes':{'pg':{'name':'customer_pg'}}}
        (self.root/'config.json').write_text(json.dumps(self.config))
        (old/'docker-compose.yml').write_text(json.dumps(self.config))
        (self.root/'inspect.json').write_text(json.dumps([{'Config':{'Env':['POSTGRES_PASSWORD=p$a$$word']},
            'Mounts':[{'Type':'volume','Name':'customer_pg','Destination':'/var/lib/postgresql'}]}]))
        with tarfile.open(self.root/'source.tar.gz','w:gz') as archive:
            for folder in ['api-gateway','web-vue3']:
                data=b'{"version":"1.6.10"}'
                m=tarfile.TarInfo(f'snmp-1.6.10/{folder}/package.json');m.size=len(data)
                archive.addfile(m,io.BytesIO(data))
        bin_dir=self.root/'bin';bin_dir.mkdir()
        for name in ['docker','curl']:
            f=bin_dir/name;f.write_text(MOCK);f.chmod(0o755)
        self.env={**os.environ,'FAKE_ROOT':str(self.root),'PATH':str(bin_dir)+':'+os.environ['PATH']}

    def tearDown(self):
        self.temp.cleanup()

    def run_upgrade(self, **flags):
        result=subprocess.run(['bash',str(SCRIPT),str(self.root/'old')],env={**self.env,**flags},
                              text=True,capture_output=True,timeout=20)
        return result

    def calls(self):
        p=self.root/'calls'
        return [json.loads(line) for line in p.read_text().splitlines()] if p.exists() else []

    def test_precheck_pins_volume_contexts_and_literal_secrets(self):
        r=self.run_upgrade(CHECK_ONLY='1');self.assertEqual(r.returncode,0,r.stdout+r.stderr)
        folder=next(self.root.glob('source-v1.6.10-*'))
        config=json.loads((folder/'docker-compose.yml').read_text())
        self.assertEqual(config['volumes']['pg'],{'external':True,'name':'customer_pg'})
        self.assertEqual(config['services']['postgres']['environment']['POSTGRES_PASSWORD'],'p$$a$$$$word')
        self.assertEqual(config['services']['api-gateway']['build']['context'],str(folder/'api-gateway'))
        self.assertEqual(config['services']['migrator']['volumes'][1]['source'],str(folder/'postgres/migrations'))
        self.assertFalse(any('stop' in a or 'run' in a for a in self.calls()))

    def test_wrong_volume_stops_before_application_changes(self):
        self.config['volumes']['pg']['name']='wrong-volume'
        (self.root/'config.json').write_text(json.dumps(self.config))
        r=self.run_upgrade();self.assertNotEqual(r.returncode,0)
        self.assertIn('空数据库',r.stderr)
        self.assertFalse(any('stop' in a for a in self.calls()))

    def test_database_failure_does_not_download_or_stop_apps(self):
        r=self.run_upgrade(DB_DEAD='1');self.assertNotEqual(r.returncode,0)
        self.assertFalse(any(a[0]=='curl' or 'stop' in a for a in self.calls()))

    def test_download_failure_does_not_stop_apps(self):
        r=self.run_upgrade(DOWNLOAD_FAIL='1');self.assertNotEqual(r.returncode,0)
        self.assertFalse(any('stop' in a for a in self.calls()))

    def test_migration_failure_keeps_backup_and_does_not_start_apps(self):
        r=self.run_upgrade(MIGRATION_FAIL='1');self.assertNotEqual(r.returncode,0)
        self.assertTrue(list(self.root.glob('backups/*/database.dump')))
        self.assertTrue(any('stop' in a for a in self.calls()))
        self.assertFalse(any('up' in a for a in self.calls()))

    def test_success_backups_before_migration_and_preserves_database(self):
        r=self.run_upgrade();self.assertEqual(r.returncode,0,r.stdout+r.stderr)
        calls=self.calls()
        dump=next(i for i,a in enumerate(calls) if 'pg_dump' in a)
        migrate=next(i for i,a in enumerate(calls) if 'run' in a)
        start=next(i for i,a in enumerate(calls) if 'up' in a)
        self.assertLess(dump,migrate);self.assertLess(migrate,start)
        self.assertIn('--no-deps',calls[start]);self.assertNotIn('postgres',calls[start])
        self.assertFalse(any('down' in a for a in calls))


if __name__=='__main__':
    unittest.main()
