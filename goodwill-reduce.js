#!/usr/bin/env node
"use strict";
/**
 * goodwill-reduce.js — reverse or partially reduce goodwill boosts
 *
 * Sync-safe strategy: adds a NEGATIVE nominee_boosts row instead of
 * deleting/updating existing rows. Because pull() uses INSERT OR IGNORE
 * for nominee_boosts, negative rows propagate identically to every server
 * without needing a restart or reconcile.
 *
 * Usage:
 *   node goodwill-reduce.js --votes 100                        # preview -100/nominee
 *   node goodwill-reduce.js --votes 100 --apply --sync         # execute + push
 *   node goodwill-reduce.js --nominee VOTE_MK685 --votes 100 --apply --sync
 *   node goodwill-reduce.js --all --apply --sync               # remove ALL goodwill
 *   node goodwill-reduce.js --latest --apply --sync            # remove newest batch
 */

require("dotenv").config();
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const Database = require("better-sqlite3");

const DB_PATH = process.env.DB_PATH || path.join(__dirname, "voting-local.db");

const ARGV = process.argv.slice(2);
const APPLY = ARGV.includes("--apply");
const SYNC = ARGV.includes("--sync");

const REDUCE_VOTES = (() => {
  const i = ARGV.indexOf("--votes");
  if (i < 0) return null;
  const n = parseInt(ARGV[i + 1], 10);
  return Number.isFinite(n) && n > 0 ? n : null;
})();
const REDUCE_ALL = ARGV.includes("--all");
const REDUCE_LATEST = ARGV.includes("--latest");

const STAGE = (() => {
  const i = ARGV.indexOf("--stage");
  return i >= 0 ? String(ARGV[i + 1] || "semi_finals") : "semi_finals";
})();
const NOMINEE_Q = (() => {
  const i = ARGV.indexOf("--nominee");
  return i >= 0 ? String(ARGV[i + 1] || "").trim() : null;
})();
const EMAIL_Q = (() => {
  const i = ARGV.indexOf("--email");
  return i >= 0
    ? String(ARGV[i + 1] || "")
        .trim()
        .toLowerCase()
    : null;
})();
const ID_Q = (() => {
  const i = ARGV.indexOf("--id");
  return i >= 0 ? String(ARGV[i + 1] || "").trim() : null;
})();

const IS_SINGLE = !!(NOMINEE_Q || EMAIL_Q || ID_Q);

let MODE = null;
if (REDUCE_VOTES) MODE = "votes";
else if (REDUCE_ALL) MODE = "all";
else if (REDUCE_LATEST) MODE = "latest";

if (!MODE) {
  console.error("\n✗ Specify a reduction mode: --votes N | --all | --latest\n");
  process.exit(1);
}

const REF_PREFIX = `GOODWILL-REDUCE-${new Date().toISOString().slice(0, 10)}`;
const C = {
  r: "\x1b[31m",
  y: "\x1b[33m",
  g: "\x1b[32m",
  b: "\x1b[36m",
  w: "\x1b[1m",
  d: "\x1b[2m",
  x: "\x1b[0m",
};
const paint = (c, s) => c + s + C.x;
const fmtN = (n) => Number(n || 0).toLocaleString();
const hdr = (t) => {
  console.log("\n" + C.b + "=".repeat(78) + C.x);
  console.log(" " + C.w + t + C.x);
  console.log(C.b + "=".repeat(78) + C.x);
};
const sub = (t) => console.log("\n" + C.w + " " + t + C.x);
const ok = (m) => console.log("  " + paint(C.g, "✓ ") + m);
const warn = (m) => console.log("  " + paint(C.y, "⚠ ") + m);
const fail = (m) => console.log("  " + paint(C.r, "✗ ") + m);
const info = (m) => console.log("  " + paint(C.d, "  " + m));

if (!fs.existsSync(DB_PATH)) {
  console.error(paint(C.r, `\n✗ DB not found: ${DB_PATH}`));
  process.exit(1);
}

hdr("GOODWILL REDUCE" + (APPLY ? "  (APPLY)" : "  (DRY-RUN)"));
console.log("  DB:         " + DB_PATH);
console.log(
  "  Target:     " +
    (IS_SINGLE
      ? paint(C.g, "SINGLE USER")
      : paint(C.y, `BULK · stage "${STAGE}"`)),
);
if (NOMINEE_Q) console.log("  Nominee:    " + NOMINEE_Q);
if (EMAIL_Q) console.log("  Email:      " + EMAIL_Q);
if (ID_Q) console.log("  User ID:    " + ID_Q);
console.log("  Mode:       " + paint(C.y, MODE.toUpperCase()));
if (MODE === "votes")
  console.log(
    "  Amount:     " +
      paint(C.r, "-" + fmtN(REDUCE_VOTES)) +
      " per nominee (capped at current goodwill)",
  );
if (MODE === "all")
  console.log("  Amount:     " + paint(C.r, "ALL goodwill") + " (net to 0)");
if (MODE === "latest")
  console.log(
    "  Amount:     " + paint(C.r, "LAST BATCH") + " (newest positive boost)",
  );
console.log(
  "  Mode:       " + (APPLY ? paint(C.g, "APPLY") : paint(C.y, "DRY-RUN")),
);
console.log(
  "  Turso sync: " +
    (SYNC
      ? paint(C.g, "IMMEDIATE (--sync)")
      : paint(C.y, "via server's 30s queue")),
);

const db = new Database(DB_PATH);
db.pragma("busy_timeout = 8000");
db.exec(
  `CREATE TABLE IF NOT EXISTS _sync_queue (id INTEGER PRIMARY KEY AUTOINCREMENT, sql TEXT NOT NULL, args TEXT, attempts INTEGER DEFAULT 0, created_at TEXT DEFAULT CURRENT_TIMESTAMP);`,
);

function enqueue(sql, args) {
  const trimmed = String(sql || "")
    .trim()
    .toUpperCase();
  if (!/^(INSERT|UPDATE|DELETE|REPLACE)/.test(trimmed)) return;
  db.prepare("INSERT INTO _sync_queue (sql, args) VALUES (?, ?)").run(
    sql,
    JSON.stringify(args || []),
  );
}

const SELECT_COLS = `
  SELECT n.id, n.code, n.name, n.category_id, n.stage, n.eliminated,
         COALESCE(n.votes, 0) AS votes, c.name AS category
  FROM nominees n JOIN categories c ON c.id = n.category_id
`;

// ── Find targets ──
let candidates = [];
if (IS_SINGLE) {
  if (ID_Q) {
    let row = db.prepare(`${SELECT_COLS} WHERE n.id = ?`).get(ID_Q);
    if (!row) row = db.prepare(`${SELECT_COLS} WHERE n.user_id = ?`).get(ID_Q);
    if (row) candidates = [row];
  }
  if (!candidates.length && EMAIL_Q) {
    const user = db
      .prepare("SELECT id FROM users WHERE LOWER(email) = ?")
      .get(EMAIL_Q);
    if (user) {
      const row = db.prepare(`${SELECT_COLS} WHERE n.user_id = ?`).get(user.id);
      if (row) candidates = [row];
    }
  }
  if (!candidates.length && NOMINEE_Q) {
    const q = NOMINEE_Q;
    const qUpper = q.toUpperCase();
    let row = db
      .prepare(`${SELECT_COLS} WHERE n.code = ? COLLATE NOCASE`)
      .get(qUpper);
    if (row) candidates = [row];
    if (!candidates.length) {
      row = db.prepare(`${SELECT_COLS} WHERE n.name = ? COLLATE NOCASE`).get(q);
      if (row) candidates = [row];
    }
    if (!candidates.length) {
      const matches = db
        .prepare(
          `${SELECT_COLS} WHERE n.name LIKE ? COLLATE NOCASE ORDER BY n.name ASC`,
        )
        .all(`%${q}%`);
      if (matches.length === 1) candidates = matches;
      else if (matches.length > 1) {
        console.log("");
        warn(`"${q}" matches ${matches.length} nominees:`);
        for (const m of matches)
          console.log(
            "    " +
              paint(C.w, m.code.padEnd(16)) +
              String(m.name).padEnd(30) +
              paint(C.d, `[${m.category}]`),
          );
        db.close();
        process.exit(3);
      }
    }
    if (!candidates.length) {
      row = db
        .prepare(
          `${SELECT_COLS} WHERE n.code LIKE ? COLLATE NOCASE ORDER BY LENGTH(n.code) ASC LIMIT 1`,
        )
        .get(`%${qUpper}%`);
      if (row) candidates = [row];
    }
  }
  if (!candidates.length) {
    fail(`No nominee found: ${NOMINEE_Q || EMAIL_Q || ID_Q}`);
    db.close();
    process.exit(4);
  }
} else {
  if (STAGE === "all") {
    candidates = db
      .prepare(
        `${SELECT_COLS} WHERE COALESCE(n.eliminated, 0) = 0 ORDER BY c.name ASC, n.votes DESC`,
      )
      .all();
  } else {
    candidates = db
      .prepare(
        `${SELECT_COLS} WHERE n.stage = ? AND COALESCE(n.eliminated, 0) = 0 ORDER BY c.name ASC, n.votes DESC`,
      )
      .all(STAGE);
  }
  if (!candidates.length) {
    warn(`No ACTIVE nominees in stage "${STAGE}".`);
    db.close();
    process.exit(2);
  }
}

// ── Compute plan ──
function getGoodwillState(nomineeId) {
  const rows = db
    .prepare(
      `SELECT id, reference, votes_added, created_at FROM nominee_boosts
     WHERE nominee_id = ? AND reference LIKE 'GOODWILL-%'
     ORDER BY created_at DESC`,
    )
    .all(nomineeId);
  const positiveRows = rows.filter((r) => r.votes_added > 0);
  const negativeRows = rows.filter((r) => r.votes_added < 0);
  const positiveTotal = positiveRows.reduce((s, r) => s + r.votes_added, 0);
  const negativeTotal = negativeRows.reduce((s, r) => s + r.votes_added, 0);
  const netTotal = positiveTotal + negativeTotal;
  return {
    rows,
    positiveRows,
    negativeRows,
    positiveTotal,
    negativeTotal,
    netTotal,
  };
}

function computeReduction(state) {
  if (MODE === "all") return Math.max(0, state.netTotal);
  if (MODE === "latest") {
    if (!state.positiveRows.length) return 0;
    return Math.min(
      state.positiveRows[0].votes_added,
      Math.max(0, state.netTotal),
    );
  }
  if (MODE === "votes")
    return Math.min(REDUCE_VOTES, Math.max(0, state.netTotal));
  return 0;
}

const plan = [];
let totalReduction = 0,
  alreadyAtZero = 0,
  eligible = 0;

for (const n of candidates) {
  const state = getGoodwillState(n.id);
  const reduceAmount = computeReduction(state);
  const after = n.votes - reduceAmount;
  const entry = {
    id: n.id,
    code: n.code,
    name: n.name,
    category: n.category,
    stage: n.stage,
    before: n.votes,
    positive: state.positiveTotal,
    net: state.netTotal,
    reduceAmount,
    after,
    reference: `${REF_PREFIX}-${n.code}`,
    action:
      reduceAmount > 0
        ? "reduce"
        : state.netTotal <= 0
          ? "skip:no-goodwill"
          : "skip:zero",
  };
  if (reduceAmount > 0) {
    eligible++;
    totalReduction += reduceAmount;
  } else if (state.netTotal <= 0) alreadyAtZero++;
  plan.push(entry);
}

// ── Preview ──
sub(
  IS_SINGLE
    ? `Target nominee — ${plan.length} matched`
    : `Candidates in stage "${STAGE}" — ${plan.length} found`,
);
console.log(
  "  " +
    paint(
      C.d,
      "Code".padEnd(16) +
        "Name".padEnd(24) +
        "Before".padStart(8) +
        "  Reduce".padStart(9) +
        "  →  " +
        "After".padStart(8) +
        "  Status",
    ),
);
console.log("  " + C.d + "─".repeat(88) + C.x);
for (const p of plan) {
  const codeCell = paint(C.w, String(p.code).slice(0, 15).padEnd(16));
  const nameCell = String(p.name).slice(0, 23).padEnd(24);
  const beforeCell = paint(C.y, fmtN(p.before).padStart(8));
  const reduceCell = paint(
    p.action === "reduce" ? C.r : C.d,
    ("-" + fmtN(p.reduceAmount)).padStart(9),
  );
  const arrow = paint(C.d, "  →  ");
  const afterCell = paint(
    p.action === "reduce" ? C.g : C.d,
    fmtN(p.after).padStart(8),
  );
  const status =
    p.action === "reduce"
      ? paint(C.g, "WILL REDUCE")
      : p.action === "skip:no-goodwill"
        ? paint(C.y, "SKIPPED (no goodwill)")
        : paint(C.y, "SKIPPED (nothing to reduce)");
  console.log(
    "  " +
      codeCell +
      nameCell +
      beforeCell +
      reduceCell +
      arrow +
      afterCell +
      "  " +
      status,
  );
}

sub("Summary");
console.log("  Nominees in scope:      " + fmtN(plan.length));
console.log("  Eligible for reduction: " + paint(C.r, fmtN(eligible)));
console.log("  Already at zero:        " + paint(C.y, fmtN(alreadyAtZero)));
console.log(
  "  Total votes to reduce:  " + paint(C.r, "-" + fmtN(totalReduction)),
);

if (!APPLY) {
  console.log("");
  info("Dry-run complete. No changes made.");
  info("Re-run with --apply to execute, --sync to push immediately.");
  db.close();
  process.exit(0);
}

if (eligible === 0) {
  warn("Nothing to reduce — every targeted nominee is skipped.");
  db.close();
  process.exit(0);
}

// ── Apply ──
sub("Applying reductions (INSERT-only, sync-safe)");
const toReduce = plan.filter((p) => p.action === "reduce");
const nowIso = new Date().toISOString();
let inserted = 0,
  recomputed = 0,
  enqueued = 0;

try {
  const tx = db.transaction(() => {
    for (const p of toReduce) {
      const adjId = crypto.randomUUID();
      const adjRef = `${REF_PREFIX}-${p.code}-${adjId.slice(0, 6)}`;
      const insSql = `INSERT INTO nominee_boosts (id, nominee_id, reference, votes_added, created_at) VALUES (?, ?, ?, ?, ?)`;
      const insArgs = [adjId, p.id, adjRef, -p.reduceAmount, nowIso];
      db.prepare(insSql).run(...insArgs);
      enqueue(insSql, insArgs);
      enqueued++;
      inserted++;

      const free = db
        .prepare("SELECT COUNT(*) AS c FROM free_votes WHERE nominee_id = ?")
        .get(p.id).c;
      const boost = db
        .prepare(
          "SELECT COALESCE(SUM(votes_added),0) AS s FROM nominee_boosts WHERE nominee_id = ?",
        )
        .get(p.id).s;
      const total = Number(free) + Number(boost);
      const updSql = `UPDATE nominees SET votes = ? WHERE id = ?`;
      const updArgs = [total, p.id];
      db.prepare(updSql).run(...updArgs);
      enqueue(updSql, updArgs);
      enqueued++;
      recomputed++;
    }
  });
  tx();
  ok(`Inserted ${inserted} reduction row(s)`);
  ok(`Recomputed ${recomputed} nominee vote total(s)`);
  ok(`Enqueued ${enqueued} write(s) to _sync_queue`);
} catch (e) {
  fail("Transaction failed: " + e.message);
  db.close();
  process.exit(1);
}

// ── Verify ──
sub("Verification");
let verified = 0,
  mismatch = 0;
for (const p of toReduce) {
  const row = db
    .prepare(
      `SELECT COALESCE(n.votes, 0) AS stored,
            (SELECT COUNT(*) FROM free_votes WHERE nominee_id = n.id)
            + (SELECT COALESCE(SUM(votes_added),0) FROM nominee_boosts WHERE nominee_id = n.id) AS computed
     FROM nominees n WHERE n.id = ?`,
    )
    .get(p.id);
  const delta = Number(row.stored) - Number(row.computed);
  if (delta === 0) verified++;
  else {
    mismatch++;
    fail(`${p.code}: stored=${row.stored} computed=${row.computed}`);
  }
}
ok(`${verified} nominee(s) verified: votes === free + boosts`);
if (mismatch) warn(`${mismatch} mismatch(es) — investigate`);

// ── Sync + final report ──
(async () => {
  if (SYNC) {
    sub("Syncing to Turso (--sync)");
    const qsize = db.prepare("SELECT COUNT(*) AS c FROM _sync_queue").get().c;
    info(`_sync_queue has ${qsize} row(s)`);
    try {
      db.pragma("wal_checkpoint(TRUNCATE)");
    } catch {}
    db.close();
    if (!process.env.TURSO_DATABASE_URL || !process.env.TURSO_AUTH_TOKEN) {
      fail("TURSO_* env vars missing");
      process.exit(1);
    }
    let dbModule;
    try {
      dbModule = require("./db");
    } catch (e) {
      fail("Cannot load ./db.js: " + e.message);
      process.exit(1);
    }
    try {
      const { pushed } = await dbModule.push();
      ok(`Pushed ${pushed} row(s) to Turso`);
      const remaining = dbModule.getQueueSize();
      if (remaining === 0) ok("_sync_queue is now empty");
      else warn(`${remaining} row(s) still queued`);
    } catch (e) {
      fail("Push failed: " + e.message);
      warn("Local DB updated. Server will push on next 30s tick.");
    }
  } else {
    const qsize = db.prepare("SELECT COUNT(*) AS c FROM _sync_queue").get().c;
    ok(`_sync_queue now has ${qsize} pending row(s)`);
    info("Server pushes to Turso within 30s if running.");
    try {
      db.pragma("wal_checkpoint(TRUNCATE)");
    } catch {}
    db.close();
  }

  const db2 = new Database(DB_PATH, { readonly: true });
  if (IS_SINGLE && toReduce[0]) {
    const row = db2
      .prepare(
        `SELECT n.code, n.name, n.votes, n.stage, c.name AS category
       FROM nominees n JOIN categories c ON c.id = n.category_id WHERE n.id = ?`,
      )
      .get(toReduce[0].id);
    db2.close();
    sub("Final state for target nominee");
    console.log("  " + paint(C.w, row.code) + "  " + row.name);
    console.log("  Category:  " + row.category);
    console.log("  Votes:     " + paint(C.g, fmtN(row.votes)));
    console.log("  Stage:     " + (row.stage || "—"));
  } else {
    sub("Post-reduction leaderboard (active nominees)");
    const finalRows = db2
      .prepare(
        `SELECT n.code, n.name, n.votes, n.stage, c.name AS category
       FROM nominees n JOIN categories c ON c.id = n.category_id
       WHERE COALESCE(n.eliminated, 0) = 0
       ORDER BY c.name ASC, COALESCE(n.votes, 0) DESC`,
      )
      .all();
    db2.close();
    let lastCat = null;
    for (const r of finalRows) {
      if (r.category !== lastCat) {
        console.log("\n  " + paint(C.w, r.category));
        lastCat = r.category;
      }
      console.log(
        "    " +
          paint(C.d, String(r.code).padEnd(16)) +
          String(r.name).slice(0, 28).padEnd(30) +
          paint(C.y, fmtN(r.votes).padStart(8)) +
          "  " +
          paint(C.d, r.stage || "—"),
      );
    }
  }

  console.log("\n" + paint(C.g, "═".repeat(78)));
  console.log(" " + paint(C.g, "✓ GOODWILL REDUCTION APPLIED"));
  console.log(paint(C.g, "═".repeat(78)));
  console.log(
    "  " + paint(C.d, `Total reduced: -${fmtN(totalReduction)} votes`),
  );
  console.log(
    "  " +
      paint(
        C.d,
        "Reductions logged as GOODWILL-REDUCE-* rows (fully auditable).",
      ),
  );
})().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
