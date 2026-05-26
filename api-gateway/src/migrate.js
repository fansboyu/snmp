import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const { Pool } = pg;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const databaseUrl = process.env.DATABASE_URL;
const baselineFile = process.env.MIGRATION_BASELINE_SQL || path.resolve(__dirname, '../schema.sql');
const migrationsDir = process.env.MIGRATIONS_DIR || path.resolve(__dirname, '../migrations');

if (!databaseUrl) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}

const pool = new Pool({ connectionString: databaseUrl });

function checksum(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function normalizeSql(content) {
  return content.replace(/^\uFEFF/, '');
}

function migrationName(fileName) {
  return fileName.replace(/^\d+_?/, '').replace(/\.sql$/i, '') || fileName;
}

async function ensureMigrationTable(client) {
  await client.query(`
    create table if not exists schema_migrations (
      version text primary key,
      name text not null,
      checksum text,
      applied_at timestamptz not null default now()
    )
  `);
}

async function hasMigration(client, version) {
  const result = await client.query('select 1 from schema_migrations where version = $1', [version]);
  return result.rowCount > 0;
}

async function recordMigration(client, version, name, sql) {
  await client.query(
    `insert into schema_migrations (version, name, checksum)
     values ($1, $2, $3)
     on conflict (version) do nothing`,
    [version, name, checksum(sql)]
  );
}

async function runSqlMigration(client, version, name, sql) {
  console.log(`Running migration ${version} ${name}`);
  await client.query('begin');
  try {
    await client.query(sql);
    await recordMigration(client, version, name, sql);
    await client.query('commit');
    console.log(`Migration ${version} ${name} applied`);
  } catch (error) {
    await client.query('rollback');
    throw error;
  }
}

async function runBaseline(client) {
  const version = '001';
  const name = 'baseline_v1_5_3';

  if (await hasMigration(client, version)) {
    console.log('Baseline migration already applied');
    return;
  }

  const sql = normalizeSql(await fs.readFile(baselineFile, 'utf8'));
  await runSqlMigration(client, version, name, sql);
}

async function listMigrationFiles() {
  try {
    const entries = await fs.readdir(migrationsDir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && /^\d+_.+\.sql$/i.test(entry.name))
      .map((entry) => entry.name)
      .sort((left, right) => left.localeCompare(right, 'en'));
  } catch (error) {
    if (error.code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}

async function runPendingMigrations(client) {
  const files = await listMigrationFiles();

  for (const fileName of files) {
    const version = fileName.split('_', 1)[0];
    const name = migrationName(fileName);

    if (version === '001') {
      console.log(`Skipping ${fileName}; version 001 is reserved for baseline`);
      continue;
    }

    if (await hasMigration(client, version)) {
      console.log(`Migration ${fileName} already applied`);
      continue;
    }

    const sql = normalizeSql(await fs.readFile(path.join(migrationsDir, fileName), 'utf8'));
    await runSqlMigration(client, version, name, sql);
  }

  if (files.length === 0) {
    console.log('No extra migration files found');
  }
}

async function main() {
  const client = await pool.connect();

  try {
    await ensureMigrationTable(client);
    await runBaseline(client);
    await runPendingMigrations(client);
    console.log('Database migrations completed');
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error('Database migration failed');
  console.error(error);
  process.exit(1);
});
