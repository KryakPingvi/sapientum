import { randomUUID } from 'node:crypto';
import type { TestContext } from 'node:test';
import pg from 'pg';
import { PostgresDatabase } from '../src/infrastructure/postgres.js';

const url = process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/sapientum_test';

async function admin(sql: string): Promise<void> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query(sql);
  } finally {
    await client.end();
  }
}

export async function testSchema(t: TestContext, ...migrations: string[]) {
  const schema = `test_${randomUUID().replaceAll('-', '')}`;
  await admin(`CREATE SCHEMA ${schema}`);
  const opened: PostgresDatabase[] = [];
  const open = () => {
    const database = new PostgresDatabase({ connectionString: url, options: `-c search_path=${schema}` });
    opened.push(database);
    return database;
  };
  t.after(async () => {
    await Promise.all(opened.map((database) => database.close()));
    await admin(`DROP SCHEMA ${schema} CASCADE`);
  });
  const database = open();
  for (const migration of migrations) await database.migrate(migration);
  return { database, open };
}
