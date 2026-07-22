import { spawnSync } from 'child_process';
import path from 'path';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '../..');
const etlPaths = [
  'src/etl/ingest-laps.py',
  'src/etl/ingest-laps-2025.py',
  'src/etl/ingest-laps-2026.py'
];

const guardProbe = String.raw`
import importlib.util
import json
import sys
import types

dotenv = types.ModuleType('dotenv')
dotenv.load_dotenv = lambda: None
sys.modules['dotenv'] = dotenv

fastf1 = types.ModuleType('fastf1')
fastf1.Cache = types.SimpleNamespace(enable_cache=lambda _: None)
sys.modules['fastf1'] = fastf1

pandas = types.ModuleType('pandas')
pandas.DataFrame = object
sys.modules['pandas'] = pandas

psycopg2 = types.ModuleType('psycopg2')
extras = types.ModuleType('psycopg2.extras')
extras.execute_values = lambda *args: None
sys.modules['psycopg2'] = psycopg2
sys.modules['psycopg2.extras'] = extras

class Cursor:
    def __init__(self, connection):
        self.connection = connection
    def __enter__(self):
        return self
    def __exit__(self, *args):
        return False
    def execute(self, sql, params):
        self.connection.sql = sql
        self.connection.params = params
    def fetchone(self):
        # A legacy-only row must not make the v2 guard report this round loaded.
        count = self.connection.v2_count if 'laps_normalized_v2' in self.connection.sql else self.connection.legacy_count
        return (count,)

class Connection:
    def __init__(self, legacy_count, v2_count):
        self.legacy_count = legacy_count
        self.v2_count = v2_count
        self.sql = ''
        self.params = ()
    def cursor(self):
        return Cursor(self)

results = []
for index, source_path in enumerate(sys.argv[1:]):
    spec = importlib.util.spec_from_file_location(f'etl_{index}', source_path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)

    legacy_only = Connection(legacy_count=9, v2_count=0)
    v2_loaded = Connection(legacy_count=0, v2_count=9)
    results.append({
        'legacy_only_skips': module.check_race_already_loaded(legacy_only, 2026, 3),
        'v2_loaded_skips': module.check_race_already_loaded(v2_loaded, 2026, 3),
        'v2_only_query': 'laps_normalized_v2' in legacy_only.sql and 'FROM laps_normalized\n' not in legacy_only.sql,
        'session_scoped': 'session_type' in legacy_only.sql and legacy_only.params == (2026, 3, 'R')
    })

print(json.dumps(results))
`;

describe('v2 lap ETL idempotency guards', () => {
  it('allows v2 ingestion when only legacy laps exist and skips when v2 facts exist', () => {
    const result = spawnSync('python3', ['-c', guardProbe, ...etlPaths], {
      cwd: repoRoot,
      encoding: 'utf8'
    });

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(
      etlPaths.map(() => ({
        legacy_only_skips: false,
        v2_loaded_skips: true,
        v2_only_query: true,
        session_scoped: true
      }))
    );
  });
});
