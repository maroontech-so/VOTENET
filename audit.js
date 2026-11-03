#!/usr/bin/env node
/**
 * sync-db.js — Inspect and repair Voteus DB inconsistencies, then push to Turso.
 *
 * Usage:
 *   node sync-db.js                 # report only (no writes)
 *   node sync-db.js --fix-votes     # fix nominees.votes so it equals free+boost
 *   node sync-db.js --dedup         # remove duplicate (fingerprint_hash, category_id) rows
 *   node sync-db.js --push          # push repaired local → Turso
 *   node sync-db.js --all           # fix-votes → dedup → push
 *
 * Safety:
 *   - Always backs up the local DB first unless --no-backup
 *   - --dedup and --push prompt for confirmation
 *   - Skips local-only tables (_sync_queue, _migrations, email_log)
 *
 * Exit codes: 0 clean, 1 errors remain, 2 fatal
 */
"use strict";
require("dotenv").config();

const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const Database = require("better-sqlite3");
const { createClient } = require("@libsql/client");

const FLAGS = new Set(process.argv.slice(2).filter((a) => a.startsWith("--")));
const DO_FIX_VOTES = FLAGS.has("--fix-votes") || FLAGS.has("--all");
const DO_DEDUP = FLAGS.has("--dedup") || FLAGS.has("--all");
const DO_PUSH = FLAGS.has("--push") || FLAGS.has("--all");
const SKIP_BACKUP = FLAGS.has("--no-backup");
const SKIP_IMAGES = FLAGS.has("--skip-images");

const DATA_DIR = process.env.DATA_DIR || __dirname;
const DB_PATH = path.join(DATA_DIR, "voting-local.db");

// ─── setup ────────────────────────────────────────────────────────────
if (!fs.existsSync(DB_PATH)) {
  console.error(`✗ Local DB not found: ${DB_PATH}`);
  process.exit(2);
}
if (!process.env.TURSO_DATABASE_URL || !process.env.TURSO_AUTH_TOKEN) {
  if (DO_PUSH) {
    console.error(
      "✗ TURSO_DATABASE_URL / TURSO_AUTH_TOKEN not set — cannot push",
    );
    process.exit(2);
  }
}

const db = new Database(DB_PATH);
db.pragma("busy_timeout = 8000");
db.pragma("journal_mode = WAL");

// ─── helpers ──────────────────────────────────────────────────────────
const C = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  cyan: "\x1b[36m",
};
function section(t) {
  console.log(`\n${C.bold}━━━ ${t} ━━━${C.reset}`);
}
function ok(m) {
  console.log(`  ${C.green}✓${C.reset} ${m}`);
}
function warn(m) {
  console.log(`  ${C.yellow}⚠${C.reset} ${m}`);
}
function err(m) {
  console.log(`  ${C.red}✗${C.reset} ${m}`);
}
function note(m) {
  console.log(`  ${C.dim}·${C.reset} ${m}`);
}
function header(m) {
  console.log(`\n${C.cyan}${m}${C.reset}`);
}

async function ask(q) {
  process.stdout.write(`${q} ${C.dim}[y/N]${C.reset} `);
  return new Promise((resolve) => {
    process.stdin.once("data", (d) => {
      resolve(/^y(es)?$/i.test(d.toString().trim()));
    });
  });
}

function sha256(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

function deriveFingerprintHash(fp) {
  const canonical = [
    String(fp.userAgent || "").slice(0, 200),
    String(fp.screen || ""),
    String(fp.timezone || ""),
    String(fp.language || ""),
    String(fp.hardwareConcurrency || ""),
    String(fp.deviceMemory || ""),
    String(fp.platform || ""),
    String(fp.maxTouchPoints || ""),
  ].join("|");
  return crypto
    .createHash("sha256")
    .update(canonical)
    .digest("hex")
    .slice(0, 32);
}

// ─── backup ───────────────────────────────────────────────────────────
function backupLocal() {
  if (SKIP_BACKUP) {
    note("Backup skipped (--no-backup)");
    return null;
  }
  section("BACKUP");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const bakPath = `${DB_PATH}.${stamp}.bak`;
  try {
    db.pragma("wal_checkpoint(TRUNCATE)");
  } catch {}
  fs.copyFileSync(DB_PATH, bakPath);
  const size = fs.statSync(bakPath).size;
  ok(`${path.basename(bakPath)} (${(size / 1024 / 1024).toFixed(2)} MB)`);
  return bakPath;
}

// ─── Turso client ─────────────────────────────────────────────────────
let turso = null;
async function initTurso() {
  if (!process.env.TURSO_DATABASE_URL) return null;
  turso = createClient({
    url: process.env.TURSO_DATABASE_URL,
    authToken: process.env.TURSO_AUTH_TOKEN,
  });
  try {
    await turso.execute("SELECT 1 AS ok");
    return turso;
  } catch (e) {
    err(`Turso unreachable: ${e.message}`);
    return null;
  }
}

// ─── 1. Report current state ──────────────────────────────────────────
const ALL_TABLES = [
  "categories",
  "users",
  "nominees",
  "free_votes",
  "transactions",
  "nominee_boosts",
  "payment_logs",
  "vote_reports",
  "vote_appeals",
  "vote_allowances",
  "admins",
  "leaderboard_access",
  "election_stages",
  "images",
  "ip_lookup_cache",
];

async function report() {
  section("LOCAL vs TURSO");

  let tursoOk = false;
  if (turso) {
    try {
      await turso.execute("SELECT 1");
      tursoOk = true;
    } catch (e) {
      warn(`Turso check failed: ${e.message}`);
    }
  }

  console.log(
    `  ${"table".padEnd(22)} ${"local".padStart(8)} ${"turso".padStart(8)}  ${"diff".padStart(8)}`,
  );
  console.log(
    `  ${"─".repeat(22)} ${"─".repeat(8)} ${"─".repeat(8)}  ${"─".repeat(8)}`,
  );

  let totLocal = 0,
    totTurso = 0,
    diffs = 0;
  for (const t of ALL_TABLES) {
    let lc = null,
      tc = null;
    try {
      lc = Number(db.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get()?.c || 0);
    } catch {}
    if (tursoOk) {
      try {
        const r = await turso.execute(`SELECT COUNT(*) AS c FROM ${t}`);
        tc = r.rows.length ? Number(r.rows[0].c) : 0;
      } catch {}
    }
    const diff = (lc ?? 0) - (tc ?? 0);
    const colour = (lc ?? 0) === (tc ?? 0) ? "" : diff > 0 ? C.yellow : C.red;
    const dStr = diff === 0 ? "—" : `${diff > 0 ? "+" : ""}${diff}`;
    console.log(
      `  ${t.padEnd(22)} ${String(lc ?? "?").padStart(8)} ${String(tc ?? (tursoOk ? "?" : "—")).padStart(8)}  ${colour}${dStr.padStart(8)}${C.reset}`,
    );
    if (lc != null) totLocal += lc;
    if (tc != null) totTurso += tc;
    if (lc != null && tc != null && lc !== tc) diffs++;
  }
  console.log(
    `  ${"─".repeat(22)} ${"─".repeat(8)} ${"─".repeat(8)}  ${"─".repeat(8)}`,
  );
  console.log(
    `  ${"TOTAL".padEnd(22)} ${String(totLocal).padStart(8)} ${String(totTurso).padStart(8)}  ${diffs === 0 ? "—" : `${totLocal - totTurso}`}`,
  );
}

// ─── 2. Vote-count mismatches ─────────────────────────────────────────
function findVoteMismatches() {
  return db
    .prepare(
      `
    SELECT n.id, n.code, n.name,
           COALESCE(n.votes, 0) AS stored,
           (SELECT COUNT(*) FROM free_votes WHERE nominee_id = n.id) AS free_count,
           (SELECT COALESCE(SUM(votes_added), 0) FROM nominee_boosts WHERE nominee_id = n.id) AS boost_sum
    FROM nominees n
    WHERE COALESCE(n.votes, -1) !=
      (SELECT COUNT(*) FROM free_votes WHERE nominee_id = n.id) +
      COALESCE((SELECT SUM(votes_added) FROM nominee_boosts WHERE nominee_id = n.id), 0)
    ORDER BY ABS(COALESCE(n.votes, 0) -
      ((SELECT COUNT(*) FROM free_votes WHERE nominee_id = n.id) +
       COALESCE((SELECT SUM(votes_added) FROM nominee_boosts WHERE nominee_id = n.id), 0))) DESC
  `,
    )
    .all();
}

function reportVoteMismatches(mismatches) {
  section("VOTE COUNT MISMATCHES");
  if (!mismatches.length) {
    ok("No mismatches. votes = free_votes + boosts for every nominee.");
    return;
  }
  err(
    `${mismatches.length} nominee(s) have a stored votes value that doesn't match free+boost.`,
  );
  note("Fix with --fix-votes (updates nominees.votes to the derived total)");
  console.log(
    `\n  ${"code".padEnd(14)} ${"stored".padStart(7)} ${"free".padStart(7)} ${"boost".padStart(7)} ${"expected".padStart(9)} ${"delta".padStart(7)}`,
  );
  for (const m of mismatches) {
    const expected = m.free_count + m.boost_sum;
    const delta = m.stored - expected;
    const colour = delta > 0 ? C.yellow : C.red;
    console.log(
      `  ${m.code.padEnd(14)} ${String(m.stored).padStart(7)} ${String(m.free_count).padStart(7)} ${String(m.boost_sum).padStart(7)} ${String(expected).padStart(9)} ${colour}${(delta > 0 ? "+" : "") + delta}${C.reset}`.padStart(
        7,
      ),
    );
  }
}

function applyVoteFix(mismatches) {
  if (!mismatches.length) return 0;
  const upd = db.prepare("UPDATE nominees SET votes = ? WHERE id = ?");
  const tx = db.transaction((rows) => {
    for (const m of rows) upd.run(m.free_count + m.boost_sum, m.id);
  });
  tx(mismatches);
  ok(`Updated ${mismatches.length} nominee(s)`);
  return mismatches.length;
}

// ─── 3. Duplicate fingerprints ────────────────────────────────────────
function findDuplicateFingerprints() {
  return db
    .prepare(
      `
    SELECT fingerprint_hash, category_id, COUNT(*) AS c
    FROM free_votes
    WHERE fingerprint_hash IS NOT NULL AND is_appeal = 0 AND category_id IS NOT NULL
    GROUP BY fingerprint_hash, category_id HAVING c > 1
    ORDER BY c DESC
  `,
    )
    .all();
}

function expandDuplicateGroups(groups) {
  const expanded = [];
  for (const g of groups) {
    const votes = db
      .prepare(
        `
      SELECT id, nominee_id, voter_token, ip, created_at
      FROM free_votes
      WHERE fingerprint_hash = ? AND category_id = ? AND is_appeal = 0
      ORDER BY created_at ASC
    `,
      )
      .all(g.fingerprint_hash, g.category_id);
    if (votes.length < 2) continue;
    // Keep earliest vote; delete the rest
    expanded.push({
      fp: g.fingerprint_hash,
      category: g.category_id,
      keep: votes[0],
      del: votes.slice(1),
    });
  }
  return expanded;
}

function reportDuplicates(groups, expanded) {
  section("DUPLICATE FINGERPRINTS");
  if (!groups.length) {
    ok("No duplicate (fingerprint_hash, category_id) groups.");
    return;
  }
  err(
    `${groups.length} group(s) — ${expanded.reduce((s, g) => s + g.del.length, 0)} row(s) would be deleted.`,
  );
  note("Fix with --dedup (keeps earliest vote per group, deletes the rest)");
  console.log(
    `\n  ${"fp".padEnd(16)} ${"category".padEnd(10)} ${"votes".padStart(5)}  ${"keep time".padEnd(20)} ${"delete".padStart(6)}`,
  );
  for (const g of expanded.slice(0, 10)) {
    const keepTime = (g.keep.created_at || "").slice(0, 19);
    console.log(
      `  ${(g.fp.slice(0, 12) + "…").padEnd(16)} ${g.category.slice(0, 8).padEnd(10)} ${String(g.del.length + 1).padStart(5)}  ${keepTime.padEnd(20)} ${String(g.del.length).padStart(6)}`,
    );
  }
  if (expanded.length > 10) note(`…and ${expanded.length - 10} more group(s)`);

  // Show a sample of the full detail for the top 3 groups
  header("Sample detail (top 3 groups):");
  for (const g of expanded.slice(0, 3)) {
    console.log(`  fp=${g.fp.slice(0, 16)}… cat=${g.category}`);
    console.log(
      `    KEEP ${g.keep.id} @ ${g.keep.created_at} ip=${g.keep.ip} nom=${g.keep.nominee_id.slice(0, 8)}…`,
    );
    for (const d of g.del) {
      console.log(
        `    DEL  ${d.id} @ ${d.created_at} ip=${d.ip} nom=${d.nominee_id.slice(0, 8)}…`,
      );
    }
  }
}

function applyDedup(expanded) {
  if (!expanded.length) return 0;
  const del = db.prepare("DELETE FROM free_votes WHERE id = ?");
  const ids = expanded.flatMap((g) => g.del.map((d) => d.id));
  const tx = db.transaction((list) => {
    for (const id of list) del.run(id);
  });
  tx(ids);
  ok(`Deleted ${ids.length} duplicate vote(s)`);
  return ids.length;
}

// ─── 4. Push local → Turso ────────────────────────────────────────────
// Table order: parents before children so foreign keys don't matter,
// though the current schema has no FKs anyway.
const PUSH_ORDER = [
  "categories",
  "users",
  "admins",
  "election_stages",
  "nominees",
  "free_votes",
  "nominee_boosts",
  "transactions",
  "payment_logs",
  "vote_reports",
  "vote_appeals",
  "vote_allowances",
  "leaderboard_access",
  "ip_lookup_cache",
  "images",
];

async function pushTable(table) {
  if (table === "images" && SKIP_IMAGES) {
    note(`${table.padEnd(18)} skipped (--skip-images)`);
    return { table, local: null, turso: null, skipped: true };
  }

  let rows;
  try {
    rows = db.prepare(`SELECT * FROM ${table}`).all();
  } catch (e) {
    warn(`${table}: read failed — ${e.message}`);
    return { table, error: e.message };
  }
  if (!rows.length) {
    note(`${table.padEnd(18)} 0 rows (nothing to push)`);
    return { table, local: 0, turso: 0 };
  }

  const cols = Object.keys(rows[0]);
  // ON CONFLICT DO UPDATE requires a primary key. All these tables have one.
  // For safety and simplicity, use INSERT OR REPLACE — the schema has no
  // triggers, and local is authoritative.
  const placeholders = cols.map(() => "?").join(",");
  const sql = `INSERT OR REPLACE INTO ${table} (${cols.join(",")}) VALUES (${placeholders})`;

  let okCount = 0,
    failCount = 0;
  const failures = [];
  const started = Date.now();
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const args = cols.map((c) => {
      const v = row[c];
      if (v instanceof Buffer) return v;
      if (v instanceof Uint8Array) return Buffer.from(v);
      return v;
    });
    try {
      await turso.execute({ sql, args });
      okCount++;
    } catch (e) {
      failCount++;
      if (failures.length < 3) failures.push(`row ${i}: ${e.message}`);
    }
    // Progress every 500 rows for large tables
    if (rows.length > 1000 && (i + 1) % 500 === 0) {
      process.stdout.write(`\r  ${table.padEnd(18)} ${i + 1}/${rows.length}…`);
    }
  }
  if (rows.length > 1000) process.stdout.write("\r");
  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  if (failCount === 0) {
    ok(`${table.padEnd(18)} ${okCount}/${rows.length} pushed (${elapsed}s)`);
  } else {
    warn(
      `${table.padEnd(18)} ${okCount}/${rows.length} pushed, ${failCount} failed (${elapsed}s)`,
    );
    for (const f of failures) note(`  ${f}`);
  }
  return { table, local: rows.length, turso: okCount, failed: failCount };
}

async function pushAll() {
  section("PUSH LOCAL → TURSO");
  if (!turso) {
    err("Turso not configured — cannot push");
    return false;
  }

  // Drain any pending queue first so we don't lose it
  let pending = 0;
  try {
    pending = Number(
      db.prepare("SELECT COUNT(*) AS c FROM _sync_queue").get()?.c || 0,
    );
  } catch {}
  if (pending > 0) {
    warn(
      `${pending} row(s) in _sync_queue — running db.push() first to drain…`,
    );
    try {
      const dbmod = require("./db");
      const r = await dbmod.push();
      ok(`Drained ${r.pushed} row(s) from queue`);
    } catch (e) {
      warn(`Queue drain failed: ${e.message} — continuing with full push`);
    }
  }

  const results = [];
  for (const t of PUSH_ORDER) {
    results.push(await pushTable(t));
  }
  const totalPushed = results.reduce((s, r) => s + (r.turso || 0), 0);
  const totalFailed = results.reduce((s, r) => s + (r.failed || 0), 0);
  if (totalFailed === 0) {
    ok(`Pushed ${totalPushed} row(s) total`);
    return true;
  }
  warn(`Pushed ${totalPushed} row(s), ${totalFailed} failed`);
  return false;
}

// ─── 5. Verify after push ─────────────────────────────────────────────
async function verifyAfterPush() {
  section("VERIFY AFTER PUSH");
  if (!turso) {
    err("Turso not configured — cannot verify");
    return false;
  }

  let totalLocal = 0,
    totalTurso = 0,
    mismatched = [];
  for (const t of PUSH_ORDER) {
    if (t === "images" && SKIP_IMAGES) continue;
    let lc = null,
      tc = null;
    try {
      lc = Number(db.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get()?.c || 0);
    } catch {}
    try {
      const r = await turso.execute(`SELECT COUNT(*) AS c FROM ${t}`);
      tc = r.rows.length ? Number(r.rows[0].c) : 0;
    } catch (e) {
      warn(`${t}: ${e.message}`);
      continue;
    }
    if (lc != null) totalLocal += lc;
    if (tc != null) totalTurso += tc;
    if (lc !== tc)
      mismatched.push({
        table: t,
        local: lc,
        turso: tc,
        diff: (lc || 0) - (tc || 0),
      });
  }

  if (mismatched.length === 0) {
    ok(`All ${PUSH_ORDER.length} tables match (${totalTurso} rows total)`);
  } else {
    warn(`${mismatched.length} table(s) still differ:`);
    for (const m of mismatched) {
      note(
        `${m.table.padEnd(22)} local ${String(m.local).padStart(7)}  turso ${String(m.turso).padStart(7)}  ${m.diff > 0 ? "+" : ""}${m.diff}`,
      );
    }
  }

  // Per-nominee vote spot check
  try {
    const localNom = db
      .prepare(
        "SELECT code, COALESCE(votes, 0) AS votes FROM nominees ORDER BY code",
      )
      .all();
    const r = await turso.execute(
      "SELECT code, COALESCE(votes, 0) AS votes FROM nominees",
    );
    const tursoMap = new Map(
      (r.rows || []).map((row) => [row.code, Number(row.votes || 0)]),
    );
    const voteDiffs = localNom.filter((n) => tursoMap.get(n.code) !== n.votes);
    if (voteDiffs.length === 0) {
      ok(`Per-nominee votes match (${localNom.length} nominees)`);
    } else {
      warn(`${voteDiffs.length} nominee vote mismatch(es) on Turso:`);
      for (const d of voteDiffs.slice(0, 5)) {
        note(
          `${d.code}  local=${d.votes}  turso=${tursoMap.get(d.code) ?? "missing"}`,
        );
      }
    }
  } catch (e) {
    note(`Per-nominee vote check skipped: ${e.message}`);
  }

  return mismatched.length === 0;
}

// ─── main ─────────────────────────────────────────────────────────────
async function main() {
  console.log(
    `\n${C.bold}╔══════════════════════════════════════════════════════════╗${C.reset}`,
  );
  console.log(
    `${C.bold}║  Voteus — DB Inspection & Sync                           ║${C.reset}`,
  );
  console.log(`${C.bold}║  ${new Date().toISOString().padEnd(56)}║${C.reset}`);
  console.log(
    `${C.bold}╚══════════════════════════════════════════════════════════╝${C.reset}`,
  );

  header("Actions requested:");
  note(
    `--fix-votes        ${DO_FIX_VOTES ? C.green + "ON" : C.dim + "off"}${C.reset}`,
  );
  note(
    `--dedup            ${DO_DEDUP ? C.green + "ON" : C.dim + "off"}${C.reset}`,
  );
  note(
    `--push             ${DO_PUSH ? C.green + "ON" : C.dim + "off"}${C.reset}`,
  );
  note(
    `--skip-images      ${SKIP_IMAGES ? C.green + "ON" : C.dim + "off"}${C.reset}`,
  );
  if (!DO_FIX_VOTES && !DO_DEDUP && !DO_PUSH) {
    note(
      `${C.yellow}Nothing will be changed — this is a report only.${C.reset}`,
    );
  }

  await initTurso();
  if (turso)
    note(`Turso: ${(process.env.TURSO_DATABASE_URL || "").slice(0, 45)}…`);

  // Backup before any write
  const willWrite = DO_FIX_VOTES || DO_DEDUP || DO_PUSH;
  if (willWrite) backupLocal();

  // ── Report ──
  await report();
  const mismatches = findVoteMismatches();
  reportVoteMismatches(mismatches);
  const dupGroups = findDuplicateFingerprints();
  const dupExpanded = expandDuplicateGroups(dupGroups);
  reportDuplicates(dupGroups, dupExpanded);

  // ── Apply fixes ──
  if (DO_DEDUP && dupExpanded.length) {
    section("APPLY DEDUP");
    const total = dupExpanded.reduce((s, g) => s + g.del.length, 0);
    warn(
      `This will DELETE ${total} free_votes row(s) across ${dupExpanded.length} group(s).`,
    );
    warn(
      "Keeps the EARLIEST vote in each group (most likely the legitimate one).",
    );
    const yes = await ask("Proceed with dedup?");
    if (yes) {
      applyDedup(dupExpanded);
      // Recompute mismatches (deletions change free_count)
      const remaining = findVoteMismatches();
      if (remaining.length && DO_FIX_VOTES) {
        applyVoteFix(remaining);
      }
    } else {
      warn("Dedup cancelled.");
    }
  } else if (DO_DEDUP) {
    note("Nothing to dedup.");
  }

  if (DO_FIX_VOTES) {
    section("APPLY VOTE FIX");
    const fresh = findVoteMismatches();
    if (!fresh.length) {
      ok("No vote-count mismatches to fix.");
    } else {
      applyVoteFix(fresh);
    }
  }

  // ── Push ──
  if (DO_PUSH) {
    section("APPLY PUSH");
    if (!turso) {
      err("Turso not configured — skipping push.");
    } else {
      const yes = await ask(
        "Push local DB to Turso? This overwrites Turso rows.",
      );
      if (yes) {
        await pushAll();
        if (DO_PUSH) await verifyAfterPush();
      } else {
        warn("Push cancelled.");
      }
    }
  }

  // ── Final state ──
  section("FINAL STATE");
  const finalMismatches = findVoteMismatches();
  const finalDups = findDuplicateFingerprints();
  if (finalMismatches.length === 0 && finalDups.length === 0) {
    ok("Local DB is clean: no vote mismatches, no duplicate fingerprints.");
  } else {
    if (finalMismatches.length)
      warn(`${finalMismatches.length} vote mismatch(es) still present`);
    if (finalDups.length)
      warn(`${finalDups.length} duplicate fingerprint group(s) still present`);
  }

  db.close();
  const clean = finalMismatches.length === 0 && finalDups.length === 0;
  process.exit(clean ? 0 : 1);
}

main().catch((e) => {
  console.error("\n✗ Fatal:", e.message);
  console.error(e.stack);
  try {
    db.close();
  } catch {}
  process.exit(2);
});
