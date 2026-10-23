import fs from "node:fs";
import path from "node:path";

let mode = null;
let pool = null;
let pglite = null;

function sslConfig(connectionString) {
  const setting = process.env.DATABASE_SSL;
  if (setting === "false") return false;
  if (setting === "true") return { rejectUnauthorized: false };

  try {
    const host = new URL(connectionString).hostname;
    if (host === "localhost" || host === "127.0.0.1" || host === "::1") return false;
    if (
      host.endsWith(".render.com") ||
      host.includes("neon.tech") ||
      host.includes("supabase.co") ||
      host.includes("supabase.com")
    ) {
      return { rejectUnauthorized: false };
    }
  } catch {
    // Fall through to no SSL.
  }
  return false;
}

async function createSchema() {
  const statements = [
    `CREATE TABLE IF NOT EXISTS clans (
      id BIGSERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      name_lower TEXT NOT NULL UNIQUE,
      tag TEXT NOT NULL,
      tag_lower TEXT NOT NULL UNIQUE,
      owner_id BIGINT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`,
    `CREATE TABLE IF NOT EXISTS users (
      id BIGSERIAL PRIMARY KEY,
      username TEXT NOT NULL,
      username_lower TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      coins DOUBLE PRECISION NOT NULL DEFAULT 0,
      total_clicks BIGINT NOT NULL DEFAULT 0,
      clan_id BIGINT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`,
    `CREATE INDEX IF NOT EXISTS users_clan_idx ON users (clan_id)`,
    `CREATE TABLE IF NOT EXISTS upgrade_levels (
      user_id BIGINT NOT NULL,
      upgrade_id TEXT NOT NULL,
      level INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (user_id, upgrade_id)
    )`,
    `CREATE INDEX IF NOT EXISTS upgrade_levels_user_idx ON upgrade_levels (user_id)`,
  ];

  for (const statement of statements) {
    await query(statement);
  }
}

export async function initDb() {
  const connectionString = process.env.DATABASE_URL;

  if (connectionString) {
    const pg = await import("pg");
    mode = "postgres";
    pool = new pg.default.Pool({
      connectionString,
      max: 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
      ssl: sslConfig(connectionString),
    });
    await pool.query("SELECT 1");
    console.log("[db] connected to PostgreSQL");
  } else {
    if (process.env.NODE_ENV === "production") {
      throw new Error("DATABASE_URL is required in production");
    }

    const { PGlite } = await import("@electric-sql/pglite");
    const dataDir = process.env.PGLITE_DIR || path.join(process.cwd(), ".data");
    fs.mkdirSync(dataDir, { recursive: true });
    pglite = new PGlite(dataDir);
    await pglite.waitReady;
    mode = "pglite";
    console.log(`[db] using embedded PostgreSQL at ${dataDir}`);
  }

  await createSchema();
}

export async function query(text, params = []) {
  if (mode === "postgres") {
    const result = await pool.query(text, params);
    return result.rows;
  }
  if (mode === "pglite") {
    const result = await pglite.query(text, params);
    return result.rows;
  }
  throw new Error("Database is not initialised");
}

export async function withTransaction(callback) {
  if (mode === "postgres") {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const tx = {
        query: async (text, params = []) => (await client.query(text, params)).rows,
      };
      const result = await callback(tx);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // Ignore rollback failures.
      }
      throw error;
    } finally {
      client.release();
    }
  }

  if (mode === "pglite") {
    await pglite.query("BEGIN");
    try {
      const tx = {
        query: async (text, params = []) => (await pglite.query(text, params)).rows,
      };
      const result = await callback(tx);
      await pglite.query("COMMIT");
      return result;
    } catch (error) {
      try {
        await pglite.query("ROLLBACK");
      } catch {
        // Ignore rollback failures.
      }
      throw error;
    }
  }

  throw new Error("Database is not initialised");
}

export async function closeDb() {
  if (pool) {
    await pool.end();
    pool = null;
  }
  if (pglite) {
    await pglite.close();
    pglite = null;
  }
}
