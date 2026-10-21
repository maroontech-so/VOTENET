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
const BOOST_VOTES = 50;
const STALE_TX_MINUTES = 15;

const SYNC_PUSH_INTERVAL_MS = 30_000;
const SYNC_PULL_INTERVAL_MS = 60_000;
const WAL_CHECKPOINT_INTERVAL_MS = 60_000;
const CHECKPOINT_WAL_THRESHOLD = 5 * 1024 * 1024;
const RECONCILE_INTERVAL_MS = 60_000;
const RECONCILE_MIN_AGE_MS = 30_000;

const IMG_MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const IMG_TARGET_DIMENSION = 700;
const IMG_JPEG_QUALITY = 82;
const IMG_ORPHAN_GRACE_MS = 60 * 60 * 1000;

const REPORT_SECRET =
  process.env.REPORT_SECRET || JWT_SECRET || "voteus-report-secret";

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
      `[Body Missing] ${req.method} ${req.url} from ${req.ip} ` +
        `content-type="${req.headers["content-type"] || "none"}"`,
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
  `);

  for (const col of ["device_hash TEXT", "ip TEXT", "category_id TEXT"]) {
    try {
      await db.exec(`ALTER TABLE free_votes ADD COLUMN ${col}`);
    } catch {}
  }

  try {
    await db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_fv_device_cat
      ON free_votes(device_hash, category_id)
      WHERE device_hash IS NOT NULL
    `);
  } catch (e) {
    console.warn("[Schema] idx_fv_device_cat:", e.message);
  }

  try {
    await db.exec(`
      UPDATE free_votes
      SET category_id = (
        SELECT category_id FROM nominees WHERE id = free_votes.nominee_id
      )
      WHERE category_id IS NULL
    `);
  } catch (e) {
    console.warn("[Schema] category_id backfill:", e.message);
  }

  try {
    const r = await db.exec("UPDATE nominees SET votes = 0 WHERE votes IS NULL");
    if (r && r.changes)
      console.log(`[Schema] Normalized ${r.changes} NULL votes row(s)`);
  } catch (e) {
    console.warn("[Schema] votes backfill:", e.message);
  }

  try {
    await db.exec(`
      CREATE TABLE IF NOT EXISTS nominee_boosts (
        id TEXT PRIMARY KEY,
        nominee_id TEXT UNIQUE NOT NULL,
        reference TEXT NOT NULL,
        votes_added INTEGER NOT NULL,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await db.exec(
      `CREATE INDEX IF NOT EXISTS idx_boosts_nominee ON nominee_boosts(nominee_id)`,
    );
  } catch (e) {
    console.warn("[Schema] nominee_boosts:", e.message);
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
function votingOpen() {
  return new Date() < new Date(VOTE_DEADLINE);
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

// ============================================================
// LIVE SSE
// ============================================================
const nomineeVoteClients = new Map();
const publicVoteClients = new Set();
const adminStreamClients = new Set();

function writeSSE(res, payload) {
  try {
    res.write(payload);
  } catch {}
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
  const payload = `event: payment\ndata: ${JSON.stringify({
    type: txType,
    reference,
    status: "success",
    ...extra,
  })}\n\n`;
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

// ============================================================
// REPORT HELPERS
// ============================================================
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
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
    ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    })[c],
  );
}

// ✅ Report data — NO financial fields. Only voting data + signature.
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
      `SELECT id, name, code, category_id, COALESCE(votes, 0) as votes
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

// ============================================================
// PAYMENT ENGINE
// ============================================================
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
        sql: `UPDATE transactions
              SET status='success', mpesa_receipt=?, completed_at=CURRENT_TIMESTAMP
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
      } catch {}

      let extra = {};

      if (txRow.type === "category_change") {
        const newCat = meta.newCategoryId;
        if (!newCat) throw new Error("Missing newCategoryId");
        const target = await t.get(
          "SELECT id FROM categories WHERE id = ?",
          [newCat],
        );
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
          sql: `INSERT INTO nominee_boosts
                (id, nominee_id, reference, votes_added) VALUES (?, ?, ?, ?)`,
          args: [uuidv4(), txRow.nominee_id, reference, BOOST_VOTES],
        });
        await t.execute({
          sql: "UPDATE nominees SET votes = COALESCE(votes, 0) + ? WHERE id = ?",
          args: [BOOST_VOTES, txRow.nominee_id],
        });
        extra.votes = BOOST_VOTES;
      } else if (txRow.type === "vote") {
        await t.execute({
          sql: "UPDATE nominees SET votes = COALESCE(votes, 0) + ? WHERE id = ?",
          args: [meta.voteCount || 0, txRow.nominee_id],
        });
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
    } catch {}
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

// ============================================================
// UPLOAD / IMAGES
// ============================================================
app.post(
  "/api/upload",
  anyAuth,
  rateLimit({ key: "upload", max: 20 }),
  (req, res) => {
    upload.single("image")(req, res, async (err) => {
      if (err) return res.status(400).json({ error: err.message });
      if (!req.file) return res.status(400).json({ error: "No file uploaded" });
      try {
        const processed = await processImage(req.file.buffer);
        const id = uuidv4();
        await db
          .prepare(
            "INSERT INTO images (id, data, mime, size) VALUES (?, ?, ?, ?)",
          )
          .run(id, processed.data, processed.mime, processed.data.length);
        db.push().catch((e) => console.warn("[Push after upload]", e.message));
        res.json({ url: `/api/images/${id}`, bytes: processed.data.length });
      } catch (e) {
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
      if (remoteRow) row = { data: remoteRow.data, mime: remoteRow.mime };
      else {
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
    res.setHeader("Cache-Control", "no-store");
    res.status(500).end();
  }
});

// ============================================================
// HEALTH / CONFIG / PUBLIC DATA
// ============================================================
app.get("/api/health", async (req, res) => {
  let dbOk = true;
  try {
    await db.prepare("SELECT 1").get();
  } catch {
    dbOk = false;
  }
  res.json({
    ok: dbOk,
    uptime: Math.floor(process.uptime()),
    memory: Math.round(process.memoryUsage().rss / 1024 / 1024) + " MB",
    db: dbOk ? "ok" : "error",
    payhero: PAYHERO_API_KEY ? "live" : "simulation",
    sse: {
      nominees: nomineeVoteClients.size,
      public: publicVoteClients.size,
      admins: adminStreamClients.size,
    },
  });
});

app.get("/api/config", (req, res) => {
  res.json({
    deadline: VOTE_DEADLINE,
    votingOpen: votingOpen(),
    freeVoting: true,
    votesPerCategory: 1,
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

  const bg = valid
    ? "from-emerald-50 to-green-100"
    : "from-red-50 to-rose-100";
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
          `SELECT fv.nominee_id, n2.category_id, n2.name, n2.code
           FROM free_votes fv
           JOIN nominees n2 ON fv.nominee_id = n2.id
           WHERE ${conditions.join(" OR ")}`,
        )
        .all(...params);

      const votedByNominee = new Set();
      const votedByCategory = {};
      for (const v of voterVotes) {
        votedByNominee.add(v.nominee_id);
        if (!votedByCategory[v.category_id])
          votedByCategory[v.category_id] = {
            nomineeId: v.nominee_id,
            name: v.name,
            code: v.code,
          };
      }
      for (const r of rows) {
        r.voted = votedByNominee.has(r.id);
        r.categoryVoted = Object.prototype.hasOwnProperty.call(
          votedByCategory,
          r.category_id,
        );
        r.categoryVoteFor = votedByCategory[r.category_id] || null;
      }
    } catch (e) {
      console.warn("[Nominees vote-status]", e.message);
      for (const r of rows) {
        r.voted = false;
        r.categoryVoted = false;
        r.categoryVoteFor = null;
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

// ============================================================
// AUTH
// ============================================================
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
      if (existing && existing.id)
        return res.status(409).json({
          error:
            "An account with this email already exists. Try signing in instead.",
          code: "EMAIL_EXISTS",
        });

      const hash = await bcrypt.hash(cleanPassword, 10);
      const id = uuidv4();
      try {
        await db
          .prepare(
            "INSERT INTO users (id, name, email, password_hash) VALUES (?,?,?,?)",
          )
          .run(id, cleanName, cleanEmail, hash);
      } catch (insErr) {
        if (String(insErr.message || "").toLowerCase().includes("unique"))
          return res.status(409).json({
            error:
              "An account with this email already exists. Try signing in instead.",
            code: "EMAIL_EXISTS",
          });
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
      `SELECT id, username, display_name, role, created_by, created_at,
              revoked, revoked_at, revoked_by
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

// ============================================================
// LEADERBOARD ACCESS
// ============================================================
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
              COALESCE(n.votes, 0) AS votes, n.created_at,
              c.name as category
       FROM nominees n
       JOIN categories c ON n.category_id = c.id
       WHERE n.user_id = ?`,
    )
    .get(req.user.id);
  if (!nominee) return res.status(404).json({ error: "Not a nominee yet" });

  const boostRow = await db
    .prepare(
      "SELECT votes_added, created_at FROM nominee_boosts WHERE nominee_id = ?",
    )
    .get(nominee.id);

  const rows = await db
    .prepare(
      `SELECT id, COALESCE(votes, 0) AS votes FROM nominees
       WHERE category_id = ? ORDER BY COALESCE(votes, 0) DESC`,
    )
    .all(nominee.category_id);
  const idx = rows.findIndex((r) => r.id === nominee.id);
  const leaderboard = {
    above: idx > 0 ? { votes: rows[idx - 1].votes } : null,
    self: { votes: nominee.votes },
    below: idx < rows.length - 1 ? { votes: rows[idx + 1].votes } : null,
  };

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
  });
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
       FROM nominees n
       WHERE n.category_id = ?
       ORDER BY COALESCE(n.votes, 0) DESC`,
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

// ============================================================
// VOTES
// ============================================================
app.post(
  "/api/votes",
  rateLimit({ key: "vote", max: 60 }),
  async (req, res) => {
    if (!votingOpen())
      return res.status(403).json({ error: "Voting is closed" });

    const { nomineeCode, voterToken, deviceHash } = req.body || {};
    if (!nomineeCode || !voterToken || !deviceHash)
      return res.status(400).json({
        error:
          "Nominee code, voter token, and device fingerprint are required",
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
    const ip = req.ip || req.socket.remoteAddress || "unknown";

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
          return {
            ok: false,
            sameNominee: existing.nominee_id === nominee.id,
            votedName: existing.voted_name,
            votedCode: existing.voted_code,
            reason: existing.device_hash === deviceHash ? "device" : "voter",
          };
        }
        await t.execute({
          sql: `INSERT INTO free_votes
                (id, voter_token, nominee_id, device_hash, ip, category_id)
                VALUES (?, ?, ?, ?, ?, ?)`,
          args: [
            uuidv4(),
            voterToken,
            nominee.id,
            deviceHash,
            ip,
            nominee.category_id,
          ],
        });
        await t.execute({
          sql: "UPDATE nominees SET votes = COALESCE(votes, 0) + 1 WHERE id = ?",
          args: [nominee.id],
        });
        return { ok: true };
      });
    } catch (e) {
      console.error("[Vote]", e.message);
      if (String(e.message || "").toLowerCase().includes("unique"))
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
    const updated = await db
      .prepare("SELECT COALESCE(votes, 0) AS votes FROM nominees WHERE id = ?")
      .get(nominee.id);

    broadcastVotes(nominee.id, updated.votes);
    broadcastPublicVote(nominee.id, updated.votes);
    broadcastAdminEvent({
      type: "vote",
      nomineeId: nominee.id,
      votes: updated.votes,
      at: new Date().toISOString(),
    });
    res.json({ success: true, votes: updated.votes });
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
         WHERE fv.voter_token = ?
         ORDER BY fv.created_at DESC`,
      )
      .all(token);
    res.json(rows);
  } catch {
    res.json([]);
  }
});

// ============================================================
// TRANSACTIONS
// ============================================================
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
  } catch {}
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
    } catch {}
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
  } catch {}
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

// ============================================================
// PAYHERO CALLBACK
// ============================================================
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
            `SELECT reference FROM transactions
             WHERE status='pending' ORDER BY created_at DESC LIMIT 50`,
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
        `[PayHero CB] ref=${ref} status="${statusRaw}" receipt="${receiptClean}" → ${
          success ? "SUCCESS" : failure ? "FAILURE" : "AWAITING_RECEIPT"
        }`,
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

// ============================================================
// ADMIN: STATS (dashboard — still shows revenue to super)
// ============================================================
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
        .prepare(`SELECT COUNT(*) as c FROM transactions WHERE status='pending'`)
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

// ============================================================
// ADMIN: CHARTS
// ============================================================
app.get("/api/admin/charts", adminAuth, async (req, res) => {
  const topNominees = await db
    .prepare(
      `SELECT n.name, COALESCE(n.votes, 0) as votes, c.name as category
       FROM nominees n JOIN categories c ON n.category_id = c.id
       ORDER BY COALESCE(n.votes, 0) DESC LIMIT 5`,
    )
    .all();

  const categoryDistribution = await db
    .prepare(
      `SELECT c.name, COALESCE(SUM(COALESCE(n.votes, 0)), 0) as votes
       FROM categories c
       LEFT JOIN nominees n ON n.category_id = c.id
       GROUP BY c.id ORDER BY c.created_at ASC`,
    )
    .all();

  const dailyRows = await db
    .prepare(
      `SELECT date(created_at) as day, COUNT(*) as votes
       FROM free_votes
       WHERE created_at >= datetime('now', '-7 days')
       GROUP BY day ORDER BY day ASC`,
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
      `SELECT n.id, n.name, n.code, n.img, n.category_id,
              COALESCE(n.votes, 0) as votes
       FROM nominees n
       ORDER BY n.category_id, COALESCE(n.votes, 0) DESC`,
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
      })),
    };
  });

  const dailyCatRows = await db
    .prepare(
      `SELECT date(fv.created_at) as day, c.name as category, COUNT(*) as votes
       FROM free_votes fv
       JOIN nominees n ON fv.nominee_id = n.id
       JOIN categories c ON n.category_id = c.id
       WHERE fv.created_at >= datetime('now', '-7 days')
       GROUP BY day, category
       ORDER BY day ASC`,
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

// ============================================================
// ADMIN: CATEGORIES
// ============================================================
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
  } catch {
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
  } catch {
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

// ============================================================
// ADMIN: NOMINEES
// ============================================================
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
  await db.prepare("DELETE FROM nominees WHERE id = ?").run(req.params.id);
  broadcastAdminEvent({ type: "nominee:delete", nomineeId: req.params.id });
  res.json({ success: true });
});

// ============================================================
// ADMIN: TRANSACTIONS / LOGS (super only)
// ============================================================
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

// ============================================================
// ADMIN: SIGNED EXPORTS — NO FINANCIAL DATA
// ============================================================
app.get("/api/admin/export/csv", adminAuth, async (req, res) => {
  try {
    const r = await loadReportData(req);
    const lines = [];
    const add = (...a) => lines.push(a.join(""));
    const bar = "\u2550".repeat(60);

    add("VOTEUS \u2014 OFFICIAL RESULTS EXPORT");
    add(bar);
    add("");
    add(`Report ID,${r.reportId}`);
    add(`Generated,${formatDateTime(r.generatedAt)}`);
    add(`Generated By,${csvEscape(r.generatedBy)} (${r.generatedByRole})`);
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
      add("Rank,Name,Code,Votes,Share %,Share Bar");
      for (const n of cat.nominees) {
        add(
          [
            n.rank,
            csvEscape(n.name),
            csvEscape(n.code),
            n.votes,
            n.percent.toFixed(1) + "%",
            `"${shareBar(n.percent)}"`,
          ].join(","),
        );
      }
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
    add("To verify authenticity, contact the system administrator");
    add("and provide the Report ID and Signature above.");
    add("");
    add("Signed: Voteus.io Automated Reporting System");

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

    const verifyUrl =
      `https://gala.voteus.xyz/verify?` +
      `r=${encodeURIComponent(r.reportId)}` +
      `&s=${r.signature}` +
      `&v=${r.totalVotes}` +
      `&c=${r.categories.length}` +
      `&n=${r.nominees.length}` +
      `&t=${Date.parse(r.generatedAt)}`;

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

    const INDIGO = "#3F51B5";
    const INDIGO_LT = "#E8EAF6";
    const GREEN = "#16A34A";
    const GRAY = "#6b7280";
    const DARK = "#1d1d1f";
    const BORDER = "#e5e7eb";
    const PAGE_W = 507;
    const LEFT = 44;
    const RIGHT = 551;
    const BOTTOM = 780;

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
      doc.text("DISTRIBUTION", LEFT + 445, hy, { width: 62 });
      doc.y = hy + 10;
      doc
        .strokeColor(BORDER)
        .lineWidth(0.5)
        .moveTo(LEFT, doc.y)
        .lineTo(RIGHT, doc.y)
        .stroke();
      doc.y += 3;
    };

    // ============================================================
    // PAGE 1 — Cover + Executive Summary (no finance)
    // ============================================================
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
      .text("Gala Awards 2026  ·  MKUPLC", { align: "center" });

    doc.moveDown(1);
    const metaBoxY = doc.y;
    const metaBoxH = 108;
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
    const cardW = (PAGE_W - 12) / 2;
    const cardH = 52;
    const gridStartY = doc.y;
    for (let i = 0; i < summaryItems.length; i++) {
      const [label, value] = summaryItems[i];
      const col = i % 2;
      const row = Math.floor(i / 2);
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
    doc.y =
      gridStartY + Math.ceil(summaryItems.length / 2) * (cardH + 8) + 14;

    footer();

    // ============================================================
    // RESULTS BY CATEGORY
    // ============================================================
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
        if (ensureSpace(24)) {
          drawColHeaders();
        }

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
          .fillColor(DARK)
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

        const barX = LEFT + 445;
        const barW = 62;
        const barY = yy + 4;
        doc.roundedRect(barX, barY, barW, 4, 2).fill("#F3F4F6");
        const fillW = Math.max(2, (Math.max(n.percent, 0.5) / 100) * barW);
        doc.roundedRect(barX, barY, fillW, 4, 2).fill(INDIGO);

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

    // ============================================================
    // SIGNATURE PAGE — QR-verifiable
    // ============================================================
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

    const sigBoxY = doc.y;
    const sigBoxH = 190;
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
        "The signature above is a SHA-256 hash of the report totals combined " +
          "with a server secret. Any modification to the totals would " +
          "invalidate the signature. Scan the QR code to verify online.",
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
    if (!res.headersSent) {
      res.status(500).json({ error: "Export failed: " + e.message });
    }
  }
});

// ============================================================
// SEO / STATIC / NOMINEE META
// ============================================================
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
    res.type("application/xml");
    res.send(xml);
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
    const shareUrl = `${baseUrl}/nominee/${encodeURIComponent(nominee.code)}`;
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
    console.error(`[Image] ${label} missing at ${filePath}`);
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

// ============================================================
// CLEANUP JOBS
// ============================================================
setInterval(async () => {
  try {
    const cutoff = new Date(
      Date.now() - STALE_TX_MINUTES * 60_000,
    ).toISOString();
    const r = await db
      .prepare(
        `UPDATE transactions SET status = 'abandoned'
         WHERE status = 'pending' AND created_at < ?`,
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
        `DELETE FROM images
         WHERE created_at < ?
           AND id NOT IN (
             SELECT REPLACE(img, '/api/images/', '') FROM nominees
             WHERE img LIKE '/api/images/%'
           )`,
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
        `SELECT reference FROM transactions
         WHERE status = 'pending' AND created_at < ?
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
    } catch {}
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
  console.log(`  Images:      SQLite BLOB · /api/images/:id`);
  console.log(`  PayHero:     ${PAYHERO_API_KEY ? "LIVE" : "SIMULATION"}`);
  console.log(`  Voting:      FREE · one per device per category`);
  console.log(
    `  Live SSE:    /api/nominee/stream · /api/live/votes · /api/live/admin`,
  );
  console.log(`  Exports:     /api/admin/export/{csv,pdf} · no financial data`);
  console.log(`  QR verify:   /verify · ${QRCode ? "enabled" : "text-only"}`);
  console.log(`  Leaderboard: 1m=10 · 1h=25 · 12h=50 · 24h=100`);
  console.log(
    `  Boost:       +${BOOST_VOTES} votes = KES ${PRICES.boost_50} (once)`,
  );
  console.log(`  Super Admin: ${SUPER_ADMIN_USERNAME}`);
  console.log(
    `  Hero wide:   ${fs.existsSync(HERO_WIDE) ? "✓" : "✗ MISSING"} ${HERO_WIDE}`,
  );
  console.log(
    `  Hero mobile: ${fs.existsSync(HERO_MOBILE) ? "✓" : "✗ MISSING"} ${HERO_MOBILE}\n`,
  );
});
