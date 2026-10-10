// db.js — local-first (better-sqlite3) with Turso cloud backup
const path = require("path");
const fs = require("fs");
const Database = require("better-sqlite3");
const { createClient } = require("@libsql/client");

const DATA_DIR = process.env.DATA_DIR || __dirname;
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const LOCAL_DB_PATH = path.join(DATA_DIR, "voting-local.db");

/* ---------- local database (source of truth) ---------- */
const local = new Database(LOCAL_DB_PATH);
local.pragma("journal_mode = WAL");
local.pragma("synchronous = NORMAL");
local.pragma("foreign_keys = OFF");

// Write-ahead queue: every write is logged here so we can replay it to Turso
local.exec(`
  CREATE TABLE IF NOT EXISTS _sync_queue (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sql TEXT NOT NULL,
    args TEXT,
    attempts INTEGER DEFAULT 0,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
`);

/* ---------- cloud client (backup) ---------- */
const remote = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

/* ---------- helpers ---------- */
function isWrite(sql) {
  const s = sql.trim().toUpperCase();
  return /^(INSERT|UPDATE|DELETE|REPLACE)/.test(s);
}

/**
 * Rewrites a plain INSERT into an INSERT OR REPLACE so re-applying the
 * same statement to Turso is idempotent. Prevents "UNIQUE constraint failed"
 * when local and cloud have drifted.
 */
function makeIdempotent(sql) {
  const trimmed = sql.trim();
  if (/^INSERT\s+OR\s+REPLACE/i.test(trimmed)) return trimmed;
  if (/^INSERT\s+INTO/i.test(trimmed)) {
    return trimmed.replace(/^INSERT\s+INTO/i, "INSERT OR REPLACE INTO");
  }
  return trimmed;
}

function enqueue(sql, args) {
  if (!isWrite(sql)) return;
  try {
    const normalized = makeIdempotent(sql);
    local
      .prepare("INSERT INTO _sync_queue (sql, args) VALUES (?, ?)")
      .run(normalized, JSON.stringify(args || []));
  } catch (e) {
    console.error("[Queue]", e.message);
  }
}

/* ---------- adapter that mimics the async API server.js expects ---------- */
function prepare(sql) {
  const stmt = local.prepare(sql);
  return {
    async get(...args) {
      return stmt.get(...args) || null;
    },
    async all(...args) {
      return stmt.all(...args);
    },
    async run(...args) {
      const r = stmt.run(...args);
      enqueue(sql, args);
      return {
        changes: Number(r.changes || 0),
        lastInsertRowid:
          r.lastInsertRowid != null ? Number(r.lastInsertRowid) : null,
      };
    },
  };
}

async function exec(sqlBlock) {
  local.exec(sqlBlock);
}

/** Transaction wrapper — same callback shape as before. */
async function tx(fn) {
  local.exec("BEGIN IMMEDIATE");
  const wrapper = {
    execute: async ({ sql, args }) => {
      const stmt = local.prepare(sql);
      const r = stmt.run(...(args || []));
      enqueue(sql, args || []);
      return {
        rowsAffected: Number(r.changes || 0),
        lastInsertRowid:
          r.lastInsertRowid != null ? Number(r.lastInsertRowid) : null,
      };
    },
  };
  try {
    const out = await fn(wrapper);
    local.exec("COMMIT");
    return out;
  } catch (e) {
    try {
      local.exec("ROLLBACK");
    } catch (rb) {
      console.error("[tx rollback]", rb.message);
    }
    throw e;
  }
}

/* ================================================================
   CLOUD SYNC
   ================================================================ */

/**
 * Push pending writes from the queue to Turso.
 *
 * Rules:
 *  - Successful write → delete row from queue.
 *  - UNIQUE constraint violation → drop row (the data is already in
 *    Turso; the local state is authoritative and will be re-pulled
 *    on the next cycle anyway).
 *  - Any other error → increment attempt count; drop after 5 tries so
 *    one bad row can't permanently block the queue.
 */
async function push() {
  let pushed = 0;
  const MAX_PER_RUN = 500;

  while (pushed < MAX_PER_RUN) {
    const row = local
      .prepare(
        "SELECT id, sql, args, attempts FROM _sync_queue ORDER BY id ASC LIMIT 1",
      )
      .get();
    if (!row) break;

    const args = row.args ? JSON.parse(row.args) : [];
    try {
      await remote.execute({ sql: row.sql, args });
      local.prepare("DELETE FROM _sync_queue WHERE id = ?").run(row.id);
      pushed++;
    } catch (e) {
      const msg = String(e.message || "");

      // Duplicate row already in Turso — nothing to do, drop it.
      if (
        msg.includes("UNIQUE constraint failed") ||
        msg.includes("SQLITE_CONSTRAINT")
      ) {
        console.warn(`[Push] Dropping row ${row.id} — already exists in cloud`);
        local.prepare("DELETE FROM _sync_queue WHERE id = ?").run(row.id);
        continue;
      }

      // Malformed SQL — log it, drop the row so the queue keeps flowing.
      if (
        msg.includes("syntax error") ||
        msg.includes("no such table") ||
        msg.includes("no such column")
      ) {
        console.error(
          `[Push] Dropping row ${row.id} — unrecoverable SQL: ${msg}`,
        );
        console.error(`       SQL: ${row.sql}`);
        local.prepare("DELETE FROM _sync_queue WHERE id = ?").run(row.id);
        continue;
      }

      // Transient error — retry with backoff; drop after 5 tries.
      const attempts = (row.attempts || 0) + 1;
      if (attempts >= 5) {
        console.error(
          `[Push] Dropping row ${row.id} after ${attempts} attempts: ${msg}`,
        );
        console.error(`       SQL: ${row.sql}`);
        local.prepare("DELETE FROM _sync_queue WHERE id = ?").run(row.id);
        continue;
      }
      local
        .prepare("UPDATE _sync_queue SET attempts = ? WHERE id = ?")
        .run(attempts, row.id);
      console.warn(`[Push] Transient failure (attempt ${attempts}): ${msg}`);
      break; // pause this cycle, retry next time
    }
  }

  return { pushed };
}

/** Pull all rows from Turso into local. Uses INSERT OR REPLACE so it's idempotent. */
async function pull() {
  const TABLES = [
    "categories",
    "users",
    "nominees",
    "transactions",
    "leaderboard_access",
    "payment_logs",
    "admins",
  ];

  let pulled = 0;
  for (const table of TABLES) {
    try {
      const res = await remote.execute(`SELECT * FROM ${table}`);
      if (!res.rows || !res.rows.length) continue;

      const columns = res.columns;
      if (!columns || !columns.length) continue;

      const placeholders = columns.map(() => "?").join(",");
      const sql = `INSERT OR REPLACE INTO ${table} (${columns.join(",")}) VALUES (${placeholders})`;
      const stmt = local.prepare(sql);

      const insertMany = local.transaction((rows) => {
        for (const row of rows) {
          const values = Array.isArray(row) ? row : columns.map((c) => row[c]);
          stmt.run(...values);
        }
      });

      insertMany(res.rows);
      pulled += res.rows.length;
    } catch (e) {
      console.warn(`[Pull] ${table}: ${e.message}`);
    }
  }
  return { pulled };
}

/* ================================================================
   BOOTSTRAP
   ================================================================ */

async function verifyConnection() {
  if (!process.env.TURSO_DATABASE_URL) {
    throw new Error("TURSO_DATABASE_URL is not set in .env");
  }
  if (!process.env.TURSO_AUTH_TOKEN) {
    throw new Error("TURSO_AUTH_TOKEN is not set in .env");
  }
  console.log(`  Turso URL: ${process.env.TURSO_DATABASE_URL.slice(0, 45)}…`);
  await remote.execute("SELECT 1 AS ok");
  console.log("  ✓ Turso cloud reachable");
  console.log(`  Local DB:  ${LOCAL_DB_PATH}`);
}

/**
 * Called AFTER initSchema() so the local tables exist.
 * If the local DB has no rows in `categories`, assume fresh install and pull.
 */
async function bootstrapIfEmpty() {
  let isEmpty;
  try {
    const row = local.prepare("SELECT COUNT(*) AS c FROM categories").get();
    isEmpty = !row || Number(row.c) === 0;
  } catch {
    isEmpty = true;
  }

  if (!isEmpty) {
    console.log("  Local DB has data — using as primary");
    return;
  }

  console.log("  → Local DB is empty — pulling from Turso Cloud…");
  const { pulled } = await pull();
  console.log(`  ✓ Pull complete — ${pulled} row(s) restored`);
}

/* ---------- misc ---------- */
async function checkpoint() {
  try {
    local.pragma("wal_checkpoint(TRUNCATE)");
  } catch {}
}

async function walSize() {
  try {
    return fs.statSync(LOCAL_DB_PATH + "-wal").size;
  } catch {
    return 0;
  }
}

function getQueueSize() {
  try {
    return local.prepare("SELECT COUNT(*) AS c FROM _sync_queue").get().c;
  } catch {
    return 0;
  }
}

module.exports = {
  prepare,
  exec,
  tx,
  push,
  pull,
  checkpoint,
  walSize,
  verifyConnection,
  bootstrapIfEmpty,
  getQueueSize,
  LOCAL_DB_PATH,
};
