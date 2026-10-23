require("dotenv").config();
const express = require("express");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const axios = require("axios");
const multer = require("multer");
const sharp = require("sharp");
const PDFDocument = require("pdfkit");
const { v4: uuidv4 } = require("uuid");
const db = require("./db");

let QRCode = null;
try {
  QRCode = require("qrcode");
} catch {
  console.warn(
    "[PDF] qrcode not installed — QR codes will be skipped. Run: npm install qrcode",
  );
}

const app = express();
app.set("trust proxy", 1);
app.disable("x-powered-by");

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || "change-me";
const SUPER_ADMIN_USERNAME = process.env.SUPER_ADMIN_USERNAME || "superadmin";
const SUPER_ADMIN_PASSWORD = process.env.SUPER_ADMIN_PASSWORD || "super123";
const VOTE_DEADLINE = process.env.VOTE_DEADLINE || "2026-11-30T23:59:59Z";
const PAYHERO_API_KEY = process.env.PAYHERO_API_KEY || "";
const PAYHERO_API_SECRET = process.env.PAYHERO_API_SECRET || "";
const PAYHERO_CHANNEL_ID = process.env.PAYHERO_CHANNEL_ID || "";
const PAYHERO_CALLBACK_URL = process.env.PAYHERO_CALLBACK_URL || "";
const PAYHERO_BASE_URL =
  process.env.PAYHERO_BASE_URL || "https://backend.payhero.co.ke/api/v2";

const PRICES = {
  category_change: 50,
  leaderboard_once: 10,
  leaderboard_1h: 25,
  leaderboard_12h: 50,
  leaderboard_24h: 100,
  boost_50: 250,
};
const LEADERBOARD_ONCE_MS = 60 * 1000;
const LEADERBOARD_1H_MS = 60 * 60 * 1000;
const LEADERBOARD_12H_MS = 12 * 60 * 60 * 1000;
const LEADERBOARD_24H_MS = 24 * 60 * 60 * 1000;
const LEADERBOARD_2H_MS = 2 * 60 * 60 * 1000;
const BOOST_VOTES = 100;
const STALE_TX_MINUTES = 15;
const SYNC_PUSH_INTERVAL_MS = 30_000;
const SYNC_PULL_INTERVAL_MS = 60_000;
const WAL_CHECKPOINT_INTERVAL_MS = 60_000;
const CHECKPOINT_WAL_THRESHOLD = 5 * 1024 * 1024;
const RECONCILE_INTERVAL_MS = 60_000;
const RECONCILE_MIN_AGE_MS = 30_000;
const VOTES_RECONCILE_INTERVAL_MS = 5 * 60 * 1000;
const IMG_MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const IMG_TARGET_DIMENSION = 700;
const IMG_JPEG_QUALITY = 82;
const IMG_ORPHAN_GRACE_MS = 60 * 60 * 1000;
const REPORT_SECRET =
  process.env.REPORT_SECRET || JWT_SECRET || "voteus-report-secret";

// ─── Stage system constants ───
const STAGE_ORDER = ["preliminaries", "semi_finals", "finals", "completed"];
const STAGE_LABELS = {
  preliminaries: "Preliminaries",
  semi_finals: "Semi Finals",
  finals: "Finals",
  completed: "Completed",
};
const NEXT_STAGE = {
  preliminaries: "semi_finals",
  semi_finals: "finals",
  finals: "completed",
  completed: null,
};
// Number that advance FROM the current stage TO the next
const STAGE_CUTOFF = {
  preliminaries: 5, // Top 5 advance to semis
  semi_finals: 2, // Top 2 advance to finals
  finals: 1, // Top 1 wins
};

app.use(
  express.json({
    limit: "1mb",
    type: ["application/json", "application/*+json", "text/json", "text/plain"],
  }),
);
app.use(express.urlencoded({ extended: true, limit: "1mb" }));
app.use((req, res, next) => {
  if (["POST", "PUT", "PATCH"].includes(req.method) && !req.body) {
    console.warn(
      `[Body Missing] ${req.method} ${req.url} from ${req.ip} content-type="${req.headers["content-type"] || "none"}"`,
    );
  }
  next();
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: IMG_MAX_UPLOAD_BYTES, files: 1 },
  fileFilter: (req, file, cb) => {
    if (/^image\/(jpeg|png|webp|gif|jpg|heic|heif)$/i.test(file.mimetype))
      cb(null, true);
    else cb(new Error("Only image files are allowed"));
  },
});

async function processImage(buffer) {
  try {
    const out = await sharp(buffer, { failOn: "none" })
      .rotate()
      .resize(IMG_TARGET_DIMENSION, IMG_TARGET_DIMENSION, {
        fit: "cover",
        position: "attention",
      })
      .jpeg({ quality: IMG_JPEG_QUALITY, mozjpeg: true, progressive: true })
      .toBuffer();
    return { data: out, mime: "image/jpeg" };
  } catch (err) {
    console.warn("[Image] sharp fallback:", err.message);
    return { data: buffer, mime: "application/octet-stream" };
  }
}

function toISOUTC(dbTimestamp) {
  if (!dbTimestamp) return null;
  const str = String(dbTimestamp);
  if (/[Zz]$|[+-]\d{2}:?\d{2}$/.test(str)) {
    try {
      return new Date(str).toISOString();
    } catch {
      return null;
    }
  }
  try {
    return new Date(str.replace(" ", "T") + "Z").toISOString();
  } catch {
    return null;
  }
}

function parseUA(ua) {
  if (!ua) return { device: "Unknown", os: "Unknown", browser: "Unknown" };
  ua = String(ua);
  let device = "Unknown device",
    os = "Unknown OS",
    browser = "Unknown browser";
  if (/iPhone/.test(ua)) {
    device = "iPhone";
    const m = ua.match(/OS (\d+[_.]\d+)/);
    os = m ? "iOS " + m[1].replace("_", ".") : "iOS";
  } else if (/iPad/.test(ua)) {
    device = "iPad";
    const m = ua.match(/OS (\d+[_.]\d+)/);
    os = m ? "iPadOS " + m[1].replace("_", ".") : "iPadOS";
  } else if (/Android/.test(ua)) {
    const m = ua.match(/Android (\d+[.]\d+)[^;]*;\s*([^)]+?)(?:\s+Build|\))/);
    if (m) {
      os = "Android " + m[1];
      device = m[2].trim();
    } else {
      const m2 = ua.match(/Android (\d+[.]\d+)/);
      os = m2 ? "Android " + m2[1] : "Android";
      device = "Android device";
    }
  } else if (/Windows NT 10/.test(ua)) {
    os = "Windows 10/11";
    device = "Windows PC";
  } else if (/Windows NT 6\.3/.test(ua)) {
    os = "Windows 8.1";
    device = "Windows PC";
  } else if (/Windows NT 6\.1/.test(ua)) {
    os = "Windows 7";
    device = "Windows PC";
  } else if (/Mac OS X (\d+[_.]\d+)/.test(ua)) {
    const m = ua.match(/Mac OS X (\d+[_.]\d+)/);
    os = "macOS " + m[1].replace("_", ".");
    device = "Mac";
  } else if (/CrOS/.test(ua)) {
    os = "ChromeOS";
    device = "Chromebook";
  } else if (/Linux/.test(ua)) {
    os = "Linux";
    device = "Linux PC";
  }

  if (/Edg\/(\d+)/.test(ua)) browser = "Edge " + ua.match(/Edg\/(\d+)/)[1];
  else if (/OPR\/(\d+)/.test(ua))
    browser = "Opera " + ua.match(/OPR\/(\d+)/)[1];
  else if (/Chrome\/(\d+)/.test(ua) && !/Chromium/.test(ua))
    browser = "Chrome " + ua.match(/Chrome\/(\d+)/)[1];
  else if (/Safari\//.test(ua) && !/Chrome/.test(ua)) {
    const m = ua.match(/Version\/(\d+)/);
    browser = "Safari " + (m ? m[1] : "?");
  } else if (/Firefox\/(\d+)/.test(ua))
    browser = "Firefox " + ua.match(/Firefox\/(\d+)/)[1];
  else if (/MSIE |Trident\//.test(ua)) browser = "Internet Explorer";
  return { device, os, browser };
}

function parseFingerprint(fpJson) {
  if (!fpJson) return null;
  try {
    const fp = typeof fpJson === "string" ? JSON.parse(fpJson) : fpJson;
    if (!fp) return null;
    const out = {};
    if (fp.screen) out.screen = fp.screen;
    else if (fp.screenWidth && fp.screenHeight)
      out.screen = `${fp.screenWidth}×${fp.screenHeight}`;
    if (fp.viewport) out.viewport = fp.viewport;
    else if (fp.viewportWidth && fp.viewportHeight)
      out.viewport = `${fp.viewportWidth}×${fp.viewportHeight}`;
    if (fp.language) out.language = fp.language;
    if (fp.timezone) out.timezone = fp.timezone;
    if (typeof fp.timezoneOffset === "number") {
      const off = fp.timezoneOffset;
      const sign = off <= 0 ? "+" : "-";
      const hours = Math.floor(Math.abs(off) / 60);
      const mins = Math.abs(off) % 60;
      out.timezoneDisplay = `UTC${sign}${hours}${mins ? ":" + mins.toString().padStart(2, "0") : ""}`;
    }
    if (fp.hardwareConcurrency) out.cpuCores = fp.hardwareConcurrency;
    if (fp.deviceMemory) out.memory = fp.deviceMemory;
    if (fp.maxTouchPoints != null) out.touchPoints = fp.maxTouchPoints;
    if (fp.cookieEnabled != null) out.cookieEnabled = fp.cookieEnabled;
    if (fp.doNotTrack) out.doNotTrack = fp.doNotTrack;
    if (Array.isArray(fp.plugins)) out.pluginCount = fp.plugins.length;
    if (fp.userAgent) out.userAgent = fp.userAgent;
    return out;
  } catch {
    return null;
  }
}

// ─── Stage helpers ───
async function getStages() {
  try {
    const row = await db
      .prepare("SELECT * FROM election_stages WHERE id = 1")
      .get();
    if (row) return row;
  } catch (e) {
    console.warn("[Stages]", e.message);
  }
  return {
    id: 1,
    current_stage: "preliminaries",
    preliminaries_start: null,
    preliminaries_end: VOTE_DEADLINE,
    semifinals_start: null,
    semifinals_end: null,
    finals_start: null,
    finals_end: null,
    last_advanced_at: null,
    updated_at: null,
  };
}

function stageStartField(stage) {
  return {
    preliminaries: "preliminaries_start",
    semi_finals: "semifinals_start",
    finals: "finals_start",
    completed: null,
  }[stage];
}

function stageEndField(stage) {
  return {
    preliminaries: "preliminaries_end",
    semi_finals: "semifinals_end",
    finals: "finals_end",
    completed: null,
  }[stage];
}

async function votingOpen() {
  const s = await getStages();
  if (!s || s.current_stage === "completed") return false;
  const now = Date.now();
  const start = s[stageStartField(s.current_stage)];
  const end = s[stageEndField(s.current_stage)];
  if (start) {
    const startMs = new Date(start).getTime();
    if (Number.isFinite(startMs) && now < startMs) return false;
  }
  if (end) {
    const endMs = new Date(end).getTime();
    if (Number.isFinite(endMs) && now > endMs) return false;
  }
  return true;
}

function broadcastStage(stage) {
  broadcastAdminEvent({ type: "stage:updated", stage });
  const payload = `event: stage\ndata: ${JSON.stringify({ stage })}\n\n`;
  for (const clients of nomineeVoteClients.values()) {
    for (const r of clients) writeSSE(r, payload);
  }
  for (const r of publicVoteClients) writeSSE(r, payload);
}

async function advanceStage() {
  const s = await getStages();
  const current = s.current_stage || "preliminaries";
  if (current === "completed")
    return { ok: false, error: "Election already completed" };
  const next = NEXT_STAGE[current];
  if (!next) return { ok: false, error: "No next stage" };

  const categories = await db.prepare("SELECT id, name FROM categories").all();
  const now = new Date().toISOString();
  const results = [];

  for (const cat of categories) {
    // Active nominees in this category, ranked by current cumulative votes
    const rows = await db
      .prepare(
        `SELECT id, name, votes FROM nominees
         WHERE category_id = ? AND eliminated = 0
         ORDER BY COALESCE(votes, 0) DESC, created_at ASC`,
      )
      .all(cat.id);

    const cutoff = STAGE_CUTOFF[current] || 999;

    if (next === "completed") {
      // Finalize winner (rank 1) and rank all others
      for (let i = 0; i < rows.length; i++) {
        const n = rows[i];
        if (i === 0) {
          await db
            .prepare(
              `UPDATE nominees SET final_rank = 1, stage = 'winner', eliminated = 0 WHERE id = ?`,
            )
            .run(n.id);
        } else {
          await db
            .prepare(
              `UPDATE nominees SET final_rank = ?, eliminated = 1, eliminated_stage = 'finals' WHERE id = ?`,
            )
            .run(i + 1, n.id);
        }
      }
      results.push({
        category: cat.name,
        winner: rows[0]?.name || null,
        runnerUp: rows[1]?.name || null,
      });
    } else {
      for (let i = 0; i < rows.length; i++) {
        const n = rows[i];
        if (i < cutoff) {
          await db
            .prepare(
              `UPDATE nominees SET stage = ?, qualified_at = ? WHERE id = ?`,
            )
            .run(next, now, n.id);
        } else {
          await db
            .prepare(
              `UPDATE nominees SET eliminated = 1, eliminated_stage = ? WHERE id = ?`,
            )
            .run(current, n.id);
        }
      }
      results.push({
        category: cat.name,
        qualified: rows.slice(0, cutoff).map((n) => ({
          name: n.name,
          votes: n.votes,
        })),
        eliminated: rows.slice(cutoff).map((n) => ({
          name: n.name,
          votes: n.votes,
        })),
      });
    }
  }

  await db
    .prepare(
      `UPDATE election_stages SET current_stage = ?, last_advanced_at = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1`,
    )
    .run(next, now);

  db.push().catch((e) => console.warn("[Push after stage advance]", e.message));
  broadcastStage(next);

  return { ok: true, from: current, to: next, results };
}

async function getNomineeZone(nominee) {
  if (nominee.eliminated) {
    const atLabel =
      STAGE_LABELS[nominee.eliminated_stage] || nominee.eliminated_stage || "a";
    return {
      zone: "eliminated",
      label: "Eliminated",
      message: `You were eliminated at ${atLabel}. Thank you for participating.`,
      stage: nominee.eliminated_stage,
    };
  }
  if (nominee.stage === "winner") {
    return {
      zone: "winner",
      label: "Winner",
      message: "Congratulations — you are the winner! 🏆",
    };
  }

  const s = await getStages();
  const current = s.current_stage || "preliminaries";
  if (current === "completed") {
    return {
      zone: "completed",
      label: "Completed",
      message: "The election has ended.",
    };
  }

  const cutoff = STAGE_CUTOFF[current] || 5;
  const active = await db
    .prepare(
      `SELECT id, votes FROM nominees
       WHERE category_id = ? AND eliminated = 0
       ORDER BY COALESCE(votes, 0) DESC, created_at ASC`,
    )
    .all(nominee.category_id);

  const myIdx = active.findIndex((n) => n.id === nominee.id);
  const myRank = myIdx >= 0 ? myIdx + 1 : active.length + 1;
  const total = active.length;

  if (myRank <= cutoff) {
    return {
      zone: "green",
      label: "Safe Zone",
      rank: myRank,
      cutoff,
      total,
      message: `You're #${myRank} of ${total} — inside the safe zone (top ${cutoff}). Keep it up!`,
    };
  }

  const cutoffNominee = active[cutoff - 1];
  const gap = cutoffNominee
    ? Math.max(0, (cutoffNominee.votes || 0) - (nominee.votes || 0) + 1)
    : 0;

  return {
    zone: "danger",
    label: "At Risk",
    rank: myRank,
    cutoff,
    total,
    gap,
    message: `You're #${myRank} of ${total} — need ${gap} more vote${gap === 1 ? "" : "s"} to enter the safe zone (top ${cutoff}). Share your link!`,
  };
}

async function initSchema() {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS categories (
      id TEXT PRIMARY KEY, name TEXT UNIQUE NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS nominees (
      id TEXT PRIMARY KEY, user_id TEXT, name TEXT NOT NULL, category_id TEXT NOT NULL,
      code TEXT UNIQUE NOT NULL, img TEXT, desc TEXT, votes INTEGER DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS transactions (
      id TEXT PRIMARY KEY, reference TEXT UNIQUE NOT NULL, type TEXT NOT NULL,
      user_id TEXT, nominee_id TEXT, amount REAL NOT NULL, phone TEXT NOT NULL,
      status TEXT DEFAULT 'pending', metadata TEXT, mpesa_receipt TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP, completed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_tx_ref ON transactions(reference);
    CREATE INDEX IF NOT EXISTS idx_tx_status ON transactions(status);
    CREATE INDEX IF NOT EXISTS idx_tx_created ON transactions(created_at);
    CREATE TABLE IF NOT EXISTS leaderboard_access (
      user_id TEXT PRIMARY KEY, permanent INTEGER DEFAULT 0,
      expires_at TEXT, credits INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS payment_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      reference TEXT NOT NULL, event TEXT NOT NULL, details TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_logs_ref ON payment_logs(reference);
    CREATE TABLE IF NOT EXISTS free_votes (
      id TEXT PRIMARY KEY,
      voter_token TEXT NOT NULL,
      nominee_id TEXT NOT NULL,
      device_hash TEXT,
      ip TEXT,
      category_id TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(voter_token, nominee_id)
    );
    CREATE INDEX IF NOT EXISTS idx_fv_voter ON free_votes(voter_token);
    CREATE INDEX IF NOT EXISTS idx_fv_nominee ON free_votes(nominee_id);
    CREATE INDEX IF NOT EXISTS idx_fv_device ON free_votes(device_hash);
    CREATE TABLE IF NOT EXISTS images (
      id TEXT PRIMARY KEY, data BLOB NOT NULL, mime TEXT NOT NULL,
      size INTEGER, created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS admins (
      id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL,
      display_name TEXT, role TEXT DEFAULT 'admin', created_by TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP, revoked INTEGER DEFAULT 0,
      revoked_at TEXT, revoked_by TEXT
    );
    CREATE TABLE IF NOT EXISTS election_stages (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      current_stage TEXT DEFAULT 'preliminaries',
      preliminaries_start TEXT,
      preliminaries_end TEXT,
      semifinals_start TEXT,
      semifinals_end TEXT,
      finals_start TEXT,
      finals_end TEXT,
      last_advanced_at TEXT,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // Add stage columns to nominees
  for (const col of [
    "stage TEXT DEFAULT 'preliminaries'",
    "eliminated INTEGER DEFAULT 0",
    "eliminated_stage TEXT",
    "qualified_at TEXT",
    "final_rank INTEGER",
  ]) {
    try {
      await db.exec(`ALTER TABLE nominees ADD COLUMN ${col}`);
    } catch (e) {
      /* column exists */
    }
  }

  for (const col of ["device_hash TEXT", "ip TEXT", "category_id TEXT"]) {
    try {
      await db.exec(`ALTER TABLE free_votes ADD COLUMN ${col}`);
    } catch (e) {
      /* column exists */
    }
  }
  for (const col of [
    "user_agent TEXT",
    "fingerprint_json TEXT",
    "is_appeal INTEGER DEFAULT 0",
  ]) {
    try {
      await db.exec(`ALTER TABLE free_votes ADD COLUMN ${col}`);
    } catch (e) {
      /* column exists */
    }
  }

  try {
    await db.exec(`DROP INDEX IF EXISTS idx_fv_device_cat`);
    await db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_fv_device_cat
      ON free_votes(device_hash, category_id)
      WHERE device_hash IS NOT NULL AND is_appeal = 0`);
    console.log("[Schema] ✓ idx_fv_device_cat (non-appeal only)");
  } catch (e) {
    console.error(`[Schema] idx_fv_device_cat failed: ${e.message}`);
  }

  try {
    await db.exec(`UPDATE free_votes SET category_id = (
      SELECT category_id FROM nominees WHERE id = free_votes.nominee_id
    ) WHERE category_id IS NULL`);
  } catch (e) {
    console.warn("[Schema] category_id backfill:", e.message);
  }

  try {
    const r = await db.exec(
      "UPDATE nominees SET votes = 0 WHERE votes IS NULL",
    );
    if (r && r.changes)
      console.log(`[Schema] Normalized ${r.changes} NULL votes row(s)`);
  } catch (e) {
    console.warn("[Schema] votes backfill:", e.message);
  }

  // Seed election_stages
  try {
    const existing = await db
      .prepare("SELECT COUNT(*) AS c FROM election_stages")
      .get();
    if (!existing || Number(existing.c) === 0) {
      await db
        .prepare(
          `INSERT INTO election_stages (id, current_stage, preliminaries_start, preliminaries_end)
           VALUES (1, 'preliminaries', ?, ?)`,
        )
        .run(new Date().toISOString(), VOTE_DEADLINE);
      console.log("[Schema] Seeded default election_stages row");
    }
  } catch (e) {
    console.warn("[Schema] election_stages seed:", e.message);
  }

  try {
    await db.exec(`CREATE TABLE IF NOT EXISTS nominee_boosts (
      id TEXT PRIMARY KEY, nominee_id TEXT UNIQUE NOT NULL,
      reference TEXT NOT NULL, votes_added INTEGER NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP)`);
    await db.exec(
      `CREATE INDEX IF NOT EXISTS idx_boosts_nominee ON nominee_boosts(nominee_id)`,
    );
  } catch (e) {
    console.warn("[Schema] nominee_boosts:", e.message);
  }

  try {
    await db.exec(`CREATE TABLE IF NOT EXISTS vote_reports (
      id TEXT PRIMARY KEY, report_code TEXT UNIQUE NOT NULL,
      reported_at TEXT DEFAULT CURRENT_TIMESTAMP, ip TEXT, user_agent TEXT,
      voter_token TEXT, device_hash TEXT, fingerprint_details TEXT,
      report_description TEXT, reporter_name TEXT, reporter_contact TEXT,
      verdict TEXT NOT NULL, matched_votes TEXT, geo_info TEXT)`);
    await db.exec(
      `CREATE INDEX IF NOT EXISTS idx_reports_code ON vote_reports(report_code)`,
    );
    await db.exec(
      `CREATE INDEX IF NOT EXISTS idx_reports_verdict ON vote_reports(verdict)`,
    );
    await db.exec(
      `CREATE INDEX IF NOT EXISTS idx_reports_reported_at ON vote_reports(reported_at)`,
    );
  } catch (e) {
    console.warn("[Schema] vote_reports:", e.message);
  }

  try {
    await db.exec(`CREATE TABLE IF NOT EXISTS ip_lookup_cache (
      ip TEXT PRIMARY KEY, country TEXT, region TEXT, city TEXT,
      isp TEXT, org TEXT, asn TEXT, fetched_at TEXT DEFAULT CURRENT_TIMESTAMP)`);
  } catch (e) {
    console.warn("[Schema] ip_lookup_cache:", e.message);
  }

  try {
    await db.exec(`CREATE TABLE IF NOT EXISTS vote_appeals (
      id TEXT PRIMARY KEY, appeal_code TEXT UNIQUE NOT NULL, report_code TEXT NOT NULL,
      device_hash TEXT NOT NULL, voter_token TEXT NOT NULL, category_id TEXT NOT NULL,
      category_name TEXT, reason TEXT NOT NULL, status TEXT DEFAULT 'pending',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP, decided_at TEXT, decided_by TEXT,
      decision_note TEXT, UNIQUE(report_code, category_id))`);
    await db.exec(
      `CREATE INDEX IF NOT EXISTS idx_appeals_code ON vote_appeals(appeal_code)`,
    );
    await db.exec(
      `CREATE INDEX IF NOT EXISTS idx_appeals_status ON vote_appeals(status)`,
    );
    await db.exec(
      `CREATE INDEX IF NOT EXISTS idx_appeals_device ON vote_appeals(device_hash)`,
    );
  } catch (e) {
    console.warn("[Schema] vote_appeals:", e.message);
  }

  try {
    await db.exec(`CREATE TABLE IF NOT EXISTS vote_allowances (
      id TEXT PRIMARY KEY, appeal_code TEXT NOT NULL, device_hash TEXT NOT NULL,
      voter_token TEXT NOT NULL, category_id TEXT NOT NULL, status TEXT DEFAULT 'active',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP, used_at TEXT, used_vote_id TEXT,
      UNIQUE(device_hash, category_id))`);
    await db.exec(
      `CREATE INDEX IF NOT EXISTS idx_allowances_device ON vote_allowances(device_hash)`,
    );
    await db.exec(
      `CREATE INDEX IF NOT EXISTS idx_allowances_status ON vote_allowances(status)`,
    );
  } catch (e) {
    console.warn("[Schema] vote_allowances:", e.message);
  }

  try {
    const withCredits = await db
      .prepare(
        "SELECT user_id, credits FROM leaderboard_access WHERE credits > 0",
      )
      .all();
    for (const row of withCredits) {
      const expiresAt = new Date(
        Date.now() + LEADERBOARD_ONCE_MS,
      ).toISOString();
      await db
        .prepare(
          "UPDATE leaderboard_access SET credits = 0, expires_at = ? WHERE user_id = ?",
        )
        .run(expiresAt, row.user_id);
    }
    if (withCredits.length)
      console.log(
        `[Migration] Converted ${withCredits.length} credit(s) → 1-minute timed access`,
      );
  } catch (e) {
    console.warn("[Migration credits]", e.message);
  }
}

const rateBuckets = new Map();
function rateLimit({ windowMs = 60_000, max = 60, key = "default" } = {}) {
  return (req, res, next) => {
    const ip = req.ip || req.socket.remoteAddress || "unknown";
    const body = req.body || {};
    const disc = body.phone || body.voterToken || body.email || "";
    const discClean = String(disc).replace(/\D/g, "");
    const bucketKey = discClean ? `${key}:id:${discClean}` : `${key}:ip:${ip}`;
    const now = Date.now();
    let entry = rateBuckets.get(bucketKey);
    if (!entry || now > entry.resetAt) {
      entry = { count: 0, resetAt: now + windowMs };
      rateBuckets.set(bucketKey, entry);
    }
    entry.count++;
    if (entry.count > max) {
      res.setHeader("Retry-After", Math.ceil((entry.resetAt - now) / 1000));
      return res
        .status(429)
        .json({ error: "Too many requests. Please slow down." });
    }
    next();
  };
}
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of rateBuckets) if (now > v.resetAt) rateBuckets.delete(k);
}, 60_000);

function generateCode(name) {
  const initials = (name || "XX")
    .split(" ")
    .map((s) => s[0])
    .join("")
    .toUpperCase()
    .slice(0, 2);
  return `VOTE_${initials}${Math.floor(100 + Math.random() * 900)}`;
}
function normalizePhone(phone) {
  let p = String(phone).replace(/\D/g, "");
  if (p.startsWith("0")) p = "254" + p.slice(1);
  else if (p.startsWith("7") || p.startsWith("1")) p = "254" + p;
  if (!p.startsWith("254")) p = "254" + p;
  return p;
}
async function logEvent(reference, event, details) {
  try {
    await db
      .prepare(
        "INSERT INTO payment_logs (reference, event, details) VALUES (?, ?, ?)",
      )
      .run(reference, event, details ? JSON.stringify(details) : null);
  } catch (e) {
    console.error("[Log]", e.message);
  }
}

function deepFind(obj, predicate, seen = new Set()) {
  if (!obj || typeof obj !== "object") return undefined;
  if (seen.has(obj)) return undefined;
  seen.add(obj);
  for (const key of Object.keys(obj)) {
    const value = obj[key];
    if (predicate(key, value)) return value;
    if (value && typeof value === "object") {
      const found = deepFind(value, predicate, seen);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

function cleanIP(ip) {
  if (!ip) return "unknown";
  if (ip.startsWith("::ffff:")) return ip.slice(7);
  if (ip === "::1") return "127.0.0.1";
  return ip;
}
function isPrivateIP(ip) {
  return (
    ip === "unknown" ||
    ip === "127.0.0.1" ||
    ip.startsWith("10.") ||
    ip.startsWith("192.168.") ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(ip)
  );
}

async function lookupIP(rawIp) {
  const ip = cleanIP(rawIp);
  if (isPrivateIP(ip))
    return {
      ip,
      country: "Local/Private",
      region: "",
      city: "",
      isp: "Local",
      org: "",
      asn: "",
    };
  try {
    const cached = await db
      .prepare("SELECT * FROM ip_lookup_cache WHERE ip = ?")
      .get(ip);
    if (cached) {
      const ageMs = Date.now() - new Date(cached.fetched_at).getTime();
      if (ageMs < 30 * 24 * 3600 * 1000) return cached;
    }
  } catch (e) {
    console.warn("[GeoIP cache]", e.message);
  }

  try {
    const r = await axios.get(`https://ipwho.is/${encodeURIComponent(ip)}`, {
      timeout: 6000,
      validateStatus: () => true,
    });
    if (r.status === 200 && r.data && r.data.success !== false) {
      const d = r.data;
      const row = {
        ip,
        country: d.country || "",
        region: d.region || "",
        city: d.city || "",
        isp: (d.connection && d.connection.isp) || "",
        org: (d.connection && d.connection.org) || "",
        asn:
          (d.connection && d.connection.asn && String(d.connection.asn)) || "",
      };
      try {
        await db
          .prepare(
            `INSERT OR REPLACE INTO ip_lookup_cache
          (ip, country, region, city, isp, org, asn, fetched_at)
          VALUES (?,?,?,?,?,?,?,CURRENT_TIMESTAMP)`,
          )
          .run(
            row.ip,
            row.country,
            row.region,
            row.city,
            row.isp,
            row.org,
            row.asn,
          );
      } catch (e) {
        console.warn("[GeoIP cache write]", e.message);
      }
      return row;
    }
  } catch (e) {
    console.warn("[GeoIP]", ip, e.message);
  }
  return {
    ip,
    country: "Lookup failed",
    region: "",
    city: "",
    isp: "",
    org: "",
    asn: "",
  };
}

function auth(req, res, next) {
  const h = req.headers.authorization || "";
  if (!h.startsWith("Bearer "))
    return res.status(401).json({ error: "Unauthorized" });
  try {
    req.user = jwt.verify(h.slice(7), JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: "Invalid token" });
  }
}
function authAllowQuery(req, res, next) {
  let token = null;
  const h = req.headers.authorization || "";
  if (h.startsWith("Bearer ")) token = h.slice(7);
  else if (req.query && req.query.token) token = String(req.query.token);
  if (!token) return res.status(401).json({ error: "Unauthorized" });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: "Invalid token" });
  }
}
function anyAuth(req, res, next) {
  const h = req.headers.authorization || "";
  if (!h.startsWith("Bearer "))
    return res.status(401).json({ error: "Unauthorized" });
  try {
    req.user = jwt.verify(h.slice(7), JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: "Invalid token" });
  }
}
function adminAuth(req, res, next) {
  const h = req.headers.authorization || "";
  if (!h.startsWith("Bearer "))
    return res.status(401).json({ error: "Unauthorized" });
  try {
    const p = jwt.verify(h.slice(7), JWT_SECRET);
    if (p.role !== "admin" && p.role !== "super")
      return res.status(403).json({ error: "Admin only" });
    req.admin = p;
    next();
  } catch {
    res.status(401).json({ error: "Invalid token" });
  }
}
function superAuth(req, res, next) {
  const h = req.headers.authorization || "";
  if (!h.startsWith("Bearer "))
    return res.status(401).json({ error: "Unauthorized" });
  try {
    const p = jwt.verify(h.slice(7), JWT_SECRET);
    if (p.role !== "super")
      return res.status(403).json({ error: "Super admin only" });
    req.admin = p;
    next();
  } catch {
    res.status(401).json({ error: "Invalid token" });
  }
}
function adminAuthAllowQuery(req, res, next) {
  let token = null;
  const h = req.headers.authorization || "";
  if (h.startsWith("Bearer ")) token = h.slice(7);
  else if (req.query && req.query.token) token = String(req.query.token);
  if (!token) return res.status(401).json({ error: "Unauthorized" });
  try {
    const p = jwt.verify(token, JWT_SECRET);
    if (p.role !== "admin" && p.role !== "super")
      return res.status(403).json({ error: "Admin only" });
    req.admin = p;
    next();
  } catch {
    res.status(401).json({ error: "Invalid token" });
  }
}

const nomineeVoteClients = new Map();
const publicVoteClients = new Set();
const adminStreamClients = new Set();

function writeSSE(res, payload) {
  try {
    res.write(payload);
  } catch (e) {
    console.warn("[SSE write]", e.message);
  }
}

function initSSE(req, res, bucketSet, key) {
  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders();
  res.write(": connected\n\n");
  if (bucketSet instanceof Map) {
    if (!bucketSet.has(key)) bucketSet.set(key, new Set());
    bucketSet.get(key).add(res);
  } else {
    bucketSet.add(res);
  }
  const hb = setInterval(() => writeSSE(res, ": ping\n\n"), 25_000);
  req.on("close", () => {
    clearInterval(hb);
    if (bucketSet instanceof Map) bucketSet.get(key)?.delete(res);
    else bucketSet.delete(res);
  });
}

async function broadcastVotes(nomineeId, votes) {
  try {
    const row = await db
      .prepare("SELECT user_id FROM nominees WHERE id = ?")
      .get(nomineeId);
    if (!row || !row.user_id) return;
    const payload = `event: votes\ndata: ${JSON.stringify({ votes })}\n\n`;
    nomineeVoteClients.get(row.user_id)?.forEach((r) => writeSSE(r, payload));
  } catch (e) {
    console.warn("[SSE nominee broadcast]", e.message);
  }
}
function broadcastPublicVote(nomineeId, votes) {
  const payload = `event: vote\ndata: ${JSON.stringify({ nomineeId, votes })}\n\n`;
  for (const r of publicVoteClients) writeSSE(r, payload);
}
function broadcastAdminEvent(event) {
  const payload = `event: update\ndata: ${JSON.stringify(event)}\n\n`;
  for (const r of adminStreamClients) writeSSE(r, payload);
}
function broadcastPaymentComplete(userId, txType, reference, extra = {}) {
  const payload = `event: payment\ndata: ${JSON.stringify({ type: txType, reference, status: "success", ...extra })}\n\n`;
  nomineeVoteClients.get(userId)?.forEach((r) => writeSSE(r, payload));
}

app.get("/api/nominee/stream", authAllowQuery, (req, res) => {
  initSSE(req, res, nomineeVoteClients, req.user.id);
});
app.get("/api/live/votes", (req, res) => {
  initSSE(req, res, publicVoteClients, null);
});
app.get("/api/live/admin", adminAuthAllowQuery, (req, res) => {
  initSSE(req, res, adminStreamClients, null);
});

function buildReportId() {
  const d = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const r = crypto.randomBytes(3).toString("hex").toUpperCase();
  return `EXP-${d}-${r}`;
}
function signReportTotals({
  reportId,
  generatedAtMs,
  totalVotes,
  categoryCount,
  nomineeCount,
}) {
  const canonical = [
    reportId,
    generatedAtMs,
    totalVotes,
    categoryCount,
    nomineeCount,
  ].join("|");
  return crypto
    .createHash("sha256")
    .update(canonical + "|" + REPORT_SECRET)
    .digest("hex")
    .toUpperCase()
    .slice(0, 40);
}
function formatDateTime(iso) {
  return new Date(iso).toLocaleString("en-US", {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    timeZoneName: "short",
  });
}
function csvEscape(v) {
  const s = String(v == null ? "" : v);
  if (s.includes(",") || s.includes('"') || s.includes("\n"))
    return '"' + s.replace(/"/g, '""') + '"';
  return s;
}
function shareBar(percent, width = 20) {
  const filled = Math.max(
    0,
    Math.min(width, Math.round((percent / 100) * width)),
  );
  return "\u2588".repeat(filled) + "\u2591".repeat(width - filled);
}
function escapeAttr(s) {
  return String(s == null ? "" : s).replace(
    /[&<>"']/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[c],
  );
}

async function loadReportData(req) {
  const isSuper = req.admin.role === "super";
  const reportId = buildReportId();
  const generatedAt = new Date().toISOString();
  const generatedBy = req.admin.username;
  const generatedByRole = isSuper ? "Super Administrator" : "Administrator";
  const categories = await db
    .prepare("SELECT id, name FROM categories ORDER BY created_at ASC")
    .all();
  const nominees = await db
    .prepare(
      `SELECT id, name, code, category_id, COALESCE(votes, 0) as votes,
        stage, eliminated, eliminated_stage, final_rank
     FROM nominees ORDER BY category_id, COALESCE(votes, 0) DESC`,
    )
    .all();
  const totalVotes = nominees.reduce((s, n) => s + (n.votes || 0), 0);
  const uniqueVoters = (
    await db
      .prepare("SELECT COUNT(DISTINCT voter_token) as c FROM free_votes")
      .get()
  ).c;
  const uniqueDevices = (
    await db
      .prepare(
        "SELECT COUNT(DISTINCT device_hash) as c FROM free_votes WHERE device_hash IS NOT NULL",
      )
      .get()
  ).c;
  const signature = signReportTotals({
    reportId,
    generatedAtMs: Date.parse(generatedAt),
    totalVotes,
    categoryCount: categories.length,
    nomineeCount: nominees.length,
  });
  const perCategory = categories.map((cat) => {
    const list = nominees.filter((n) => n.category_id === cat.id);
    const catTotal = list.reduce((s, n) => s + (n.votes || 0), 0);
    return {
      id: cat.id,
      name: cat.name,
      totalVotes: catTotal,
      nominees: list.map((n, i) => ({
        id: n.id,
        name: n.name,
        code: n.code,
        votes: n.votes,
        rank: i + 1,
        percent:
          catTotal > 0 ? Math.round((n.votes / catTotal) * 1000) / 10 : 0,
        stage: n.stage,
        eliminated: n.eliminated,
        eliminated_stage: n.eliminated_stage,
        final_rank: n.final_rank,
      })),
    };
  });
  return {
    reportId,
    generatedAt,
    generatedBy,
    generatedByRole,
    categories,
    nominees,
    totalVotes,
    uniqueVoters,
    uniqueDevices,
    signature,
    perCategory,
  };
}

async function extendLeaderboardAccess(t, userId, durationMs) {
  const existing = await t.get(
    "SELECT expires_at FROM leaderboard_access WHERE user_id = ?",
    [userId],
  );
  const nowMs = Date.now();
  const exMs =
    existing && existing.expires_at
      ? new Date(existing.expires_at).getTime()
      : 0;
  const base = exMs > nowMs ? exMs : nowMs;
  const expiresAt = new Date(base + durationMs).toISOString();
  await t.execute({
    sql: `INSERT INTO leaderboard_access (user_id, expires_at) VALUES (?, ?)
          ON CONFLICT(user_id) DO UPDATE SET expires_at = ?`,
    args: [userId, expiresAt, expiresAt],
  });
  return expiresAt;
}

async function completeTransaction(reference, receipt) {
  try {
    const result = await db.tx(async (t) => {
      const claimed = await t.execute({
        sql: `UPDATE transactions SET status='success', mpesa_receipt=?, completed_at=CURRENT_TIMESTAMP
              WHERE reference=? AND status='pending'`,
        args: [receipt, reference],
      });
      if (Number(claimed.rowsAffected || 0) === 0)
        return { ok: false, reason: "already_processed_or_not_pending" };
      const txRow = await t.get(
        "SELECT * FROM transactions WHERE reference = ?",
        [reference],
      );
      let meta = {};
      try {
        meta = txRow.metadata ? JSON.parse(txRow.metadata) : {};
      } catch (e) {
        console.warn("[Tx meta parse]", e.message);
      }
      let extra = {};
      if (txRow.type === "category_change") {
        const newCat = meta.newCategoryId;
        if (!newCat) throw new Error("Missing newCategoryId");
        const target = await t.get("SELECT id FROM categories WHERE id = ?", [
          newCat,
        ]);
        if (!target) throw new Error("Target category no longer exists");
        await t.execute({
          sql: "UPDATE nominees SET category_id = ? WHERE id = ?",
          args: [newCat, txRow.nominee_id],
        });
      } else if (txRow.type === "leaderboard_once") {
        extra.expiresAt = await extendLeaderboardAccess(
          t,
          txRow.user_id,
          LEADERBOARD_ONCE_MS,
        );
      } else if (txRow.type === "leaderboard_1h") {
        extra.expiresAt = await extendLeaderboardAccess(
          t,
          txRow.user_id,
          LEADERBOARD_1H_MS,
        );
      } else if (txRow.type === "leaderboard_12h") {
        extra.expiresAt = await extendLeaderboardAccess(
          t,
          txRow.user_id,
          LEADERBOARD_12H_MS,
        );
      } else if (txRow.type === "leaderboard_24h") {
        extra.expiresAt = await extendLeaderboardAccess(
          t,
          txRow.user_id,
          LEADERBOARD_24H_MS,
        );
      } else if (txRow.type === "leaderboard_2h") {
        extra.expiresAt = await extendLeaderboardAccess(
          t,
          txRow.user_id,
          LEADERBOARD_2H_MS,
        );
      } else if (txRow.type === "boost_50") {
        const already = await t.get(
          "SELECT id FROM nominee_boosts WHERE nominee_id = ?",
          [txRow.nominee_id],
        );
        if (already) throw new Error("ALREADY_BOOSTED");
        await t.execute({
          sql: `INSERT INTO nominee_boosts (id, nominee_id, reference, votes_added) VALUES (?, ?, ?, ?)`,
          args: [uuidv4(), txRow.nominee_id, reference, BOOST_VOTES],
        });
        await t.execute({
          sql: `UPDATE nominees SET votes =
                (SELECT COUNT(*) FROM free_votes WHERE nominee_id = ?) +
                (SELECT votes_added FROM nominee_boosts WHERE nominee_id = ?)
                WHERE id = ?`,
          args: [txRow.nominee_id, txRow.nominee_id, txRow.nominee_id],
        });
        const upd = await t.get("SELECT votes FROM nominees WHERE id = ?", [
          txRow.nominee_id,
        ]);
        extra.votes = upd?.votes || 0;
        extra.nomineeId = txRow.nominee_id;
        extra.boosted = true;
      } else if (txRow.type === "vote") {
        await t.execute({
          sql: `UPDATE nominees SET votes =
                (SELECT COUNT(*) FROM free_votes WHERE nominee_id = ?) +
                COALESCE((SELECT votes_added FROM nominee_boosts WHERE nominee_id = ?), 0)
                WHERE id = ?`,
          args: [txRow.nominee_id, txRow.nominee_id, txRow.nominee_id],
        });
        const upd = await t.get("SELECT votes FROM nominees WHERE id = ?", [
          txRow.nominee_id,
        ]);
        extra.votes = upd?.votes || 0;
        extra.nomineeId = txRow.nominee_id;
      }
      await t.execute({
        sql: "INSERT INTO payment_logs (reference, event, details) VALUES (?, ?, ?)",
        args: [
          reference,
          "completed",
          JSON.stringify({ receipt, type: txRow.type }),
        ],
      });
      return { ok: true, type: txRow.type, userId: txRow.user_id, extra };
    });
    if (result.ok) {
      console.log(`✓ ${reference} completed (${result.type})`);
      db.push().catch((e) => console.warn("[Push after payment]", e.message));
      broadcastAdminEvent({ type: "transaction:completed", reference });
      if (result.userId) {
        broadcastPaymentComplete(result.userId, result.type, reference, {
          expiresAt: result.extra?.expiresAt || null,
          votes: result.extra?.votes || null,
        });
      }
      if (result.extra?.boosted && result.extra?.nomineeId) {
        broadcastVotes(result.extra.nomineeId, result.extra.votes);
        broadcastPublicVote(result.extra.nomineeId, result.extra.votes);
      }
    } else {
      await logEvent(reference, "complete_skipped", { reason: result.reason });
    }
    return result.ok;
  } catch (e) {
    console.error("[Complete Error]", e.message);
    await logEvent(reference, "complete_error", { message: e.message });
    return false;
  }
}

async function failTransaction(reference, reason) {
  try {
    await db
      .prepare(
        `UPDATE transactions SET status='failed' WHERE reference=? AND status='pending'`,
      )
      .run(reference);
    await logEvent(reference, "failed", { reason });
    broadcastAdminEvent({ type: "transaction:failed", reference });
  } catch (e) {
    console.error("[Fail Error]", e.message);
  }
}

async function initiatePayment({
  type,
  userId,
  nomineeId,
  amount,
  phone,
  metadata,
  existingReference,
}) {
  const prefix =
    {
      category_change: "CC",
      leaderboard_once: "LB1",
      leaderboard_1h: "LB2",
      leaderboard_12h: "LB3",
      leaderboard_24h: "LB4",
      boost_50: "BS",
    }[type] || "TX";
  const reference =
    existingReference ||
    `${prefix}-${Date.now()}-${Math.floor(Math.random() * 100000)}`;
  if (!existingReference) {
    const id = uuidv4();
    await db
      .prepare(
        `INSERT INTO transactions (id, reference, type, user_id, nominee_id, amount, phone, metadata)
       VALUES (?,?,?,?,?,?,?,?)`,
      )
      .run(
        id,
        reference,
        type,
        userId || null,
        nomineeId || null,
        amount,
        phone,
        JSON.stringify(metadata || {}),
      );
    await logEvent(reference, "created", {
      type,
      amount,
      phone: normalizePhone(phone),
    });
  }
  if (!PAYHERO_API_KEY || !PAYHERO_API_SECRET || !PAYHERO_CHANNEL_ID) {
    console.log(`[SIM] ${reference} → ${type} ${amount} KES`);
    setTimeout(() => completeTransaction(reference, "SIM-" + Date.now()), 3000);
    return { success: true, reference, amount, simulated: true };
  }
  const cleanPhone = normalizePhone(phone);
  const authHeader = Buffer.from(
    `${PAYHERO_API_KEY}:${PAYHERO_API_SECRET}`,
  ).toString("base64");
  const payload = {
    amount,
    phone_number: cleanPhone,
    channel_id: parseInt(PAYHERO_CHANNEL_ID, 10),
    provider: "m-pesa",
    external_reference: reference,
    callback_url: PAYHERO_CALLBACK_URL,
  };
  let lastErr;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const r = await axios.post(`${PAYHERO_BASE_URL}/payments`, payload, {
        headers: {
          "Content-Type": "application/json",
          Authorization: `Basic ${authHeader}`,
        },
        timeout: 20000,
      });
      await logEvent(reference, "stk_sent", { attempt });
      return { success: true, reference, amount, payhero: r.data };
    } catch (err) {
      lastErr = err;
      const status = err.response && err.response.status;
      await logEvent(reference, "stk_error", {
        attempt,
        status,
        message: err.message,
      });
      if (status && status >= 400 && status < 500) break;
      if (attempt < 2) await new Promise((r) => setTimeout(r, 1500));
    }
  }
  console.error(
    `[PayHero] ${reference} failed:`,
    (lastErr && lastErr.response && lastErr.response.data) ||
      (lastErr && lastErr.message),
  );
  throw lastErr;
}

async function checkPayHeroStatus(reference) {
  if (!PAYHERO_API_KEY || !PAYHERO_API_SECRET) return null;
  const authHeader = Buffer.from(
    `${PAYHERO_API_KEY}:${PAYHERO_API_SECRET}`,
  ).toString("base64");
  const endpoints = [
    `${PAYHERO_BASE_URL}/payments/status?reference=${encodeURIComponent(reference)}`,
    `${PAYHERO_BASE_URL}/payments/${encodeURIComponent(reference)}`,
    `${PAYHERO_BASE_URL}/transactionstatus?reference=${encodeURIComponent(reference)}`,
    `${PAYHERO_BASE_URL}/transactions/${encodeURIComponent(reference)}`,
  ];
  for (const url of endpoints) {
    try {
      const r = await axios.get(url, {
        headers: { Authorization: `Basic ${authHeader}` },
        timeout: 10000,
        validateStatus: () => true,
      });
      if (r.status >= 200 && r.status < 300 && r.data) return r.data;
    } catch (e) {
      console.warn("[PayHeroStatus]", url, e.message);
    }
  }
  return null;
}

function interpretPayHeroStatus(payload) {
  if (!payload) return null;
  const data = payload.response || payload.data || payload;
  const receipt =
    data.MPESA_Reference ||
    data.mpesa_receipt ||
    data.MpesaReceiptNumber ||
    data.Transaction_Reference ||
    data.receipt ||
    null;
  if (receipt && String(receipt).trim().length > 0)
    return { status: "success", receipt: String(receipt).trim() };
  const resultCode = data.ResultCode ?? data.resultCode ?? null;
  if (resultCode !== null && resultCode !== 0 && resultCode !== "0")
    return { status: "failed" };
  const statusRaw = String(
    data.status ?? data.Status ?? data.PaymentStatus ?? "",
  ).toLowerCase();
  if (
    statusRaw.includes("fail") ||
    statusRaw.includes("cancel") ||
    statusRaw.includes("declin") ||
    statusRaw.includes("reject")
  )
    return { status: "failed" };
  return null;
}

app.post(
  "/api/upload",
  anyAuth,
  rateLimit({ key: "upload", max: 20 }),
  (req, res) => {
    upload.single("image")(req, res, async (err) => {
      if (err) {
        console.error("[Upload multer error]", err.message);
        return res.status(400).json({ error: err.message });
      }
      if (!req.file) return res.status(400).json({ error: "No file uploaded" });
      console.log(
        `[Upload] Received ${req.file.originalname} (${req.file.mimetype}, ${Math.round(req.file.size / 1024)} KB)`,
      );
      try {
        const processed = await processImage(req.file.buffer);
        const id = uuidv4();
        await db
          .prepare(
            "INSERT INTO images (id, data, mime, size) VALUES (?, ?, ?, ?)",
          )
          .run(id, processed.data, processed.mime, processed.data.length);
        db.push().catch((e) => console.warn("[Push after upload]", e.message));
        const url = `/api/images/${id}`;
        console.log(
          `[Upload] ✓ ${url} (${Math.round(processed.data.length / 1024)} KB)`,
        );
        res.json({ url, bytes: processed.data.length });
      } catch (e) {
        console.error("[Upload] ✗", e.message);
        res.status(500).json({ error: e.message || "Image upload failed" });
      }
    });
  },
);

app.get("/api/images/:id", async (req, res) => {
  const id = String(req.params.id || "").trim();
  if (!/^[0-9a-f-]{8,64}$/i.test(id)) {
    res.setHeader("Cache-Control", "no-store");
    return res.status(400).end();
  }
  try {
    let row = await db
      .prepare("SELECT data, mime FROM images WHERE id = ?")
      .get(id);
    if (!row) {
      const remoteRow = await db.pullImage(id);
      if (remoteRow) {
        row = { data: remoteRow.data, mime: remoteRow.mime };
      } else {
        res.setHeader("Cache-Control", "no-store");
        return res.status(404).end();
      }
    }
    if (!row.data || row.data.length === 0) {
      res.setHeader("Cache-Control", "no-store");
      return res.status(500).end();
    }
    const buf = Buffer.isBuffer(row.data) ? row.data : Buffer.from(row.data);
    res.setHeader("Content-Type", row.mime || "image/jpeg");
    res.setHeader("Content-Length", buf.length);
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    res.setHeader("ETag", `"${id}"`);
    res.send(buf);
  } catch (e) {
    console.error(`[Images] ✗ error for ${id}:`, e.message);
    res.setHeader("Cache-Control", "no-store");
    res.status(500).end();
  }
});

app.get("/api/health", async (req, res) => {
  let dbOk = true;
  try {
    await db.prepare("SELECT 1").get();
  } catch (e) {
    dbOk = false;
  }
  let imageCount = null;
  try {
    const row = await db.prepare("SELECT COUNT(*) as c FROM images").get();
    imageCount = row?.c ?? 0;
  } catch (e) {}
  res.json({
    ok: dbOk,
    uptime: Math.floor(process.uptime()),
    memory: Math.round(process.memoryUsage().rss / 1024 / 1024) + " MB",
    db: dbOk ? "ok" : "error",
    payhero: PAYHERO_API_KEY ? "live" : "simulation",
    images: { storage: "sqlite-blob", count: imageCount },
    sse: {
      nominees: nomineeVoteClients.size,
      public: publicVoteClients.size,
      admins: adminStreamClients.size,
    },
    syncQueue: db.getQueueSize ? db.getQueueSize() : null,
    pushFailures: db.getPushFailures ? db.getPushFailures() : null,
  });
});

// ── Public stages endpoint ──
app.get("/api/stages", async (req, res) => {
  const s = await getStages();
  const open = await votingOpen();
  res.json({
    current: s.current_stage,
    label: STAGE_LABELS[s.current_stage] || s.current_stage,
    next: NEXT_STAGE[s.current_stage] || null,
    nextLabel: STAGE_LABELS[NEXT_STAGE[s.current_stage]] || null,
    cutoff: STAGE_CUTOFF[s.current_stage] || 5,
    votingOpen: open,
    preliminaries_start: s.preliminaries_start,
    preliminaries_end: s.preliminaries_end,
    semifinals_start: s.semifinals_start,
    semifinals_end: s.semifinals_end,
    finals_start: s.finals_start,
    finals_end: s.finals_end,
    last_advanced_at: s.last_advanced_at,
    updated_at: s.updated_at,
  });
});

app.get("/api/config", async (req, res) => {
  const s = await getStages();
  const open = await votingOpen();
  const currentEnd =
    {
      preliminaries: s.preliminaries_end,
      semi_finals: s.semifinals_end,
      finals: s.finals_end,
      completed: null,
    }[s.current_stage] || VOTE_DEADLINE;
  res.json({
    deadline: currentEnd,
    votingOpen: open,
    freeVoting: true,
    votesPerCategory: 1,
    stage: {
      current: s.current_stage,
      label: STAGE_LABELS[s.current_stage] || s.current_stage,
      preliminariesStart: s.preliminaries_start,
      preliminariesEnd: s.preliminaries_end,
      semifinalsStart: s.semifinals_start,
      semifinalsEnd: s.semifinals_end,
      finalsStart: s.finals_start,
      finalsEnd: s.finals_end,
      next: NEXT_STAGE[s.current_stage] || null,
      nextLabel: STAGE_LABELS[NEXT_STAGE[s.current_stage]] || null,
      cutoff: STAGE_CUTOFF[s.current_stage] || 5,
    },
    payheroConfigured: !!(
      PAYHERO_API_KEY &&
      PAYHERO_API_SECRET &&
      PAYHERO_CHANNEL_ID
    ),
    prices: {
      categoryChange: PRICES.category_change,
      leaderboardOnce: PRICES.leaderboard_once,
      leaderboard1h: PRICES.leaderboard_1h,
      leaderboard12h: PRICES.leaderboard_12h,
      leaderboard24h: PRICES.leaderboard_24h,
      boost50: PRICES.boost_50,
    },
  });
});

app.get("/verify", (req, res) => {
  const { r, s, v, c, n, t } = req.query;
  const missing = !r || !s;
  let valid = false;
  if (!missing) {
    const expected = signReportTotals({
      reportId: String(r),
      generatedAtMs: parseInt(t) || 0,
      totalVotes: parseInt(v) || 0,
      categoryCount: parseInt(c) || 0,
      nomineeCount: parseInt(n) || 0,
    });
    valid = String(s).toUpperCase() === expected;
  }
  const bg = valid ? "from-emerald-50 to-green-100" : "from-red-50 to-rose-100";
  const bubble = valid
    ? "bg-emerald-100 text-emerald-600"
    : "bg-red-100 text-red-600";
  const icon = valid ? "✓" : "✗";
  const title = valid ? "Report Verified" : "Verification Failed";
  const subtitle = valid
    ? "This report is authentic and matches our signing records."
    : missing
      ? "This verification link is incomplete."
      : "The signature does not match. This report may have been tampered with.";
  const details = missing
    ? ""
    : `
    <div class="bg-gray-50 rounded-xl p-4 text-left space-y-2 mb-6">
      <div class="flex justify-between"><span class="text-xs font-bold text-gray-500 uppercase">Report ID</span><span class="text-sm font-mono font-bold text-gray-900">${escapeAttr(r)}</span></div>
      <div class="flex justify-between"><span class="text-xs font-bold text-gray-500 uppercase">Total Votes</span><span class="text-sm font-bold text-gray-900">${(parseInt(v) || 0).toLocaleString()}</span></div>
      <div class="flex justify-between"><span class="text-xs font-bold text-gray-500 uppercase">Categories</span><span class="text-sm font-bold text-gray-900">${parseInt(c) || 0}</span></div>
      <div class="flex justify-between"><span class="text-xs font-bold text-gray-500 uppercase">Participants</span><span class="text-sm font-bold text-gray-900">${parseInt(n) || 0}</span></div>
      <div class="flex justify-between"><span class="text-xs font-bold text-gray-500 uppercase">Generated</span><span class="text-xs font-mono text-gray-700">${t ? new Date(parseInt(t)).toLocaleString() : "—"}</span></div>
      <div class="flex justify-between"><span class="text-xs font-bold text-gray-500 uppercase">Status</span><span class="text-sm font-bold ${valid ? "text-emerald-600" : "text-red-600"}">${valid ? "✓ VALID" : "✗ INVALID"}</span></div>
    </div>`;
  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Report Verification · Voteus</title>
  <meta name="robots" content="noindex, nofollow" />
  <script src="https://cdn.tailwindcss.com"></script>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet" />
  <style>* { font-family: 'Inter', sans-serif; }</style>
</head>
<body class="min-h-screen bg-gradient-to-br ${bg} flex items-center justify-center p-4">
  <div class="bg-white rounded-2xl shadow-xl max-w-lg w-full p-8 text-center">
    <div class="w-20 h-20 rounded-full ${bubble} flex items-center justify-center mx-auto mb-5 text-4xl font-black">${icon}</div>
    <h1 class="text-2xl font-extrabold text-gray-900 mb-2">${title}</h1>
    <p class="text-gray-500 mb-6">${subtitle}</p>
    ${details}
    <div class="text-xs text-gray-400 mt-6">
      Verified by <strong>Voteus.io</strong>
      · <a href="/" class="text-indigo-600 hover:underline">Back to site</a>
    </div>
  </div>
</body>
</html>`;
  res.type("html").send(html);
});

app.get("/api/categories", async (req, res) => {
  res.json(
    await db.prepare("SELECT * FROM categories ORDER BY created_at ASC").all(),
  );
});

app.get("/api/nominees", async (req, res) => {
  const voterToken =
    typeof req.query.voterToken === "string" ? req.query.voterToken : null;
  const deviceHash =
    typeof req.query.deviceHash === "string" ? req.query.deviceHash : null;
  const rows = await db
    .prepare(
      `SELECT n.*, c.name as category FROM nominees n
     JOIN categories c ON n.category_id = c.id ORDER BY n.created_at ASC`,
    )
    .all();
  for (const r of rows)
    if (r.votes === null || r.votes === undefined) r.votes = 0;
  if (voterToken || deviceHash) {
    try {
      const conditions = [];
      const params = [];
      if (voterToken) {
        conditions.push("fv.voter_token = ?");
        params.push(voterToken);
      }
      if (deviceHash) {
        conditions.push("fv.device_hash = ?");
        params.push(deviceHash);
      }
      const voterVotes = await db
        .prepare(
          `SELECT fv.nominee_id, n2.category_id, n2.name, n2.code,
                fv.is_appeal, fv.created_at
         FROM free_votes fv
         JOIN nominees n2 ON fv.nominee_id = n2.id
         WHERE ${conditions.join(" OR ")}
         ORDER BY fv.is_appeal DESC, fv.created_at DESC`,
        )
        .all(...params);
      const votedByNominee = new Set();
      const votedByCategory = {};
      for (const v of voterVotes) {
        votedByNominee.add(v.nominee_id);
        if (!votedByCategory[v.category_id]) {
          votedByCategory[v.category_id] = {
            nomineeId: v.nominee_id,
            name: v.name,
            code: v.code,
          };
        }
      }
      const allowanceConditions = [];
      const allowanceParams = [];
      if (deviceHash) {
        allowanceConditions.push("device_hash = ?");
        allowanceParams.push(deviceHash);
      }
      if (voterToken) {
        allowanceConditions.push("voter_token = ?");
        allowanceParams.push(voterToken);
      }
      let allowanceCategories = new Set();
      if (allowanceConditions.length) {
        try {
          const activeAllowances = await db
            .prepare(
              `SELECT category_id FROM vote_allowances
             WHERE (${allowanceConditions.join(" OR ")}) AND status = 'active'`,
            )
            .all(...allowanceParams);
          allowanceCategories = new Set(
            activeAllowances.map((a) => a.category_id),
          );
        } catch (ae) {
          console.warn("[Nominees allowances]", ae.message);
        }
      }
      for (const r of rows) {
        const hasAllowance = allowanceCategories.has(r.category_id);
        if (hasAllowance) {
          r.voted = false;
          r.categoryVoted = false;
          r.categoryVoteFor = null;
          r.appealAllowed = true;
        } else {
          r.voted = votedByNominee.has(r.id);
          r.categoryVoted = Object.prototype.hasOwnProperty.call(
            votedByCategory,
            r.category_id,
          );
          r.categoryVoteFor = votedByCategory[r.category_id] || null;
          r.appealAllowed = false;
        }
      }
    } catch (e) {
      console.warn("[Nominees vote-status]", e.message);
      for (const r of rows) {
        r.voted = false;
        r.categoryVoted = false;
        r.categoryVoteFor = null;
        r.appealAllowed = false;
      }
    }
  }
  res.json(rows);
});

app.get("/api/nominees/:code", async (req, res) => {
  const n = await db
    .prepare(
      `SELECT n.*, c.name as category FROM nominees n
     JOIN categories c ON n.category_id = c.id WHERE n.code = ?`,
    )
    .get(req.params.code);
  if (!n) return res.status(404).json({ error: "Not found" });
  if (n.votes === null || n.votes === undefined) n.votes = 0;
  res.json(n);
});

app.post(
  "/api/auth/register",
  rateLimit({ key: "register", max: 10 }),
  async (req, res) => {
    try {
      const body = req.body || {};
      const { name, email, password } = body;
      if (!name || !email || !password)
        return res
          .status(400)
          .json({ error: "Name, email, and password are required" });
      const cleanName = String(name).trim();
      const cleanEmail = String(email).trim().toLowerCase();
      const cleanPassword = String(password);
      if (!cleanName)
        return res.status(400).json({ error: "Name is required" });
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail))
        return res
          .status(400)
          .json({ error: "Please enter a valid email address" });
      if (cleanPassword.length < 8)
        return res
          .status(400)
          .json({ error: "Password must be at least 8 characters" });
      if (!/\d/.test(cleanPassword))
        return res
          .status(400)
          .json({ error: "Password must contain at least one number" });
      const existing = await db
        .prepare("SELECT id FROM users WHERE LOWER(email) = ?")
        .get(cleanEmail);
      if (existing && existing.id) {
        return res.status(409).json({
          error:
            "An account with this email already exists. Try signing in instead.",
          code: "EMAIL_EXISTS",
        });
      }
      const hash = await bcrypt.hash(cleanPassword, 10);
      const id = uuidv4();
      try {
        await db
          .prepare(
            "INSERT INTO users (id, name, email, password_hash) VALUES (?,?,?,?)",
          )
          .run(id, cleanName, cleanEmail, hash);
      } catch (insErr) {
        if (
          String(insErr.message || "")
            .toLowerCase()
            .includes("unique")
        ) {
          return res.status(409).json({
            error:
              "An account with this email already exists. Try signing in instead.",
            code: "EMAIL_EXISTS",
          });
        }
        throw insErr;
      }
      const token = jwt.sign({ id, role: "nominee" }, JWT_SECRET, {
        expiresIn: "7d",
      });
      res.json({
        token,
        user: { id, name: cleanName, email: cleanEmail, hasNominee: false },
      });
    } catch (e) {
      console.error("[Register] Fatal:", e.message);
      res.status(500).json({ error: "Registration failed. Please try again." });
    }
  },
);

app.post(
  "/api/auth/login",
  rateLimit({ key: "login", max: 20 }),
  async (req, res) => {
    const { email, password } = req.body || {};
    if (!email || !password)
      return res.status(400).json({ error: "Email and password required" });
    const cleanEmail = String(email).trim().toLowerCase();
    const user = await db
      .prepare("SELECT * FROM users WHERE LOWER(email) = ?")
      .get(cleanEmail);
    if (!user) return res.status(401).json({ error: "Invalid credentials" });
    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return res.status(401).json({ error: "Invalid credentials" });
    const nominee = await db
      .prepare("SELECT id FROM nominees WHERE user_id = ?")
      .get(user.id);
    const token = jwt.sign({ id: user.id, role: "nominee" }, JWT_SECRET, {
      expiresIn: "7d",
    });
    res.json({
      token,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        hasNominee: !!nominee,
      },
    });
  },
);

app.post(
  "/api/admin/login",
  rateLimit({ key: "admin-login", max: 10 }),
  async (req, res) => {
    const { username, password } = req.body || {};
    if (!username || !password)
      return res.status(400).json({ error: "Username and password required" });
    if (
      username === SUPER_ADMIN_USERNAME &&
      password === SUPER_ADMIN_PASSWORD
    ) {
      const token = jwt.sign(
        { role: "super", username, displayName: "Super Administrator" },
        JWT_SECRET,
        { expiresIn: "12h" },
      );
      return res.json({
        token,
        user: { username, role: "super", displayName: "Super Administrator" },
      });
    }
    const admin = await db
      .prepare("SELECT * FROM admins WHERE username = ? AND revoked = 0")
      .get(username);
    if (!admin) return res.status(401).json({ error: "Invalid credentials" });
    const ok = await bcrypt.compare(password, admin.password_hash);
    if (!ok) return res.status(401).json({ error: "Invalid credentials" });
    const token = jwt.sign(
      {
        role: "admin",
        id: admin.id,
        username: admin.username,
        displayName: admin.display_name,
      },
      JWT_SECRET,
      { expiresIn: "12h" },
    );
    res.json({
      token,
      user: {
        username: admin.username,
        role: "admin",
        displayName: admin.display_name || admin.username,
      },
    });
  },
);

app.get("/api/admin/users", superAuth, async (req, res) => {
  const rows = await db
    .prepare(
      `SELECT id, username, display_name, role, created_by, created_at, revoked, revoked_at, revoked_by
     FROM admins ORDER BY created_at DESC`,
    )
    .all();
  res.json({ admins: rows, super: { username: SUPER_ADMIN_USERNAME } });
});

app.post("/api/admin/users", superAuth, async (req, res) => {
  const { username, password, displayName } = req.body || {};
  if (!username || !password)
    return res.status(400).json({ error: "Username and password required" });
  if (username.length < 3)
    return res
      .status(400)
      .json({ error: "Username must be at least 3 characters" });
  if (password.length < 6)
    return res
      .status(400)
      .json({ error: "Password must be at least 6 characters" });
  if (username === SUPER_ADMIN_USERNAME)
    return res.status(400).json({ error: "Username reserved" });
  if (
    await db.prepare("SELECT id FROM admins WHERE username = ?").get(username)
  )
    return res.status(409).json({ error: "Username already taken" });
  const hash = await bcrypt.hash(password, 10);
  const id = uuidv4();
  await db
    .prepare(
      `INSERT INTO admins (id, username, password_hash, display_name, role, created_by)
     VALUES (?,?,?,?,?,?)`,
    )
    .run(
      id,
      username,
      hash,
      displayName || username,
      "admin",
      req.admin.username,
    );
  res.json({ id, username, displayName: displayName || username });
});

app.delete("/api/admin/users/:id", superAuth, async (req, res) => {
  const admin = await db
    .prepare("SELECT * FROM admins WHERE id = ?")
    .get(req.params.id);
  if (!admin) return res.status(404).json({ error: "Admin not found" });
  if (admin.revoked) return res.status(400).json({ error: "Already revoked" });
  await db
    .prepare(
      `UPDATE admins SET revoked = 1, revoked_at = CURRENT_TIMESTAMP, revoked_by = ? WHERE id = ?`,
    )
    .run(req.admin.username, req.params.id);
  res.json({ success: true });
});

app.get("/api/admin/diagnostic/users-list", superAuth, async (req, res) => {
  try {
    const total = (await db.prepare("SELECT COUNT(*) as c FROM users").get()).c;
    const users = await db
      .prepare(
        "SELECT id, name, email, created_at FROM users ORDER BY created_at DESC LIMIT 500",
      )
      .all();
    res.json({ total, returned: users.length, users });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Admin: Stage management (super only) ───
app.get("/api/admin/stages/status", superAuth, async (req, res) => {
  try {
    const s = await getStages();
    const cats = await db.prepare("SELECT id, name FROM categories").all();
    const counts = [];
    for (const cat of cats) {
      const row = await db
        .prepare(
          `SELECT
            COUNT(*) AS total,
            SUM(CASE WHEN eliminated = 0 THEN 1 ELSE 0 END) AS active
           FROM nominees WHERE category_id = ?`,
        )
        .get(cat.id);
      counts.push({
        category: cat.name,
        total: Number(row?.total || 0),
        active: Number(row?.active || 0),
      });
    }
    res.json({
      stages: {
        current_stage: s.current_stage,
        label: STAGE_LABELS[s.current_stage] || s.current_stage,
        next: NEXT_STAGE[s.current_stage] || null,
        next_label: STAGE_LABELS[NEXT_STAGE[s.current_stage]] || null,
        cutoff: STAGE_CUTOFF[s.current_stage] || 5,
        preliminaries_start: s.preliminaries_start,
        preliminaries_end: s.preliminaries_end,
        semifinals_start: s.semifinals_start,
        semifinals_end: s.semifinals_end,
        finals_start: s.finals_start,
        finals_end: s.finals_end,
        last_advanced_at: s.last_advanced_at,
        updated_at: s.updated_at,
      },
      counts,
    });
  } catch (e) {
    console.error("[Stage status]", e);
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/admin/stages/config", superAuth, async (req, res) => {
  try {
    const {
      preliminaries_start,
      preliminaries_end,
      semifinals_start,
      semifinals_end,
      finals_start,
      finals_end,
    } = req.body || {};
    await getStages(); // ensure row exists
    await db
      .prepare(
        `UPDATE election_stages SET
          preliminaries_start = ?,
          preliminaries_end = ?,
          semifinals_start = ?,
          semifinals_end = ?,
          finals_start = ?,
          finals_end = ?,
          updated_at = CURRENT_TIMESTAMP
         WHERE id = 1`,
      )
      .run(
        preliminaries_start || null,
        preliminaries_end || null,
        semifinals_start || null,
        semifinals_end || null,
        finals_start || null,
        finals_end || null,
      );
    const s = await getStages();
    db.push().catch((e) =>
      console.warn("[Push after stage config]", e.message),
    );
    broadcastStage(s.current_stage);
    res.json({ ok: true, stages: s });
  } catch (e) {
    console.error("[Stage config]", e);
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/admin/stages/advance", superAuth, async (req, res) => {
  try {
    const r = await advanceStage();
    if (!r.ok) return res.status(400).json({ error: r.error });
    res.json(r);
  } catch (e) {
    console.error("[Stage advance]", e);
    res.status(500).json({ error: e.message });
  }
});

async function getLeaderboardAccess(userId) {
  const acc = await db
    .prepare("SELECT * FROM leaderboard_access WHERE user_id = ?")
    .get(userId);
  if (!acc) return { allowed: false, type: "none" };
  if (acc.permanent) return { allowed: true, type: "permanent" };
  if (acc.expires_at) {
    const expiresMs = new Date(acc.expires_at).getTime();
    const now = Date.now();
    if (Number.isFinite(expiresMs) && expiresMs > now) {
      return {
        allowed: true,
        type: "timed",
        expiresAt: acc.expires_at,
        secondsLeft: Math.max(0, Math.floor((expiresMs - now) / 1000)),
      };
    }
  }
  return { allowed: false, type: "none" };
}

app.get("/api/nominee/me", auth, async (req, res) => {
  const nominee = await db
    .prepare(
      `SELECT n.id, n.user_id, n.name, n.category_id, n.code, n.img, n.desc,
            COALESCE(n.votes, 0) AS votes, n.created_at, c.name as category,
            n.stage, n.eliminated, n.eliminated_stage, n.final_rank
     FROM nominees n JOIN categories c ON n.category_id = c.id WHERE n.user_id = ?`,
    )
    .get(req.user.id);
  if (!nominee) return res.status(404).json({ error: "Not a nominee yet" });
  const boostRow = await db
    .prepare(
      "SELECT votes_added, created_at FROM nominee_boosts WHERE nominee_id = ?",
    )
    .get(nominee.id);

  // Leaderboard: active nominees only (eliminated ones are out of competition)
  const activeRows = await db
    .prepare(
      `SELECT id, COALESCE(votes, 0) AS votes FROM nominees
       WHERE category_id = ? AND eliminated = 0
       ORDER BY COALESCE(votes, 0) DESC, created_at ASC`,
    )
    .all(nominee.category_id);
  const idx = activeRows.findIndex((r) => r.id === nominee.id);
  let leaderboard;
  if (idx >= 0) {
    leaderboard = {
      above: idx > 0 ? { votes: activeRows[idx - 1].votes } : null,
      self: { votes: nominee.votes },
      below:
        idx < activeRows.length - 1
          ? { votes: activeRows[idx + 1].votes }
          : null,
    };
  } else {
    leaderboard = {
      above: null,
      self: { votes: nominee.votes },
      below: null,
      eliminated: true,
    };
  }

  const stages = await getStages();
  const zone = await getNomineeZone(nominee);

  res.json({
    nominee: {
      ...nominee,
      boosted: !!boostRow,
      boostVotesAdded: boostRow?.votes_added || 0,
      boostPurchasedAt: boostRow?.created_at || null,
    },
    leaderboard,
    leaderboardAccess: await getLeaderboardAccess(req.user.id),
    boostPrice: PRICES.boost_50,
    boostVotes: BOOST_VOTES,
    stage: {
      current: stages.current_stage,
      label: STAGE_LABELS[stages.current_stage] || stages.current_stage,
      next: NEXT_STAGE[stages.current_stage] || null,
      nextLabel: STAGE_LABELS[NEXT_STAGE[stages.current_stage]] || null,
      cutoff: STAGE_CUTOFF[stages.current_stage] || 5,
      preliminariesStart: stages.preliminaries_start,
      preliminariesEnd: stages.preliminaries_end,
      semifinalsStart: stages.semifinals_start,
      semifinalsEnd: stages.semifinals_end,
      finalsStart: stages.finals_start,
      finalsEnd: stages.finals_end,
    },
    zone,
  });
});

app.post("/api/nominee/update-profile", auth, async (req, res) => {
  const { name, img } = req.body || {};
  const nominee = await db
    .prepare("SELECT * FROM nominees WHERE user_id = ?")
    .get(req.user.id);
  if (!nominee) return res.status(404).json({ error: "Not a nominee yet" });

  const updates = [];
  const args = [];

  if (name !== undefined) {
    const cleanName = String(name).trim();
    if (!cleanName)
      return res.status(400).json({ error: "Name cannot be empty" });
    if (cleanName.length > 80)
      return res.status(400).json({ error: "Name too long (max 80 chars)" });
    updates.push("name = ?");
    args.push(cleanName);
  }

  if (img !== undefined) {
    const cleanImg = String(img).trim();
    if (cleanImg && !/^\/api\/images\/[0-9a-f-]+$/i.test(cleanImg)) {
      return res
        .status(400)
        .json({ error: "Invalid image URL — must be an /api/images/ path" });
    }
    updates.push("img = ?");
    args.push(cleanImg || null);
  }

  if (!updates.length)
    return res.status(400).json({ error: "Nothing to update" });

  args.push(nominee.id);
  await db
    .prepare(`UPDATE nominees SET ${updates.join(", ")} WHERE id = ?`)
    .run(...args);

  const updated = await db
    .prepare(
      `SELECT n.*, c.name as category FROM nominees n
       JOIN categories c ON n.category_id = c.id WHERE n.id = ?`,
    )
    .get(nominee.id);

  db.push().catch((e) => console.warn("[Push after profile edit]", e.message));
  broadcastAdminEvent({ type: "nominee:update", nomineeId: nominee.id });
  res.json({ nominee: updated });
});

app.get("/api/nominee/leaderboard", auth, async (req, res) => {
  const nominee = await db
    .prepare("SELECT * FROM nominees WHERE user_id = ?")
    .get(req.user.id);
  if (!nominee) return res.status(404).json({ error: "Not a nominee yet" });
  const access = await getLeaderboardAccess(req.user.id);
  if (!access.allowed)
    return res.status(402).json({ error: "Leaderboard locked", access });
  const rows = await db
    .prepare(
      `SELECT n.id, n.name, n.code, n.img, COALESCE(n.votes, 0) AS votes
     FROM nominees n WHERE n.category_id = ? AND n.eliminated = 0
     ORDER BY COALESCE(n.votes, 0) DESC, n.created_at ASC`,
    )
    .all(nominee.category_id);
  res.json({
    leaderboard: rows.map((r, i) => ({
      ...r,
      rank: i + 1,
      isMe: r.id === nominee.id,
    })),
    access,
  });
});

app.post(
  "/api/nominee/register",
  auth,
  rateLimit({ key: "nom-register", max: 5 }),
  async (req, res) => {
    const { name, categoryId, img, desc } = req.body || {};
    if (!name || !categoryId)
      return res.status(400).json({ error: "Name and category required" });
    if (
      await db
        .prepare("SELECT id FROM nominees WHERE user_id = ?")
        .get(req.user.id)
    )
      return res.status(400).json({ error: "Already registered as nominee" });
    if (
      !(await db
        .prepare("SELECT id FROM categories WHERE id = ?")
        .get(categoryId))
    )
      return res.status(400).json({ error: "Invalid category" });
    let code;
    do {
      code = generateCode(name);
    } while (
      await db.prepare("SELECT id FROM nominees WHERE code = ?").get(code)
    );
    const id = uuidv4();
    await db
      .prepare(
        "INSERT INTO nominees (id, user_id, name, category_id, code, img, desc) VALUES (?,?,?,?,?,?,?)",
      )
      .run(id, req.user.id, name, categoryId, code, img || null, desc || null);
    const nominee = await db
      .prepare(
        `SELECT n.*, c.name as category FROM nominees n
     JOIN categories c ON n.category_id = c.id WHERE n.id = ?`,
      )
      .get(id);
    broadcastAdminEvent({ type: "nominee:new", nomineeId: id, name });
    res.json({ nominee });
  },
);

app.post(
  "/api/nominee/change-category",
  auth,
  rateLimit({ key: "change-cat", max: 5 }),
  async (req, res) => {
    const { newCategoryId, phone } = req.body || {};
    if (!newCategoryId || !phone)
      return res.status(400).json({ error: "Category and phone required" });
    const nominee = await db
      .prepare("SELECT * FROM nominees WHERE user_id = ?")
      .get(req.user.id);
    if (!nominee) return res.status(404).json({ error: "Not a nominee yet" });
    if (nominee.eliminated)
      return res
        .status(400)
        .json({ error: "You cannot change category after elimination" });
    if (nominee.category_id === newCategoryId)
      return res.status(400).json({ error: "Already in this category" });
    if (
      !(await db
        .prepare("SELECT id FROM categories WHERE id = ?")
        .get(newCategoryId))
    )
      return res.status(400).json({ error: "Invalid category" });
    try {
      const r = await initiatePayment({
        type: "category_change",
        userId: req.user.id,
        nomineeId: nominee.id,
        amount: PRICES.category_change,
        phone,
        metadata: { newCategoryId },
      });
      res.json(r);
    } catch (err) {
      res.status(502).json({
        error:
          (err.response && err.response.data && err.response.data.message) ||
          "Payment gateway unreachable. Please retry.",
      });
    }
  },
);

app.post(
  "/api/nominee/unlock-leaderboard",
  auth,
  rateLimit({ key: "unlock-lb", max: 10 }),
  async (req, res) => {
    const { type, phone } = req.body || {};
    const map = {
      once: { tx: "leaderboard_once", amount: PRICES.leaderboard_once },
      "1h": { tx: "leaderboard_1h", amount: PRICES.leaderboard_1h },
      "12h": { tx: "leaderboard_12h", amount: PRICES.leaderboard_12h },
      "24h": { tx: "leaderboard_24h", amount: PRICES.leaderboard_24h },
    };
    const chosen = map[type];
    if (!chosen) return res.status(400).json({ error: "Invalid unlock type" });
    if (!phone) return res.status(400).json({ error: "Phone required" });
    const nominee = await db
      .prepare("SELECT * FROM nominees WHERE user_id = ?")
      .get(req.user.id);
    if (!nominee) return res.status(404).json({ error: "Not a nominee yet" });
    try {
      const r = await initiatePayment({
        type: chosen.tx,
        userId: req.user.id,
        nomineeId: nominee.id,
        amount: chosen.amount,
        phone,
      });
      res.json(r);
    } catch (err) {
      res.status(502).json({
        error:
          (err.response && err.response.data && err.response.data.message) ||
          "Payment gateway unreachable. Please retry.",
      });
    }
  },
);

app.post(
  "/api/nominee/boost",
  auth,
  rateLimit({ key: "boost", max: 5 }),
  async (req, res) => {
    const { phone } = req.body || {};
    if (!phone) return res.status(400).json({ error: "Phone required" });
    const nominee = await db
      .prepare("SELECT * FROM nominees WHERE user_id = ?")
      .get(req.user.id);
    if (!nominee) return res.status(404).json({ error: "Not a nominee yet" });
    if (nominee.eliminated)
      return res
        .status(400)
        .json({ error: "You cannot purchase a boost after elimination" });
    const existing = await db
      .prepare("SELECT id FROM nominee_boosts WHERE nominee_id = ?")
      .get(nominee.id);
    if (existing)
      return res.status(400).json({
        error: "Boost already purchased — one per nominee.",
        code: "ALREADY_BOOSTED",
      });
    try {
      const r = await initiatePayment({
        type: "boost_50",
        userId: req.user.id,
        nomineeId: nominee.id,
        amount: PRICES.boost_50,
        phone,
        metadata: { votes: BOOST_VOTES },
      });
      res.json(r);
    } catch (err) {
      res.status(502).json({
        error:
          (err.response && err.response.data && err.response.data.message) ||
          "Payment gateway unreachable. Please retry.",
      });
    }
  },
);

app.post(
  "/api/votes",
  rateLimit({ key: "vote", max: 60 }),
  async (req, res) => {
    if (!(await votingOpen()))
      return res.status(403).json({ error: "Voting is closed" });
    const {
      nomineeCode,
      voterToken,
      deviceHash,
      userAgent,
      fingerprintDetails,
    } = req.body || {};
    if (!nomineeCode || !voterToken || !deviceHash)
      return res.status(400).json({
        error: "Nominee code, voter token, and device fingerprint are required",
      });
    if (
      typeof deviceHash !== "string" ||
      deviceHash.length < 8 ||
      deviceHash.length > 128
    )
      return res.status(400).json({ error: "Invalid device fingerprint" });
    if (
      typeof voterToken !== "string" ||
      voterToken.length < 10 ||
      voterToken.length > 100
    )
      return res.status(400).json({ error: "Invalid voter token" });
    const nominee = await db
      .prepare("SELECT * FROM nominees WHERE code = ?")
      .get(nomineeCode);
    if (!nominee) return res.status(404).json({ error: "Nominee not found" });

    // Reject votes for eliminated nominees
    if (nominee.eliminated) {
      return res.status(403).json({
        error: `${nominee.name} was eliminated from the ${STAGE_LABELS[nominee.eliminated_stage] || "competition"}.`,
        code: "NOMINEE_ELIMINATED",
        eliminatedStage: nominee.eliminated_stage,
      });
    }

    const ip = cleanIP(req.ip || req.socket.remoteAddress || "unknown");
    const ua = String(userAgent || req.headers["user-agent"] || "").slice(
      0,
      500,
    );
    const fpJson = fingerprintDetails
      ? JSON.stringify(fingerprintDetails).slice(0, 4000)
      : null;

    let result;
    try {
      result = await db.tx(async (t) => {
        const existing = await t.get(
          `SELECT fv.nominee_id, n2.name AS voted_name, n2.code AS voted_code,
                fv.voter_token, fv.device_hash
         FROM free_votes fv
         JOIN nominees n2 ON fv.nominee_id = n2.id
         WHERE n2.category_id = ?
           AND (fv.voter_token = ? OR fv.device_hash = ?)
         LIMIT 1`,
          [nominee.category_id, voterToken, deviceHash],
        );
        if (existing) {
          const allowance = await t.get(
            `SELECT * FROM vote_allowances
           WHERE (device_hash = ? OR voter_token = ?)
             AND category_id = ? AND status = 'active'
           LIMIT 1`,
            [deviceHash, voterToken, nominee.category_id],
          );
          if (!allowance) {
            return {
              ok: false,
              sameNominee: existing.nominee_id === nominee.id,
              votedName: existing.voted_name,
              votedCode: existing.voted_code,
              reason: existing.device_hash === deviceHash ? "device" : "voter",
            };
          }
          const voteId = uuidv4();
          const appealVoterToken = `${voterToken}_apl_${Date.now()}`;
          await t.execute({
            sql: `INSERT INTO free_votes
                (id, voter_token, nominee_id, device_hash, ip, category_id,
                 user_agent, fingerprint_json, is_appeal)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`,
            args: [
              voteId,
              appealVoterToken,
              nominee.id,
              deviceHash,
              ip,
              nominee.category_id,
              ua,
              fpJson,
            ],
          });
          await t.execute({
            sql: `UPDATE nominees SET votes =
                  (SELECT COUNT(*) FROM free_votes WHERE nominee_id = ?) +
                  COALESCE((SELECT votes_added FROM nominee_boosts WHERE nominee_id = ?), 0)
                  WHERE id = ?`,
            args: [nominee.id, nominee.id, nominee.id],
          });
          await t.execute({
            sql: `UPDATE vote_allowances SET status = 'used', used_at = CURRENT_TIMESTAMP, used_vote_id = ? WHERE id = ?`,
            args: [voteId, allowance.id],
          });
          await t.execute({
            sql: `INSERT INTO payment_logs (reference, event, details) VALUES (?, 'appeal_vote_used', ?)`,
            args: [
              allowance.appeal_code,
              JSON.stringify({
                nominee_id: nominee.id,
                category_id: nominee.category_id,
                vote_id: voteId,
                device_hash_at_vote: deviceHash,
                voter_token_at_vote: voterToken,
              }),
            ],
          });
          return {
            ok: true,
            appealVote: true,
            appealCode: allowance.appeal_code,
          };
        }
        await t.execute({
          sql: `INSERT INTO free_votes
              (id, voter_token, nominee_id, device_hash, ip, category_id,
               user_agent, fingerprint_json, is_appeal)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`,
          args: [
            uuidv4(),
            voterToken,
            nominee.id,
            deviceHash,
            ip,
            nominee.category_id,
            ua,
            fpJson,
          ],
        });
        await t.execute({
          sql: `UPDATE nominees SET votes =
                (SELECT COUNT(*) FROM free_votes WHERE nominee_id = ?) +
                COALESCE((SELECT votes_added FROM nominee_boosts WHERE nominee_id = ?), 0)
                WHERE id = ?`,
          args: [nominee.id, nominee.id, nominee.id],
        });
        return { ok: true };
      });
    } catch (e) {
      console.error("[Vote]", e.message);
      if (
        String(e.message || "")
          .toLowerCase()
          .includes("unique")
      )
        return res.status(409).json({
          error: "This device has already voted in this category.",
          code: "DEVICE_ALREADY_VOTED",
        });
      return res.status(500).json({ error: "Vote failed. Please try again." });
    }

    if (!result.ok) {
      let message;
      if (result.reason === "device")
        message = `This device has already voted in this category (for ${result.votedName}). Only one vote per device per category is allowed.`;
      else if (result.sameNominee)
        message = "You have already voted for this nominee.";
      else
        message = `You've already voted in this category (for ${result.votedName}). Only one vote per category is allowed.`;
      return res.status(409).json({
        error: message,
        code: "ALREADY_VOTED",
        votedNominee: { name: result.votedName, code: result.votedCode },
      });
    }

    db.push().catch((e) => console.warn("[Push after vote]", e.message));
    const absoluteVotes = await (async () => {
      const c = await db
        .prepare("SELECT COUNT(*) AS c FROM free_votes WHERE nominee_id = ?")
        .get(nominee.id);
      const b = await db
        .prepare("SELECT votes_added FROM nominee_boosts WHERE nominee_id = ?")
        .get(nominee.id);
      const total = (c?.c || 0) + (b?.votes_added || 0);
      await db
        .prepare("UPDATE nominees SET votes = ? WHERE id = ?")
        .run(total, nominee.id);
      return total;
    })();
    broadcastVotes(nominee.id, absoluteVotes);
    broadcastPublicVote(nominee.id, absoluteVotes);
    broadcastAdminEvent({
      type: "vote",
      nomineeId: nominee.id,
      votes: absoluteVotes,
      appealVote: !!result.appealVote,
      at: new Date().toISOString(),
    });
    const response = { success: true, votes: absoluteVotes };
    if (result.appealVote) {
      response.appealVote = true;
      response.appealCode = result.appealCode;
    }
    res.json(response);
  },
);

app.get("/api/votes/my-votes/:voterToken", async (req, res) => {
  const token = req.params.voterToken;
  if (!token || token.length < 10) return res.json([]);
  try {
    const rows = await db
      .prepare(
        `SELECT fv.nominee_id, fv.created_at,
              n.code, n.name, n.category_id, c.name AS category
       FROM free_votes fv
       JOIN nominees n ON fv.nominee_id = n.id
       JOIN categories c ON n.category_id = c.id
       WHERE fv.voter_token = ? OR fv.voter_token LIKE ?
       ORDER BY fv.created_at DESC`,
      )
      .all(token, token + "_apl_%");
    res.json(rows);
  } catch (e) {
    console.warn("[my-votes]", e.message);
    res.json([]);
  }
});

app.get("/api/transactions/status/:reference", async (req, res) => {
  const tx = await db
    .prepare(
      "SELECT status, type, metadata, amount, completed_at FROM transactions WHERE reference = ?",
    )
    .get(req.params.reference);
  if (!tx) return res.status(404).json({ error: "Not found" });
  let meta = {};
  try {
    meta = tx.metadata ? JSON.parse(tx.metadata) : {};
  } catch (e) {
    console.warn("[Tx parse]", e.message);
  }
  res.json({
    status: tx.status,
    type: tx.type,
    amount: tx.amount,
    voteCount: meta.voteCount,
    metadata: meta,
    completedAt: tx.completed_at,
  });
});

app.get("/api/transactions/check/:reference", async (req, res) => {
  const reference = req.params.reference;
  const tx = await db
    .prepare(
      "SELECT status, type, metadata, amount, completed_at FROM transactions WHERE reference = ?",
    )
    .get(reference);
  if (!tx) return res.status(404).json({ error: "Not found" });
  if (["success", "failed", "abandoned"].includes(tx.status)) {
    let meta = {};
    try {
      meta = tx.metadata ? JSON.parse(tx.metadata) : {};
    } catch (e) {
      console.warn("[Tx parse]", e.message);
    }
    return res.json({
      status: tx.status,
      type: tx.type,
      amount: tx.amount,
      voteCount: meta.voteCount,
      metadata: meta,
      completedAt: tx.completed_at,
      source: "database",
    });
  }
  try {
    const payload = await checkPayHeroStatus(reference);
    const result = interpretPayHeroStatus(payload);
    if (result && result.status === "success")
      await completeTransaction(reference, result.receipt);
    else if (result && result.status === "failed")
      await failTransaction(reference, "payhero_status_failed");
  } catch (e) {
    console.warn("[LiveCheck]", e.message);
  }
  const updated = await db
    .prepare(
      "SELECT status, type, metadata, amount, completed_at FROM transactions WHERE reference = ?",
    )
    .get(reference);
  let meta = {};
  try {
    meta = updated.metadata ? JSON.parse(updated.metadata) : {};
  } catch (e) {
    console.warn("[Tx parse]", e.message);
  }
  res.json({
    status: updated.status,
    type: updated.type,
    amount: updated.amount,
    voteCount: meta.voteCount,
    metadata: meta,
    completedAt: updated.completed_at,
    source: "live_check",
  });
});

app.post("/api/payhero/callback", (req, res) => {
  res.json({ received: true });
  (async () => {
    try {
      const body = req.body || {};
      console.log(
        "[PayHero CB] FULL BODY:",
        JSON.stringify(body).slice(0, 1500),
      );
      const data = body.response || body.data || body;
      let ref =
        data.User_Reference ||
        data.user_reference ||
        data.external_reference ||
        data.reference ||
        body.User_Reference ||
        body.user_reference ||
        body.external_reference ||
        body.ExternalReference ||
        body.externalReference ||
        body.reference ||
        body.Reference ||
        null;
      if (!ref)
        ref = deepFind(
          body,
          (k, v) =>
            typeof v === "string" && /^(CC|LB1|LB2|LB3|LB4|BS|TX)-\d/.test(v),
        );
      if (!ref) {
        const raw = JSON.stringify(body).toUpperCase();
        const pending = await db
          .prepare(
            `SELECT reference FROM transactions WHERE status='pending' ORDER BY created_at DESC LIMIT 50`,
          )
          .all();
        for (const tx of pending)
          if (raw.includes(tx.reference.toUpperCase())) {
            ref = tx.reference;
            break;
          }
      }
      if (!ref) {
        console.warn("[PayHero CB] No reference found");
        return;
      }
      const wooStatus = String(
        data.woocommerce_payment_status ||
          body.woocommerce_payment_status ||
          "",
      ).toLowerCase();
      const statusRaw = String(
        data.status ??
          data.Status ??
          data.payment_status ??
          data.PaymentStatus ??
          body.status ??
          body.Status ??
          "",
      ).toLowerCase();
      const resultCode = data.ResultCode ?? data.resultCode ?? null;
      const receipt =
        data.MPESA_Reference ||
        data.mpesa_receipt ||
        data.MpesaReceiptNumber ||
        data.Transaction_Reference ||
        data.receipt ||
        null;
      const receiptClean =
        receipt && String(receipt).trim().length > 0
          ? String(receipt).trim()
          : null;
      const failure =
        wooStatus === "failed" ||
        wooStatus === "cancelled" ||
        wooStatus === "canceled" ||
        statusRaw.includes("fail") ||
        statusRaw.includes("cancel") ||
        statusRaw.includes("declin") ||
        statusRaw.includes("reject") ||
        (resultCode !== null && resultCode !== 0 && resultCode !== "0");
      const success = !failure && receiptClean !== null;
      console.log(
        `[PayHero CB] ref=${ref} status="${statusRaw}" receipt="${receiptClean}" → ${success ? "SUCCESS" : failure ? "FAILURE" : "AWAITING_RECEIPT"}`,
      );
      await logEvent(ref, "callback_received", {
        wooStatus,
        statusRaw,
        receipt: receiptClean,
        decision: success
          ? "success"
          : failure
            ? "failure"
            : "awaiting_receipt",
      });
      if (success) await completeTransaction(ref, receiptClean);
      else if (failure) await failTransaction(ref, "callback_failure");
    } catch (e) {
      console.error("[Callback Error]", e.message);
    }
  })();
});

const VERDICT_MESSAGES = {
  NO_RECORD_FOUND:
    "No votes exist on record for your browser, your device fingerprint, or your network. If you saw an 'already voted' message, it was NOT because of a recorded vote — it was a frontend/UI bug or a transient loading state.",
  FINGERPRINT_COLLISION:
    "A vote WAS recorded, but from a DIFFERENT browser, at a DIFFERENT IP address, with a device fingerprint that matches yours. This proves the system wrongly blocked you because fingerprint collisions are happening. You did not vote — someone else's device generated the same signature as yours.",
  VOTED_FROM_THIS_NETWORK:
    "A vote was recorded from your network (same IP address), but from a different browser/fingerprint. If you are on a shared network (e.g., campus wifi), someone near you voted. This is weak evidence — it does not prove you voted, but it explains why your network is flagged.",
  VOTED_BY_THIS_BROWSER:
    "Your exact browser session has a vote on record. This means either you (or someone using your device) pressed the vote button. If you are certain you didn't, check the device — someone with physical access may have voted on your behalf.",
};

app.post(
  "/api/report-auto-vote",
  rateLimit({ key: "report-auto", max: 5 }),
  async (req, res) => {
    try {
      const {
        name,
        contact,
        description,
        voterToken,
        deviceHash,
        fingerprintDetails,
      } = req.body || {};
      if (!description || String(description).trim().length < 10)
        return res.status(400).json({
          error: "Please describe what happened (at least 10 characters)",
        });
      const ip = cleanIP(req.ip || req.socket.remoteAddress || "unknown");
      const ua = String(req.headers["user-agent"] || "").slice(0, 500);
      const currentDevice = parseUA(ua);
      const currentFingerprint = parseFingerprint(fingerprintDetails);
      const matches = [];
      const seen = new Set();
      const pushMatch = (v, matchType, strength, note) => {
        const key = `${v.created_at}|${v.nominee_code}|${v.ip}`;
        if (seen.has(key)) return;
        seen.add(key);
        const matchUA = v.user_agent || "";
        const matchFp = parseFingerprint(v.fingerprint_json);
        const hasDetails = !!(matchUA || matchFp);
        matches.push({
          created_at: toISOUTC(v.created_at),
          created_at_raw: v.created_at,
          nominee_code: v.nominee_code,
          nominee_name: v.nominee_name,
          category: v.category,
          ip_at_vote: cleanIP(v.ip || ""),
          match_type: matchType,
          match_strength: strength,
          note: note || "",
          device_info: matchUA ? parseUA(matchUA) : null,
          fingerprint: matchFp,
          user_agent_raw: matchUA || null,
          is_appeal: !!(v.is_appeal && Number(v.is_appeal) === 1),
          details_available: hasDetails,
          unavailable_reason: hasDetails
            ? null
            : "This vote was recorded before detailed fingerprint logging was enabled — only the hashed fingerprint is on record.",
        });
      };
      const selectCols = `fv.created_at, fv.ip, fv.device_hash, fv.voter_token,
                        fv.user_agent, fv.fingerprint_json, fv.is_appeal,
                        n.code AS nominee_code, n.name AS nominee_name,
                        c.name AS category`;
      if (voterToken && typeof voterToken === "string") {
        try {
          const ownRows = await db
            .prepare(
              `SELECT ${selectCols} FROM free_votes fv
           JOIN nominees n ON n.id = fv.nominee_id
           JOIN categories c ON c.id = fv.category_id
           WHERE fv.voter_token = ? ORDER BY fv.created_at ASC`,
            )
            .all(voterToken);
          ownRows.forEach((v) =>
            pushMatch(
              v,
              "own_token",
              "high",
              "This exact browser session is on record",
            ),
          );
        } catch (e) {
          console.warn("[Report] own_token lookup:", e.message);
        }
      }
      if (deviceHash && typeof deviceHash === "string") {
        try {
          const hashRows = await db
            .prepare(
              `SELECT ${selectCols} FROM free_votes fv
           JOIN nominees n ON n.id = fv.nominee_id
           JOIN categories c ON c.id = fv.category_id
           WHERE fv.device_hash = ? ORDER BY fv.created_at ASC`,
            )
            .all(deviceHash);
          hashRows.forEach((v) => {
            const sameIp = cleanIP(v.ip) === ip;
            const sameToken = v.voter_token === voterToken;
            if (sameToken) return;
            pushMatch(
              v,
              sameIp ? "same_hash_same_ip" : "collision",
              sameIp ? "medium" : "low",
              sameIp
                ? "Same fingerprint AND same IP (probably same device, cleared storage)"
                : "Same fingerprint, different IP (fingerprint collision — different device)",
            );
          });
        } catch (e) {
          console.warn("[Report] device_hash lookup:", e.message);
        }
      }
      if (ip && !isPrivateIP(ip)) {
        try {
          const ipRows = await db
            .prepare(
              `SELECT ${selectCols} FROM free_votes fv
           JOIN nominees n ON n.id = fv.nominee_id
           JOIN categories c ON c.id = fv.category_id
           WHERE fv.ip = ? ORDER BY fv.created_at ASC LIMIT 50`,
            )
            .all(ip);
          ipRows.forEach((v) => {
            if (v.voter_token === voterToken) return;
            pushMatch(
              v,
              "same_ip",
              "weak",
              "Same network IP only — different browser and fingerprint",
            );
          });
        } catch (e) {
          console.warn("[Report] same_ip lookup:", e.message);
        }
      }
      let verdict;
      if (matches.length === 0) verdict = "NO_RECORD_FOUND";
      else if (matches.some((m) => m.match_type === "own_token"))
        verdict = "VOTED_BY_THIS_BROWSER";
      else if (matches.some((m) => m.match_type === "collision"))
        verdict = "FINGERPRINT_COLLISION";
      else verdict = "VOTED_FROM_THIS_NETWORK";
      const reporterGeo = await lookupIP(ip);
      const uniqueVotingIps = [
        ...new Set(matches.map((m) => m.ip_at_vote)),
      ].filter((v) => v && v !== "unknown" && !isPrivateIP(v));
      const geosByIp = {};
      for (const vip of uniqueVotingIps.slice(0, 10))
        geosByIp[vip] = await lookupIP(vip);
      for (const m of matches)
        if (m.ip_at_vote && geosByIp[m.ip_at_vote])
          m.ip_geo = geosByIp[m.ip_at_vote];
      const reportCode = `RPT-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(3).toString("hex").toUpperCase()}`;
      const id = uuidv4();
      await db
        .prepare(
          `INSERT INTO vote_reports (
         id, report_code, ip, user_agent, voter_token, device_hash,
         fingerprint_details, report_description, reporter_name, reporter_contact,
         verdict, matched_votes, geo_info
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          id,
          reportCode,
          ip,
          ua,
          voterToken || null,
          deviceHash || null,
          JSON.stringify(fingerprintDetails || {}),
          String(description).slice(0, 2000),
          (name || "").slice(0, 100),
          (contact || "").slice(0, 200),
          verdict,
          JSON.stringify({ matches }),
          JSON.stringify(reporterGeo),
        );
      console.log(
        `[Report] ${reportCode} from ${ip} → ${verdict} (${matches.length} match${matches.length === 1 ? "" : "es"})`,
      );
      broadcastAdminEvent({ type: "vote_report:new", reportCode, verdict });
      const maskIp = (v) => {
        if (!v || v === "unknown") return v;
        if (v === ip) return v;
        if (v.includes(":")) {
          const parts = v.split(":");
          return parts.slice(0, 2).join(":") + ":····";
        }
        const p = v.split(".");
        if (p.length === 4) return `${p[0]}.${p[1]}.xxx.xxx`;
        return v;
      };
      res.json({
        success: true,
        reportCode,
        reportedAt: toISOUTC(new Date().toISOString()),
        verdict,
        message: VERDICT_MESSAGES[verdict],
        yourIP: ip,
        yourIPInfo: reporterGeo,
        yourDevice: currentDevice,
        yourFingerprint: currentFingerprint,
        matchCount: matches.length,
        matches: matches.map((m) => ({
          ...m,
          ip_at_vote: maskIp(m.ip_at_vote),
          ip_geo: m.ip_geo
            ? {
                country: m.ip_geo.country,
                region: m.ip_geo.region,
                city: m.ip_geo.city,
                isp: m.ip_geo.isp,
                org: m.ip_geo.org,
                asn: m.ip_geo.asn,
              }
            : null,
        })),
        appeals: [],
      });
    } catch (e) {
      console.error("[Report] Fatal:", e);
      res.status(500).json({ error: "Report failed: " + e.message });
    }
  },
);

app.get("/api/report/:code", async (req, res) => {
  const code = String(req.params.code || "")
    .trim()
    .toUpperCase();
  if (!/^RPT-[A-Z0-9]+-[A-Z0-9]+$/.test(code))
    return res.status(400).json({ error: "Invalid report code" });
  const row = await db
    .prepare("SELECT * FROM vote_reports WHERE report_code = ?")
    .get(code);
  if (!row) return res.status(404).json({ error: "Report not found" });
  let matches = [];
  try {
    matches = JSON.parse(row.matched_votes || "{}").matches || [];
  } catch (e) {
    console.warn("[Report parse]", e.message);
  }
  let geo = {};
  try {
    geo = JSON.parse(row.geo_info || "{}");
  } catch (e) {
    console.warn("[Report geo parse]", e.message);
  }
  let fp = {};
  try {
    fp = row.fingerprint_details ? JSON.parse(row.fingerprint_details) : {};
  } catch (e) {
    console.warn("[Report fp parse]", e.message);
  }
  const appealRows = await db
    .prepare(
      `SELECT va.*,
            (SELECT status FROM vote_allowances WHERE appeal_code = va.appeal_code LIMIT 1) AS allowance_status,
            (SELECT used_at FROM vote_allowances WHERE appeal_code = va.appeal_code LIMIT 1) AS allowance_used_at,
            (SELECT n.name FROM free_votes fv
               JOIN nominees n ON n.id = fv.nominee_id
               WHERE fv.id = (SELECT used_vote_id FROM vote_allowances WHERE appeal_code = va.appeal_code LIMIT 1)) AS used_for_nominee
     FROM vote_appeals va WHERE va.report_code = ? ORDER BY va.created_at ASC`,
    )
    .all(code);
  res.json({
    reportCode: row.report_code,
    reportedAt: toISOUTC(row.reported_at),
    verdict: row.verdict,
    description: row.report_description,
    matchCount: matches.length,
    matches: matches.map((m) => ({
      ...m,
      created_at: toISOUTC(m.created_at || m.created_at_raw || row.reported_at),
    })),
    yourIP: row.ip,
    yourIPInfo: geo,
    yourDevice: row.user_agent ? parseUA(row.user_agent) : null,
    yourFingerprint: parseFingerprint(fp),
    appeals: appealRows.map((a) => ({
      appealCode: a.appeal_code,
      category: a.category_name,
      categoryId: a.category_id,
      reason: a.reason,
      status: a.status,
      createdAt: toISOUTC(a.created_at),
      decidedAt: toISOUTC(a.decided_at),
      decisionNote: a.decision_note,
      allowanceStatus: a.allowance_status,
      allowanceUsedAt: toISOUTC(a.allowance_used_at),
      usedForNominee: a.used_for_nominee,
    })),
  });
});

app.post(
  "/api/report-appeal",
  rateLimit({ key: "report-appeal", max: 5 }),
  async (req, res) => {
    try {
      const { reportCode, categoryId, reason } = req.body || {};
      if (!reportCode || !categoryId || !reason)
        return res
          .status(400)
          .json({ error: "reportCode, categoryId, and reason are required" });
      if (String(reason).trim().length < 20)
        return res.status(400).json({
          error: "Please explain in at least 20 characters why you disagree",
        });
      const code = String(reportCode).trim().toUpperCase();
      const report = await db
        .prepare("SELECT * FROM vote_reports WHERE report_code = ?")
        .get(code);
      if (!report) return res.status(404).json({ error: "Report not found" });
      const category = await db
        .prepare("SELECT id, name FROM categories WHERE id = ?")
        .get(categoryId);
      if (!category) return res.status(400).json({ error: "Invalid category" });
      const existing = await db
        .prepare(
          "SELECT appeal_code FROM vote_appeals WHERE report_code = ? AND category_id = ?",
        )
        .get(code, categoryId);
      if (existing)
        return res.status(409).json({
          error: "You already filed an appeal for this category",
          appealCode: existing.appeal_code,
        });
      const appealCode = `APL-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(2).toString("hex").toUpperCase()}`;
      const id = uuidv4();
      await db
        .prepare(
          `INSERT INTO vote_appeals (
         id, appeal_code, report_code, device_hash, voter_token,
         category_id, category_name, reason, status
       ) VALUES (?,?,?,?,?,?,?,?,'pending')`,
        )
        .run(
          id,
          appealCode,
          code,
          report.device_hash,
          report.voter_token,
          categoryId,
          category.name,
          String(reason).trim().slice(0, 2000),
        );
      broadcastAdminEvent({
        type: "appeal:new",
        appealCode,
        reportCode: code,
        categoryName: category.name,
      });
      res.json({
        success: true,
        appealCode,
        status: "pending",
        message:
          "Your appeal has been sent to the admin. You will be able to vote once more in this category once it is approved.",
      });
    } catch (e) {
      console.error("[Appeal] Fatal:", e);
      res.status(500).json({ error: "Appeal failed: " + e.message });
    }
  },
);

app.get("/api/appeal/:code", async (req, res) => {
  const code = String(req.params.code || "")
    .trim()
    .toUpperCase();
  if (!/^APL-[A-Z0-9]+-[A-Z0-9]+$/.test(code))
    return res.status(400).json({ error: "Invalid appeal code" });
  const appeal = await db
    .prepare("SELECT * FROM vote_appeals WHERE appeal_code = ?")
    .get(code);
  if (!appeal) return res.status(404).json({ error: "Appeal not found" });
  const allowance = await db
    .prepare("SELECT * FROM vote_allowances WHERE appeal_code = ?")
    .get(code);
  let usedForNominee = null;
  if (allowance?.used_vote_id) {
    const v = await db
      .prepare(
        `SELECT n.name FROM free_votes fv JOIN nominees n ON n.id = fv.nominee_id WHERE fv.id = ?`,
      )
      .get(allowance.used_vote_id);
    usedForNominee = v?.name || null;
  }
  res.json({
    appealCode: appeal.appeal_code,
    reportCode: appeal.report_code,
    category: appeal.category_name,
    reason: appeal.reason,
    status: appeal.status,
    createdAt: toISOUTC(appeal.created_at),
    decidedAt: toISOUTC(appeal.decided_at),
    decisionNote: appeal.decision_note,
    allowanceStatus: allowance?.status || null,
    allowanceUsedAt: allowance ? toISOUTC(allowance.used_at) : null,
    usedForNominee,
  });
});

app.get("/api/admin/reports", superAuth, async (req, res) => {
  const verdict = req.query.verdict ? String(req.query.verdict) : null;
  const limit = Math.min(parseInt(req.query.limit) || 500, 2000);
  const where = verdict ? "WHERE verdict = ?" : "";
  const params = verdict ? [verdict, limit] : [limit];
  const rows = await db
    .prepare(
      `SELECT * FROM vote_reports ${where} ORDER BY reported_at DESC LIMIT ?`,
    )
    .all(...params);
  const enriched = rows.map((r) => {
    let matches = [];
    try {
      matches = JSON.parse(r.matched_votes || "{}").matches || [];
    } catch (e) {
      console.warn("[Reports parse]", e.message);
    }
    let geo = {};
    try {
      geo = JSON.parse(r.geo_info || "{}");
    } catch (e) {
      console.warn("[Reports geo parse]", e.message);
    }
    let fp = {};
    try {
      fp = r.fingerprint_details ? JSON.parse(r.fingerprint_details) : {};
    } catch (e) {
      console.warn("[Reports fp parse]", e.message);
    }
    return {
      ...r,
      reported_at: toISOUTC(r.reported_at),
      matched_votes: undefined,
      geo_info: undefined,
      fingerprint_details: undefined,
      matches: matches.map((m) => ({
        ...m,
        created_at: toISOUTC(m.created_at || m.created_at_raw),
      })),
      geo,
      fingerprint: fp,
      device_info: r.user_agent ? parseUA(r.user_agent) : null,
    };
  });
  const counts = (
    await db
      .prepare(
        `SELECT verdict, COUNT(*) AS c FROM vote_reports GROUP BY verdict`,
      )
      .all()
  ).reduce((a, r) => ({ ...a, [r.verdict]: r.c }), {});
  res.json({ reports: enriched, counts, total: enriched.length });
});

app.get("/api/admin/appeals", superAuth, async (req, res) => {
  const status = req.query.status ? String(req.query.status) : null;
  const where = status ? "WHERE status = ?" : "";
  const params = status ? [status] : [];
  const rows = await db
    .prepare(
      `SELECT va.*,
            (SELECT status FROM vote_allowances WHERE appeal_code = va.appeal_code LIMIT 1) AS allowance_status,
            (SELECT used_at FROM vote_allowances WHERE appeal_code = va.appeal_code LIMIT 1) AS allowance_used_at,
            (SELECT n.name FROM free_votes fv
               JOIN nominees n ON n.id = fv.nominee_id
               WHERE fv.id = (SELECT used_vote_id FROM vote_allowances WHERE appeal_code = va.appeal_code LIMIT 1)) AS used_for_nominee
     FROM vote_appeals va ${where} ORDER BY va.created_at DESC LIMIT 500`,
    )
    .all(...params);
  const counts = (
    await db
      .prepare("SELECT status, COUNT(*) AS c FROM vote_appeals GROUP BY status")
      .all()
  ).reduce((a, r) => ({ ...a, [r.status]: r.c }), {});
  res.json({
    appeals: rows.map((a) => ({
      ...a,
      created_at: toISOUTC(a.created_at),
      decided_at: toISOUTC(a.decided_at),
      allowance_used_at: toISOUTC(a.allowance_used_at),
    })),
    counts,
    total: rows.length,
  });
});

app.post("/api/admin/appeals/:code/decide", superAuth, async (req, res) => {
  try {
    const { decision, note } = req.body || {};
    if (!["approve", "reject"].includes(decision))
      return res
        .status(400)
        .json({ error: "decision must be 'approve' or 'reject'" });

    const code = String(req.params.code || "")
      .trim()
      .toUpperCase();
    const appeal = await db
      .prepare("SELECT * FROM vote_appeals WHERE appeal_code = ?")
      .get(code);
    if (!appeal) return res.status(404).json({ error: "Appeal not found" });

    if (appeal.status !== "pending")
      return res.status(400).json({
        error: `Appeal already ${appeal.status} — cannot decide again`,
      });

    let allowancesCreated = 0;
    let allowancesSkipped = 0;
    let blockedCategories = [];

    if (decision === "approve") {
      blockedCategories = await db
        .prepare(
          `SELECT DISTINCT category_id FROM free_votes
         WHERE (device_hash = ? OR voter_token = ?)
           AND category_id IS NOT NULL`,
        )
        .all(appeal.device_hash, appeal.voter_token);

      if (!blockedCategories.length) {
        return res.status(400).json({
          error:
            "This device has no recorded votes to re-cast. Nothing to approve.",
        });
      }

      for (const { category_id } of blockedCategories) {
        const existing = await db
          .prepare(
            "SELECT id FROM vote_allowances WHERE device_hash = ? AND category_id = ?",
          )
          .get(appeal.device_hash, category_id);
        if (existing) {
          allowancesSkipped++;
          continue;
        }

        await db
          .prepare(
            `INSERT INTO vote_allowances
           (id, appeal_code, device_hash, voter_token, category_id, status)
           VALUES (?,?,?,?,?,'active')`,
          )
          .run(
            uuidv4(),
            appeal.appeal_code,
            appeal.device_hash,
            appeal.voter_token,
            category_id,
          );
        allowancesCreated++;
      }
    }

    await db
      .prepare(
        `UPDATE vote_appeals SET status = ?, decided_at = CURRENT_TIMESTAMP,
              decided_by = ?, decision_note = ? WHERE appeal_code = ?`,
      )
      .run(
        decision === "approve" ? "approved" : "rejected",
        req.admin.username,
        (note || "").slice(0, 1000),
        code,
      );

    broadcastAdminEvent({ type: "appeal:decided", appealCode: code, decision });

    const totalCovered = allowancesCreated + allowancesSkipped;
    res.json({
      success: true,
      appealCode: code,
      decision: decision === "approve" ? "approved" : "rejected",
      allowancesCreated,
      allowancesSkipped,
      blockedCategoriesCount: blockedCategories.length,
      message:
        decision === "approve"
          ? `Approved. User can now vote once more in ${totalCovered} categor${totalCovered === 1 ? "y" : "ies"} where they were blocked (${allowancesCreated} new, ${allowancesSkipped} already covered).`
          : "Appeal rejected.",
    });
  } catch (e) {
    console.error("[Appeal Decide]", e);
    res.status(500).json({ error: "Failed: " + e.message });
  }
});

app.get("/api/admin/stats", adminAuth, async (req, res) => {
  try {
    const isSuper = req.admin.role === "super";
    const totalVotes = (
      await db
        .prepare(
          "SELECT COALESCE(SUM(COALESCE(votes, 0)), 0) as t FROM nominees",
        )
        .get()
    ).t;
    const nomineesCount = (
      await db.prepare("SELECT COUNT(*) as c FROM nominees").get()
    ).c;
    const activeNomineesCount = (
      await db
        .prepare("SELECT COUNT(*) as c FROM nominees WHERE eliminated = 0")
        .get()
    ).c;
    const categoriesCount = (
      await db.prepare("SELECT COUNT(*) as c FROM categories").get()
    ).c;
    const uniqueVoters = (
      await db
        .prepare("SELECT COUNT(DISTINCT voter_token) as c FROM free_votes")
        .get()
    ).c;
    const uniqueDevices = (
      await db
        .prepare(
          "SELECT COUNT(DISTINCT device_hash) as c FROM free_votes WHERE device_hash IS NOT NULL",
        )
        .get()
    ).c;
    const base = {
      totalVotes,
      nomineesCount,
      activeNomineesCount,
      categoriesCount,
      uniqueVoters,
      uniqueDevices,
      avgVotesPerNominee: nomineesCount > 0 ? totalVotes / nomineesCount : 0,
    };
    if (!isSuper) return res.json(base);
    const grossRevenue = (
      await db
        .prepare(
          `SELECT COALESCE(SUM(amount),0) as t FROM transactions WHERE status='success'`,
        )
        .get()
    ).t;
    const pending = (
      await db
        .prepare(
          `SELECT COUNT(*) as c FROM transactions WHERE status='pending'`,
        )
        .get()
    ).c;
    const successful = (
      await db
        .prepare(
          `SELECT COUNT(*) as c FROM transactions WHERE status='success'`,
        )
        .get()
    ).c;
    const abandoned = (
      await db
        .prepare(
          `SELECT COUNT(*) as c FROM transactions WHERE status='abandoned'`,
        )
        .get()
    ).c;
    res.json({
      ...base,
      grossRevenue,
      platformRevenue: grossRevenue * 0.1,
      pendingPayments: pending,
      successfulPayments: successful,
      abandonedTransactions: abandoned,
    });
  } catch (e) {
    console.error("[Stats]", e);
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/admin/charts", adminAuth, async (req, res) => {
  const topNominees = await db
    .prepare(
      `SELECT n.name, COALESCE(n.votes, 0) as votes, c.name as category
     FROM nominees n JOIN categories c ON n.category_id = c.id
     WHERE n.eliminated = 0
     ORDER BY COALESCE(n.votes, 0) DESC LIMIT 5`,
    )
    .all();
  const categoryDistribution = await db
    .prepare(
      `SELECT c.name, COALESCE(SUM(COALESCE(n.votes, 0)), 0) as votes
     FROM categories c LEFT JOIN nominees n ON n.category_id = c.id
     GROUP BY c.id ORDER BY c.created_at ASC`,
    )
    .all();
  const dailyRows = await db
    .prepare(
      `SELECT date(created_at) as day, COUNT(*) as votes FROM free_votes
     WHERE created_at >= datetime('now', '-7 days') GROUP BY day ORDER BY day ASC`,
    )
    .all();
  const days = [];
  const byDay = Object.fromEntries(dailyRows.map((r) => [r.day, r.votes]));
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    days.push({
      day: d.toLocaleDateString("en-US", { weekday: "short" }),
      votes: byDay[key] || 0,
    });
  }
  const allCategories = await db
    .prepare("SELECT id, name FROM categories ORDER BY created_at ASC")
    .all();
  const allNominees = await db
    .prepare(
      `SELECT n.id, n.name, n.code, n.img, n.category_id, COALESCE(n.votes, 0) as votes,
        n.eliminated, n.stage
     FROM nominees n ORDER BY n.category_id, COALESCE(n.votes, 0) DESC`,
    )
    .all();
  const perCategory = allCategories.map((cat) => {
    const list = allNominees.filter((n) => n.category_id === cat.id);
    const total = list.reduce((s, n) => s + (n.votes || 0), 0);
    return {
      id: cat.id,
      name: cat.name,
      totalVotes: total,
      nominees: list.map((n, i) => ({
        id: n.id,
        name: n.name,
        code: n.code,
        img: n.img,
        votes: n.votes,
        rank: i + 1,
        percent: total > 0 ? Math.round((n.votes / total) * 1000) / 10 : 0,
        eliminated: n.eliminated,
        stage: n.stage,
      })),
    };
  });
  const dailyCatRows = await db
    .prepare(
      `SELECT date(fv.created_at) as day, c.name as category, COUNT(*) as votes
     FROM free_votes fv JOIN nominees n ON fv.nominee_id = n.id
     JOIN categories c ON n.category_id = c.id
     WHERE fv.created_at >= datetime('now', '-7 days')
     GROUP BY day, category ORDER BY day ASC`,
    )
    .all();
  const categories = categoryDistribution.map((c) => c.name);
  const catByDay = {};
  for (const r of dailyCatRows) {
    if (!catByDay[r.day]) catByDay[r.day] = {};
    catByDay[r.day][r.category] = r.votes;
  }
  const dailyByCategory = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    const cats = catByDay[key] || {};
    const entry = { day: d.toLocaleDateString("en-US", { weekday: "short" }) };
    for (const catName of categories) entry[catName] = cats[catName] || 0;
    dailyByCategory.push(entry);
  }
  res.json({
    topNominees,
    categoryDistribution,
    dailyVotes: days,
    perCategory,
    dailyByCategory,
    categories,
  });
});

app.post("/api/admin/categories", adminAuth, async (req, res) => {
  const { name } = req.body || {};
  if (!name || !name.trim())
    return res.status(400).json({ error: "Name required" });
  try {
    const id = uuidv4();
    await db
      .prepare("INSERT INTO categories (id, name) VALUES (?,?)")
      .run(id, name.trim());
    broadcastAdminEvent({ type: "category:update" });
    res.json({ id, name: name.trim() });
  } catch (e) {
    console.warn("[Category create]", e.message);
    res.status(409).json({ error: "Category already exists" });
  }
});

app.patch("/api/admin/categories/:id", adminAuth, async (req, res) => {
  const { name } = req.body || {};
  if (!name || !name.trim())
    return res.status(400).json({ error: "Name required" });
  if (
    !(await db
      .prepare("SELECT id FROM categories WHERE id = ?")
      .get(req.params.id))
  )
    return res.status(404).json({ error: "Category not found" });
  try {
    await db
      .prepare("UPDATE categories SET name = ? WHERE id = ?")
      .run(name.trim(), req.params.id);
    broadcastAdminEvent({ type: "category:update" });
    res.json({ id: req.params.id, name: name.trim() });
  } catch (e) {
    console.warn("[Category patch]", e.message);
    res.status(409).json({ error: "Category name already exists" });
  }
});

app.delete("/api/admin/categories/:id", adminAuth, async (req, res) => {
  const c = (
    await db
      .prepare("SELECT COUNT(*) as c FROM nominees WHERE category_id = ?")
      .get(req.params.id)
  ).c;
  if (c > 0)
    return res
      .status(400)
      .json({ error: "Cannot delete — category has nominees" });
  await db.prepare("DELETE FROM categories WHERE id = ?").run(req.params.id);
  broadcastAdminEvent({ type: "category:update" });
  res.json({ success: true });
});

app.post("/api/admin/nominees", adminAuth, async (req, res) => {
  const { name, categoryId, img, desc, email, password } = req.body || {};
  if (!name || !categoryId)
    return res.status(400).json({ error: "Name and category required" });
  if (!email) return res.status(400).json({ error: "Email required" });
  const cleanEmail = String(email).trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail))
    return res.status(400).json({ error: "Invalid email address" });
  if (
    !(await db
      .prepare("SELECT id FROM categories WHERE id = ?")
      .get(categoryId))
  )
    return res.status(400).json({ error: "Invalid category" });
  if (
    await db
      .prepare("SELECT id FROM users WHERE LOWER(email) = ?")
      .get(cleanEmail)
  )
    return res.status(409).json({ error: "Email already registered" });
  const emailPrefix = cleanEmail.split("@")[0].replace(/[^a-z0-9._-]/g, "");
  const finalPassword =
    password && String(password).trim().length >= 6
      ? String(password).trim()
      : emailPrefix + "123";
  if (finalPassword.length < 6)
    return res
      .status(400)
      .json({ error: "Password must be at least 6 characters" });
  const hash = await bcrypt.hash(finalPassword, 10);
  const userId = uuidv4();
  await db
    .prepare(
      "INSERT INTO users (id, name, email, password_hash) VALUES (?,?,?,?)",
    )
    .run(userId, name, cleanEmail, hash);
  let code;
  do {
    code = generateCode(name);
  } while (
    await db.prepare("SELECT id FROM nominees WHERE code = ?").get(code)
  );
  const id = uuidv4();
  await db
    .prepare(
      "INSERT INTO nominees (id, user_id, name, category_id, code, img, desc) VALUES (?,?,?,?,?,?,?)",
    )
    .run(id, userId, name, categoryId, code, img || null, desc || null);
  broadcastAdminEvent({ type: "nominee:new", nomineeId: id, name });
  res.json({
    id,
    code,
    email: cleanEmail,
    credentials: { email: cleanEmail, password: finalPassword },
  });
});

app.delete("/api/admin/nominees/:id", adminAuth, async (req, res) => {
  await db
    .prepare("DELETE FROM free_votes WHERE nominee_id = ?")
    .run(req.params.id);
  await db
    .prepare("DELETE FROM nominee_boosts WHERE nominee_id = ?")
    .run(req.params.id);
  await db.prepare("DELETE FROM nominees WHERE id = ?").run(req.params.id);
  db.push().catch((e) =>
    console.warn("[Push after nominee delete]", e.message),
  );
  broadcastAdminEvent({ type: "nominee:delete", nomineeId: req.params.id });
  res.json({ success: true });
});

app.get("/api/admin/transactions", superAuth, async (req, res) => {
  res.json(
    await db
      .prepare(
        `SELECT t.*, n.name as nominee_name, n.code as nominee_code
     FROM transactions t LEFT JOIN nominees n ON t.nominee_id = n.id
     ORDER BY t.created_at DESC LIMIT 200`,
      )
      .all(),
  );
});

app.get("/api/admin/logs/:reference", superAuth, async (req, res) => {
  res.json(
    await db
      .prepare(
        "SELECT * FROM payment_logs WHERE reference = ? ORDER BY created_at ASC",
      )
      .all(req.params.reference),
  );
});

app.get("/api/admin/export/csv", adminAuth, async (req, res) => {
  try {
    const r = await loadReportData(req);
    const stages = await getStages();
    const lines = [];
    const add = (...a) => lines.push(a.join(""));
    const bar = "\u2550".repeat(60);
    add("VOTEUS \u2014 OFFICIAL RESULTS EXPORT");
    add(bar);
    add("");
    add(`Report ID,${r.reportId}`);
    add(`Generated,${formatDateTime(r.generatedAt)}`);
    add(`Generated By,${csvEscape(r.generatedBy)} (${r.generatedByRole})`);
    add(`Stage,${STAGE_LABELS[stages.current_stage] || stages.current_stage}`);
    add(`Event,Gala Awards 2026 - MKUPLC`);
    add(`Platform,Voteus.io`);
    add(`Signature,${r.signature}`);
    add("");
    add(bar);
    add("OVERVIEW");
    add(bar);
    add("");
    add("Metric,Value");
    add(`Total Votes,${r.totalVotes.toLocaleString()}`);
    add(`Categories,${r.categories.length}`);
    add(`Participants,${r.nominees.length}`);
    add(
      `Avg Votes per Participant,${(r.nominees.length > 0 ? r.totalVotes / r.nominees.length : 0).toFixed(2)}`,
    );
    add(`Unique Voters,${r.uniqueVoters.toLocaleString()}`);
    add(`Unique Devices,${r.uniqueDevices.toLocaleString()}`);
    add("");
    for (const cat of r.perCategory) {
      add(bar);
      add(`CATEGORY: ${csvEscape(cat.name)}`);
      add(`Total Votes: ${cat.totalVotes.toLocaleString()}`);
      add(bar);
      add("");
      if (!cat.nominees.length) {
        add("No participants in this category.");
        add("");
        continue;
      }
      add("Rank,Name,Code,Votes,Share %,Share Bar,Stage,Eliminated,Final Rank");
      for (const n of cat.nominees)
        add(
          [
            n.rank,
            csvEscape(n.name),
            csvEscape(n.code),
            n.votes,
            n.percent.toFixed(1) + "%",
            `"${shareBar(n.percent)}"`,
            n.stage || "",
            n.eliminated ? "yes" : "no",
            n.final_rank || "",
          ].join(","),
        );
      add("");
    }
    add(bar);
    add("SYSTEM SIGNATURE");
    add(bar);
    add("");
    add("This report was generated automatically by Voteus.io.");
    add(`Report ID: ${r.reportId}`);
    add(`Signature: ${r.signature}`);
    add(`Generated: ${formatDateTime(r.generatedAt)}`);
    add(`Verified: VALID`);
    add("");
    const filename = `votenet-report-${r.reportId}.csv`;
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.setHeader("X-Report-Id", r.reportId);
    res.setHeader("X-Report-Signature", r.signature);
    res.send(lines.join("\n"));
  } catch (e) {
    console.error("[Export CSV]", e);
    res.status(500).json({ error: "Export failed: " + e.message });
  }
});

app.get("/api/admin/export/pdf", adminAuth, async (req, res) => {
  try {
    const r = await loadReportData(req);
    const stages = await getStages();
    const verifyUrl =
      `https://gala.voteus.xyz/verify?` +
      `r=${encodeURIComponent(r.reportId)}&s=${r.signature}` +
      `&v=${r.totalVotes}&c=${r.categories.length}&n=${r.nominees.length}&t=${Date.parse(r.generatedAt)}`;
    let qrBuf = null;
    if (QRCode) {
      try {
        qrBuf = await QRCode.toBuffer(verifyUrl, {
          errorCorrectionLevel: "M",
          margin: 1,
          width: 240,
          color: { dark: "#1d1d1f", light: "#ffffff" },
        });
      } catch (e) {
        console.warn("[PDF] QR generation failed:", e.message);
      }
    }
    const filename = `votenet-report-${r.reportId}.pdf`;
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.setHeader("X-Report-Id", r.reportId);
    res.setHeader("X-Report-Signature", r.signature);

    const doc = new PDFDocument({ size: "A4", margin: 44 });
    doc.pipe(res);

    const INDIGO = "#3F51B5",
      INDIGO_LT = "#E8EAF6",
      GREEN = "#16A34A";
    const GRAY = "#6b7280",
      DARK = "#1d1d1f",
      BORDER = "#e5e7eb";
    const PAGE_W = 507,
      LEFT = 44,
      RIGHT = 551,
      BOTTOM = 780;

    const footer = () => {
      const y = doc.page.height - 26;
      doc
        .fontSize(6.5)
        .fillColor(GRAY)
        .text(
          `Voteus.io  ·  Report ${r.reportId}  ·  Sig ${r.signature.slice(0, 14)}…`,
          LEFT,
          y,
          { width: PAGE_W, align: "left", lineBreak: false },
        );
    };
    const ensureSpace = (needed) => {
      if (doc.y + needed > BOTTOM - 20) {
        footer();
        doc.addPage();
        return true;
      }
      return false;
    };
    const drawColHeaders = () => {
      const hy = doc.y;
      doc.fillColor(GRAY).fontSize(7).font("Helvetica-Bold");
      doc.text("RANK", LEFT + 4, hy, { width: 36 });
      doc.text("PARTICIPANT", LEFT + 44, hy, { width: 170 });
      doc.text("CODE", LEFT + 218, hy, { width: 100 });
      doc.text("VOTES", LEFT + 320, hy, { width: 60, align: "right" });
      doc.text("SHARE", LEFT + 384, hy, { width: 55, align: "right" });
      doc.text("STAGE", LEFT + 445, hy, { width: 62 });
      doc.y = hy + 10;
      doc
        .strokeColor(BORDER)
        .lineWidth(0.5)
        .moveTo(LEFT, doc.y)
        .lineTo(RIGHT, doc.y)
        .stroke();
      doc.y += 3;
    };

    doc.rect(0, 0, doc.page.width, 6).fill(INDIGO);
    doc.moveDown(1.2);
    doc
      .fillColor(INDIGO)
      .fontSize(10)
      .font("Helvetica-Bold")
      .text("VOTEUS.IO", { align: "center", characterSpacing: 5 });
    doc.moveDown(0.2);
    doc
      .fillColor(GRAY)
      .fontSize(8)
      .font("Helvetica")
      .text("Official Event Voting Platform", { align: "center" });
    doc.moveDown(1);
    doc
      .fillColor(DARK)
      .fontSize(26)
      .font("Helvetica-Bold")
      .text("Official Results Report", { align: "center", lineGap: -2 });
    doc.moveDown(0.2);
    doc
      .fillColor(INDIGO)
      .fontSize(12)
      .font("Helvetica")
      .text(
        `Gala Awards 2026  ·  MKUPLC  ·  ${STAGE_LABELS[stages.current_stage] || stages.current_stage}`,
        { align: "center" },
      );

    doc.moveDown(1);
    const metaBoxY = doc.y,
      metaBoxH = 108;
    doc
      .roundedRect(LEFT + 50, metaBoxY, PAGE_W - 100, metaBoxH, 10)
      .lineWidth(1)
      .strokeColor(BORDER)
      .stroke();
    doc
      .fillColor(INDIGO_LT)
      .roundedRect(LEFT + 50, metaBoxY, PAGE_W - 100, 24, 10)
      .fill();
    doc
      .fillColor(INDIGO)
      .fontSize(8)
      .font("Helvetica-Bold")
      .text("REPORT METADATA", LEFT + 50, metaBoxY + 8, {
        width: PAGE_W - 100,
        align: "center",
        characterSpacing: 2,
      });
    const meta = [
      ["Report ID", r.reportId],
      ["Generated", formatDateTime(r.generatedAt)],
      ["Prepared By", `${r.generatedBy} (${r.generatedByRole})`],
      ["Signature", r.signature],
    ];
    let my = metaBoxY + 32;
    for (const [k, v] of meta) {
      doc
        .fillColor(GRAY)
        .fontSize(7)
        .font("Helvetica")
        .text(k.toUpperCase(), LEFT + 66, my, {
          width: 78,
          characterSpacing: 0.5,
        });
      doc
        .fillColor(DARK)
        .fontSize(9)
        .font("Helvetica-Bold")
        .text(String(v), LEFT + 158, my, {
          width: PAGE_W - 218,
          ellipsis: true,
        });
      my += 18;
    }
    doc.y = metaBoxY + metaBoxH + 14;

    doc
      .fillColor(INDIGO)
      .fontSize(14)
      .font("Helvetica-Bold")
      .text("Executive Summary");
    doc.moveDown(0.2);
    doc
      .strokeColor(INDIGO)
      .lineWidth(2)
      .moveTo(LEFT, doc.y)
      .lineTo(LEFT + 50, doc.y)
      .stroke();
    doc.moveDown(0.7);

    const summaryItems = [
      ["Total Votes", r.totalVotes.toLocaleString()],
      ["Categories", String(r.categories.length)],
      ["Participants", String(r.nominees.length)],
      [
        "Avg Votes / Participant",
        r.nominees.length > 0
          ? (r.totalVotes / r.nominees.length).toFixed(1)
          : "0",
      ],
      ["Unique Voters", r.uniqueVoters.toLocaleString()],
      ["Unique Devices", r.uniqueDevices.toLocaleString()],
    ];
    const cardW = (PAGE_W - 12) / 2,
      cardH = 52;
    const gridStartY = doc.y;
    for (let i = 0; i < summaryItems.length; i++) {
      const [label, value] = summaryItems[i];
      const col = i % 2,
        row = Math.floor(i / 2);
      const x = LEFT + col * (cardW + 12);
      const y = gridStartY + row * (cardH + 8);
      doc
        .roundedRect(x, y, cardW, cardH, 8)
        .lineWidth(1)
        .strokeColor(BORDER)
        .stroke();
      doc
        .fillColor(GRAY)
        .fontSize(7)
        .font("Helvetica")
        .text(label.toUpperCase(), x + 12, y + 9, {
          width: cardW - 24,
          characterSpacing: 0.5,
        });
      doc
        .fillColor(DARK)
        .fontSize(17)
        .font("Helvetica-Bold")
        .text(String(value), x + 12, y + 22, { width: cardW - 24 });
    }
    doc.y = gridStartY + Math.ceil(summaryItems.length / 2) * (cardH + 8) + 14;
    footer();

    doc.addPage();
    doc
      .fillColor(INDIGO)
      .fontSize(14)
      .font("Helvetica-Bold")
      .text("Results by Category");
    doc.moveDown(0.2);
    doc
      .strokeColor(INDIGO)
      .lineWidth(2)
      .moveTo(LEFT, doc.y)
      .lineTo(LEFT + 50, doc.y)
      .stroke();
    doc.moveDown(0.7);

    if (!r.perCategory.length) {
      doc
        .fillColor(GRAY)
        .fontSize(10)
        .font("Helvetica-Oblique")
        .text("No categories have been created yet.", LEFT + 6, doc.y);
      doc.moveDown(1);
    }

    for (const cat of r.perCategory) {
      ensureSpace(110);
      const headY = doc.y;
      doc.roundedRect(LEFT, headY, PAGE_W, 28, 5).fill(INDIGO_LT);
      doc
        .fillColor(INDIGO)
        .fontSize(12)
        .font("Helvetica-Bold")
        .text(cat.name, LEFT + 10, headY + 8, { width: PAGE_W - 130 });
      doc
        .fillColor(INDIGO)
        .fontSize(8)
        .font("Helvetica")
        .text(`${cat.totalVotes.toLocaleString()} votes`, LEFT, headY + 10, {
          width: PAGE_W - 10,
          align: "right",
        });
      doc.y = headY + 36;
      if (!cat.nominees.length) {
        doc
          .fillColor(GRAY)
          .fontSize(9)
          .font("Helvetica-Oblique")
          .text("No participants in this category.", LEFT + 6, doc.y);
        doc.moveDown(0.7);
        continue;
      }
      drawColHeaders();
      for (const n of cat.nominees) {
        if (ensureSpace(24)) drawColHeaders();
        const yy = doc.y;
        const rankColor =
          n.rank === 1
            ? "#FEF3C7"
            : n.rank === 2
              ? "#E5E7EB"
              : n.rank === 3
                ? "#FED7AA"
                : "#F3F4F6";
        const rankText =
          n.rank === 1
            ? "#92400E"
            : n.rank === 2
              ? "#374151"
              : n.rank === 3
                ? "#9A3412"
                : "#9CA3AF";
        doc.circle(LEFT + 11, yy + 5, 8).fill(rankColor);
        doc
          .fillColor(rankText)
          .fontSize(7)
          .font("Helvetica-Bold")
          .text(String(n.rank), LEFT + 3, yy + 2, {
            width: 16,
            align: "center",
          });
        doc
          .fillColor(n.eliminated ? "#9CA3AF" : DARK)
          .fontSize(9)
          .font("Helvetica-Bold")
          .text(n.name, LEFT + 44, yy, { width: 170, ellipsis: true });
        doc
          .fillColor(GRAY)
          .fontSize(7)
          .font("Helvetica")
          .text(n.code, LEFT + 218, yy + 1, { width: 100 });
        doc
          .fillColor(DARK)
          .fontSize(9)
          .font("Helvetica-Bold")
          .text(n.votes.toLocaleString(), LEFT + 320, yy, {
            width: 60,
            align: "right",
          });
        doc
          .fillColor(INDIGO)
          .fontSize(9)
          .font("Helvetica-Bold")
          .text(n.percent.toFixed(1) + "%", LEFT + 384, yy, {
            width: 55,
            align: "right",
          });
        // Stage column
        const stageLabel = n.eliminated
          ? "Elim."
          : n.stage === "winner"
            ? "Winner"
            : STAGE_LABELS[n.stage] || "—";
        doc
          .fillColor(
            n.eliminated ? "#DC2626" : n.stage === "winner" ? "#16A34A" : GRAY,
          )
          .fontSize(7)
          .font("Helvetica-Bold")
          .text(stageLabel, LEFT + 445, yy + 1, { width: 62 });
        doc.y = yy + 18;
      }
      doc.moveDown(0.3);
      doc
        .strokeColor(BORDER)
        .lineWidth(0.5)
        .moveTo(LEFT, doc.y)
        .lineTo(RIGHT, doc.y)
        .stroke();
      doc.moveDown(0.8);
    }
    footer();

    doc.addPage();
    doc
      .fillColor(INDIGO)
      .fontSize(18)
      .font("Helvetica-Bold")
      .text("Verification & Signature", { align: "center" });
    doc.moveDown(0.3);
    doc
      .fillColor(GRAY)
      .fontSize(9)
      .font("Helvetica")
      .text("Scan the QR code to verify this report online.", {
        align: "center",
      });
    doc.moveDown(1);

    if (qrBuf) {
      const qrSize = 190;
      const qrX = (doc.page.width - qrSize) / 2;
      const qrY = doc.y;
      doc
        .roundedRect(qrX - 10, qrY - 10, qrSize + 20, qrSize + 20, 10)
        .lineWidth(2)
        .strokeColor(INDIGO)
        .stroke();
      doc.image(qrBuf, qrX, qrY, { width: qrSize, height: qrSize });
      doc.y = qrY + qrSize + 20;
      doc
        .fillColor(INDIGO)
        .fontSize(9)
        .font("Helvetica-Bold")
        .text("Scan to verify", { align: "center" });
      doc.moveDown(1);
    } else {
      doc
        .fillColor(GRAY)
        .fontSize(10)
        .font("Helvetica")
        .text("QR code unavailable — use the verification block below.", {
          align: "center",
        });
      doc.moveDown(1);
    }

    const sigBoxY = doc.y,
      sigBoxH = 190;
    doc
      .roundedRect(LEFT + 20, sigBoxY, PAGE_W - 40, sigBoxH, 10)
      .lineWidth(1.5)
      .strokeColor(INDIGO)
      .stroke();
    doc
      .fillColor(INDIGO_LT)
      .roundedRect(LEFT + 20, sigBoxY, PAGE_W - 40, 26, 10)
      .fill();
    doc
      .fillColor(INDIGO)
      .fontSize(8)
      .font("Helvetica-Bold")
      .text("VERIFICATION BLOCK", LEFT + 20, sigBoxY + 9, {
        width: PAGE_W - 40,
        align: "center",
        characterSpacing: 2,
      });
    let sy = sigBoxY + 38;
    const sigItems = [
      ["Report ID", r.reportId],
      ["Signature", r.signature],
      ["Generated", formatDateTime(r.generatedAt)],
      ["Prepared By", `${r.generatedBy} (${r.generatedByRole})`],
      ["Status", "\u2713 VERIFIED AUTHENTIC"],
    ];
    for (const [k, v] of sigItems) {
      doc
        .fillColor(GRAY)
        .fontSize(7)
        .font("Helvetica")
        .text(k.toUpperCase(), LEFT + 40, sy, {
          width: 100,
          characterSpacing: 0.5,
        });
      doc
        .fillColor(k === "Status" ? GREEN : DARK)
        .fontSize(9)
        .font("Helvetica-Bold")
        .text(String(v), LEFT + 145, sy, {
          width: PAGE_W - 170,
          ellipsis: true,
        });
      sy += 28;
    }
    doc.y = sigBoxY + sigBoxH + 14;
    doc
      .fillColor(GRAY)
      .fontSize(8)
      .font("Helvetica")
      .text(
        "The signature above is a SHA-256 hash of the report totals combined with a server secret. Any modification to the totals would invalidate the signature. Scan the QR code to verify online.",
        LEFT,
        doc.y,
        { width: PAGE_W, align: "center", lineGap: 2 },
      );
    doc.moveDown(0.8);
    doc
      .fillColor(INDIGO)
      .fontSize(7)
      .font("Helvetica")
      .text(verifyUrl, LEFT, doc.y, {
        width: PAGE_W,
        align: "center",
        ellipsis: true,
      });
    doc.moveDown(1.2);
    doc
      .fillColor(GRAY)
      .fontSize(9)
      .font("Helvetica")
      .text("Signed by", { align: "center" });
    doc.moveDown(0.2);
    doc
      .fillColor(DARK)
      .fontSize(11)
      .font("Helvetica-Bold")
      .text("Voteus.io Automated Reporting System", { align: "center" });
    doc.moveDown(0.2);
    doc
      .fillColor(GRAY)
      .fontSize(8)
      .font("Helvetica")
      .text(formatDateTime(r.generatedAt), { align: "center" });
    footer();
    doc.end();
  } catch (e) {
    console.error("[Export PDF]", e);
    if (!res.headersSent)
      res.status(500).json({ error: "Export failed: " + e.message });
  }
});

app.get("/manifest.json", (req, res) => {
  res.type("application/manifest+json");
  res.sendFile(path.join(__dirname, "manifest.json"));
});

app.get("/robots.txt", (req, res) => {
  res.type("text/plain");
  res.send(`# Voteus - Gala Awards 2026
User-agent: *
Allow: /
Disallow: /nominee
Disallow: /admin
Disallow: /api/

Sitemap: https://gala.voteus.xyz/sitemap.xml
Host: https://gala.voteus.xyz
`);
});

app.get("/sitemap.xml", async (req, res) => {
  try {
    const nominees = await db
      .prepare(
        `SELECT n.code, n.name, n.img, n.created_at, c.name as category
       FROM nominees n JOIN categories c ON n.category_id = c.id
       ORDER BY COALESCE(n.votes, 0) DESC`,
      )
      .all();
    const baseUrl = "https://gala.voteus.xyz";
    const now = new Date().toISOString().split("T")[0];
    const absImg = (p) => {
      if (!p) return `${baseUrl}/hero-mobile.jpeg`;
      if (p.startsWith("http://") || p.startsWith("https://")) return p;
      return baseUrl + (p.startsWith("/") ? p : "/" + p);
    };
    let xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"
        xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">
  <url>
    <loc>${baseUrl}/</loc>
    <lastmod>${now}</lastmod>
    <changefreq>daily</changefreq>
    <priority>1.0</priority>
    <image:image>
      <image:loc>${baseUrl}/hero-mobile.jpeg</image:loc>
      <image:title>Gala Awards 2026 - Voteus</image:title>
    </image:image>
  </url>`;
    for (const n of nominees) {
      const nomineeUrl = `${baseUrl}/nominee/${encodeURIComponent(n.code)}`;
      const lastmod = n.created_at ? String(n.created_at).split("T")[0] : now;
      xml += `
  <url>
    <loc>${nomineeUrl}</loc>
    <lastmod>${lastmod}</lastmod>
    <changefreq>daily</changefreq>
    <priority>0.8</priority>
    <image:image>
      <image:loc>${absImg(n.img)}</image:loc>
      <image:title>${n.name} - ${n.category}</image:title>
    </image:image>
  </url>`;
    }
    xml += `\n</urlset>`;
    res.type("application/xml").send(xml);
  } catch (e) {
    console.error("[Sitemap]", e.message);
    res
      .status(500)
      .type("application/xml")
      .send(
        `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://gala.voteus.xyz/</loc></url></urlset>`,
      );
  }
});

app.get("/nominee/:code", async (req, res) => {
  try {
    const nominee = await db
      .prepare(
        `SELECT n.*, c.name as category FROM nominees n
       JOIN categories c ON n.category_id = c.id WHERE n.code = ?`,
      )
      .get(req.params.code);
    if (!nominee) return res.redirect("/");
    const baseUrl = "https://gala.voteus.xyz";
    const shareUrl = `${baseUrl}/?c=${encodeURIComponent(nominee.code)}`;
    const imgPath = nominee.img || "";
    const image = imgPath
      ? imgPath.startsWith("http")
        ? imgPath
        : baseUrl + (imgPath.startsWith("/") ? imgPath : "/" + imgPath)
      : `${baseUrl}/hero-mobile.jpeg`;
    const title = `${nominee.name} | Voteus — Gala Awards 2026`;
    const description = `Vote for ${nominee.name} in ${nominee.category} at the Gala Awards 2026. ${(nominee.votes || 0).toLocaleString()} votes so far!`;
    const html = `<!doctype html>
<html lang="en" itemscope itemtype="https://schema.org/Person">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta name="theme-color" content="#0071e3" />
  <title>${title}</title>
  <meta name="description" content="${description}" />
  <meta name="robots" content="index, follow, max-image-preview:large" />
  <link rel="canonical" href="${shareUrl}" />
  <meta property="og:type" content="profile" />
  <meta property="og:url" content="${shareUrl}" />
  <meta property="og:title" content="${title}" />
  <meta property="og:description" content="${description}" />
  <meta property="og:image" content="${image}" />
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="${title}" />
  <meta name="twitter:description" content="${description}" />
  <meta name="twitter:image" content="${image}" />
  <meta http-equiv="refresh" content="0; url=${shareUrl}" />
</head>
<body><p>Redirecting to <a href="${shareUrl}">Voteus</a>...</p>
<script>window.location.href="${shareUrl}";</script></body></html>`;
    res.send(html);
  } catch (e) {
    console.error("[Nominee Meta]", e.message);
    res.redirect("/");
  }
});

const HERO_WIDE = path.join(__dirname, "hero.jpeg");
const HERO_MOBILE = path.join(__dirname, "hero-mobile.jpeg");
function serveHeroImage(res, filePath, label) {
  if (!fs.existsSync(filePath)) {
    console.error(`[Image] ${label} not found at ${filePath}`);
    res.setHeader("Cache-Control", "no-store");
    return res.status(404).type("text/plain").send(`${label} missing`);
  }
  res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
  res.setHeader("Content-Type", "image/jpeg");
  res.sendFile(filePath);
}
app.get("/hero.jpeg", (req, res) =>
  serveHeroImage(res, HERO_WIDE, "hero.jpeg"),
);
app.get("/hero-mobile.jpeg", (req, res) =>
  serveHeroImage(res, HERO_MOBILE, "hero-mobile.jpeg"),
);

function sendHTMLNoCache(file) {
  return (req, res) => {
    res.setHeader("Cache-Control", "no-store, must-revalidate");
    res.setHeader("Pragma", "no-cache");
    res.sendFile(path.join(__dirname, file));
  };
}
app.get("/", sendHTMLNoCache("index.html"));
app.get("/nominee", sendHTMLNoCache("nominee.html"));
app.get("/admin", sendHTMLNoCache("admin.html"));
app.get("/report", sendHTMLNoCache("report.html"));
app.get("/admin/reports", sendHTMLNoCache("admin-reports.html"));

setInterval(async () => {
  try {
    const cutoff = new Date(
      Date.now() - STALE_TX_MINUTES * 60_000,
    ).toISOString();
    const r = await db
      .prepare(
        `UPDATE transactions SET status = 'abandoned' WHERE status = 'pending' AND created_at < ?`,
      )
      .run(cutoff);
    if (r.changes > 0)
      console.log(`[Cleanup] ${r.changes} stale transactions abandoned`);
  } catch (e) {
    console.error("[Cleanup]", e.message);
  }
}, 5 * 60_000);

setInterval(
  async () => {
    try {
      const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60_000).toISOString();
      await db
        .prepare("DELETE FROM payment_logs WHERE created_at < ?")
        .run(cutoff);
    } catch (e) {
      console.error("[Prune]", e.message);
    }
  },
  24 * 60 * 60_000,
);

setInterval(async () => {
  try {
    const cutoff = new Date(Date.now() - IMG_ORPHAN_GRACE_MS).toISOString();
    const r = await db
      .prepare(
        `DELETE FROM images WHERE created_at < ?
       AND id NOT IN (SELECT REPLACE(img, '/api/images/', '') FROM nominees WHERE img LIKE '/api/images/%')`,
      )
      .run(cutoff);
    if (r.changes > 0)
      console.log(`[Images] Pruned ${r.changes} orphaned image(s)`);
  } catch (e) {
    console.error("[Images prune]", e.message);
  }
}, 60 * 60_000);

setInterval(async () => {
  try {
    const cutoff = new Date(Date.now() - RECONCILE_MIN_AGE_MS).toISOString();
    const pending = await db
      .prepare(
        `SELECT reference FROM transactions WHERE status = 'pending' AND created_at < ?
       ORDER BY created_at ASC LIMIT 10`,
      )
      .all(cutoff);
    if (!pending.length) return;
    for (const tx of pending) {
      try {
        const payload = await checkPayHeroStatus(tx.reference);
        const result = interpretPayHeroStatus(payload);
        if (result && result.status === "success") {
          await completeTransaction(tx.reference, result.receipt);
          console.log(`[Reconcile] ${tx.reference} → success`);
        } else if (result && result.status === "failed") {
          await failTransaction(tx.reference, "reconciliation_failed");
          console.log(`[Reconcile] ${tx.reference} → failed`);
        }
      } catch (e) {
        console.warn(`[Reconcile] ${tx.reference}:`, e.message);
      }
      await new Promise((r) => setTimeout(r, 500));
    }
  } catch (e) {
    console.error("[Reconcile]", e.message);
  }
}, RECONCILE_INTERVAL_MS);

setInterval(async () => {
  try {
    if (typeof db.reconcileVotes === "function") {
      const fixed = await db.reconcileVotes();
      if (fixed > 0) {
        console.log(`[Votes Reconcile] Corrected ${fixed} nominee(s)`);
        db.push().catch((e) =>
          console.warn("[Push after votes reconcile]", e.message),
        );
      }
    }
  } catch (e) {
    console.warn("[Votes Reconcile]", e.message);
  }
}, VOTES_RECONCILE_INTERVAL_MS);

app.use((err, req, res, next) => {
  console.error(`[Error] ${req.method} ${req.url}:`, err.message);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: "Internal server error" });
});

process.on("unhandledRejection", (reason) => {
  console.error("[Unhandled Rejection]", (reason && reason.message) || reason);
});
process.on("uncaughtException", (err) => {
  console.error("[Uncaught Exception]", err.message);
});

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[${signal}] Shutting down gracefully…`);
  server.close(async () => {
    try {
      await db.push();
      console.log("  ✓ Final push to cloud");
    } catch (e) {
      console.warn("  ⚠ Final push failed:", e.message);
    }
    try {
      await db.checkpoint();
    } catch (e) {
      console.warn("[Checkpoint on shutdown]", e.message);
    }
    console.log("✓ Closed cleanly");
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 15_000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

const server = app.listen(PORT, async () => {
  console.log(`\n✓ Voteus on http://localhost:${PORT}`);
  try {
    await db.verifyConnection();
    await db.ensureRemoteSchema();
    await initSchema();
    console.log("  ✓ Local schema ready");
    await db.bootstrapIfEmpty();
    if (typeof db.reconcileVotes === "function") {
      const fixed = await db.reconcileVotes();
      if (fixed > 0) {
        console.log(`  ✓ Reconciled ${fixed} nominee(s) on startup`);
      }
    }
  } catch (e) {
    console.error("\n⚠ Startup failed:", e.message);
    console.error("  Server is up but DB operations will fail.\n");
  }

  let syncBusy = false;
  setInterval(async () => {
    if (syncBusy) return;
    syncBusy = true;
    try {
      const { pushed } = await db.push();
      if (pushed > 0)
        console.log(`[Sync Push] ${pushed} write(s) sent to cloud`);
    } catch (e) {
      console.warn("[Sync Push]", e.message);
    } finally {
      syncBusy = false;
    }
  }, SYNC_PUSH_INTERVAL_MS);

  setInterval(async () => {
    try {
      await db.pull();
      if (typeof db.reconcileVotes === "function") {
        await db.reconcileVotes();
      }
    } catch (e) {
      console.warn("[Sync Pull]", e.message);
    }
  }, SYNC_PULL_INTERVAL_MS);

  setInterval(async () => {
    try {
      const size = await db.walSize();
      if (size > CHECKPOINT_WAL_THRESHOLD) {
        await db.checkpoint();
        console.log(
          `[Checkpoint] WAL compacted (was ${Math.round(size / 1024)} KB)`,
        );
      }
    } catch (e) {
      console.warn("[Checkpoint]", e.message);
    }
  }, WAL_CHECKPOINT_INTERVAL_MS);

  console.log(
    `  Sync:        local primary, cloud backup every ${SYNC_PUSH_INTERVAL_MS / 1000}s`,
  );
  console.log(
    `  Reconcile:   pending txns every ${RECONCILE_INTERVAL_MS / 1000}s`,
  );
  console.log(
    `  Votes:       reconciled every ${VOTES_RECONCILE_INTERVAL_MS / 1000}s`,
  );
  console.log(`  Images:      SQLite BLOB · /api/images/:id`);
  console.log(`  PayHero:     ${PAYHERO_API_KEY ? "LIVE" : "SIMULATION"}`);
  console.log(`  Voting:      FREE · one per device per category`);
  console.log(
    `  Stages:      preliminaries → semi_finals (top 5) → finals (top 2) → completed`,
  );
  console.log(
    `  Live SSE:    /api/nominee/stream · /api/live/votes · /api/live/admin`,
  );
  console.log(`  Exports:     /api/admin/export/{csv,pdf} · no financial data`);
  console.log(`  QR verify:   /verify · ${QRCode ? "enabled" : "text-only"}`);
  console.log(`  Super Admin: ${SUPER_ADMIN_USERNAME}`);
  console.log(
    `  Hero wide:   ${fs.existsSync(HERO_WIDE) ? "✓" : "✗ MISSING"} ${HERO_WIDE}`,
  );
  console.log(
    `  Hero mobile: ${fs.existsSync(HERO_MOBILE) ? "✓" : "✗ MISSING"} ${HERO_MOBILE}\n`,
  );
});
