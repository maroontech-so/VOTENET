require("dotenv").config();
const express = require("express");
const path = require("path");
const fs = require("fs");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const axios = require("axios");
const multer = require("multer");
const sharp = require("sharp");
const PDFDocument = require("pdfkit");
const { v4: uuidv4 } = require("uuid");
const db = require("./db");

const app = express();
app.set("trust proxy", 1);
app.disable("x-powered-by");

/* ================================================================
   CONFIG
   ================================================================ */
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
  leaderboard_2h: 25,
};
const LEADERBOARD_2H_MS = 2 * 60 * 60 * 1000;
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

/* ================================================================
   BODY PARSING
   ================================================================ */
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

/* ================================================================
   UPLOADS (multer → memory)
   ================================================================ */
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
      .jpeg({
        quality: IMG_JPEG_QUALITY,
        mozjpeg: true,
        progressive: true,
      })
      .toBuffer();
    return { data: out, mime: "image/jpeg" };
  } catch (err) {
    console.warn(
      "[Image] sharp could not process, storing original:",
      err.message,
    );
    return {
      data: buffer,
      mime: "application/octet-stream",
    };
  }
}

/* ================================================================
   DATABASE SCHEMA
   ================================================================ */
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
    CREATE INDEX IF NOT EXISTS idx_fv_ip ON free_votes(ip);
    CREATE TABLE IF NOT EXISTS images (
      id TEXT PRIMARY KEY,
      data BLOB NOT NULL,
      mime TEXT NOT NULL,
      size INTEGER,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS admins (
      id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL,
      display_name TEXT, role TEXT DEFAULT 'admin', created_by TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP, revoked INTEGER DEFAULT 0,
      revoked_at TEXT, revoked_by TEXT
    );
  `);

  /* ---------- Migration for existing installs ---------- */
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
}

/* ================================================================
   RATE LIMIT
   ================================================================ */
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

/* ================================================================
   HELPERS
   ================================================================ */
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

/* ================================================================
   AUTH MIDDLEWARE
   ================================================================ */
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

/* ================================================================
   PAYMENT PIPELINE (nominee-portal only)
   ================================================================ */
async function completeTransaction(reference, receipt) {
  try {
    const result = await db.tx(async (t) => {
      const claimed = await t.execute({
        sql: `UPDATE transactions
              SET status='success', mpesa_receipt=?, completed_at=CURRENT_TIMESTAMP
              WHERE reference=? AND status='pending'`,
        args: [receipt, reference],
      });
      if (Number(claimed.rowsAffected || 0) === 0) {
        return { ok: false, reason: "already_processed_or_not_pending" };
      }

      const txRow = await t.get(
        "SELECT * FROM transactions WHERE reference = ?",
        [reference],
      );

      let meta = {};
      try {
        meta = txRow.metadata ? JSON.parse(txRow.metadata) : {};
      } catch {}

      if (txRow.type === "category_change") {
        await t.execute({
          sql: "UPDATE nominees SET category_id = ? WHERE id = ?",
          args: [meta.newCategoryId, txRow.nominee_id],
        });
      } else if (txRow.type === "leaderboard_once") {
        await t.execute({
          sql: `INSERT INTO leaderboard_access (user_id, credits) VALUES (?, 1)
                ON CONFLICT(user_id) DO UPDATE SET credits = credits + 1`,
          args: [txRow.user_id],
        });
      } else if (txRow.type === "leaderboard_2h") {
        const existing = await t.get(
          "SELECT expires_at FROM leaderboard_access WHERE user_id = ?",
          [txRow.user_id],
        );
        const now = Date.now();
        const existingMs =
          existing && existing.expires_at
            ? new Date(existing.expires_at).getTime()
            : 0;
        const base = existingMs > now ? existingMs : now;
        const expiresAt = new Date(base + LEADERBOARD_2H_MS).toISOString();
        await t.execute({
          sql: `INSERT INTO leaderboard_access (user_id, expires_at) VALUES (?, ?)
                ON CONFLICT(user_id) DO UPDATE SET expires_at = ?`,
          args: [txRow.user_id, expiresAt, expiresAt],
        });
      } else if (txRow.type === "vote") {
        await t.execute({
          sql: "UPDATE nominees SET votes = votes + ? WHERE id = ?",
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

      return { ok: true, type: txRow.type };
    });

    if (result.ok) {
      console.log(`✓ ${reference} completed (${result.type})`);
      db.push().catch((e) => console.warn("[Push after payment]", e.message));
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
      leaderboard_2h: "LB2",
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

/* ================================================================
   PAYHERO STATUS LOOKUP
   ================================================================ */
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
      if (r.status >= 200 && r.status < 300 && r.data) {
        return r.data;
      }
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

  if (receipt && String(receipt).trim().length > 0) {
    return { status: "success", receipt: String(receipt).trim() };
  }

  const resultCode = data.ResultCode ?? data.resultCode ?? null;
  if (resultCode !== null && resultCode !== 0 && resultCode !== "0") {
    return { status: "failed" };
  }

  const statusRaw = String(
    data.status ?? data.Status ?? data.PaymentStatus ?? "",
  ).toLowerCase();

  if (
    statusRaw.includes("fail") ||
    statusRaw.includes("cancel") ||
    statusRaw.includes("declin") ||
    statusRaw.includes("reject")
  ) {
    return { status: "failed" };
  }

  return null;
}

/* ================================================================
   IMAGES
   ================================================================ */
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
        `[Upload] Received ${req.file.originalname} (${req.file.mimetype}, ${Math.round(
          req.file.size / 1024,
        )} KB)`,
      );

      try {
        const processed = await processImage(req.file.buffer);
        const id = uuidv4();

        await db
          .prepare(
            "INSERT INTO images (id, data, mime, size) VALUES (?, ?, ?, ?)",
          )
          .run(id, processed.data, processed.mime, processed.data.length);

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
  try {
    const id = String(req.params.id || "").trim();
    if (!/^[0-9a-f-]{8,64}$/i.test(id)) {
      res.setHeader("Cache-Control", "no-store");
      return res.status(400).end();
    }

    let row = await db
      .prepare("SELECT data, mime FROM images WHERE id = ?")
      .get(id);

    if (!row) {
      const remoteRow = await db.pullImage(id);
      if (remoteRow) {
        row = { data: remoteRow.data, mime: remoteRow.mime };
      }
    }

    if (!row) {
      res.setHeader("Cache-Control", "no-store");
      return res.status(404).end();
    }

    const buf = Buffer.isBuffer(row.data) ? row.data : Buffer.from(row.data);

    res.setHeader("Content-Type", row.mime || "image/jpeg");
    res.setHeader("Content-Length", buf.length);
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    res.setHeader("ETag", `"${id}"`);
    res.send(buf);
  } catch (e) {
    console.error("[Images]", e.message);
    res.status(500).end();
  }
});

/* ================================================================
   PUBLIC
   ================================================================ */
app.get("/api/health", async (req, res) => {
  let dbOk = true;
  try {
    await db.prepare("SELECT 1").get();
  } catch {
    dbOk = false;
  }
  let imageCount = null;
  try {
    const row = await db.prepare("SELECT COUNT(*) as c FROM images").get();
    imageCount = row?.c ?? 0;
  } catch {}
  res.json({
    ok: dbOk,
    uptime: Math.floor(process.uptime()),
    memory: Math.round(process.memoryUsage().rss / 1024 / 1024) + " MB",
    db: dbOk ? "ok" : "error",
    payhero: PAYHERO_API_KEY ? "live" : "simulation",
    images: { storage: "sqlite-blob", count: imageCount },
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
      leaderboard2h: PRICES.leaderboard_2h,
    },
  });
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
      `
    SELECT n.*, c.name as category FROM nominees n
    JOIN categories c ON n.category_id = c.id ORDER BY n.created_at ASC
  `,
    )
    .all();

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
          `
        SELECT fv.nominee_id, n2.category_id, n2.name, n2.code
        FROM free_votes fv
        JOIN nominees n2 ON fv.nominee_id = n2.id
        WHERE ${conditions.join(" OR ")}
      `,
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
      `
    SELECT n.*, c.name as category FROM nominees n
    JOIN categories c ON n.category_id = c.id WHERE n.code = ?
  `,
    )
    .get(req.params.code);
  if (!n) return res.status(404).json({ error: "Not found" });
  res.json(n);
});

/* ================================================================
   NOMINEE AUTH
   ================================================================ */
app.post(
  "/api/auth/register",
  rateLimit({ key: "register", max: 10 }),
  async (req, res) => {
    try {
      const body = req.body || {};
      const rawName = body.name;
      const rawEmail = body.email;
      const rawPassword = body.password;

      if (!rawName || !rawEmail || !rawPassword) {
        return res
          .status(400)
          .json({ error: "Name, email, and password are required" });
      }

      const cleanName = String(rawName).trim();
      const cleanEmail = String(rawEmail).trim().toLowerCase();
      const cleanPassword = String(rawPassword);

      if (!cleanName) {
        return res.status(400).json({ error: "Name is required" });
      }
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
        return res
          .status(400)
          .json({ error: "Please enter a valid email address" });
      }
      if (cleanPassword.length < 8) {
        return res
          .status(400)
          .json({ error: "Password must be at least 8 characters" });
      }
      if (!/\d/.test(cleanPassword)) {
        return res
          .status(400)
          .json({ error: "Password must contain at least one number" });
      }

      console.log(`[Register] Attempt: ${cleanEmail}`);

      const existing = await db
        .prepare("SELECT id FROM users WHERE LOWER(email) = ?")
        .get(cleanEmail);

      if (existing && existing.id) {
        console.log(
          `[Register] Already exists: ${cleanEmail} (${existing.id})`,
        );
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
          console.log(`[Register] Race on insert: ${cleanEmail}`);
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

      console.log(`[Register] Created: ${cleanEmail} (${id})`);

      res.json({
        token,
        user: {
          id,
          name: cleanName,
          email: cleanEmail,
          hasNominee: false,
        },
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

/* ================================================================
   ADMIN LOGIN
   ================================================================ */
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

/* ================================================================
   ADMIN USER MANAGEMENT
   ================================================================ */
app.get("/api/admin/users", superAuth, async (req, res) => {
  const rows = await db
    .prepare(
      `
    SELECT id, username, display_name, role, created_by, created_at, revoked, revoked_at, revoked_by
    FROM admins ORDER BY created_at DESC
  `,
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

/* ================================================================
   NOMINEE PORTAL
   ================================================================ */
async function getLeaderboardAccess(userId) {
  const acc = await db
    .prepare("SELECT * FROM leaderboard_access WHERE user_id = ?")
    .get(userId);
  if (!acc) return { allowed: false, type: "none" };
  if (acc.permanent) return { allowed: true, type: "permanent" };
  if (acc.expires_at && new Date(acc.expires_at) > new Date())
    return { allowed: true, type: "timed", expiresAt: acc.expires_at };
  if (acc.credits > 0)
    return { allowed: true, type: "credits", credits: acc.credits };
  return { allowed: false, type: "none" };
}

app.get("/api/nominee/me", auth, async (req, res) => {
  const nominee = await db
    .prepare(
      `
    SELECT n.*, c.name as category FROM nominees n
    JOIN categories c ON n.category_id = c.id WHERE n.user_id = ?
  `,
    )
    .get(req.user.id);
  if (!nominee) return res.status(404).json({ error: "Not a nominee yet" });

  const rows = await db
    .prepare(
      "SELECT id, votes FROM nominees WHERE category_id = ? ORDER BY votes DESC",
    )
    .all(nominee.category_id);
  const idx = rows.findIndex((r) => r.id === nominee.id);
  const leaderboard = {
    above: idx > 0 ? { votes: rows[idx - 1].votes } : null,
    self: { votes: nominee.votes },
    below: idx < rows.length - 1 ? { votes: rows[idx + 1].votes } : null,
  };
  res.json({
    nominee,
    leaderboard,
    leaderboardAccess: await getLeaderboardAccess(req.user.id),
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
  if (access.type === "credits")
    await db
      .prepare(
        "UPDATE leaderboard_access SET credits = MAX(credits - 1, 0) WHERE user_id = ?",
      )
      .run(req.user.id);
  const rows = await db
    .prepare(
      `
    SELECT n.id, n.name, n.code, n.img, n.votes FROM nominees n
    WHERE n.category_id = ? ORDER BY n.votes DESC
  `,
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
        `
    SELECT n.*, c.name as category FROM nominees n
    JOIN categories c ON n.category_id = c.id WHERE n.id = ?
  `,
      )
      .get(id);
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
    if (!["once", "2h"].includes(type))
      return res.status(400).json({ error: "Invalid unlock type" });
    if (!phone) return res.status(400).json({ error: "Phone required" });
    const nominee = await db
      .prepare("SELECT * FROM nominees WHERE user_id = ?")
      .get(req.user.id);
    if (!nominee) return res.status(404).json({ error: "Not a nominee yet" });
    const txType = type === "once" ? "leaderboard_once" : "leaderboard_2h";
    const amount =
      type === "once" ? PRICES.leaderboard_once : PRICES.leaderboard_2h;
    try {
      const r = await initiatePayment({
        type: txType,
        userId: req.user.id,
        nomineeId: nominee.id,
        amount,
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

/* ================================================================
   FREE VOTING
   ================================================================
   Enforcement rules:
     1. One vote per voterToken per category (matches previous rule).
     2. One vote per deviceHash per category — catches incognito and
        cleared-localStorage circumvention in the same browser.
     3. The two rules run inside BEGIN IMMEDIATE so they cannot be
        raced. The idx_fv_device_cat unique index is a second safety net.
   ================================================================ */
app.post(
  "/api/votes",
  rateLimit({ key: "vote", max: 60 }),
  async (req, res) => {
    if (!votingOpen())
      return res.status(403).json({ error: "Voting is closed" });

    const { nomineeCode, voterToken, deviceHash } = req.body || {};
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

    const ip = req.ip || req.socket.remoteAddress || "unknown";

    let result;
    try {
      result = await db.tx(async (t) => {
        const existing = await t.get(
          `
          SELECT fv.nominee_id, n2.name AS voted_name, n2.code AS voted_code,
                 fv.voter_token, fv.device_hash
          FROM free_votes fv
          JOIN nominees n2 ON fv.nominee_id = n2.id
          WHERE n2.category_id = ?
            AND (fv.voter_token = ? OR fv.device_hash = ?)
          LIMIT 1
        `,
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
          sql: "UPDATE nominees SET votes = votes + 1 WHERE id = ?",
          args: [nominee.id],
        });

        return { ok: true };
      });
    } catch (e) {
      console.error("[Vote]", e.message);
      if (
        String(e.message || "")
          .toLowerCase()
          .includes("unique")
      ) {
        return res.status(409).json({
          error: "This device has already voted in this category.",
          code: "DEVICE_ALREADY_VOTED",
        });
      }
      return res.status(500).json({ error: "Vote failed. Please try again." });
    }

    if (!result.ok) {
      let message;
      if (result.reason === "device") {
        message = `This device has already voted in this category (for ${result.votedName}). Only one vote per device per category is allowed.`;
      } else if (result.sameNominee) {
        message = "You have already voted for this nominee.";
      } else {
        message = `You've already voted in this category (for ${result.votedName}). Only one vote per category is allowed.`;
      }

      return res.status(409).json({
        error: message,
        code: "ALREADY_VOTED",
        votedNominee: { name: result.votedName, code: result.votedCode },
      });
    }

    db.push().catch((e) => console.warn("[Push after vote]", e.message));

    const updated = await db
      .prepare("SELECT votes FROM nominees WHERE id = ?")
      .get(nominee.id);
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

/* ================================================================
   TRANSACTION STATUS
   ================================================================ */
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
    if (result && result.status === "success") {
      await completeTransaction(reference, result.receipt);
    } else if (result && result.status === "failed") {
      await failTransaction(reference, "payhero_status_failed");
    }
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

/* ================================================================
   PAYHERO CALLBACK
   ================================================================ */
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

      if (!ref) {
        ref = deepFind(
          body,
          (k, v) => typeof v === "string" && /^(CC|LB1|LB2)-\d/.test(v),
        );
      }

      if (!ref) {
        const raw = JSON.stringify(body).toUpperCase();
        const pending = await db
          .prepare(
            `SELECT reference FROM transactions
             WHERE status='pending' ORDER BY created_at DESC LIMIT 50`,
          )
          .all();
        for (const tx of pending) {
          if (raw.includes(tx.reference.toUpperCase())) {
            ref = tx.reference;
            break;
          }
        }
      }

      if (!ref) {
        console.warn(
          "[PayHero CB] Could not extract a reference from body:",
          JSON.stringify(body),
        );
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
        `[PayHero CB] ref=${ref} wooStatus="${wooStatus}" status="${statusRaw}" receipt="${receiptClean}" → ${
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

      if (success) {
        await completeTransaction(ref, receiptClean);
      } else if (failure) {
        await failTransaction(ref, "callback_failure");
      } else {
        console.log(
          `[PayHero CB] ${ref} — STK delivered, waiting for M-Pesa receipt`,
        );
      }
    } catch (e) {
      console.error("[Callback Error]", e.message);
    }
  })();
});

/* ================================================================
   ADMIN DATA
   ================================================================ */
app.get("/api/admin/stats", adminAuth, async (req, res) => {
  const isSuper = req.admin.role === "super";
  const totalVotes = (
    await db.prepare("SELECT COALESCE(SUM(votes),0) as t FROM nominees").get()
  ).t;
  const nomineesCount = (
    await db.prepare("SELECT COUNT(*) as c FROM nominees").get()
  ).c;
  const categoriesCount = (
    await db.prepare("SELECT COUNT(*) as c FROM categories").get()
  ).c;

  if (!isSuper) {
    return res.json({ totalVotes, nomineesCount, categoriesCount });
  }

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
  const successCount = (
    await db
      .prepare(`SELECT COUNT(*) as c FROM transactions WHERE status='success'`)
      .get()
  ).c;
  const abandoned = (
    await db
      .prepare(
        `SELECT COUNT(*) as c FROM transactions WHERE status='abandoned'`,
      )
      .get()
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
  res.json({
    totalVotes,
    grossRevenue,
    platformRevenue: grossRevenue * 0.1,
    pendingPayments: pending,
    successfulPayments: successCount,
    abandonedTransactions: abandoned,
    nomineesCount,
    categoriesCount,
    uniqueVoters,
    uniqueDevices,
  });
});

app.get("/api/admin/charts", adminAuth, async (req, res) => {
  const topNominees = await db
    .prepare(
      `
    SELECT n.name, n.votes, c.name as category FROM nominees n
    JOIN categories c ON n.category_id = c.id
    ORDER BY n.votes DESC LIMIT 5
  `,
    )
    .all();

  const categoryDistribution = await db
    .prepare(
      `
    SELECT c.name, COALESCE(SUM(n.votes),0) as votes FROM categories c
    LEFT JOIN nominees n ON n.category_id = c.id
    GROUP BY c.id ORDER BY c.created_at ASC
  `,
    )
    .all();

  const dailyRows = await db
    .prepare(
      `
    SELECT date(created_at) as day, COUNT(*) as votes
    FROM free_votes
    WHERE created_at >= datetime('now', '-7 days')
    GROUP BY day ORDER BY day ASC
  `,
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

  res.json({ topNominees, categoryDistribution, dailyVotes: days });
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
  res.json({ success: true });
});

app.get("/api/admin/transactions", superAuth, async (req, res) => {
  res.json(
    await db
      .prepare(
        `
    SELECT t.*, n.name as nominee_name, n.code as nominee_code
    FROM transactions t LEFT JOIN nominees n ON t.nominee_id = n.id
    ORDER BY t.created_at DESC LIMIT 200
  `,
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

/* ================================================================
   EXPORTS
   ================================================================ */
async function buildLeaderboardRows() {
  return await db
    .prepare(
      `
    SELECT n.name, n.code, c.name as category, n.votes
    FROM nominees n JOIN categories c ON n.category_id = c.id
    ORDER BY c.name ASC, n.votes DESC
  `,
    )
    .all();
}

function csvEscape(v) {
  const s = String(v == null ? "" : v);
  if (s.includes(",") || s.includes('"') || s.includes("\n"))
    return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

app.get("/api/admin/export/csv", superAuth, async (req, res) => {
  const rows = await buildLeaderboardRows();
  const lines = ["Rank,Name,Code,Category,Votes"];
  const catCounters = {};
  for (const r of rows) {
    catCounters[r.category] = (catCounters[r.category] || 0) + 1;
    lines.push(
      [
        catCounters[r.category],
        csvEscape(r.name),
        csvEscape(r.code),
        csvEscape(r.category),
        r.votes,
      ].join(","),
    );
  }
  const stats = await db
    .prepare(
      `SELECT COALESCE(SUM(amount),0) as gross FROM transactions WHERE status='success'`,
    )
    .get();
  lines.push("");
  lines.push(`Report generated,${new Date().toISOString()}`);
  lines.push(`Total votes,${rows.reduce((s, r) => s + (r.votes || 0), 0)}`);
  lines.push(`Gross revenue (KES),${stats.gross}`);
  lines.push(`Platform revenue (KES),${(stats.gross * 0.1).toFixed(2)}`);

  const filename = `votenet-report-${new Date().toISOString().slice(0, 10)}.csv`;
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.send(lines.join("\n"));
});

app.get("/api/admin/export/pdf", superAuth, async (req, res) => {
  const stats = {
    totalVotes: (
      await db.prepare("SELECT COALESCE(SUM(votes),0) as t FROM nominees").get()
    ).t,
    gross: (
      await db
        .prepare(
          `SELECT COALESCE(SUM(amount),0) as t FROM transactions WHERE status='success'`,
        )
        .get()
    ).t,
    nominees: (await db.prepare("SELECT COUNT(*) as c FROM nominees").get()).c,
    categories: (await db.prepare("SELECT COUNT(*) as c FROM categories").get())
      .c,
  };
  const rows = await buildLeaderboardRows();
  const byCategory = {};
  for (const r of rows)
    (byCategory[r.category] = byCategory[r.category] || []).push(r);

  const filename = `votenet-report-${new Date().toISOString().slice(0, 10)}.pdf`;
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);

  const doc = new PDFDocument({ size: "A4", margin: 44 });
  doc.pipe(res);

  const primary = "#3F51B5";
  const gray = "#6b7280";

  doc
    .fillColor(primary)
    .fontSize(24)
    .text("Voteus — Official Results Report", { align: "center" });
  doc.moveDown(0.2);
  doc
    .fillColor(gray)
    .fontSize(10)
    .text(`Generated: ${new Date().toLocaleString()}`, { align: "center" });
  doc.moveDown(1.2);
  doc
    .strokeColor("#e5e7eb")
    .lineWidth(1)
    .moveTo(44, doc.y)
    .lineTo(551, doc.y)
    .stroke();
  doc.moveDown(1);

  doc.fillColor("#1d1d1f").fontSize(14).text("Summary");
  doc.moveDown(0.5);
  const summaryLines = [
    ["Total Votes Cast", stats.totalVotes.toLocaleString()],
    ["Gross Revenue", `KES ${Number(stats.gross).toLocaleString()}`],
    ["Platform Revenue (10%)", `KES ${(stats.gross * 0.1).toLocaleString()}`],
    ["Categories", String(stats.categories)],
    ["Nominees", String(stats.nominees)],
  ];
  const col1X = 44,
    col2X = 300;
  let summaryY = doc.y;
  for (const [k, v] of summaryLines) {
    doc.fillColor(gray).fontSize(10).text(k, col1X, summaryY);
    doc.fillColor("#1d1d1f").fontSize(11).text(v, col2X, summaryY);
    summaryY += 18;
  }
  doc.y = summaryY + 10;
  doc.moveDown(0.5);

  for (const cat of Object.keys(byCategory).sort()) {
    const list = byCategory[cat].sort(
      (a, b) => (b.votes || 0) - (a.votes || 0),
    );
    const totalCat = list.reduce((s, r) => s + (r.votes || 0), 0);

    if (doc.y > 690) doc.addPage();
    doc.fillColor(primary).fontSize(13).text(cat);
    doc
      .fillColor(gray)
      .fontSize(9)
      .text(`Total category votes: ${totalCat.toLocaleString()}`);
    doc.moveDown(0.4);

    const y0 = doc.y;
    doc.fillColor("#1d1d1f").fontSize(10).font("Helvetica-Bold");
    doc.text("#", 44, y0, { width: 24 });
    doc.text("Name", 70, y0, { width: 220 });
    doc.text("Code", 290, y0, { width: 130 });
    doc.text("Votes", 420, y0, { width: 60, align: "right" });
    doc.text("Share", 490, y0, { width: 60, align: "right" });
    doc.font("Helvetica");
    doc.moveDown(0.6);
    doc
      .strokeColor("#e5e7eb")
      .lineWidth(0.5)
      .moveTo(44, doc.y)
      .lineTo(551, doc.y)
      .stroke();
    doc.moveDown(0.3);

    let rank = 1;
    for (const r of list) {
      if (doc.y > 780) {
        doc.addPage();
        doc.moveDown(1);
      }
      const share =
        totalCat > 0 ? ((r.votes / totalCat) * 100).toFixed(1) + "%" : "—";
      const yy = doc.y;
      doc.fillColor("#1d1d1f").fontSize(10);
      doc.text(String(rank), 44, yy, { width: 24 });
      doc.text(r.name, 70, yy, { width: 220 });
      doc.fillColor(gray).fontSize(9).text(r.code, 290, yy, { width: 130 });
      doc
        .fillColor("#1d1d1f")
        .fontSize(10)
        .text(String(r.votes || 0), 420, yy, { width: 60, align: "right" });
      doc.text(share, 490, yy, { width: 60, align: "right" });
      doc.moveDown(0.5);
      rank++;
    }
    doc.moveDown(1);
  }

  if (doc.y > 750) doc.addPage();
  doc
    .fillColor(gray)
    .fontSize(9)
    .text(
      "Auto-generated by Voteus.io. Reflects all successful transactions at time of export.",
      44,
      doc.y,
      { align: "center", width: 507 },
    );

  doc.end();
});

/* ================================================================
   SEO / PAGES / STATIC
   ================================================================ */
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
         ORDER BY n.votes DESC`,
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

app.get("/", (req, res) => res.sendFile(path.join(__dirname, "index.html")));
app.get("/nominee", (req, res) =>
  res.sendFile(path.join(__dirname, "nominee.html")),
);
app.get("/admin", (req, res) =>
  res.sendFile(path.join(__dirname, "admin.html")),
);

/* ================================================================
   BACKGROUND JOBS
   ================================================================ */
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

/* ================================================================
   ERROR HANDLING
   ================================================================ */
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

/* ================================================================
   START
   ================================================================ */
const server = app.listen(PORT, async () => {
  console.log(`\n✓ Voteus on http://localhost:${PORT}`);

  try {
    await db.verifyConnection();
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
    `  Reconcile:   pending txns checked every ${RECONCILE_INTERVAL_MS / 1000}s`,
  );
  console.log(`  Images:      SQLite BLOB · served at /api/images/:id`);
  console.log(`  PayHero:     ${PAYHERO_API_KEY ? "LIVE" : "SIMULATION"}`);
  console.log(
    `  Voting:      FREE · one per device per category (fingerprint-enforced)`,
  );
  console.log(`  Super Admin: ${SUPER_ADMIN_USERNAME}`);
  console.log(
    `  Hero wide:   ${fs.existsSync(HERO_WIDE) ? "✓" : "✗ MISSING"} ${HERO_WIDE}`,
  );
  console.log(
    `  Hero mobile: ${fs.existsSync(HERO_MOBILE) ? "✓" : "✗ MISSING"} ${HERO_MOBILE}\n`,
  );
});
