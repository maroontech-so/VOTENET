// db.js — local-first (better-sqlite3) with Turso cloud backup
const path = require("path");
const fs = require("fs");
const Database = require("better-sqlite3");
const { createClient } = require("@libsql/client");

const DATA_DIR = process.env.DATA_DIR || __dirname;
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const LOCAL_DB_PATH = path.join(DATA_DIR, "voting-local.db");

/* ---------- local database (source of truth for vote counts) ---------- */
const local = new Database(LOCAL_DB_PATH);
local.pragma("journal_mode = WAL");
local.pragma("synchronous = NORMAL");
local.pragma("foreign_keys = OFF");

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

let _pushFailures = 0;
let _lastPushError = null;

function getPushFailures() {
  return { count: _pushFailures, lastError: _lastPushError };
}

/* ---------- helpers ---------- */
function isWrite(sql) {
  const s = sql.trim().toUpperCase();
  return /^(INSERT|UPDATE|DELETE|REPLACE)/.test(s);
}

function makeIdempotent(sql) {
  const trimmed = sql.trim();
  if (/^INSERT\s+OR\s+(REPLACE|IGNORE)/i.test(trimmed)) return trimmed;
  if (/^INSERT\s+INTO/i.test(trimmed)) {
    return trimmed.replace(/^INSERT\s+INTO/i, "INSERT OR IGNORE INTO");
  }
  return trimmed;
}

function serializeArg(a) {
  if (Buffer.isBuffer(a)) return { __buf: a.toString("base64") };
  if (a instanceof Uint8Array)
    return { __buf: Buffer.from(a).toString("base64") };
  return a;
}

function deserializeArg(a) {
  if (a && typeof a === "object" && typeof a.__buf === "string") {
    return Buffer.from(a.__buf, "base64");
  }
  return a;
}

function enqueue(sql, args) {
  if (!isWrite(sql)) return;
  try {
    const normalized = makeIdempotent(sql);
    const serializable = (args || []).map(serializeArg);
    local
      .prepare("INSERT INTO _sync_queue (sql, args) VALUES (?, ?)")
      .run(normalized, JSON.stringify(serializable));
  } catch (e) {
    console.error("[Queue]", e.message);
  }
}

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
    get: async (sql, args) => {
      const stmt = local.prepare(sql);
      return stmt.get(...(args || [])) || null;
    },
    all: async (sql, args) => {
      const stmt = local.prepare(sql);
      return stmt.all(...(args || []));
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

    const rawArgs = row.args ? JSON.parse(row.args) : [];
    const args = rawArgs.map(deserializeArg);

    try {
      await remote.execute({ sql: row.sql, args });
      local.prepare("DELETE FROM _sync_queue WHERE id = ?").run(row.id);
      pushed++;
      _pushFailures = 0;
      _lastPushError = null;
    } catch (e) {
      const msg = String(e.message || "");
      _lastPushError = msg;

      if (
        msg.includes("UNIQUE constraint failed") ||
        msg.includes("SQLITE_CONSTRAINT")
      ) {
        console.warn(`[Push] Dropping row ${row.id} — already exists in cloud`);
        local.prepare("DELETE FROM _sync_queue WHERE id = ?").run(row.id);
        continue;
      }

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
      _pushFailures++;
      console.warn(`[Push] Transient failure (attempt ${attempts}): ${msg}`);
      break;
    }
  }

  return { pushed };
}

/**
 * Pull from Turso.
 *
 * - `nominees`: UPSERT updates metadata but PRESERVES local `votes` AND all
 *   stage-related columns (stage, eliminated, eliminated_stage, qualified_at,
 *   final_rank) — those are controlled locally by super admin and should never
 *   be overwritten by stale cloud values.
 * - `election_stages`: NOT pulled — super admin config is local source of truth.
 *   Table exists on Turso via ensureRemoteSchema for backup.
 * - Append-only tables use INSERT OR IGNORE (never overwrite local status).
 * - Config tables (categories, admins, ip_lookup_cache) use INSERT OR REPLACE.
 */
async function pull() {
  const REPLACE_TABLES = ["categories", "admins", "ip_lookup_cache"];
  const IGNORE_TABLES = [
    "users",
    "free_votes",
    "transactions",
    "leaderboard_access",
    "nominee_boosts",
    "payment_logs",
    "vote_reports",
    "vote_appeals",
    "vote_allowances",
  ];
  // Election stages is intentionally NOT pulled. Local is authoritative for
  // super-admin stage config. Push syncs local to cloud for backup only.

  let pulled = 0;

  for (const table of REPLACE_TABLES) {
    try {
      const res = await remote.execute(`SELECT * FROM ${table}`);
      if (!res.rows || !res.rows.length) continue;
      const cols = res.columns;
      if (!cols || !cols.length) continue;
      const sql = `INSERT OR REPLACE INTO ${table} (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`;
      const stmt = local.prepare(sql);
      const insertMany = local.transaction((rows) => {
        for (const row of rows) {
          const values = Array.isArray(row) ? row : cols.map((c) => row[c]);
          stmt.run(...values);
        }
      });
      insertMany(res.rows);
      pulled += res.rows.length;
    } catch (e) {
      console.warn(`[Pull] ${table}:`, e.message);
    }
  }

  for (const table of IGNORE_TABLES) {
    try {
      const res = await remote.execute(`SELECT * FROM ${table}`);
      if (!res.rows || !res.rows.length) continue;
      const cols = res.columns;
      if (!cols || !cols.length) continue;
      const sql = `INSERT OR IGNORE INTO ${table} (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`;
      const stmt = local.prepare(sql);
      const insertMany = local.transaction((rows) => {
        for (const row of rows) {
          const values = Array.isArray(row) ? row : cols.map((c) => row[c]);
          stmt.run(...values);
        }
      });
      insertMany(res.rows);
      pulled += res.rows.length;
    } catch (e) {
      console.warn(`[Pull] ${table}:`, e.message);
    }
  }

  // Nominees: UPSERT metadata; preserve votes AND stage-related local columns
  const PROTECTED_NOMINEE_COLS = [
    "id",
    "votes",
    "stage",
    "eliminated",
    "eliminated_stage",
    "qualified_at",
    "final_rank",
  ];
  try {
    const res = await remote.execute("SELECT * FROM nominees");
    if (res.rows && res.rows.length) {
      const cols = res.columns;
      const updateCols = cols.filter(
        (c) => !PROTECTED_NOMINEE_COLS.includes(c),
      );
      if (updateCols.length > 0) {
        const updateClause = updateCols
          .map((c) => `${c} = excluded.${c}`)
          .join(", ");
        const sql = `INSERT INTO nominees (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})
          ON CONFLICT(id) DO UPDATE SET ${updateClause}`;
        const stmt = local.prepare(sql);
        const insertMany = local.transaction((rows) => {
          for (const row of rows) {
            const values = Array.isArray(row) ? row : cols.map((c) => row[c]);
            stmt.run(...values);
          }
        });
        insertMany(res.rows);
        pulled += res.rows.length;
      }
    }
  } catch (e) {
    console.warn("[Pull] nominees:", e.message);
  }

  return { pulled };
}

async function reconcileVotes() {
  try {
    const mismatched = local
      .prepare(
        `
      SELECT n.id,
        (SELECT COUNT(*) FROM free_votes WHERE nominee_id = n.id) +
        COALESCE((SELECT votes_added FROM nominee_boosts WHERE nominee_id = n.id), 0) AS expected
      FROM nominees n
      WHERE COALESCE(n.votes, -1) !=
        (SELECT COUNT(*) FROM free_votes WHERE nominee_id = n.id) +
        COALESCE((SELECT votes_added FROM nominee_boosts WHERE nominee_id = n.id), 0)
    `,
      )
      .all();

    if (!mismatched.length) return 0;

    const updateLocal = local.prepare(
      "UPDATE nominees SET votes = ? WHERE id = ?",
    );
    const enqueueUpdate = local.prepare(
      "INSERT INTO _sync_queue (sql, args) VALUES (?, ?)",
    );
    const runUpdate = local.transaction((rows) => {
      for (const { id, expected } of rows) {
        updateLocal.run(expected, id);
        enqueueUpdate.run(
          "UPDATE nominees SET votes = ? WHERE id = ?",
          JSON.stringify([expected, id]),
        );
      }
    });
    runUpdate(mismatched);
    console.log(
      `[Reconcile] Corrected votes for ${mismatched.length} nominee(s)`,
    );
    return mismatched.length;
  } catch (e) {
    console.warn("[Reconcile]", e.message);
    return 0;
  }
}

async function pullImage(id) {
  try {
    const res = await remote.execute({
      sql: "SELECT id, data, mime, size, created_at FROM images WHERE id = ?",
      args: [id],
    });
    if (!res.rows || !res.rows.length) return null;
    const row = res.rows[0];
    const vals = res.columns.map((c) => row[c]);
    const obj = Object.fromEntries(res.columns.map((c, i) => [c, vals[i]]));

    const data = Buffer.isBuffer(obj.data) ? obj.data : Buffer.from(obj.data);

    local
      .prepare(
        "INSERT OR REPLACE INTO images (id, data, mime, size, created_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(obj.id, data, obj.mime, obj.size, obj.created_at);

    return { ...obj, data };
  } catch (e) {
    console.warn("[pullImage]", e.message);
    return null;
  }
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

async function ensureRemoteSchema() {
  const statements = [
    `CREATE TABLE IF NOT EXISTS categories (id TEXT PRIMARY KEY, name TEXT UNIQUE NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP)`,
    `CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP)`,
    `CREATE TABLE IF NOT EXISTS nominees (id TEXT PRIMARY KEY, user_id TEXT, name TEXT NOT NULL, category_id TEXT NOT NULL, code TEXT UNIQUE NOT NULL, img TEXT, desc TEXT, votes INTEGER DEFAULT 0, created_at TEXT DEFAULT CURRENT_TIMESTAMP)`,
    `CREATE TABLE IF NOT EXISTS transactions (id TEXT PRIMARY KEY, reference TEXT UNIQUE NOT NULL, type TEXT NOT NULL, user_id TEXT, nominee_id TEXT, amount REAL NOT NULL, phone TEXT NOT NULL, status TEXT DEFAULT 'pending', metadata TEXT, mpesa_receipt TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP, completed_at TEXT)`,
    `CREATE TABLE IF NOT EXISTS leaderboard_access (user_id TEXT PRIMARY KEY, permanent INTEGER DEFAULT 0, expires_at TEXT, credits INTEGER DEFAULT 0)`,
    `CREATE TABLE IF NOT EXISTS payment_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, reference TEXT NOT NULL, event TEXT NOT NULL, details TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP)`,
    `CREATE TABLE IF NOT EXISTS free_votes (id TEXT PRIMARY KEY, voter_token TEXT NOT NULL, nominee_id TEXT NOT NULL, device_hash TEXT, ip TEXT, category_id TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP, UNIQUE(voter_token, nominee_id))`,
    `CREATE TABLE IF NOT EXISTS images (id TEXT PRIMARY KEY, data BLOB NOT NULL, mime TEXT NOT NULL, size INTEGER, created_at TEXT DEFAULT CURRENT_TIMESTAMP)`,
    `CREATE TABLE IF NOT EXISTS admins (id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, display_name TEXT, role TEXT DEFAULT 'admin', created_by TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP, revoked INTEGER DEFAULT 0, revoked_at TEXT, revoked_by TEXT)`,
    `CREATE TABLE IF NOT EXISTS nominee_boosts (id TEXT PRIMARY KEY, nominee_id TEXT UNIQUE NOT NULL, reference TEXT NOT NULL, votes_added INTEGER NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP)`,
    `CREATE TABLE IF NOT EXISTS vote_reports (id TEXT PRIMARY KEY, report_code TEXT UNIQUE NOT NULL, reported_at TEXT DEFAULT CURRENT_TIMESTAMP, ip TEXT, user_agent TEXT, voter_token TEXT, device_hash TEXT, fingerprint_details TEXT, report_description TEXT, reporter_name TEXT, reporter_contact TEXT, verdict TEXT NOT NULL, matched_votes TEXT, geo_info TEXT)`,
    `CREATE TABLE IF NOT EXISTS ip_lookup_cache (ip TEXT PRIMARY KEY, country TEXT, region TEXT, city TEXT, isp TEXT, org TEXT, asn TEXT, fetched_at TEXT DEFAULT CURRENT_TIMESTAMP)`,
    `CREATE TABLE IF NOT EXISTS vote_appeals (id TEXT PRIMARY KEY, appeal_code TEXT UNIQUE NOT NULL, report_code TEXT NOT NULL, device_hash TEXT NOT NULL, voter_token TEXT NOT NULL, category_id TEXT NOT NULL, category_name TEXT, reason TEXT NOT NULL, status TEXT DEFAULT 'pending', created_at TEXT DEFAULT CURRENT_TIMESTAMP, decided_at TEXT, decided_by TEXT, decision_note TEXT, UNIQUE(report_code, category_id))`,
    `CREATE TABLE IF NOT EXISTS vote_allowances (id TEXT PRIMARY KEY, appeal_code TEXT NOT NULL, device_hash TEXT NOT NULL, voter_token TEXT NOT NULL, category_id TEXT NOT NULL, status TEXT DEFAULT 'active', created_at TEXT DEFAULT CURRENT_TIMESTAMP, used_at TEXT, used_vote_id TEXT, UNIQUE(device_hash, category_id))`,
    `CREATE TABLE IF NOT EXISTS election_stages (id INTEGER PRIMARY KEY CHECK (id = 1), current_stage TEXT DEFAULT 'preliminaries', preliminaries_start TEXT, preliminaries_end TEXT, semifinals_start TEXT, semifinals_end TEXT, finals_start TEXT, finals_end TEXT, last_advanced_at TEXT, updated_at TEXT DEFAULT CURRENT_TIMESTAMP)`,
  ];

  let created = 0;
  for (const sql of statements) {
    try {
      await remote.execute(sql);
      created++;
    } catch (e) {
      if (!e.message.includes("already exists")) {
        console.warn(`[Remote Schema] ${e.message}`);
      }
    }
  }

  // Ensure nominees has stage columns on remote
  for (const col of [
    "stage TEXT DEFAULT 'preliminaries'",
    "eliminated INTEGER DEFAULT 0",
    "eliminated_stage TEXT",
    "qualified_at TEXT",
    "final_rank INTEGER",
  ]) {
    try {
      await remote.execute(`ALTER TABLE nominees ADD COLUMN ${col}`);
    } catch (e) {
      // column exists - ignore
    }
  }

  // Ensure free_votes has all columns on remote
  for (const col of [
    "device_hash TEXT",
    "ip TEXT",
    "category_id TEXT",
    "user_agent TEXT",
    "fingerprint_json TEXT",
    "is_appeal INTEGER DEFAULT 0",
  ]) {
    try {
      await remote.execute(`ALTER TABLE free_votes ADD COLUMN ${col}`);
    } catch (e) {
      // column exists - ignore
    }
  }

  // Ensure idx_fv_device_cat excludes appeal votes
  try {
    await remote.execute(`DROP INDEX IF EXISTS idx_fv_device_cat`);
    await remote.execute(`CREATE UNIQUE INDEX IF NOT EXISTS idx_fv_device_cat
      ON free_votes(device_hash, category_id)
      WHERE device_hash IS NOT NULL AND is_appeal = 0`);
  } catch (e) {
    if (!e.message.includes("already exists")) {
      console.warn(`[Remote Schema] idx_fv_device_cat: ${e.message}`);
    }
  }

  console.log(
    `  ✓ Remote schema verified (${created}/${statements.length} statements OK)`,
  );
}

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
  pullImage,
  reconcileVotes,
  checkpoint,
  walSize,
  verifyConnection,
  ensureRemoteSchema,
  bootstrapIfEmpty,
  getQueueSize,
  getPushFailures,
  LOCAL_DB_PATH,
};
