#!/usr/bin/env node
"use strict";
/**
 * voteus.js — Voteus consolidated integrity tool
 *
 * Single file that replaces:
 *   - audit.js
 *   - diagnose-votes.js
 *   - clean-fraud.js
 *   - purge-attack-ips.js
 *   - and every inline one-off script
 *
 * COMMANDS:
 *   list              List all nominees
 *   diagnose <code>   Deep-dive one nominee (code/name/surname/id — fuzzy)
 *   audit             Full integrity audit (report only, no changes)
 *   clean             Fingerprint fraud cleanup — keep earliest vote per (nominee,fp)
 *   purge-ips         Purge all votes from attack IPs
 *   wipe-boosts       Wipe unverified / simulated boosts
 *   wipe              Wipe eliminated members (free votes + boosts; --cascade removes nominees+users)
 *   fix               Fix vote math mismatches + orphan records
 *   all               Run every detector (report only)
 *
 * FLAGS:
 *   --apply           Actually modify DB (default: DRY-RUN)
 *   --nominee <q>     Filter to one nominee (code/name/surname/id)
 *   --strict          Tighter thresholds
 *   --verbose         Show every detail
 *   --json            Machine-readable output
 *   --cascade         With wipe: also delete nominees + users rows
 *   --pull            Pull from Turso cloud first
 *   --stage <s>       Filter to preliminaries|semi_finals|finals|completed
 *   --ips <list>      Comma-separated IPs for purge-ips (overrides defaults)
 *   --help            This help
 *
 * EXAMPLES:
 *   node voteus.js list
 *   node voteus.js diagnose VOTE_LW189
 *   node voteus.js diagnose lorraine
 *   node voteus.js audit --verbose
 *   node voteus.js audit --strict
 *   node voteus.js clean --apply
 *   node voteus.js purge-ips --apply
 *   node voteus.js wipe-boosts --apply
 *   node voteus.js wipe --apply
 *   node voteus.js wipe --cascade --apply
 *   node voteus.js fix --apply
 *   node voteus.js all --verbose
 *
 * ENV:
 *   DB_PATH              (default: ./voting-local.db)
 *   TURSO_DATABASE_URL   (for --pull / auto-pull on empty DB)
 *   TURSO_AUTH_TOKEN     (for --pull)
 *   ATTACK_IPS           Comma-separated, overrides defaults
 *   BURST_PER_MIN        (default: 15)
 *   BURST_PER_HOUR       (default: 100)
 *   IP_VOTES_PER_CAT     (default: 3)
 *   IP_VOTES_TOTAL       (default: 20)
 *   UA_REUSE             (default: 30)
 *   FP_REUSE             (default: 20)
 *   CONCENTRATION        (default: 0.50)
 *   BOOSTS_PER_NOMINEE   (default: 5)
 *   OFF_HOURS_VOTES      (default: 10)
 *   Z_SCORE              (default: 3)
 */

const path = require("path");
const fs = require("fs");

/* ═══════════════════════════════════════════════════════════════════════
   ARGUMENT PARSER
   ═══════════════════════════════════════════════════════════════════════ */

function parseArgs(argv) {
  const out = {
    cmd: null,
    nominee: null,
    apply: false,
    strict: false,
    verbose: false,
    json: false,
    cascade: false,
    pull: false,
    stage: null,
    ips: null,
    help: false,
    positional: [],
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") out.help = true;
    else if (a === "--apply") out.apply = true;
    else if (a === "--strict") out.strict = true;
    else if (a === "--verbose" || a === "-v") out.verbose = true;
    else if (a === "--json") out.json = true;
    else if (a === "--cascade") out.cascade = true;
    else if (a === "--pull") out.pull = true;
    else if (a === "--nominee" || a === "-n") out.nominee = argv[++i] ?? null;
    else if (a.startsWith("--nominee=")) out.nominee = a.slice(10);
    else if (a === "--stage") out.stage = argv[++i] ?? null;
    else if (a.startsWith("--stage=")) out.stage = a.slice(8);
    else if (a === "--ips") out.ips = argv[++i] ?? null;
    else if (a.startsWith("--ips=")) out.ips = a.slice(6);
    else if (!a.startsWith("-")) out.positional.push(a);
  }
  out.cmd = out.positional[0] || null;
  if (!out.nominee && out.positional[1] && out.cmd === "diagnose")
    out.nominee = out.positional[1];
  return out;
}

const ARGS = parseArgs(process.argv.slice(2));

if (ARGS.help || !ARGS.cmd) {
  console.log(`
  voteus.js — Voteus consolidated integrity tool

  COMMANDS:
    list              List all nominees
    diagnose <code>   Deep-dive one nominee (fuzzy: code/name/surname/id)
    audit             Full integrity audit (report only)
    clean             Fingerprint fraud cleanup (1 vote per nominee+fingerprint)
    purge-ips         Purge votes from attack IPs
    wipe-boosts       Wipe unverified / simulated boosts
    wipe              Wipe eliminated members (free votes + boosts)
    fix               Fix vote math mismatches + orphan records
    all               Run all detectors (report only)

  FLAGS:
    --apply           Actually modify DB (default: DRY-RUN)
    --nominee <q>     Filter to one nominee
    --strict          Tighter thresholds
    --verbose         Full detail
    --json            Machine-readable output
    --cascade         wipe: also delete nominees + users rows
    --pull            Pull from Turso cloud first
    --stage <s>       preliminaries|semi_finals|finals|completed
    --ips <list>      Comma-separated IPs for purge-ips
    -h, --help        This help

  EXAMPLES:
    node voteus.js list
    node voteus.js diagnose VOTE_LW189
    node voteus.js audit --verbose
    node voteus.js clean --apply
    node voteus.js purge-ips --apply
    node voteus.js wipe-boosts --apply
    node voteus.js wipe --apply
    node voteus.js fix --apply
`);
  process.exit(ARGS.cmd ? 0 : 2);
}

/* ═══════════════════════════════════════════════════════════════════════
   CONFIG + HELPERS
   ═══════════════════════════════════════════════════════════════════════ */

const DB_PATH = process.env.DB_PATH || path.join(__dirname, "voting-local.db");
const HAS_TURSO = !!(
  process.env.TURSO_DATABASE_URL && process.env.TURSO_AUTH_TOKEN
);
const EAT_MS = 3 * 3600 * 1000;
const JSON_OUT = ARGS.json;

const S = (k, d) =>
  Number(process.env[k]) || (ARGS.strict ? Math.max(1, Math.floor(d / 2)) : d);

const CFG = {
  BURST_PER_MIN: S("BURST_PER_MIN", 15),
  BURST_PER_HOUR: S("BURST_PER_HOUR", 100),
  IP_VOTES_PER_CAT: S("IP_VOTES_PER_CAT", 3),
  IP_VOTES_TOTAL: S("IP_VOTES_TOTAL", 20),
  UA_REUSE: S("UA_REUSE", 30),
  FP_REUSE: S("FP_REUSE", 20),
  CONCENTRATION:
    Number(process.env.CONCENTRATION) || (ARGS.strict ? 0.35 : 0.5),
  BOOSTS_PER_NOMINEE: S("BOOSTS_PER_NOMINEE", 5),
  OFF_HOURS_VOTES: S("OFF_HOURS_VOTES", 10),
  Z_SCORE: Number(process.env.Z_SCORE) || (ARGS.strict ? 2 : 3),
};

const DEFAULT_ATTACK_IPS = [
  "10.25.16.27",
  "10.28.37.5",
  "10.25.105.50",
  "10.29.248.125",
  "10.31.127.154",
  "10.31.179.45",
  "10.28.187.238",
  "10.27.179.133",
  "10.26.240.238",
];
const ATTACK_IPS =
  ARGS.ips || process.env.ATTACK_IPS || ""
    ? String(ARGS.ips || process.env.ATTACK_IPS)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : DEFAULT_ATTACK_IPS;

const C = {
  r: "\x1b[31m",
  y: "\x1b[33m",
  g: "\x1b[32m",
  b: "\x1b[36m",
  m: "\x1b[35m",
  w: "\x1b[1m",
  d: "\x1b[2m",
  x: "\x1b[0m",
};
const paint = (c, s) => (JSON_OUT ? String(s) : c + s + C.x);
const fmtN = (n) => Number(n || 0).toLocaleString();
const pct = (n, d) => (d > 0 ? ((n / d) * 100).toFixed(1) + "%" : "0.0%");

function eatTime(iso) {
  if (!iso) return "—";
  const str = String(iso);
  const d = new Date(
    str.includes("Z") || /[+-]\d{2}:?\d{2}$/.test(str)
      ? str
      : str.replace(" ", "T") + "Z",
  );
  if (isNaN(d)) return "—";
  return (
    new Date(d.getTime() + EAT_MS)
      .toISOString()
      .replace("T", " ")
      .slice(0, 19) + " EAT"
  );
}

function section(title) {
  if (JSON_OUT) return;
  console.log("\n" + C.b + "═".repeat(78) + C.x);
  console.log("  " + C.w + title + C.x);
  console.log(C.b + "═".repeat(78) + C.x);
}

function sub(title) {
  if (JSON_OUT) return;
  console.log("\n" + C.w + "  ▸ " + title + C.x);
}

function line(msg) {
  if (JSON_OUT) return;
  console.log("  " + msg);
}

function ok(msg) {
  line(paint(C.g, "✓ ") + msg);
}
function fail(msg) {
  line(paint(C.r, "✗ ") + msg);
}
function warn(msg) {
  line(paint(C.y, "⚠ ") + msg);
}
function info(msg) {
  line(paint(C.d, "  " + msg));
}

function table(rows, cols) {
  if (JSON_OUT) return;
  if (!rows.length) {
    line(paint(C.d, "(none)"));
    return;
  }
  const widths = cols.map((c) =>
    Math.max(
      c.label.length,
      ...rows.map(
        (r) => String(c.fmt ? c.fmt(r[c.key], r) : (r[c.key] ?? "")).length,
      ),
    ),
  );
  const pad = (s, w) => String(s).padEnd(w);
  line(cols.map((c, i) => paint(C.w, pad(c.label, widths[i]))).join("  "));
  line(widths.map((w) => paint(C.d, "─".repeat(w))).join("  "));
  for (const r of rows) {
    line(
      cols
        .map((c, i) => {
          const raw = c.fmt ? c.fmt(r[c.key], r) : (r[c.key] ?? "");
          const col = c.color ? c.color(r, raw) : C.d;
          return paint(col, pad(raw, widths[i]));
        })
        .join("  "),
    );
  }
}

/* ═══════════════════════════════════════════════════════════════════════
   DB OPEN + SCHEMA + PULL
   ═══════════════════════════════════════════════════════════════════════ */

let Database;
try {
  Database = require("better-sqlite3");
} catch {
  console.error("✗ better-sqlite3 missing. Run: npm install better-sqlite3");
  process.exit(1);
}

if (!fs.existsSync(DB_PATH)) {
  console.error("✗ DB not found:", DB_PATH);
  process.exit(1);
}

const ALL_TABLES = [
  `CREATE TABLE IF NOT EXISTS categories (id TEXT PRIMARY KEY, name TEXT UNIQUE NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP)`,
  `CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP)`,
  `CREATE TABLE IF NOT EXISTS nominees (id TEXT PRIMARY KEY, user_id TEXT, name TEXT NOT NULL, category_id TEXT NOT NULL, code TEXT UNIQUE NOT NULL, img TEXT, desc TEXT, votes INTEGER DEFAULT 0, created_at TEXT DEFAULT CURRENT_TIMESTAMP)`,
  `CREATE TABLE IF NOT EXISTS free_votes (id TEXT PRIMARY KEY, voter_token TEXT NOT NULL, nominee_id TEXT NOT NULL, device_hash TEXT, ip TEXT, category_id TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP, UNIQUE(voter_token, nominee_id))`,
  `CREATE TABLE IF NOT EXISTS nominee_boosts (id TEXT PRIMARY KEY, nominee_id TEXT NOT NULL, reference TEXT NOT NULL, votes_added INTEGER NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP)`,
  `CREATE TABLE IF NOT EXISTS transactions (id TEXT PRIMARY KEY, reference TEXT UNIQUE NOT NULL, type TEXT NOT NULL, user_id TEXT, nominee_id TEXT, amount REAL NOT NULL, phone TEXT NOT NULL, status TEXT DEFAULT 'pending', metadata TEXT, mpesa_receipt TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP, completed_at TEXT)`,
  `CREATE TABLE IF NOT EXISTS leaderboard_access (user_id TEXT PRIMARY KEY, permanent INTEGER DEFAULT 0, expires_at TEXT, credits INTEGER DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS payment_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, reference TEXT NOT NULL, event TEXT NOT NULL, details TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP)`,
  `CREATE TABLE IF NOT EXISTS admins (id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, display_name TEXT, role TEXT DEFAULT 'admin', created_by TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP, revoked INTEGER DEFAULT 0, revoked_at TEXT, revoked_by TEXT)`,
  `CREATE TABLE IF NOT EXISTS ip_lookup_cache (ip TEXT PRIMARY KEY, country TEXT, region TEXT, city TEXT, isp TEXT, org TEXT, asn TEXT, fetched_at TEXT DEFAULT CURRENT_TIMESTAMP)`,
  `CREATE TABLE IF NOT EXISTS vote_reports (id TEXT PRIMARY KEY, report_code TEXT UNIQUE NOT NULL, reported_at TEXT DEFAULT CURRENT_TIMESTAMP, ip TEXT, user_agent TEXT, voter_token TEXT, device_hash TEXT, fingerprint_details TEXT, report_description TEXT, reporter_name TEXT, reporter_contact TEXT, verdict TEXT NOT NULL, matched_votes TEXT, geo_info TEXT)`,
  `CREATE TABLE IF NOT EXISTS vote_appeals (id TEXT PRIMARY KEY, appeal_code TEXT UNIQUE NOT NULL, report_code TEXT NOT NULL, device_hash TEXT NOT NULL, voter_token TEXT NOT NULL, category_id TEXT NOT NULL, category_name TEXT, reason TEXT NOT NULL, status TEXT DEFAULT 'pending', created_at TEXT DEFAULT CURRENT_TIMESTAMP, decided_at TEXT, decided_by TEXT, decision_note TEXT)`,
  `CREATE TABLE IF NOT EXISTS vote_allowances (id TEXT PRIMARY KEY, appeal_code TEXT NOT NULL, device_hash TEXT NOT NULL, voter_token TEXT NOT NULL, category_id TEXT NOT NULL, status TEXT DEFAULT 'active', created_at TEXT DEFAULT CURRENT_TIMESTAMP, used_at TEXT, used_vote_id TEXT)`,
];
const COLUMN_PATCHES = [
  ["nominees", "stage TEXT DEFAULT 'preliminaries'"],
  ["nominees", "eliminated INTEGER DEFAULT 0"],
  ["nominees", "eliminated_stage TEXT"],
  ["nominees", "qualified_at TEXT"],
  ["nominees", "final_rank INTEGER"],
  ["free_votes", "device_hash TEXT"],
  ["free_votes", "ip TEXT"],
  ["free_votes", "category_id TEXT"],
  ["free_votes", "user_agent TEXT"],
  ["free_votes", "fingerprint_json TEXT"],
  ["free_votes", "is_appeal INTEGER DEFAULT 0"],
];

function ensureLocalSchema() {
  const db = new Database(DB_PATH);
  db.pragma("busy_timeout = 8000");
  for (const sql of ALL_TABLES) {
    try {
      db.exec(sql);
    } catch {}
  }
  for (const [t, c] of COLUMN_PATCHES) {
    try {
      db.exec(`ALTER TABLE ${t} ADD COLUMN ${c}`);
    } catch {}
  }
  db.close();
}

async function ensureData() {
  ensureLocalSchema();
  let nomineeCount = 0;
  try {
    const probe = new Database(DB_PATH, { readonly: true });
    nomineeCount = probe.prepare("SELECT COUNT(*) AS c FROM nominees").get().c;
    probe.close();
  } catch {}

  if (nomineeCount > 0 && !ARGS.pull) return nomineeCount;
  if (!HAS_TURSO) {
    if (nomineeCount === 0) {
      console.error(paint(C.r, "✗ Local DB empty AND no Turso creds."));
      console.error(
        paint(
          C.y,
          "  Run the server once, or set TURSO_DATABASE_URL + TURSO_AUTH_TOKEN.",
        ),
      );
      process.exit(1);
    }
    return nomineeCount;
  }
  if (!JSON_OUT) console.log(paint(C.y, "\n  → Pulling from Turso…"));
  try {
    const dbModule = require("./db");
    await dbModule.pull();
    const probe = new Database(DB_PATH, { readonly: true });
    nomineeCount = probe.prepare("SELECT COUNT(*) AS c FROM nominees").get().c;
    probe.close();
    if (!JSON_OUT && nomineeCount > 0)
      ok(`Pulled — ${fmtN(nomineeCount)} nominee(s)`);
    return nomineeCount;
  } catch (e) {
    if (nomineeCount === 0) {
      console.error(paint(C.r, "✗ Pull failed:", e.message));
      process.exit(1);
    }
    warn("Pull failed, using local data: " + e.message);
    return nomineeCount;
  }
}

function openDB(readonly) {
  const db = new Database(DB_PATH, { readonly: !!readonly });
  db.pragma("busy_timeout = 8000");
  return db;
}

/* ═══════════════════════════════════════════════════════════════════════
   NOMINEE LOOKUP — bulletproof fuzzy matching
   ═══════════════════════════════════════════════════════════════════════ */

function sanitizeQuery(q) {
  return String(q || "")
    .trim()
    .replace(
      /^["'`\u201C\u201D\u2018\u2019]+|["'`\u201C\u201D\u2018\u2019]+$/g,
      "",
    )
    .replace(/[\u200B-\u200D\uFEFF]/g, "");
}

function findNominee(db, query) {
  const q = sanitizeQuery(query);
  if (!q) return null;
  const SEL = `SELECT n.*, c.name AS category FROM nominees n JOIN categories c ON c.id = n.category_id`;

  let n = db.prepare(`${SEL} WHERE n.code = ? COLLATE NOCASE`).get(q);
  if (n) return { nominee: n, matchType: "exact_code" };

  const normalized = q.replace(/\s+/g, "_");
  if (normalized !== q) {
    n = db.prepare(`${SEL} WHERE n.code = ? COLLATE NOCASE`).get(normalized);
    if (n) return { nominee: n, matchType: "normalized_code" };
  }

  if (
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(q)
  ) {
    n = db.prepare(`${SEL} WHERE n.id = ?`).get(q);
    if (n) return { nominee: n, matchType: "exact_id" };
  }

  n = db.prepare(`${SEL} WHERE n.name = ? COLLATE NOCASE`).get(q);
  if (n) return { nominee: n, matchType: "exact_name" };

  n = db
    .prepare(
      `${SEL} WHERE n.code LIKE ? COLLATE NOCASE ORDER BY LENGTH(n.code) ASC LIMIT 1`,
    )
    .get(`%${q}%`);
  if (n) return { nominee: n, matchType: "partial_code" };

  n = db
    .prepare(
      `${SEL} WHERE n.name LIKE ? COLLATE NOCASE ORDER BY LENGTH(n.name) ASC LIMIT 1`,
    )
    .get(`%${q}%`);
  if (n) return { nominee: n, matchType: "partial_name" };

  const parts = q.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) {
    n = db
      .prepare(
        `${SEL} WHERE n.name LIKE ? COLLATE NOCASE ORDER BY LENGTH(n.name) ASC LIMIT 1`,
      )
      .get(`%${parts[parts.length - 1]}%`);
    if (n) return { nominee: n, matchType: "surname" };
  }
  return null;
}

function diagnoseNotFound(db, query) {
  const nc = db.prepare("SELECT COUNT(*) AS c FROM nominees").get().c;
  const cc = db.prepare("SELECT COUNT(*) AS c FROM categories").get().c;
  let vc = 0;
  try {
    vc = db.prepare("SELECT COUNT(*) AS c FROM free_votes").get().c;
  } catch {}
  fail(`Nominee not found: "${query}"`);
  line("");
  line(`DB:          ${DB_PATH}`);
  line(`Nominees:    ${fmtN(nc)}`);
  line(`Categories:  ${fmtN(cc)}`);
  line(`Free votes:  ${fmtN(vc)}`);
  if (nc === 0) {
    warn("Local DB has 0 nominees. Try: node voteus.js --pull list");
    return;
  }
  const sugg = db
    .prepare(
      `SELECT n.code, n.name, c.name AS category FROM nominees n
     JOIN categories c ON c.id = n.category_id
     WHERE n.code LIKE ? COLLATE NOCASE OR n.name LIKE ? COLLATE NOCASE
     ORDER BY n.name ASC LIMIT 10`,
    )
    .all(`%${query}%`, `%${query}%`);
  if (sugg.length) {
    sub("Did you mean?");
    for (const s of sugg)
      line(
        `${C.w}${s.code}${C.x}  ${s.name}  ${paint(C.d, `(${s.category})`)}`,
      );
  } else {
    const sample = db
      .prepare("SELECT code, name FROM nominees ORDER BY name ASC LIMIT 5")
      .all();
    sub("First 5 nominees in DB:");
    for (const s of sample) line(`${s.code}  ${s.name}`);
  }
}

/* ═══════════════════════════════════════════════════════════════════════
   COMMAND: list
   ═══════════════════════════════════════════════════════════════════════ */

function cmdList() {
  const db = openDB(true);
  try {
    let rows;
    if (ARGS.nominee) {
      const q = `%${ARGS.nominee}%`;
      rows = db
        .prepare(
          `SELECT n.code, n.name, c.name AS category, COALESCE(n.votes,0) AS votes,
                n.stage, n.eliminated
         FROM nominees n JOIN categories c ON c.id = n.category_id
         WHERE n.code LIKE ? COLLATE NOCASE OR n.name LIKE ? COLLATE NOCASE
         ORDER BY votes DESC`,
        )
        .all(q, q);
    } else {
      rows = db
        .prepare(
          `SELECT n.code, n.name, c.name AS category, COALESCE(n.votes,0) AS votes,
                n.stage, n.eliminated
         FROM nominees n JOIN categories c ON c.id = n.category_id
         ORDER BY votes DESC`,
        )
        .all();
    }

    if (JSON_OUT) {
      console.log(JSON.stringify(rows, null, 2));
      return;
    }

    section("NOMINEES" + (ARGS.nominee ? ` — filter "${ARGS.nominee}"` : ""));
    if (!rows.length) {
      warn("No nominees found.");
      return;
    }
    line(`${rows.length} nominee(s):\n`);
    for (const r of rows) {
      const elim = r.eliminated ? paint(C.r, " (elim)") : "";
      line(
        `${C.w}${String(r.code).padEnd(18)}${C.x}` +
          `${String(r.name).slice(0, 32).padEnd(34)}` +
          `${paint(C.d, `(${String(r.category).slice(0, 22)})`).padEnd(28)} ` +
          `${C.y}${fmtN(r.votes).padStart(8)}${C.x}${elim}`,
      );
    }
  } finally {
    db.close();
  }
}

/* ═══════════════════════════════════════════════════════════════════════
   COMMAND: diagnose
   ═══════════════════════════════════════════════════════════════════════ */

function cmdDiagnose() {
  if (!ARGS.nominee) {
    fail("diagnose requires --nominee <code|name|surname|id>");
    process.exit(2);
  }
  const db = openDB(true);
  try {
    const found = findNominee(db, ARGS.nominee);
    if (!found) {
      diagnoseNotFound(db, ARGS.nominee);
      process.exit(3);
    }

    const nom = found.nominee;
    if (
      !JSON_OUT &&
      found.matchType !== "exact_code" &&
      found.matchType !== "exact_id"
    ) {
      warn(
        `Matched by ${found.matchType}: "${ARGS.nominee}" → ${nom.code} (${nom.name})`,
      );
    }

    const out = {
      nominee: {
        code: nom.code,
        name: nom.name,
        category: nom.category,
        votes: nom.votes,
        stage: nom.stage,
        eliminated: nom.eliminated,
        created_at: nom.created_at,
        user_id: nom.user_id,
      },
      matched_by: found.matchType,
      math: {},
      daily: [],
      hourly: [],
      bursts: [],
      ips: [],
      devices: [],
      uas: [],
      fingerprints: [],
      boosts: [],
      verdict: { suspicious: false, reasons: [] },
    };

    section(`DEEP DIVE: ${nom.code} — ${nom.name}`);
    line(`Matched by: ${paint(C.d, found.matchType)}`);
    line(`Category:   ${nom.category}`);
    line(`Votes:      ${paint(C.y, fmtN(nom.votes))}`);
    line(
      `Stage:      ${nom.stage || "—"}  eliminated=${nom.eliminated ? "YES" : "no"}`,
    );
    line(`Created:    ${eatTime(nom.created_at)}`);
    if (nom.user_id) line(`User ID:    ${paint(C.d, nom.user_id)}`);

    const free = db
      .prepare("SELECT COUNT(*) AS c FROM free_votes WHERE nominee_id = ?")
      .get(nom.id).c;
    const boost = db
      .prepare(
        "SELECT COALESCE(SUM(votes_added),0) AS s, COUNT(*) AS c FROM nominee_boosts WHERE nominee_id = ?",
      )
      .get(nom.id);
    const expected = free + boost.s;
    const delta = nom.votes - expected;

    out.math = {
      stored: nom.votes,
      free,
      boost: boost.s,
      boost_count: boost.c,
      expected,
      delta,
    };

    line("");
    line(`Free votes:  ${fmtN(free)}`);
    line(
      `Boost votes: ${fmtN(boost.s)} (${boost.c} boost${boost.c === 1 ? "" : "s"})`,
    );
    if (delta !== 0)
      fail(
        `MISMATCH: stored ${fmtN(nom.votes)} vs expected ${fmtN(expected)} (Δ ${delta > 0 ? "+" : ""}${fmtN(delta)})`,
      );
    else ok(`Math OK: ${fmtN(expected)}`);

    const daily = db
      .prepare(
        "SELECT date(created_at) AS day, COUNT(*) AS c FROM free_votes WHERE nominee_id = ? GROUP BY day ORDER BY day ASC",
      )
      .all(nom.id);
    out.daily = daily;
    if (daily.length) {
      sub("Daily votes:");
      const max = Math.max(...daily.map((x) => x.c));
      for (const d of daily) {
        const bar = "█".repeat(
          Math.min(60, Math.ceil((d.c / Math.max(1, max)) * 40)),
        );
        const col = d.c > 1000 ? C.r : d.c > 100 ? C.y : C.g;
        line(`${d.day}  ${paint(col, bar.padEnd(40))} ${fmtN(d.c)}`);
      }
    }

    const hourly = db
      .prepare(
        `SELECT CAST(strftime('%H', datetime(created_at, '+3 hours')) AS INTEGER) AS hr, COUNT(*) AS c
       FROM free_votes WHERE nominee_id = ? GROUP BY hr ORDER BY hr`,
      )
      .all(nom.id);
    out.hourly = hourly;
    if (hourly.length) {
      sub("Hourly (EAT):");
      const max = Math.max(...hourly.map((x) => x.c));
      for (const h of hourly) {
        const bar = "█".repeat(
          Math.min(60, Math.ceil((h.c / Math.max(1, max)) * 40)),
        );
        const col = h.hr <= 4 ? C.y : C.g;
        line(
          `${String(h.hr).padStart(2, "0")}:00  ${paint(col, bar.padEnd(40))} ${fmtN(h.c)}`,
        );
      }
    }

    const bursts = db
      .prepare(
        `SELECT strftime('%Y-%m-%d %H:%M', created_at) AS minute, COUNT(*) AS c
       FROM free_votes WHERE nominee_id = ? GROUP BY minute ORDER BY c DESC LIMIT 10`,
      )
      .all(nom.id);
    out.bursts = bursts;
    if (bursts.length) {
      sub("Top 10 burst minutes:");
      for (const b of bursts) {
        const col = b.c > 20 ? C.r : b.c > 5 ? C.y : C.d;
        line(
          `${b.minute}  →  ${eatTime(b.minute + ":00Z").padEnd(30)}  ${paint(col, String(b.c).padStart(5))}`,
        );
      }
    }

    const ips = db
      .prepare(
        `SELECT ip, COUNT(*) AS c, COUNT(DISTINCT voter_token) AS tokens, COUNT(DISTINCT device_hash) AS devices
       FROM free_votes WHERE nominee_id = ? GROUP BY ip ORDER BY c DESC LIMIT 10`,
      )
      .all(nom.id);
    out.ips = ips;
    if (ips.length) {
      sub("Top 10 IPs:");
      for (const r of ips) {
        const col = r.c > 100 ? C.r : r.c > 10 ? C.y : C.d;
        line(
          `${String(r.ip || "?").padEnd(22)}  ${paint(col, String(r.c).padStart(6))} votes  ${C.d}${r.tokens} tokens, ${r.devices} devices${C.x}`,
        );
      }
    }

    const devices = db
      .prepare(
        `SELECT device_hash, COUNT(*) AS c FROM free_votes
       WHERE nominee_id = ? AND device_hash IS NOT NULL GROUP BY device_hash ORDER BY c DESC LIMIT 10`,
      )
      .all(nom.id);
    out.devices = devices;
    if (devices.length) {
      sub("Top 10 device hashes:");
      for (const r of devices) {
        const col = r.c > 100 ? C.r : r.c > 10 ? C.y : C.d;
        line(
          `${String(r.device_hash).slice(0, 24).padEnd(26)}  ${paint(col, String(r.c).padStart(6))} votes`,
        );
      }
    }

    const uas = db
      .prepare(
        `SELECT user_agent, COUNT(*) AS c FROM free_votes
       WHERE nominee_id = ? AND user_agent IS NOT NULL GROUP BY user_agent ORDER BY c DESC LIMIT 5`,
      )
      .all(nom.id);
    out.uas = uas;
    if (uas.length) {
      sub("Top 5 user-agents:");
      for (const r of uas) {
        const col = r.c > 100 ? C.r : r.c > 10 ? C.y : C.d;
        line(
          `${paint(col, String(r.c).padStart(6))}  ${String(r.user_agent || "?").slice(0, 80)}`,
        );
      }
    }

    const fps = db
      .prepare(
        `SELECT fingerprint_json, COUNT(*) AS c FROM free_votes
       WHERE nominee_id = ? AND fingerprint_json IS NOT NULL GROUP BY fingerprint_json ORDER BY c DESC LIMIT 5`,
      )
      .all(nom.id);
    out.fingerprints = fps;
    if (fps.length) {
      sub("Top 5 fingerprints:");
      for (const r of fps) {
        const col = r.c > 50 ? C.r : r.c > 10 ? C.y : C.d;
        line(
          `${paint(col, String(r.c).padStart(6))}  ${String(r.fingerprint_json).slice(0, 70)}…`,
        );
      }
    }

    const boosts = db
      .prepare(
        "SELECT reference, votes_added, created_at FROM nominee_boosts WHERE nominee_id = ? ORDER BY created_at ASC",
      )
      .all(nom.id);
    out.boosts = boosts;
    sub("Boost timeline:");
    if (boosts.length) {
      for (const b of boosts)
        line(
          `${String(b.reference).padEnd(30)}  +${fmtN(b.votes_added).padStart(5)}  ${eatTime(b.created_at)}`,
        );
    } else info("(no boosts)");

    const reasons = [];
    if (delta !== 0)
      reasons.push(
        `Math mismatch: stored ${fmtN(nom.votes)} vs expected ${fmtN(expected)} (Δ ${delta > 0 ? "+" : ""}${fmtN(delta)})`,
      );
    if (bursts.length && bursts[0].c > 30)
      reasons.push(
        `Massive burst: ${bursts[0].c} votes in one minute at ${eatTime(bursts[0].minute + ":00Z")}`,
      );
    else if (bursts.length && bursts[0].c > 15)
      reasons.push(`Elevated burst: ${bursts[0].c} votes in one minute`);
    if (ips.length && ips[0].c > 200)
      reasons.push(
        `Single IP contributed ${ips[0].c} votes (${ips[0].tokens} tokens, ${ips[0].devices} devices)`,
      );
    else if (ips.length && ips[0].c > 50)
      reasons.push(`Single IP contributed ${ips[0].c} votes`);
    const offH = hourly.filter((h) => h.hr <= 4).reduce((s, h) => s + h.c, 0);
    const totalH = hourly.reduce((s, h) => s + h.c, 0);
    if (offH > 100)
      reasons.push(
        `${offH} votes (${pct(offH, totalH)}) between 00:00–04:59 EAT`,
      );
    if (uas.length && uas[0].c > 500)
      reasons.push(`Single UA responsible for ${uas[0].c} votes`);
    if (devices.length && devices[0].c > 100)
      reasons.push(`Single device hash responsible for ${devices[0].c} votes`);
    if (fps.length && fps[0].c > 50)
      reasons.push(`Single fingerprint reused ${fps[0].c} times`);

    out.verdict = { suspicious: reasons.length > 0, reasons };

    if (JSON_OUT) {
      console.log(JSON.stringify(out, null, 2));
      return;
    }

    section("VERDICT");
    if (!reasons.length)
      ok("No statistical anomalies detected for this nominee.");
    else {
      warn(`${reasons.length} anomaly signal(s) detected:`);
      for (const r of reasons) line(paint(C.y, "● " + r));
    }
  } finally {
    db.close();
  }
}

/* ═══════════════════════════════════════════════════════════════════════
   AUDIT CHECKS (all 12+ from audit.js)
   ═══════════════════════════════════════════════════════════════════════ */

const FINDINGS = [];
function flag(sev, type, entity, evidence, recommendation) {
  FINDINGS.push({
    sev,
    type,
    entity,
    evidence,
    recommendation,
    ts: new Date().toISOString(),
  });
}

function checkVoteMath(db) {
  section("1. VOTE MATH RECONCILIATION");
  const rows = db
    .prepare(
      `SELECT n.id, n.code, n.name, COALESCE(n.votes,0) AS stored,
            (SELECT COUNT(*) FROM free_votes WHERE nominee_id = n.id) AS free_count,
            (SELECT COALESCE(SUM(votes_added),0) FROM nominee_boosts WHERE nominee_id = n.id) AS boost_sum
     FROM nominees n`,
    )
    .all();
  const mismatched = rows.filter(
    (r) => r.stored !== r.free_count + r.boost_sum,
  );
  sub(
    `Nominees: ${rows.length} · free: ${fmtN(rows.reduce((s, r) => s + r.free_count, 0))} · boost: ${fmtN(rows.reduce((s, r) => s + r.boost_sum, 0))}`,
  );
  if (!mismatched.length) {
    ok("All vote counts match source.");
    return;
  }
  fail(`${mismatched.length} nominee(s) have MISMATCHED vote counts:`);
  table(
    mismatched.map((m) => ({
      ...m,
      expected: m.free_count + m.boost_sum,
      delta: m.stored - (m.free_count + m.boost_sum),
    })),
    [
      { key: "code", label: "Code" },
      { key: "name", label: "Name", fmt: (v) => String(v).slice(0, 24) },
      { key: "stored", label: "Stored", fmt: fmtN, color: () => C.r },
      { key: "free_count", label: "Free", fmt: fmtN },
      { key: "boost_sum", label: "Boost", fmt: fmtN },
      { key: "expected", label: "Expected", fmt: fmtN, color: () => C.g },
      {
        key: "delta",
        label: "Δ",
        fmt: (v) => (v > 0 ? "+" : "") + fmtN(v),
        color: (_, v) => (v > 0 ? C.r : C.y),
      },
    ],
  );
  for (const m of mismatched)
    flag(
      m.delta > 0 ? "CRITICAL" : "HIGH",
      "vote_math_mismatch",
      `${m.code} (${m.name})`,
      {
        stored: m.stored,
        free: m.free_count,
        boost: m.boost_sum,
        expected: m.free_count + m.boost_sum,
        delta: m.stored - (m.free_count + m.boost_sum),
      },
      m.delta > 0 ? "Votes inflated above source." : "Votes deflated.",
    );
}

function checkOrphans(db) {
  section("2. ORPHANED RECORDS");
  const checks = [
    {
      label: "free_votes → nominees",
      n: db
        .prepare(
          "SELECT COUNT(*) AS c FROM free_votes fv LEFT JOIN nominees n ON n.id = fv.nominee_id WHERE n.id IS NULL",
        )
        .get().c,
      sev: "HIGH",
    },
    {
      label: "nominee_boosts → nominees",
      n: db
        .prepare(
          "SELECT COUNT(*) AS c FROM nominee_boosts b LEFT JOIN nominees n ON n.id = b.nominee_id WHERE n.id IS NULL",
        )
        .get().c,
      sev: "HIGH",
    },
    {
      label: "nominees.user_id → users",
      n: db
        .prepare(
          "SELECT COUNT(*) AS c FROM nominees n WHERE n.user_id IS NOT NULL AND n.user_id NOT IN (SELECT id FROM users)",
        )
        .get().c,
      sev: "MEDIUM",
    },
    {
      label: "nominees w/o user_id",
      n: db
        .prepare(
          "SELECT COUNT(*) AS c FROM nominees WHERE user_id IS NULL OR user_id = ''",
        )
        .get().c,
      sev: "MEDIUM",
    },
  ];
  for (const c of checks) {
    const icon = c.n === 0 ? paint(C.g, "✓") : paint(C.r, "✗");
    line(`${icon} ${c.label.padEnd(38)} ${fmtN(c.n)}`);
    if (c.n > 0)
      flag(c.sev, "orphan", c.label, { count: c.n }, "Delete or restore.");
  }
}

function checkUniqueness(db) {
  section("3. UNIQUENESS VIOLATIONS");
  const dupVoterNom = db
    .prepare(
      "SELECT voter_token, nominee_id, COUNT(*) AS c FROM free_votes GROUP BY voter_token, nominee_id HAVING c > 1 LIMIT 100",
    )
    .all();
  sub(`Duplicate (voter_token, nominee_id): ${dupVoterNom.length}`);
  if (dupVoterNom.length) {
    for (const d of dupVoterNom)
      flag(
        "CRITICAL",
        "dup_voter_nominee",
        `token=${d.voter_token.slice(0, 20)}…`,
        { votes: d.c },
        "Schema violation.",
      );
  } else ok("None");

  const dupDevCat = db
    .prepare(
      `SELECT device_hash, category_id, COUNT(*) AS c FROM free_votes
     WHERE device_hash IS NOT NULL AND is_appeal = 0 AND category_id IS NOT NULL
     GROUP BY device_hash, category_id HAVING c > 1 LIMIT 100`,
    )
    .all();
  sub(`Duplicate (device_hash, category_id) non-appeal: ${dupDevCat.length}`);
  if (dupDevCat.length) {
    for (const d of dupDevCat)
      flag(
        "CRITICAL",
        "dup_device_category",
        `device=${d.device_hash.slice(0, 16)}… cat=${d.category_id.slice(0, 8)}`,
        { votes: d.c },
        "Bypassed UNIQUE index.",
      );
  } else ok("None");

  const devMulti = db
    .prepare(
      `SELECT device_hash, COUNT(DISTINCT category_id) AS cats, COUNT(*) AS votes
     FROM free_votes WHERE device_hash IS NOT NULL AND is_appeal = 0
     GROUP BY device_hash HAVING cats > 1 ORDER BY cats DESC LIMIT 50`,
    )
    .all();
  sub(`Devices voting in > 1 category: ${devMulti.length}`);
  if (devMulti.length) {
    table(devMulti, [
      {
        key: "device_hash",
        label: "Device",
        fmt: (v) => String(v).slice(0, 20) + "…",
      },
      {
        key: "cats",
        label: "Categories",
        color: (_, v) => (v > 2 ? C.y : C.d),
      },
      { key: "votes", label: "Votes" },
    ]);
    for (const d of devMulti)
      flag(
        d.cats > 3 ? "HIGH" : "MEDIUM",
        "device_multi_category",
        `device=${d.device_hash.slice(0, 16)}…`,
        { categories: d.cats, votes: d.votes },
        null,
      );
  } else ok("None");
}

function checkBursts(db) {
  section("4. VOTE BURSTS");
  const perMin = db
    .prepare(
      `SELECT nominee_id, strftime('%Y-%m-%d %H:%M', created_at) AS bucket, COUNT(*) AS c
     FROM free_votes GROUP BY nominee_id, bucket HAVING c > ? ORDER BY c DESC LIMIT 40`,
    )
    .all(CFG.BURST_PER_MIN);

  sub(
    `Minutes with > ${CFG.BURST_PER_MIN} votes on one nominee: ${perMin.length}`,
  );
  if (perMin.length) {
    const withNames = perMin.map((r) => {
      const n =
        db
          .prepare("SELECT code, name FROM nominees WHERE id = ?")
          .get(r.nominee_id) || {};
      return { ...r, code: n.code || "?", name: n.name || "?" };
    });
    table(withNames, [
      {
        key: "bucket",
        label: "Minute (UTC)",
        fmt: (v) => v + " → " + eatTime(v + ":00Z"),
      },
      { key: "code", label: "Code" },
      { key: "name", label: "Name", fmt: (v) => String(v).slice(0, 26) },
      {
        key: "c",
        label: "Votes",
        color: (_, v) => (v > CFG.BURST_PER_MIN * 2 ? C.r : C.y),
      },
    ]);
    for (const b of withNames)
      flag(
        b.c > CFG.BURST_PER_MIN * 3 ? "CRITICAL" : "HIGH",
        "burst_minute",
        `${b.code} ${b.name}`,
        { minute: b.bucket, votes: b.c },
        "Likely bot activity.",
      );
  } else ok("None");

  const perHour = db
    .prepare(
      `SELECT nominee_id, strftime('%Y-%m-%d %H', created_at) AS bucket, COUNT(*) AS c
     FROM free_votes GROUP BY nominee_id, bucket HAVING c > ? ORDER BY c DESC LIMIT 30`,
    )
    .all(CFG.BURST_PER_HOUR);

  sub(
    `Hours with > ${CFG.BURST_PER_HOUR} votes on one nominee: ${perHour.length}`,
  );
  if (perHour.length) {
    const withNames = perHour.map((r) => {
      const n =
        db
          .prepare("SELECT code, name FROM nominees WHERE id = ?")
          .get(r.nominee_id) || {};
      return { ...r, code: n.code || "?", name: n.name || "?" };
    });
    table(withNames, [
      {
        key: "bucket",
        label: "Hour (UTC)",
        fmt: (v) => v + ":00 → " + eatTime(v + ":00:00Z"),
      },
      { key: "code", label: "Code" },
      { key: "name", label: "Name", fmt: (v) => String(v).slice(0, 26) },
      {
        key: "c",
        label: "Votes",
        color: (_, v) => (v > CFG.BURST_PER_HOUR * 2 ? C.r : C.y),
      },
    ]);
    for (const h of withNames)
      flag(
        h.c > CFG.BURST_PER_HOUR * 2 ? "CRITICAL" : "HIGH",
        "burst_hour",
        `${h.code} ${h.name}`,
        { hour: h.bucket, votes: h.c },
        "Sustained burst.",
      );
  } else ok("None");
}

function checkOffHours(db) {
  section("5. OFF-HOURS VOTES (00:00–05:00 EAT)");
  const rows = db
    .prepare(
      `SELECT n.code, n.name, n.id AS nominee_id,
            CAST(strftime('%H', datetime(created_at, '+3 hours')) AS INTEGER) AS eat_hour,
            COUNT(*) AS votes
     FROM free_votes fv JOIN nominees n ON n.id = fv.nominee_id
     WHERE CAST(strftime('%H', datetime(created_at, '+3 hours')) AS INTEGER) BETWEEN 0 AND 4
     GROUP BY n.id, eat_hour HAVING votes > ? ORDER BY votes DESC LIMIT 40`,
    )
    .all(CFG.OFF_HOURS_VOTES);
  sub(
    `Nominee-hours with > ${CFG.OFF_HOURS_VOTES} votes during 00–05 EAT: ${rows.length}`,
  );
  if (rows.length) {
    table(rows, [
      { key: "code", label: "Code" },
      { key: "name", label: "Name", fmt: (v) => String(v).slice(0, 26) },
      {
        key: "eat_hour",
        label: "EAT",
        fmt: (v) => String(v).padStart(2, "0") + ":00",
      },
      {
        key: "votes",
        label: "Votes",
        color: (_, v) => (v > CFG.OFF_HOURS_VOTES * 3 ? C.r : C.y),
      },
    ]);
    for (const r of rows)
      flag(
        r.votes > CFG.OFF_HOURS_VOTES * 3 ? "HIGH" : "MEDIUM",
        "off_hours",
        `${r.code} ${r.name}`,
        { eatHour: r.eat_hour, votes: r.votes },
        "Check geo/IP.",
      );
  } else ok("None");
}

function checkIPs(db) {
  section("6. IP CONCENTRATION");
  const perCat = db
    .prepare(
      `SELECT fv.ip, fv.category_id, c.name AS category, COUNT(*) AS votes,
            COUNT(DISTINCT fv.voter_token) AS tokens, COUNT(DISTINCT fv.device_hash) AS devices
     FROM free_votes fv JOIN categories c ON c.id = fv.category_id
     WHERE fv.ip IS NOT NULL AND fv.ip NOT IN ('unknown', '::1')
     GROUP BY fv.ip, fv.category_id HAVING votes > ? ORDER BY votes DESC LIMIT 40`,
    )
    .all(CFG.IP_VOTES_PER_CAT);
  sub(
    `IP+category pairs with > ${CFG.IP_VOTES_PER_CAT} votes: ${perCat.length}`,
  );
  if (perCat.length) {
    table(perCat, [
      { key: "ip", label: "IP", fmt: (v) => String(v).slice(0, 20) },
      {
        key: "category",
        label: "Category",
        fmt: (v) => String(v).slice(0, 22),
      },
      {
        key: "votes",
        label: "Votes",
        color: (_, v) => (v > CFG.IP_VOTES_PER_CAT * 5 ? C.r : C.y),
      },
      { key: "tokens", label: "Tokens" },
      { key: "devices", label: "Devices" },
    ]);
    for (const r of perCat)
      flag(
        r.votes > CFG.IP_VOTES_PER_CAT * 10 ? "CRITICAL" : "HIGH",
        "ip_concentration",
        `IP ${r.ip} → ${r.category}`,
        { votes: r.votes, tokens: r.tokens, devices: r.devices },
        "Token rotation attack.",
      );
  } else ok("None");

  const totalIP = db
    .prepare(
      `SELECT ip, COUNT(*) AS votes, COUNT(DISTINCT voter_token) AS tokens,
            COUNT(DISTINCT device_hash) AS devices, COUNT(DISTINCT category_id) AS cats
     FROM free_votes WHERE ip IS NOT NULL AND ip NOT IN ('unknown', '::1')
     GROUP BY ip HAVING votes > ? ORDER BY votes DESC LIMIT 40`,
    )
    .all(CFG.IP_VOTES_TOTAL);
  sub(`IPs with > ${CFG.IP_VOTES_TOTAL} total votes: ${totalIP.length}`);
  if (totalIP.length) {
    table(totalIP, [
      { key: "ip", label: "IP", fmt: (v) => String(v).slice(0, 20) },
      {
        key: "votes",
        label: "Votes",
        color: (_, v) => (v > CFG.IP_VOTES_TOTAL * 5 ? C.r : C.y),
      },
      { key: "tokens", label: "Tokens" },
      { key: "devices", label: "Devices" },
      { key: "cats", label: "Cats" },
    ]);
    for (const r of totalIP)
      flag(
        r.votes > CFG.IP_VOTES_TOTAL * 5 ? "CRITICAL" : "HIGH",
        "ip_total",
        `IP ${r.ip}`,
        {
          votes: r.votes,
          tokens: r.tokens,
          devices: r.devices,
          categories: r.cats,
        },
        "Proxy/VPN.",
      );
  } else ok("None");
}

function checkFingerprints(db) {
  section("7. FINGERPRINT & UA REUSE");
  const fpReuse = db
    .prepare(
      `SELECT fingerprint_json, COUNT(*) AS c,
            COUNT(DISTINCT device_hash) AS devices, COUNT(DISTINCT ip) AS ips,
            COUNT(DISTINCT nominee_id) AS noms
     FROM free_votes WHERE fingerprint_json IS NOT NULL
     GROUP BY fingerprint_json HAVING c > ? ORDER BY c DESC LIMIT 30`,
    )
    .all(CFG.FP_REUSE);
  sub(`Fingerprints reused > ${CFG.FP_REUSE} times: ${fpReuse.length}`);
  if (fpReuse.length) {
    table(fpReuse, [
      {
        key: "fingerprint_json",
        label: "Fingerprint",
        fmt: (v) => String(v).slice(0, 26) + "…",
      },
      {
        key: "c",
        label: "Votes",
        color: (_, v) => (v > CFG.FP_REUSE * 5 ? C.r : C.y),
      },
      { key: "devices", label: "Devices" },
      { key: "ips", label: "IPs" },
      { key: "noms", label: "Nominees" },
    ]);
    for (const r of fpReuse)
      flag(
        "HIGH",
        "fingerprint_reuse",
        `fp=${String(r.fingerprint_json).slice(0, 24)}…`,
        { votes: r.c, devices: r.devices, ips: r.ips },
        "Bot with fixed profile.",
      );
  } else ok("None");

  const uaReuse = db
    .prepare(
      `SELECT user_agent, COUNT(*) AS c, COUNT(DISTINCT voter_token) AS tokens
     FROM free_votes WHERE user_agent IS NOT NULL
     GROUP BY user_agent HAVING c > ? ORDER BY c DESC LIMIT 20`,
    )
    .all(CFG.UA_REUSE);
  sub(`User-agents reused > ${CFG.UA_REUSE} times: ${uaReuse.length}`);
  if (uaReuse.length) {
    table(uaReuse, [
      {
        key: "user_agent",
        label: "UA",
        fmt: (v) => String(v).slice(0, 60) + (v.length > 60 ? "…" : ""),
      },
      {
        key: "c",
        label: "Votes",
        color: (_, v) => (v > CFG.UA_REUSE * 10 ? C.r : C.y),
      },
      { key: "tokens", label: "Tokens" },
    ]);
    for (const r of uaReuse)
      flag(
        r.c > CFG.UA_REUSE * 20 ? "CRITICAL" : "MEDIUM",
        "ua_reuse",
        `UA=${String(r.user_agent).slice(0, 40)}…`,
        { votes: r.c, tokens: r.tokens },
        "Single tool.",
      );
  } else ok("None");
}

function checkBoosts(db) {
  section("8. BOOST ANOMALIES");
  const perNom = db
    .prepare(
      `SELECT n.code, n.name, COUNT(*) AS boosts, SUM(b.votes_added) AS votes_added,
            MAX(b.created_at) AS last_at, MIN(b.created_at) AS first_at
     FROM nominee_boosts b JOIN nominees n ON n.id = b.nominee_id
     GROUP BY b.nominee_id HAVING boosts > ? ORDER BY votes_added DESC`,
    )
    .all(CFG.BOOSTS_PER_NOMINEE);
  sub(`Nominees with > ${CFG.BOOSTS_PER_NOMINEE} boosts: ${perNom.length}`);
  if (perNom.length) {
    table(perNom, [
      { key: "code", label: "Code" },
      { key: "name", label: "Name", fmt: (v) => String(v).slice(0, 22) },
      {
        key: "boosts",
        label: "Boosts",
        color: (_, v) => (v > CFG.BOOSTS_PER_NOMINEE * 5 ? C.r : C.y),
      },
      { key: "votes_added", label: "Votes", fmt: fmtN },
      { key: "first_at", label: "First", fmt: eatTime },
      { key: "last_at", label: "Last", fmt: eatTime },
    ]);
    for (const r of perNom)
      flag(
        r.boosts > CFG.BOOSTS_PER_NOMINEE * 5 ? "HIGH" : "MEDIUM",
        "boost_abuse",
        `${r.code} ${r.name}`,
        { boosts: r.boosts, votes: r.votes_added },
        `${r.boosts} × 250 KES = ${r.boosts * 250} KES.`,
      );
  } else ok("None");

  const orphanBoosts = db
    .prepare(
      `SELECT b.id, b.reference, b.nominee_id, n.code, n.name, b.votes_added
     FROM nominee_boosts b LEFT JOIN nominees n ON n.id = b.nominee_id
     LEFT JOIN transactions t ON t.reference = b.reference AND t.status = 'success'
     WHERE t.id IS NULL`,
    )
    .all();
  sub(`Boosts without matching success transaction: ${orphanBoosts.length}`);
  if (orphanBoosts.length) {
    table(orphanBoosts, [
      { key: "code", label: "Code" },
      { key: "name", label: "Name", fmt: (v) => String(v).slice(0, 22) },
      { key: "reference", label: "Reference" },
      { key: "votes_added", label: "Votes", fmt: fmtN },
    ]);
    for (const r of orphanBoosts)
      flag(
        "CRITICAL",
        "boost_no_payment",
        `${r.code} ${r.name} / ref=${r.reference}`,
        { votes_added: r.votes_added },
        "Manual insert or lost transaction.",
      );
  } else ok("All boosts have matching transactions");

  const rapid = db
    .prepare(
      `SELECT nominee_id, reference, created_at,
            LAG(created_at) OVER (PARTITION BY nominee_id ORDER BY created_at) AS prev_at
     FROM nominee_boosts`,
    )
    .all()
    .filter((r) => {
      if (!r.prev_at) return false;
      const t1 = new Date(r.prev_at.replace(" ", "T") + "Z").getTime();
      const t2 = new Date(r.created_at.replace(" ", "T") + "Z").getTime();
      return t2 - t1 < 5 * 60_000;
    });
  sub(`Boosts fired < 5 min apart: ${rapid.length}`);
  if (rapid.length) {
    for (const r of rapid)
      flag(
        "HIGH",
        "boost_rapid_fire",
        `ref=${r.reference}`,
        { at: r.created_at, previous: r.prev_at },
        "Automation.",
      );
  } else ok("None");
}

function checkAppeals(db) {
  section("9. APPEAL & ALLOWANCE ABUSE");
  const allowances = db
    .prepare(
      "SELECT status, COUNT(*) AS c FROM vote_allowances GROUP BY status",
    )
    .all();
  sub(
    `Allowances: ${allowances.map((a) => `${a.status}=${a.c}`).join(", ") || "none"}`,
  );

  const usedWithoutVote = db
    .prepare(
      `SELECT va.id, va.appeal_code, va.device_hash, va.used_vote_id,
            (SELECT COUNT(*) FROM free_votes WHERE id = va.used_vote_id) AS vote_exists
     FROM vote_allowances va WHERE va.status = 'used'`,
    )
    .all()
    .filter((a) => !a.vote_exists);
  sub(`Used allowances pointing at missing votes: ${usedWithoutVote.length}`);
  if (usedWithoutVote.length) {
    for (const a of usedWithoutVote)
      flag(
        "HIGH",
        "allowance_missing_vote",
        `appeal=${a.appeal_code}`,
        { used_vote_id: a.used_vote_id },
        "Data corruption.",
      );
  } else ok("All used allowances reference real votes");

  const devMulti = db
    .prepare(
      "SELECT device_hash, category_id, COUNT(*) AS c FROM vote_allowances GROUP BY device_hash, category_id HAVING c > 1",
    )
    .all();
  sub(`Devices with > 1 allowance per category: ${devMulti.length}`);
  if (devMulti.length) {
    for (const d of devMulti)
      flag(
        "HIGH",
        "allowance_multi",
        `device=${String(d.device_hash).slice(0, 16)}… cat=${String(d.category_id).slice(0, 8)}`,
        { allowances: d.c },
        "Should be impossible.",
      );
  } else ok("None");
}

function checkConcentration(db) {
  section("10. CATEGORY CONCENTRATION & STAT OUTLIERS");
  const cats = db.prepare("SELECT id, name FROM categories").all();
  const rows = [];
  for (const c of cats) {
    const noms = db
      .prepare(
        `SELECT id, code, name, COALESCE(votes,0) AS votes FROM nominees
       WHERE category_id = ? AND eliminated = 0 ORDER BY votes DESC`,
      )
      .all(c.id);
    const total = noms.reduce((s, n) => s + n.votes, 0);
    if (total === 0) continue;
    const top = noms[0];
    const sorted = [...noms].map((n) => n.votes).sort((a, b) => a - b);
    const median =
      sorted.length % 2
        ? sorted[Math.floor(sorted.length / 2)]
        : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
    const devs = sorted.map((v) => Math.abs(v - median)).sort((a, b) => a - b);
    const mad =
      devs.length % 2
        ? devs[Math.floor(devs.length / 2)]
        : (devs[devs.length / 2 - 1] + devs[devs.length / 2]) / 2;
    const mean = total / noms.length;
    const std = Math.sqrt(
      noms.reduce((s, n) => s + Math.pow(n.votes - mean, 2), 0) / noms.length,
    );
    rows.push({
      category: c.name,
      category_id: c.id,
      total,
      count: noms.length,
      top_code: top.code,
      top_name: top.name,
      top_votes: top.votes,
      top_share: top.votes / total,
      median,
      mad,
      mean,
      std,
      nominees: noms,
    });
  }
  sub("Category breakdown:");
  table(rows, [
    { key: "category", label: "Category", fmt: (v) => String(v).slice(0, 26) },
    { key: "count", label: "N" },
    { key: "total", label: "Total", fmt: fmtN },
    { key: "top_name", label: "Top", fmt: (v) => String(v).slice(0, 22) },
    { key: "top_votes", label: "Votes", fmt: fmtN },
    {
      key: "top_share",
      label: "Share",
      fmt: (v) => (v * 100).toFixed(1) + "%",
      color: (r) => (r.top_share > CFG.CONCENTRATION ? C.r : C.d),
    },
  ]);
  for (const r of rows) {
    if (r.top_share > CFG.CONCENTRATION)
      flag(
        "CRITICAL",
        "category_concentration",
        `${r.category} → ${r.top_code} ${r.top_name}`,
        {
          share: r.top_share,
          votes: r.top_votes,
          total: r.total,
          threshold: CFG.CONCENTRATION,
        },
        `Top nominee holds ${(r.top_share * 100).toFixed(1)}%.`,
      );
    if (r.mad > 0)
      for (const n of r.nominees) {
        const score = (n.votes - r.median) / r.mad;
        if (score > 5)
          flag(
            "HIGH",
            "stat_outlier_mad",
            `${r.category} → ${n.code} ${n.name}`,
            {
              votes: n.votes,
              median: r.median,
              mad: r.mad,
              score: score.toFixed(2),
            },
            `${score.toFixed(1)}× MAD above median.`,
          );
      }
    if (r.std > 0)
      for (const n of r.nominees) {
        const z = (n.votes - r.mean) / r.std;
        if (Math.abs(z) > CFG.Z_SCORE)
          flag(
            "MEDIUM",
            "stat_outlier_z",
            `${r.category} → ${n.code} ${n.name}`,
            {
              votes: n.votes,
              mean: r.mean.toFixed(0),
              std: r.std.toFixed(0),
              z: z.toFixed(2),
            },
            `Z=${z.toFixed(2)}.`,
          );
      }
  }
}

function checkCategoryTotals(db) {
  section("11. CATEGORY VOTE TOTALS");
  const rows = db
    .prepare(
      `SELECT c.id, c.name,
            (SELECT COUNT(*) FROM nominees WHERE category_id = c.id AND eliminated = 0) AS active,
            (SELECT COALESCE(SUM(votes),0) FROM nominees WHERE category_id = c.id) AS total_votes,
            (SELECT COUNT(*) FROM free_votes WHERE category_id = c.id) AS free_votes
     FROM categories c`,
    )
    .all();
  table(
    rows.map((r) => ({ ...r, mismatch: r.total_votes - r.free_votes })),
    [
      { key: "name", label: "Category", fmt: (v) => String(v).slice(0, 30) },
      { key: "active", label: "Active", fmt: fmtN },
      { key: "total_votes", label: "Total", fmt: fmtN },
      { key: "free_votes", label: "Free", fmt: fmtN },
      {
        key: "mismatch",
        label: "Δ boost",
        fmt: fmtN,
        color: (_, v) => (v > 0 ? C.y : C.d),
      },
    ],
  );
  for (const r of rows)
    if (r.total_votes > 5000)
      flag(
        "HIGH",
        "category_volume",
        r.name,
        { totalVotes: r.total_votes, active: r.active },
        "Unusually high category volume.",
      );
}

function cmdAudit() {
  const db = openDB(true);
  try {
    FINDINGS.length = 0;
    checkVoteMath(db);
    checkOrphans(db);
    checkUniqueness(db);
    checkBursts(db);
    checkOffHours(db);
    checkIPs(db);
    checkFingerprints(db);
    checkBoosts(db);
    checkAppeals(db);
    checkConcentration(db);
    checkCategoryTotals(db);

    if (JSON_OUT) {
      console.log(JSON.stringify(FINDINGS, null, 2));
      return;
    }

    section("EXECUTIVE SUMMARY");
    const bySev = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0, INFO: 0 };
    for (const f of FINDINGS) bySev[f.sev] = (bySev[f.sev] || 0) + 1;
    line(
      `Findings: ${FINDINGS.length}  ` +
        `(${paint(C.r, "CRIT " + bySev.CRITICAL)}, ` +
        `${paint(C.y, "HIGH " + bySev.HIGH)}, ` +
        `${paint(C.m, "MED " + bySev.MEDIUM)}, ` +
        `${paint(C.b, "LOW " + bySev.LOW)})`,
    );

    for (const sev of ["CRITICAL", "HIGH", "MEDIUM", "LOW"]) {
      const list = FINDINGS.filter((f) => f.sev === sev);
      if (!list.length) continue;
      sub(`${sev} (${list.length})`);
      for (const f of list.slice(0, 50)) {
        line(
          `${paint(C.r, "●")} ${C.w}${f.type}${C.x}  ${C.d}${f.entity}${C.x}`,
        );
        line(`  ${C.d}${JSON.stringify(f.evidence)}${C.x}`);
        if (f.recommendation)
          line(`  ${C.b}→${C.x} ${C.d}${f.recommendation}${C.x}`);
      }
      if (list.length > 50) info(`… ${list.length - 50} more`);
    }
  } finally {
    db.close();
  }
}

/* ═══════════════════════════════════════════════════════════════════════
   COMMAND: clean (fingerprint fraud)
   ═══════════════════════════════════════════════════════════════════════ */

function cmdClean() {
  const db = openDB(!ARGS.apply);
  try {
    section(
      "FINGERPRINT FRAUD CLEANUP" + (ARGS.apply ? " (APPLY)" : " (DRY-RUN)"),
    );
    info(`Rule: 1 vote per (nominee, fingerprint) — keep earliest`);

    const whereNom = ARGS.nominee
      ? "AND nominee_id IN (SELECT id FROM nominees WHERE code = ? COLLATE NOCASE OR name LIKE ? COLLATE NOCASE)"
      : "";
    const args = ARGS.nominee ? [ARGS.nominee, `%${ARGS.nominee}%`] : [];

    const clusters = db
      .prepare(
        `SELECT nominee_id, fingerprint_json, COUNT(*) AS c,
              MIN(created_at) AS first_at, MAX(created_at) AS last_at
       FROM free_votes WHERE fingerprint_json IS NOT NULL ${whereNom}
       GROUP BY nominee_id, fingerprint_json HAVING c > 1
       ORDER BY c DESC`,
      )
      .all(...args);

    if (!clusters.length) {
      ok("No fraudulent fingerprints detected.");
      return;
    }

    const plan = [];
    for (const cl of clusters) {
      const ids = db
        .prepare(
          `SELECT id FROM free_votes WHERE nominee_id = ? AND fingerprint_json = ?
         ORDER BY created_at ASC, id ASC`,
        )
        .all(cl.nominee_id, cl.fingerprint_json)
        .map((r) => r.id);
      plan.push({ ...cl, delete: ids.length - 1, ids_to_delete: ids.slice(1) });
    }

    const groups = new Map();
    for (const p of plan) {
      if (!groups.has(p.nominee_id)) {
        const n = db
          .prepare("SELECT code, name, votes FROM nominees WHERE id = ?")
          .get(p.nominee_id);
        if (!n) continue;
        groups.set(p.nominee_id, {
          ...n,
          id: p.nominee_id,
          deleteTotal: 0,
          entries: [],
        });
      }
      const g = groups.get(p.nominee_id);
      g.deleteTotal += p.delete;
      g.entries.push(p);
    }

    let grandDelete = 0;
    for (const [, g] of groups) {
      grandDelete += g.deleteTotal;
      const after = g.votes - g.deleteTotal;
      line("");
      line(`${C.w}▸ ${g.code} — ${g.name}${C.x}`);
      line(`    Current:  ${paint(C.y, fmtN(g.votes).padStart(8))} votes`);
      line(
        `    Delete:   ${paint(C.r, fmtN(g.deleteTotal).padStart(8))} fraudulent`,
      );
      line(`    After:    ${paint(C.g, fmtN(after).padStart(8))} votes`);
      if (ARGS.verbose)
        for (const e of g.entries) {
          line(
            paint(
              C.d,
              `      • ${fmtN(e.c).padStart(6)} votes on fp=${String(e.fingerprint_json).slice(0, 50)}…`,
            ),
          );
          line(paint(C.d, `        ${e.first_at} → ${e.last_at}`));
        }
    }

    const before = db
      .prepare("SELECT COALESCE(SUM(votes),0) AS t FROM nominees")
      .get().t;
    section("SUMMARY");
    line(`Nominees affected:   ${groups.size}`);
    line(`Votes to delete:     ${paint(C.r, fmtN(grandDelete))}`);
    line(`System before:       ${paint(C.y, fmtN(before))}`);
    line(`System after:        ${paint(C.g, fmtN(before - grandDelete))}`);

    if (!ARGS.apply) {
      line("");
      info("Dry-run. Re-run with --apply to execute.");
      return;
    }

    section("APPLYING");
    let deleted = 0;
    const tx = db.transaction(() => {
      for (const p of plan) {
        if (!p.ids_to_delete.length) continue;
        const ph = p.ids_to_delete.map(() => "?").join(",");
        deleted += db
          .prepare(`DELETE FROM free_votes WHERE id IN (${ph})`)
          .run(...p.ids_to_delete).changes;
      }
      db.exec(`
        UPDATE nominees SET votes =
          (SELECT COUNT(*) FROM free_votes WHERE nominee_id = nominees.id) +
          (SELECT COALESCE(SUM(votes_added),0) FROM nominee_boosts WHERE nominee_id = nominees.id)
      `);
    });
    tx();
    try {
      db.pragma("wal_checkpoint(TRUNCATE)");
    } catch {}
    ok(`Deleted ${fmtN(deleted)} votes`);
    ok("Recomputed all nominee vote counts");
    const final = db
      .prepare("SELECT COALESCE(SUM(votes),0) AS t FROM nominees")
      .get().t;
    ok(`Final system total: ${fmtN(final)}`);
  } finally {
    db.close();
  }
}

/* ═══════════════════════════════════════════════════════════════════════
   COMMAND: purge-ips
   ═══════════════════════════════════════════════════════════════════════ */

function cmdPurgeIPs() {
  const db = openDB(!ARGS.apply);
  try {
    section("PURGE ATTACK IPs" + (ARGS.apply ? " (APPLY)" : " (DRY-RUN)"));
    info(`${ATTACK_IPS.length} IPs: ${ATTACK_IPS.join(", ")}`);

    const ph = ATTACK_IPS.map(() => "?").join(",");
    const rows = db
      .prepare(
        `SELECT n.code, n.name, COALESCE(n.votes,0) AS stored, COUNT(fv.id) AS matched
       FROM free_votes fv JOIN nominees n ON n.id = fv.nominee_id
       WHERE fv.ip IN (${ph}) GROUP BY n.id ORDER BY matched DESC`,
      )
      .all(...ATTACK_IPS);

    if (!rows.length) {
      ok("No votes from these IPs found.");
      return;
    }

    table(
      rows,
      [
        { key: "code", label: "Code" },
        { key: "name", label: "Name", fmt: (v) => String(v).slice(0, 26) },
        { key: "stored", label: "Current", fmt: fmtN, color: () => C.y },
        { key: "matched", label: "From IPs", fmt: fmtN, color: () => C.r },
        { key: "after", label: "After", fmt: fmtN, color: () => C.g },
      ].map((c) =>
        c.key === "after"
          ? { ...c, fmt: (_, r) => fmtN(r.stored - r.matched) }
          : c,
      ),
    );

    const total = rows.reduce((s, r) => s + r.matched, 0);
    line("");
    line(`${paint(C.r, "Total votes to delete: " + fmtN(total))}`);

    if (!ARGS.apply) {
      info("\nDry-run. Re-run with --apply to execute.");
      return;
    }

    section("APPLYING");
    const tx = db.transaction(() => {
      db.prepare(`DELETE FROM free_votes WHERE ip IN (${ph})`).run(
        ...ATTACK_IPS,
      );
      db.exec(`
        UPDATE nominees SET votes =
          (SELECT COUNT(*) FROM free_votes WHERE nominee_id = nominees.id) +
          (SELECT COALESCE(SUM(votes_added),0) FROM nominee_boosts WHERE nominee_id = nominees.id)
      `);
    });
    tx();
    try {
      db.pragma("wal_checkpoint(TRUNCATE)");
    } catch {}
    ok(`Deleted ${fmtN(total)} votes`);
    ok("Recomputed all vote counts");
    const final = db
      .prepare("SELECT COALESCE(SUM(votes),0) AS t FROM nominees")
      .get().t;
    ok(`Final system total: ${fmtN(final)}`);
  } finally {
    db.close();
  }
}

/* ═══════════════════════════════════════════════════════════════════════
   COMMAND: wipe-boosts
   ═══════════════════════════════════════════════════════════════════════ */

function cmdWipeBoosts() {
  const db = openDB(!ARGS.apply);
  try {
    section(
      "WIPE UNVERIFIED/SIMULATED BOOSTS" +
        (ARGS.apply ? " (APPLY)" : " (DRY-RUN)"),
    );

    const whereNom = ARGS.nominee ? "AND n.code = ? COLLATE NOCASE" : "";
    const args = ARGS.nominee ? [ARGS.nominee] : [];

    const unverified = db
      .prepare(
        `SELECT b.id, b.reference, b.votes_added, n.code, n.name,
              t.status, t.mpesa_receipt
       FROM nominee_boosts b
       JOIN nominees n ON n.id = b.nominee_id
       LEFT JOIN transactions t ON t.reference = b.reference
       WHERE (t.id IS NULL
           OR t.status != 'success'
           OR t.mpesa_receipt IS NULL
           OR t.mpesa_receipt LIKE 'SIM-%')
       ${whereNom}
       ORDER BY n.name, b.created_at`,
      )
      .all(...args);

    if (!unverified.length) {
      ok("All boosts have verified PayHero receipts.");
      return;
    }

    const byNom = new Map();
    for (const u of unverified) {
      const key = u.code + "|" + u.name;
      if (!byNom.has(key))
        byNom.set(key, { code: u.code, name: u.name, boosts: 0, votes: 0 });
      const g = byNom.get(key);
      g.boosts++;
      g.votes += u.votes_added;
    }

    table(Array.from(byNom.values()), [
      { key: "code", label: "Code" },
      { key: "name", label: "Name", fmt: (v) => String(v).slice(0, 26) },
      { key: "boosts", label: "Boosts", fmt: fmtN, color: () => C.y },
      { key: "votes", label: "Votes to remove", fmt: fmtN, color: () => C.r },
    ]);

    const totalVotes = unverified.reduce((s, u) => s + u.votes_added, 0);
    line("");
    line(`${paint(C.r, "Total fake boost votes: " + fmtN(totalVotes))}`);
    info(
      `Boosts from: NULL txn, non-success status, missing receipt, or SIM- receipt`,
    );

    if (!ARGS.apply) {
      info("\nDry-run. Re-run with --apply to execute.");
      return;
    }

    section("APPLYING");
    const tx = db.transaction(() => {
      for (const u of unverified)
        db.prepare("DELETE FROM nominee_boosts WHERE id = ?").run(u.id);
      db.exec(`
        UPDATE nominees SET votes =
          (SELECT COUNT(*) FROM free_votes WHERE nominee_id = nominees.id) +
          (SELECT COALESCE(SUM(votes_added),0) FROM nominee_boosts WHERE nominee_id = nominees.id)
      `);
    });
    tx();
    try {
      db.pragma("wal_checkpoint(TRUNCATE)");
    } catch {}
    ok(
      `Deleted ${unverified.length} fake boost(s) = ${fmtN(totalVotes)} votes`,
    );
    ok("Recomputed all vote counts");
  } finally {
    db.close();
  }
}

/* ═══════════════════════════════════════════════════════════════════════
   COMMAND: wipe (eliminated members)
   ═══════════════════════════════════════════════════════════════════════ */

function cmdWipe() {
  const db = openDB(!ARGS.apply);
  try {
    section(
      "WIPE ELIMINATED MEMBERS" + (ARGS.apply ? " (APPLY)" : " (DRY-RUN)"),
    );
    if (ARGS.stage) info(`Filtering to stage: ${ARGS.stage}`);
    if (ARGS.cascade) info("Cascade ON: also delete nominees + users rows");

    const whereStage = ARGS.stage ? "AND eliminated_stage = ?" : "";
    const args = ARGS.stage ? [ARGS.stage] : [];

    const eliminated = db
      .prepare(
        `SELECT id, code, name, eliminated_stage,
              (SELECT COUNT(*) FROM free_votes WHERE nominee_id = nominees.id) AS free_count,
              (SELECT COUNT(*) FROM nominee_boosts WHERE nominee_id = nominees.id) AS boost_count
       FROM nominees WHERE eliminated = 1 ${whereStage}
       ORDER BY name`,
      )
      .all(...args);

    if (!eliminated.length) {
      ok("No eliminated nominees.");
      return;
    }

    const totalFree = eliminated.reduce((s, n) => s + n.free_count, 0);
    const totalBoost = eliminated.reduce((s, n) => s + n.boost_count, 0);
    sub(
      `${eliminated.length} eliminated nominees · ${fmtN(totalFree)} free · ${fmtN(totalBoost)} boosts`,
    );
    table(eliminated, [
      { key: "code", label: "Code" },
      { key: "name", label: "Name", fmt: (v) => String(v).slice(0, 26) },
      { key: "eliminated_stage", label: "Stage" },
      { key: "free_count", label: "Free", fmt: fmtN },
      { key: "boost_count", label: "Boosts", fmt: fmtN },
    ]);

    const sizeBefore = fs.statSync(DB_PATH).size;
    info(`DB size: ${(sizeBefore / 1024 / 1024).toFixed(2)} MB`);

    if (!ARGS.apply) {
      info("\nDry-run. Re-run with --apply to execute.");
      if (!ARGS.cascade)
        info("Add --cascade to also delete nominees + users rows.");
      return;
    }

    section("APPLYING");
    const ids = eliminated.map((n) => n.id);
    const ph = ids.map(() => "?").join(",");

    let userIds = [];
    if (ARGS.cascade) {
      userIds = eliminated
        .map(
          (n) =>
            db.prepare("SELECT user_id FROM nominees WHERE id = ?").get(n.id)
              ?.user_id,
        )
        .filter(Boolean);
    }

    const tx = db.transaction(() => {
      db.prepare(`DELETE FROM free_votes WHERE nominee_id IN (${ph})`).run(
        ...ids,
      );
      db.prepare(`DELETE FROM nominee_boosts WHERE nominee_id IN (${ph})`).run(
        ...ids,
      );
      if (ARGS.cascade) {
        db.prepare(`DELETE FROM nominees WHERE id IN (${ph})`).run(...ids);
        if (userIds.length) {
          const uph = userIds.map(() => "?").join(",");
          db.prepare(`DELETE FROM users WHERE id IN (${uph})`).run(...userIds);
        }
      }
    });
    tx();
    try {
      db.pragma("wal_checkpoint(TRUNCATE)");
    } catch {}

    const sizeAfter = fs.statSync(DB_PATH).size;
    ok(`Wiped ${eliminated.length} nominee(s)`);
    ok(
      `DB size: ${(sizeBefore / 1024 / 1024).toFixed(2)} MB → ${(sizeAfter / 1024 / 1024).toFixed(2)} MB`,
    );
    if (ARGS.cascade)
      info(`Cascade: ${userIds.length} user row(s) also deleted`);
  } finally {
    db.close();
  }
}

/* ═══════════════════════════════════════════════════════════════════════
   COMMAND: fix (math + orphans)
   ═══════════════════════════════════════════════════════════════════════ */

function cmdFix() {
  const db = openDB(!ARGS.apply);
  try {
    section("FIX MATH + ORPHANS" + (ARGS.apply ? " (APPLY)" : " (DRY-RUN)"));

    const targets = [];

    const mismatched = db
      .prepare(
        `SELECT n.id, n.code, n.name, COALESCE(n.votes,0) AS stored,
              (SELECT COUNT(*) FROM free_votes WHERE nominee_id = n.id) +
              (SELECT COALESCE(SUM(votes_added),0) FROM nominee_boosts WHERE nominee_id = n.id) AS expected
       FROM nominees n
       WHERE COALESCE(n.votes,0) !=
         (SELECT COUNT(*) FROM free_votes WHERE nominee_id = n.id) +
         (SELECT COALESCE(SUM(votes_added),0) FROM nominee_boosts WHERE nominee_id = n.id)`,
      )
      .all();
    for (const m of mismatched)
      targets.push({
        sql: "UPDATE nominees SET votes = ? WHERE id = ?",
        args: [m.expected, m.id],
        label: `Fix votes for ${m.code}: ${fmtN(m.stored)} → ${fmtN(m.expected)}`,
      });

    const orphanVotes = db
      .prepare(
        "SELECT COUNT(*) AS c FROM free_votes fv LEFT JOIN nominees n ON n.id = fv.nominee_id WHERE n.id IS NULL",
      )
      .get().c;
    if (orphanVotes)
      targets.push({
        sql: "DELETE FROM free_votes WHERE id IN (SELECT fv.id FROM free_votes fv LEFT JOIN nominees n ON n.id = fv.nominee_id WHERE n.id IS NULL)",
        args: [],
        label: `Delete ${fmtN(orphanVotes)} orphaned free_votes`,
      });

    const orphanBoosts = db
      .prepare(
        "SELECT COUNT(*) AS c FROM nominee_boosts b LEFT JOIN nominees n ON n.id = b.nominee_id WHERE n.id IS NULL",
      )
      .get().c;
    if (orphanBoosts)
      targets.push({
        sql: "DELETE FROM nominee_boosts WHERE id IN (SELECT b.id FROM nominee_boosts b LEFT JOIN nominees n ON n.id = b.nominee_id WHERE n.id IS NULL)",
        args: [],
        label: `Delete ${fmtN(orphanBoosts)} orphaned nominee_boosts`,
      });

    if (!targets.length) {
      ok("Nothing to fix.");
      return;
    }

    for (const t of targets) line(`${paint(C.y, "→")} ${t.label}`);

    if (!ARGS.apply) {
      info("\nDry-run. Re-run with --apply to execute.");
      return;
    }

    section("APPLYING");
    const tx = db.transaction(() => {
      for (const t of targets) db.prepare(t.sql).run(...t.args);
    });
    tx();
    try {
      db.pragma("wal_checkpoint(TRUNCATE)");
    } catch {}
    ok("Applied all fixes.");
  } finally {
    db.close();
  }
}

/* ═══════════════════════════════════════════════════════════════════════
   COMMAND: all (all detectors, report only)
   ═══════════════════════════════════════════════════════════════════════ */

function cmdAll() {
  cmdAudit();
  if (!JSON_OUT) {
    section("ALL DETECTORS DONE");
    info("Now run:");
    info("  node voteus.js clean --apply");
    info("  node voteus.js purge-ips --apply");
    info("  node voteus.js wipe-boosts --apply");
    info("  node voteus.js fix --apply");
    info("  node voteus.js wipe --apply");
  }
}

/* ═══════════════════════════════════════════════════════════════════════
   MAIN DISPATCHER
   ═══════════════════════════════════════════════════════════════════════ */

(async () => {
  try {
    if (!JSON_OUT) {
      console.log(paint(C.b, "\n" + "═".repeat(78)));
      console.log("  " + paint(C.w, "VOTEUS CONSOLIDATED INTEGRITY TOOL"));
      console.log(paint(C.b, "═".repeat(78)));
      console.log(
        `  Command:  ${ARGS.cmd}${ARGS.apply ? " (APPLY)" : " (dry-run)"}`,
      );
      console.log(`  DB:       ${DB_PATH}`);
      console.log(`  Node:     ${process.version}`);
    }

    await ensureData();

    switch (ARGS.cmd) {
      case "list":
        cmdList();
        break;
      case "diagnose":
        cmdDiagnose();
        break;
      case "audit":
        cmdAudit();
        break;
      case "clean":
        cmdClean();
        break;
      case "purge-ips":
        cmdPurgeIPs();
        break;
      case "wipe-boosts":
        cmdWipeBoosts();
        break;
      case "wipe":
        cmdWipe();
        break;
      case "fix":
        cmdFix();
        break;
      case "all":
        cmdAll();
        break;
      default:
        fail(`Unknown command: ${ARGS.cmd}`);
        fail("Run with --help for usage.");
        process.exit(2);
    }
  } catch (e) {
    console.error(paint(C.r, "\n✗ " + (e.message || e)));
    if (process.env.DEBUG) console.error(e.stack);
    process.exit(1);
  } finally {
    setTimeout(() => process.exit(process.exitCode || 0), 100).unref();
  }
})();
