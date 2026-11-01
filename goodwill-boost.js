#!/usr/bin/env node
"use strict";
/**
 * goodwill-boost.js — admin discretionary vote adjustment
 * CommonJS-safe (no top-level await — Node 24 compatible)
 * Syncs to Turso via _sync_queue + --sync flag.
 *
 * ── CHANGELOG ──
 * v2 (this version):
 *   - Added require("dotenv").config() at top so --sync finds TURSO_* env vars
 *   - Added clearer error if db.js still can't load after dotenv
 *   - Added --force hint in skip status messages
 */

// ── FIX: load .env BEFORE requiring ./db so Turso credentials are available ──
require("dotenv").config();

const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const Database = require("better-sqlite3");

const DB_PATH = process.env.DB_PATH || path.join(__dirname, "voting-local.db");

const ARGV = process.argv.slice(2);
const APPLY = ARGV.includes("--apply");
const SYNC = ARGV.includes("--sync");
const FORCE = ARGV.includes("--force");

const STAGE = (() => {
  const i = ARGV.indexOf("--stage");
  return i >= 0 ? String(ARGV[i + 1] || "semi_finals") : "semi_finals";
})();
const VOTES = (() => {
  const i = ARGV.indexOf("--votes");
  const n = i >= 0 ? parseInt(ARGV[i + 1], 10) : 50;
  return Number.isFinite(n) && n > 0 && n <= 10000 ? n : 50;
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
const PREFIX = `GOODWILL-2026-${new Date().toISOString().slice(0, 10)}`;

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

hdr("GOODWILL BOOST" + (APPLY ? "  (APPLY)" : "  (DRY-RUN)"));
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
console.log("  Votes:      " + paint(C.g, "+" + fmtN(VOTES)) + " per nominee");
console.log("  Reference:  " + PREFIX + "-<code>");
console.log(
  "  Force:      " + (FORCE ? paint(C.y, "ON (double-boost allowed)") : "off"),
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

db.exec(`
  CREATE TABLE IF NOT EXISTS _sync_queue (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sql TEXT NOT NULL,
    args TEXT,
    attempts INTEGER DEFAULT 0,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
`);

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
         COALESCE(n.votes, 0) AS votes, c.name AS category,
         (SELECT COUNT(*) FROM free_votes WHERE nominee_id = n.id) AS free_count,
         (SELECT COALESCE(SUM(votes_added),0) FROM nominee_boosts WHERE nominee_id = n.id) AS boost_sum,
         (SELECT COUNT(*) FROM nominee_boosts
            WHERE nominee_id = n.id AND reference LIKE 'GOODWILL-%') AS existing_goodwill
  FROM nominees n JOIN categories c ON c.id = n.category_id
`;

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
        warn(
          `"${q}" matches ${matches.length} nominees. Please be more specific:`,
        );
        for (const m of matches) {
          console.log(
            "    " +
              paint(C.w, m.code.padEnd(16)) +
              String(m.name).padEnd(30) +
              paint(C.d, `[${m.category}]`),
          );
        }
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
    console.log("");
    fail(`No nominee found matching: ${NOMINEE_Q || EMAIL_Q || ID_Q}`);
    info("Check spelling, or try: node voteus.js list");
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

const plan = [];
let alreadyApplied = 0,
  eligible = 0,
  skippedEliminated = 0;

for (const n of candidates) {
  const isEliminated = Number(n.eliminated) === 1;
  const hasExisting = Number(n.existing_goodwill) > 0;
  const entry = {
    id: n.id,
    code: n.code,
    name: n.name,
    category: n.category,
    stage: n.stage,
    before: n.votes,
    free: Number(n.free_count),
    boosts: Number(n.boost_sum),
    hasExisting,
    isEliminated,
    after: n.votes + VOTES,
    reference: `${PREFIX}-${n.code}`,
    action: "boost",
  };
  if (isEliminated) {
    if (IS_SINGLE && FORCE) entry.action = "boost";
    else {
      entry.action = "skip:eliminated";
      skippedEliminated++;
    }
  } else if (hasExisting && !FORCE) {
    entry.action = "skip:already-applied";
    alreadyApplied++;
  } else {
    eligible++;
  }
  plan.push(entry);
}

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
        "Stage".padEnd(14) +
        "Before".padStart(8) +
        "  →  " +
        "After".padStart(8) +
        "  Status",
    ),
);
console.log("  " + C.d + "─".repeat(90) + C.x);
for (const p of plan) {
  const codeCell = paint(C.w, String(p.code).slice(0, 15).padEnd(16));
  const nameCell = String(p.name).slice(0, 23).padEnd(24);
  const stageCell = paint(C.d, String(p.stage || "—").padEnd(14));
  const beforeCell = paint(C.y, fmtN(p.before).padStart(8));
  const arrow = paint(C.d, "  →  ");
  const afterCell = paint(
    p.action === "boost" ? C.g : C.d,
    fmtN(p.after).padStart(8),
  );
  const status =
    p.action === "boost"
      ? paint(C.g, "WILL BOOST")
      : p.action === "skip:already-applied"
        ? paint(C.y, "SKIPPED (already applied — use --force to override)")
        : paint(C.y, "SKIPPED (eliminated — use --force to override)");
  console.log(
    "  " +
      codeCell +
      nameCell +
      stageCell +
      beforeCell +
      arrow +
      afterCell +
      "  " +
      status,
  );
}

if (IS_SINGLE && plan[0]) {
  const p = plan[0];
  sub("Target breakdown");
  console.log("  Category:        " + p.category);
  console.log("  Current stage:   " + (p.stage || "—"));
  console.log(
    "  Eliminated:      " +
      (p.isEliminated ? paint(C.r, "YES") : paint(C.g, "no")),
  );
  console.log("  Free votes:      " + fmtN(p.free));
  console.log(
    "  Existing boosts: " +
      fmtN(p.boosts) +
      (p.hasExisting ? paint(C.y, "  (has prior goodwill)") : ""),
  );
  console.log("  Stored total:    " + fmtN(p.before));
  console.log("  After boost:     " + paint(C.g, fmtN(p.after)));
}

if (!IS_SINGLE) {
  sub("Category totals — before vs after");
  const byCategory = new Map();
  for (const p of plan) {
    if (!byCategory.has(p.category))
      byCategory.set(p.category, { before: 0, after: 0, count: 0, boosted: 0 });
    const g = byCategory.get(p.category);
    g.before += p.before;
    g.after += p.after;
    g.count++;
    if (p.action === "boost") g.boosted++;
  }
  for (const [cat, g] of byCategory) {
    console.log(
      "  " +
        paint(C.w, String(cat).slice(0, 40).padEnd(42)) +
        `n=${g.count}  ` +
        `before=${paint(C.y, fmtN(g.before).padStart(6))}  ` +
        `after=${paint(C.g, fmtN(g.after).padStart(6))}  ` +
        `added=${paint(C.g, "+" + fmtN(g.after - g.before).padStart(4))}` +
        (g.boosted === 0 ? paint(C.d, "  (no changes)") : ""),
    );
  }
}

sub("Summary");
console.log("  Nominees in scope:      " + fmtN(plan.length));
console.log("  Eligible for boost:     " + paint(C.g, fmtN(eligible)));
console.log("  Already had goodwill:   " + paint(C.y, fmtN(alreadyApplied)));
if (skippedEliminated)
  console.log(
    "  Skipped (eliminated):   " + paint(C.y, fmtN(skippedEliminated)),
  );
console.log(
  "  Total votes to add:     " + paint(C.g, "+" + fmtN(eligible * VOTES)),
);

if (!APPLY) {
  console.log("");
  console.log(
    "  " +
      paint(C.d, "Dry-run complete. No changes made.") +
      "  Re-run with " +
      paint(C.w, "--apply") +
      " to execute.",
  );
  console.log(
    "  " +
      paint(C.d, "Add --sync to push to Turso immediately after applying."),
  );
  db.close();
  process.exit(0);
}

if (eligible === 0) {
  warn("Nothing to apply — every eligible nominee was skipped.");
  info("If you want to add MORE votes on top of an existing goodwill boost,");
  info("re-run with --force:");
  info(
    `  node goodwill-boost.js${IS_SINGLE ? ` --nominee ${NOMINEE_Q || EMAIL_Q || ID_Q}` : ""} --votes ${VOTES} --apply --sync --force`,
  );
  db.close();
  process.exit(0);
}

sub("Applying local writes + enqueueing Turso sync");
const nowIso = new Date().toISOString();
const toBoost = plan.filter((p) => p.action === "boost");

let inserted = 0,
  recomputed = 0,
  enqueued = 0;
try {
  const tx = db.transaction(() => {
    for (const p of toBoost) {
      const boostId = crypto.randomUUID();
      const insertSql = `INSERT INTO nominee_boosts (id, nominee_id, reference, votes_added, created_at) VALUES (?, ?, ?, ?, ?)`;
      const insertArgs = [boostId, p.id, p.reference, VOTES, nowIso];
      db.prepare(insertSql).run(...insertArgs);
      enqueue(insertSql, insertArgs);
      enqueued++;
      inserted++;
    }
    for (const p of toBoost) {
      const free = db
        .prepare("SELECT COUNT(*) AS c FROM free_votes WHERE nominee_id = ?")
        .get(p.id).c;
      const boost = db
        .prepare(
          "SELECT COALESCE(SUM(votes_added),0) AS s FROM nominee_boosts WHERE nominee_id = ?",
        )
        .get(p.id).s;
      const total = Number(free) + Number(boost);
      const updateSql = `UPDATE nominees SET votes = ? WHERE id = ?`;
      const updateArgs = [total, p.id];
      db.prepare(updateSql).run(...updateArgs);
      enqueue(updateSql, updateArgs);
      enqueued++;
      recomputed++;
    }
  });
  tx();
  ok(`Inserted ${inserted} goodwill boost record(s)`);
  ok(`Recomputed ${recomputed} nominee vote total(s)`);
  ok(`Enqueued ${enqueued} write(s) to _sync_queue`);
} catch (e) {
  fail("Transaction failed: " + e.message);
  db.close();
  process.exit(1);
}

sub("Verification");
let verified = 0,
  mismatch = 0;
for (const p of toBoost) {
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
if (mismatch)
  warn(`${mismatch} mismatch(es) — investigate with voteus.js audit`);

// ── Async tail: Turso sync + final report ──
(async () => {
  if (SYNC) {
    sub("Syncing to Turso (--sync)");
    const qsize = db.prepare("SELECT COUNT(*) AS c FROM _sync_queue").get().c;
    info(`_sync_queue has ${qsize} row(s) total`);
    try {
      db.pragma("wal_checkpoint(TRUNCATE)");
    } catch {}
    db.close();

    // Sanity check: are Turso env vars present?
    if (!process.env.TURSO_DATABASE_URL || !process.env.TURSO_AUTH_TOKEN) {
      fail("TURSO_DATABASE_URL or TURSO_AUTH_TOKEN is not set.");
      fail("Check your .env file — both variables are required for --sync.");
      fail(
        "Local DB is updated and queued. Server will push on next 30s tick.",
      );
      process.exit(1);
    }

    let dbModule;
    try {
      dbModule = require("./db");
    } catch (e) {
      fail("Could not load ./db.js: " + e.message);
      fail("Local DB updated and queued. Server will push on next 30s tick.");
      process.exit(1);
    }

    try {
      const { pushed } = await dbModule.push();
      ok(`Pushed ${pushed} row(s) from _sync_queue to Turso`);
      const remaining = dbModule.getQueueSize();
      if (remaining === 0) ok("_sync_queue is now empty");
      else warn(`${remaining} row(s) still in queue — server will retry`);
    } catch (e) {
      fail("Push failed: " + e.message);
      warn("Local DB updated and queued. Server will push on next 30s tick.");
    }
  } else {
    const qsize = db.prepare("SELECT COUNT(*) AS c FROM _sync_queue").get().c;
    ok(`_sync_queue now has ${qsize} pending row(s)`);
    info("Server pushes to Turso within 30s if running.");
    info("If stopped, next server start will push it.");
    info("To push immediately, re-run with --sync.");
    try {
      db.pragma("wal_checkpoint(TRUNCATE)");
    } catch {}
    db.close();
  }

  if (IS_SINGLE && toBoost[0]) {
    const db2 = new Database(DB_PATH, { readonly: true });
    const row = db2
      .prepare(
        `SELECT n.code, n.name, n.votes, n.stage, c.name AS category
       FROM nominees n JOIN categories c ON c.id = n.category_id WHERE n.id = ?`,
      )
      .get(toBoost[0].id);
    db2.close();

    sub("Final state for target nominee");
    console.log("  " + paint(C.w, row.code) + "  " + row.name);
    console.log("  Category:  " + row.category);
    console.log("  Votes:     " + paint(C.g, fmtN(row.votes)));
    console.log("  Stage:     " + (row.stage || "—"));

    console.log("\n" + paint(C.g, "═".repeat(78)));
    console.log(" " + paint(C.g, "✓ GOODWILL BOOST APPLIED"));
    console.log(paint(C.g, "═".repeat(78)));
    console.log(
      "  " + paint(C.d, `+${VOTES} votes added to ${row.code} (${row.name}).`),
    );
  } else {
    const db2 = new Database(DB_PATH, { readonly: true });
    const finalRows = db2
      .prepare(
        `SELECT n.code, n.name, n.votes, n.stage, c.name AS category
       FROM nominees n JOIN categories c ON c.id = n.category_id
       WHERE COALESCE(n.eliminated, 0) = 0
       ORDER BY c.name ASC, COALESCE(n.votes, 0) DESC`,
      )
      .all();
    db2.close();

    sub("Post-application leaderboard (active nominees)");
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

    console.log("\n" + paint(C.g, "═".repeat(78)));
    console.log(" " + paint(C.g, "✓ GOODWILL BOOST APPLIED"));
    console.log(paint(C.g, "═".repeat(78)));
    console.log(
      "  " +
        paint(
          C.d,
          `Every active ${STAGE} nominee received +${VOTES} votes. Relative rankings preserved.`,
        ),
    );
  }
})().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
