import pg from 'pg';

export type SqlClient = Pick<pg.PoolClient, 'query'>;

export class PostgresDatabase {
  private readonly pool: pg.Pool;

  constructor(config: pg.PoolConfig) {
    this.pool = new pg.Pool(config);
  }

  async migrate(sql: string): Promise<void> {
    await this.pool.query(sql);
  }

  async transaction<T>(operation: (client: SqlClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    let result: T;
    try {
      await client.query('BEGIN');
      result = await operation(client);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    return result;
  }

  close(): Promise<void> {
    return this.pool.end();
  }
}
