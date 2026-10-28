// audit.js — standalone audit & diagnostics server (port 4000)
// Usage:
//   node audit.js                    → starts HTTP dashboard on :4000
//   node audit.js --cli              → console full audit
//   node audit.js --cli VOTE_MK685   → console audit of one nominee
require("dotenv").config();
const express = require("express");
const path = require("path");
const fs = require("fs");
const Database = require("better-sqlite3");
const { createClient } = require("@libsql/client");

const PORT = process.env.AUDIT_PORT || 4000;
const DATA_DIR = process.env.DATA_DIR || __dirname;
const LOCAL_DB_PATH = path.join(DATA_DIR, "voting-local.db");
const CLI_MODE = process.argv.includes("--cli");
const CLI_CODE = process.argv.find((a) => /^VOTE_/i.test(a));

if (!fs.existsSync(LOCAL_DB_PATH)) {
  console.error(`✗ Local DB not found: ${LOCAL_DB_PATH}`);
  console.error(`  Start the main server once (npm start) to create it.`);
  process.exit(1);
}

const local = new Database(LOCAL_DB_PATH, { readonly: true });
let remote = null;
let remoteError = null;

if (process.env.TURSO_DATABASE_URL && process.env.TURSO_AUTH_TOKEN) {
  try {
    remote = createClient({
      url: process.env.TURSO_DATABASE_URL,
      authToken: process.env.TURSO_AUTH_TOKEN,
    });
  } catch (e) {
    remoteError = e.message;
  }
} else {
  remoteError = "TURSO_DATABASE_URL or TURSO_AUTH_TOKEN missing in .env";
}

// ─── helpers ───
const all = (sql, ...args) => local.prepare(sql).all(...args);
const one = (sql, ...args) => local.prepare(sql).get(...args);

async function remoteCount(table) {
  if (!remote) return { error: remoteError };
  try {
    const r = await remote.execute(`SELECT COUNT(*) AS c FROM ${table}`);
    return { count: Number(r.rows[0]?.c || 0) };
  } catch (e) {
    return { error: e.message };
  }
}

// ─── audit functions ───
function getHealth() {
  const tables = [
    "categories",
    "users",
    "nominees",
    "free_votes",
    "nominee_boosts",
    "transactions",
    "vote_reports",
    "vote_appeals",
    "vote_allowances",
    "election_stages",
    "admins",
    "email_log",
  ];
  const counts = {};
  for (const t of tables) {
    try {
      counts[t] = Number(one(`SELECT COUNT(*) AS c FROM ${t}`)?.c || 0);
    } catch {
      counts[t] = null;
    }
  }
  let stage = null;
  try {
    const s = one("SELECT * FROM election_stages WHERE id = 1");
    if (s)
      stage = {
        current: s.current_stage,
        last_advanced_at: s.last_advanced_at,
        updated_at: s.updated_at,
      };
  } catch {}
  const size = fs.statSync(LOCAL_DB_PATH).size;
  return {
    local: {
      path: LOCAL_DB_PATH,
      size,
      sizeMb: (size / 1024 / 1024).toFixed(2),
      ok: true,
    },
    turso: {
      connected: !!remote,
      url: process.env.TURSO_DATABASE_URL
        ? process.env.TURSO_DATABASE_URL.slice(0, 55) + "…"
        : null,
      error: remoteError,
    },
    tables: counts,
    stage,
    now: new Date().toISOString(),
  };
}

async function getOverview() {
  const cats = Number(one("SELECT COUNT(*) AS c FROM categories")?.c || 0);
  const noms = Number(one("SELECT COUNT(*) AS c FROM nominees")?.c || 0);
  const active = Number(
    one("SELECT COUNT(*) AS c FROM nominees WHERE eliminated = 0")?.c || 0,
  );
  const totalVotes = Number(
    one("SELECT COALESCE(SUM(votes),0) AS t FROM nominees")?.t || 0,
  );
  const freeRows = Number(one("SELECT COUNT(*) AS c FROM free_votes")?.c || 0);
  const boostRows = Number(
    one("SELECT COUNT(*) AS c FROM nominee_boosts")?.c || 0,
  );
  const boostSum = Number(
    one("SELECT COALESCE(SUM(votes_added),0) AS t FROM nominee_boosts")?.t || 0,
  );
  const uniqueVoters = Number(
    one("SELECT COUNT(DISTINCT voter_token) AS c FROM free_votes")?.c || 0,
  );
  const uniqueDevices = Number(
    one(
      "SELECT COUNT(DISTINCT device_hash) AS c FROM free_votes WHERE device_hash IS NOT NULL",
    )?.c || 0,
  );
  const uniqueIPs = Number(
    one("SELECT COUNT(DISTINCT ip) AS c FROM free_votes WHERE ip IS NOT NULL")
      ?.c || 0,
  );
  const appeals = Number(one("SELECT COUNT(*) AS c FROM vote_appeals")?.c || 0);
  const reports = Number(one("SELECT COUNT(*) AS c FROM vote_reports")?.c || 0);
  let stage = "unknown";
  try {
    stage =
      one("SELECT current_stage FROM election_stages WHERE id = 1")
        ?.current_stage || "unknown";
  } catch {}

  const turso = {};
  if (remote) {
    for (const t of [
      "nominees",
      "free_votes",
      "nominee_boosts",
      "categories",
      "vote_appeals",
      "vote_reports",
    ]) {
      turso[t] = await remoteCount(t);
    }
  }
  const computed = freeRows + boostSum;
  return {
    categories: cats,
    nominees: noms,
    active,
    eliminated: noms - active,
    totalVotes,
    freeVoteRows: freeRows,
    boostRows,
    boostVotesSum: boostSum,
    computedVotes: computed,
    delta: totalVotes - computed,
    isConsistent: totalVotes === computed,
    uniqueVoters,
    uniqueDevices,
    uniqueIPs,
    appeals,
    reports,
    stage,
    turso,
  };
}

function getIntegrity() {
  const voteMismatches = all(`
    SELECT n.id, n.code, n.name, n.votes AS stored,
      (SELECT COUNT(*) FROM free_votes WHERE nominee_id = n.id) AS free_count,
      (SELECT COALESCE(SUM(votes_added),0) FROM nominee_boosts WHERE nominee_id = n.id) AS boost_sum
    FROM nominees n
    WHERE n.votes != (
      (SELECT COUNT(*) FROM free_votes WHERE nominee_id = n.id) +
      COALESCE((SELECT SUM(votes_added) FROM nominee_boosts WHERE nominee_id = n.id), 0)
    )
  `).map((m) => ({
    id: m.id,
    code: m.code,
    name: m.name,
    stored: m.stored,
    freeCount: Number(m.free_count),
    boostSum: Number(m.boost_sum),
    computed: Number(m.free_count) + Number(m.boost_sum),
    delta: Number(m.stored) - Number(m.free_count) - Number(m.boost_sum),
  }));

  const orphanVotes = Number(
    one(
      "SELECT COUNT(*) AS c FROM free_votes WHERE nominee_id NOT IN (SELECT id FROM nominees)",
    )?.c || 0,
  );
  const duplicateDeviceCategory = all(
    `SELECT device_hash, category_id, COUNT(*) AS count FROM free_votes WHERE device_hash IS NOT NULL AND is_appeal = 0 AND category_id IS NOT NULL GROUP BY device_hash, category_id HAVING COUNT(*) > 1 LIMIT 50`,
  );
  const duplicateVoterNominee = all(
    `SELECT voter_token, nominee_id, COUNT(*) AS count FROM free_votes GROUP BY voter_token, nominee_id HAVING COUNT(*) > 1 LIMIT 50`,
  );
  const nomineesWithoutUser = all(
    "SELECT id, code, name FROM nominees WHERE user_id IS NULL OR user_id = '' LIMIT 50",
  );
  const nomineesWithoutCategory = all(
    "SELECT id, code, name FROM nominees WHERE category_id IS NULL OR category_id = '' OR category_id NOT IN (SELECT id FROM categories) LIMIT 50",
  );
  const stuckPendingTx = all(
    `SELECT reference, type, amount, created_at FROM transactions WHERE status = 'pending' AND created_at < datetime('now', '-30 minutes') LIMIT 50`,
  );
  const orphanBoosts = all(
    `SELECT nb.id, nb.nominee_id, nb.reference FROM nominee_boosts nb LEFT JOIN transactions t ON t.reference = nb.reference WHERE t.reference IS NULL LIMIT 50`,
  );
  const negativeVotes = all(
    "SELECT id, code, name, votes FROM nominees WHERE votes < 0",
  );

  const criticalCount =
    voteMismatches.length +
    orphanVotes +
    duplicateDeviceCategory.length +
    duplicateVoterNominee.length +
    nomineesWithoutUser.length +
    nomineesWithoutCategory.length +
    negativeVotes.length;
  return {
    healthy: criticalCount === 0,
    criticalCount,
    warnings: stuckPendingTx.length + orphanBoosts.length,
    issues: {
      voteMismatches,
      orphanVotes,
      duplicateDeviceCategory,
      duplicateVoterNominee,
      nomineesWithoutUser,
      nomineesWithoutCategory,
      stuckPendingTx,
      orphanBoosts,
      negativeVotes,
    },
  };
}

async function getLocalVsTurso() {
  if (!remote) return { error: remoteError, connected: false };
  const tables = [
    "categories",
    "users",
    "nominees",
    "free_votes",
    "nominee_boosts",
    "transactions",
    "vote_reports",
    "vote_appeals",
    "vote_allowances",
    "admins",
    "email_log",
    "election_stages",
  ];
  const result = {};
  for (const t of tables) {
    let localCount = null;
    try {
      localCount = Number(one(`SELECT COUNT(*) AS c FROM ${t}`)?.c || 0);
    } catch {}
    const rc = await remoteCount(t);
    const tursoCount = rc.error ? null : rc.count;
    result[t] = {
      local: localCount,
      turso: tursoCount,
      match:
        localCount !== null && tursoCount !== null && localCount === tursoCount,
      error: rc.error || null,
    };
  }
  return {
    connected: true,
    tables: result,
    mismatchCount: Object.values(result).filter((r) => !r.match && !r.error)
      .length,
    checkedAt: new Date().toISOString(),
  };
}

function getNomineeList() {
  return all(`
    SELECT n.id, n.code, n.name, n.votes, n.stage, n.eliminated, n.eliminated_stage, n.final_rank,
           n.category_id, c.name AS category, n.img
    FROM nominees n JOIN categories c ON c.id = n.category_id
    ORDER BY c.name, n.votes DESC
  `);
}

function getNomineeDeepAudit(code) {
  const n = one(
    `SELECT n.*, c.name AS category FROM nominees n JOIN categories c ON c.id = n.category_id WHERE n.code = ?`,
    code,
  );
  if (!n) return { error: "Nominee not found: " + code };

  const freeVotes = all(
    "SELECT * FROM free_votes WHERE nominee_id = ? ORDER BY created_at",
    n.id,
  );
  const boosts = all(
    "SELECT * FROM nominee_boosts WHERE nominee_id = ? ORDER BY created_at",
    n.id,
  );
  const transactions = all(
    "SELECT * FROM transactions WHERE nominee_id = ? ORDER BY created_at DESC",
    n.id,
  );

  const freeCount = freeVotes.length;
  const boostSum = boosts.reduce((s, b) => s + (b.votes_added || 0), 0);
  const computed = freeCount + boostSum;
  const stored = Number(n.votes || 0);

  const deviceCounts = {},
    ipCounts = {},
    uaCounts = {},
    tokenCounts = {},
    minuteCounts = {},
    hourCounts = {};
  let missingDevice = 0,
    missingUA = 0,
    missingIP = 0;

  for (const v of freeVotes) {
    if (v.device_hash)
      deviceCounts[v.device_hash] = (deviceCounts[v.device_hash] || 0) + 1;
    else missingDevice++;
    if (v.ip) ipCounts[v.ip] = (ipCounts[v.ip] || 0) + 1;
    else missingIP++;
    if (v.user_agent)
      uaCounts[v.user_agent] = (uaCounts[v.user_agent] || 0) + 1;
    else missingUA++;
    if (v.voter_token)
      tokenCounts[v.voter_token] = (tokenCounts[v.voter_token] || 0) + 1;
    if (v.created_at) {
      const minute = String(v.created_at).slice(0, 16);
      const hour = String(v.created_at).slice(0, 13);
      minuteCounts[minute] = (minuteCounts[minute] || 0) + 1;
      hourCounts[hour] = (hourCounts[hour] || 0) + 1;
    }
  }

  const duplicateDevices = Object.entries(deviceCounts)
    .filter(([_, c]) => c > 1)
    .map(([hash, count]) => ({ hash, count }))
    .slice(0, 50);
  const duplicateTokens = Object.entries(tokenCounts)
    .filter(([_, c]) => c > 1)
    .map(([token, count]) => ({ token, count }))
    .slice(0, 50);
  const topIPs = Object.entries(ipCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([ip, count]) => ({ ip, count }));
  const topUAs = Object.entries(uaCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([ua, count]) => ({ ua, count, preview: String(ua).slice(0, 120) }));
  const topMinutes = Object.entries(minuteCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([minute, count]) => ({ minute, count }));
  const timeline = Object.entries(hourCounts)
    .sort()
    .map(([hour, count]) => ({ hour, count }));

  let crossVotesSameCat = [],
    crossVotesOtherCats = [];
  const hashes = Object.keys(deviceCounts);
  if (hashes.length) {
    const ph = hashes.map(() => "?").join(",");
    const cross = all(
      `
      SELECT fv.device_hash, n2.code, n2.name, c.name AS category, c.id AS category_id, fv.created_at
      FROM free_votes fv
      JOIN nominees n2 ON n2.id = fv.nominee_id
      JOIN categories c ON c.id = fv.category_id
      WHERE fv.device_hash IN (${ph}) AND fv.nominee_id != ?
    `,
      ...hashes,
      n.id,
    );
    crossVotesSameCat = cross.filter((cv) => cv.category_id === n.category_id);
    crossVotesOtherCats = cross.filter(
      (cv) => cv.category_id !== n.category_id,
    );
  }

  const active = all(
    `SELECT id, votes FROM nominees WHERE category_id = ? AND eliminated = 0 ORDER BY COALESCE(votes, 0) DESC, created_at ASC`,
    n.category_id,
  );
  const rank = active.findIndex((r) => r.id === n.id) + 1;

  const firstVote = freeVotes[0]?.created_at;
  const lastVote = freeVotes[freeVotes.length - 1]?.created_at;
  const durationHours =
    firstVote && lastVote
      ? (new Date(lastVote) - new Date(firstVote)) / 3_600_000
      : 0;
  const maxPerMinute = Math.max(0, ...Object.values(minuteCounts));

  return {
    nominee: {
      code: n.code,
      name: n.name,
      category: n.category,
      category_id: n.category_id,
      stage: n.stage,
      eliminated: n.eliminated,
      eliminated_stage: n.eliminated_stage,
      final_rank: n.final_rank,
      img: n.img,
      created_at: n.created_at,
    },
    integrity: {
      stored,
      freeCount,
      boostSum,
      computed,
      delta: stored - computed,
      isConsistent: stored === computed,
    },
    ranking: { rank: rank || null, totalActiveInCategory: active.length },
    devices: {
      unique: Object.keys(deviceCounts).length,
      duplicates: duplicateDevices,
      missingDeviceHash: missingDevice,
    },
    tokens: {
      unique: Object.keys(tokenCounts).length,
      duplicates: duplicateTokens,
    },
    ips: { unique: Object.keys(ipCounts).length, missingIP, top: topIPs },
    userAgents: {
      unique: Object.keys(uaCounts).length,
      missingUA,
      top: topUAs,
    },
    votePattern: {
      firstVote,
      lastVote,
      durationHours: Math.round(durationHours * 100) / 100,
      maxPerMinute,
      topMinutes,
      suspiciousBursts: topMinutes.filter((m) => m.count >= 10).length,
    },
    crossVotes: {
      sameCategoryCount: crossVotesSameCat.length,
      otherCategoriesCount: crossVotesOtherCats.length,
      sameCategorySample: crossVotesSameCat.slice(0, 20),
    },
    appeals: all(
      `SELECT appeal_code, report_code, category_name, status, created_at FROM vote_appeals WHERE device_hash IN (SELECT DISTINCT device_hash FROM free_votes WHERE nominee_id = ?)`,
      n.id,
    ),
    boosts,
    transactions,
    timeline,
  };
}

function getDevicesAnalysis() {
  const totalUniqueDevices = Number(
    one(
      "SELECT COUNT(DISTINCT device_hash) AS c FROM free_votes WHERE device_hash IS NOT NULL",
    )?.c || 0,
  );
  const totalMissingDeviceHash = Number(
    one(
      "SELECT COUNT(*) AS c FROM free_votes WHERE device_hash IS NULL OR device_hash = ''",
    )?.c || 0,
  );
  const multiCategoryDevices = all(
    `SELECT device_hash, COUNT(DISTINCT category_id) AS categories, COUNT(*) AS total_votes FROM free_votes WHERE device_hash IS NOT NULL GROUP BY device_hash HAVING COUNT(DISTINCT category_id) > 1 ORDER BY total_votes DESC LIMIT 30`,
  );
  const sameCategoryDuplicates = all(
    `SELECT device_hash, category_id, COUNT(*) AS count FROM free_votes WHERE device_hash IS NOT NULL AND is_appeal = 0 GROUP BY device_hash, category_id HAVING COUNT(*) > 1 LIMIT 50`,
  );
  const fingerprintCollisions = all(
    `SELECT device_hash, COUNT(DISTINCT voter_token) AS tokens FROM free_votes WHERE device_hash IS NOT NULL GROUP BY device_hash HAVING COUNT(DISTINCT voter_token) > 1 ORDER BY tokens DESC LIMIT 30`,
  );
  return {
    totalUniqueDevices,
    totalMissingDeviceHash,
    multiCategoryDevices,
    sameCategoryDuplicates,
    fingerprintCollisions,
  };
}

function getIPAnalysis() {
  const totalUniqueIPs = Number(
    one("SELECT COUNT(DISTINCT ip) AS c FROM free_votes WHERE ip IS NOT NULL")
      ?.c || 0,
  );
  const topIPs = all(
    `SELECT ip, COUNT(*) AS votes, COUNT(DISTINCT nominee_id) AS nominees, COUNT(DISTINCT category_id) AS categories FROM free_votes WHERE ip IS NOT NULL AND ip != '' GROUP BY ip ORDER BY votes DESC LIMIT 30`,
  );
  const privateIPs = topIPs.filter((x) =>
    /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|127\.)/.test(x.ip),
  );
  const nomineeIPMap = all(
    `SELECT n.code, n.name, c.name AS category, COUNT(DISTINCT fv.ip) AS unique_ips, COUNT(*) AS votes FROM nominees n JOIN categories c ON c.id = n.category_id LEFT JOIN free_votes fv ON fv.nominee_id = n.id GROUP BY n.id HAVING votes > 0 ORDER BY votes DESC LIMIT 50`,
  );
  return {
    totalUniqueIPs,
    topIPs,
    privateIPs,
    privateIPCount: privateIPs.length,
    nomineeIPMap,
  };
}

function getVoteManipulation() {
  const signals = [];
  const dupDevCat = all(
    `SELECT device_hash, category_id, COUNT(*) AS count FROM free_votes WHERE device_hash IS NOT NULL AND is_appeal = 0 GROUP BY device_hash, category_id HAVING COUNT(*) > 1 LIMIT 20`,
  );
  if (dupDevCat.length)
    signals.push({
      type: "DUPLICATE_DEVICE_CATEGORY",
      severity: "critical",
      count: dupDevCat.length,
      message:
        "Same device voted multiple times in one category — impossible by design",
      sample: dupDevCat,
    });

  const collisions = all(
    `SELECT device_hash, COUNT(DISTINCT voter_token) AS tokens FROM free_votes WHERE device_hash IS NOT NULL GROUP BY device_hash HAVING COUNT(DISTINCT voter_token) > 1 LIMIT 20`,
  );
  if (collisions.length)
    signals.push({
      type: "FINGERPRINT_COLLISION",
      severity: "warning",
      count: collisions.length,
      message:
        "Same device_hash paired with multiple voter_tokens — cleared storage or collision",
      sample: collisions,
    });

  const missingDevice = Number(
    one(
      "SELECT COUNT(*) AS c FROM free_votes WHERE device_hash IS NULL OR device_hash = ''",
    )?.c || 0,
  );
  if (missingDevice > 0)
    signals.push({
      type: "MISSING_DEVICE_HASH",
      severity: "critical",
      count: missingDevice,
      message: "Votes with no device hash — suggests direct DB insertion",
    });

  const missingUA = Number(
    one(
      "SELECT COUNT(*) AS c FROM free_votes WHERE user_agent IS NULL OR user_agent = ''",
    )?.c || 0,
  );
  if (missingUA > 0)
    signals.push({
      type: "MISSING_USER_AGENT",
      severity: "warning",
      count: missingUA,
      message: "Votes with no user agent — old data or direct insert",
    });

  const bursts = all(
    `SELECT nominee_id, substr(created_at, 1, 16) AS minute, COUNT(*) AS votes FROM free_votes GROUP BY nominee_id, minute HAVING COUNT(*) >= 20 ORDER BY votes DESC LIMIT 20`,
  );
  if (bursts.length)
    signals.push({
      type: "VOTE_BURST",
      severity: "warning",
      count: bursts.length,
      message:
        "20+ votes for one nominee in a single minute — possible bot or script",
      sample: bursts,
    });

  const ipConcentration = all(
    `SELECT n.code, n.name, c.name AS category, COUNT(*) AS votes, COUNT(DISTINCT fv.ip) AS unique_ips FROM nominees n JOIN categories c ON c.id = n.category_id JOIN free_votes fv ON fv.nominee_id = n.id GROUP BY n.id HAVING votes >= 50 AND unique_ips <= 5 ORDER BY votes DESC`,
  );
  if (ipConcentration.length)
    signals.push({
      type: "IP_CONCENTRATION",
      severity: "info",
      count: ipConcentration.length,
      message:
        "Nominees with 50+ votes from ≤5 IPs — check if legitimate shared network",
      sample: ipConcentration,
    });

  const crossSameCat = all(
    `SELECT a.device_hash, a.category_id, GROUP_CONCAT(DISTINCT n.code) AS nominees FROM free_votes a JOIN nominees n ON n.id = a.nominee_id WHERE a.device_hash IS NOT NULL GROUP BY a.device_hash, a.category_id HAVING COUNT(DISTINCT a.nominee_id) > 1 LIMIT 20`,
  );
  if (crossSameCat.length)
    signals.push({
      type: "CROSS_VOTES_SAME_CATEGORY",
      severity: "critical",
      count: crossSameCat.length,
      message:
        "One device voted for 2+ nominees in same category — misattribution or unique-index failure",
      sample: crossSameCat,
    });

  const lastHourVotes = Number(
    one(
      "SELECT COUNT(*) AS c FROM free_votes WHERE created_at >= datetime('now', '-1 hour')",
    )?.c || 0,
  );

  return {
    signals,
    lastHourVotes,
    summary: {
      critical: signals.filter((s) => s.severity === "critical").length,
      warnings: signals.filter((s) => s.severity === "warning").length,
      info: signals.filter((s) => s.severity === "info").length,
    },
  };
}

// ─── server or CLI ───
if (!CLI_MODE) {
  const app = express();
  app.use(express.json());

  app.get("/", (req, res) => {
    const htmlPath = path.join(__dirname, "audit.html");
    if (!fs.existsSync(htmlPath))
      return res
        .status(404)
        .type("text/plain")
        .send("audit.html not found next to audit.js");
    res.sendFile(htmlPath);
  });

  app.get("/api/audit/health", (req, res) => res.json(getHealth()));
  app.get("/api/audit/overview", async (req, res) => {
    try {
      res.json(await getOverview());
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
  app.get("/api/audit/integrity", (req, res) => {
    try {
      res.json(getIntegrity());
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
  app.get("/api/audit/local-vs-turso", async (req, res) => {
    try {
      res.json(await getLocalVsTurso());
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
  app.get("/api/audit/nominees", (req, res) => res.json(getNomineeList()));
  app.get("/api/audit/nominee/:code", (req, res) => {
    try {
      const r = getNomineeDeepAudit(req.params.code);
      if (r.error) return res.status(404).json(r);
      res.json(r);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
  app.get("/api/audit/devices", (req, res) => {
    try {
      res.json(getDevicesAnalysis());
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
  app.get("/api/audit/ip-analysis", (req, res) => {
    try {
      res.json(getIPAnalysis());
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
  app.get("/api/audit/vote-manipulation", (req, res) => {
    try {
      res.json(getVoteManipulation());
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.listen(PORT, () => {
    console.log(`\n✓ Audit & diagnostics server running`);
    console.log(`  Dashboard:  http://localhost:${PORT}`);
    console.log(`  Local DB:   ${LOCAL_DB_PATH}`);
    console.log(
      `  Turso:      ${remote ? "connected" : "disconnected — " + remoteError}`,
    );
    console.log(`\n  Endpoints:`);
    console.log(`    GET /api/audit/health`);
    console.log(`    GET /api/audit/overview`);
    console.log(`    GET /api/audit/integrity`);
    console.log(`    GET /api/audit/local-vs-turso`);
    console.log(`    GET /api/audit/nominees`);
    console.log(`    GET /api/audit/nominee/:code`);
    console.log(`    GET /api/audit/devices`);
    console.log(`    GET /api/audit/ip-analysis`);
    console.log(`    GET /api/audit/vote-manipulation\n`);
  });
} else {
  (async () => {
    try {
      if (CLI_CODE) {
        const r = getNomineeDeepAudit(CLI_CODE);
        console.log(JSON.stringify(r, null, 2));
      } else {
        const health = getHealth();
        const overview = await getOverview();
        const integrity = getIntegrity();
        const manipulation = getVoteManipulation();
        const localVsTurso = await getLocalVsTurso();
        console.log(
          JSON.stringify(
            { health, overview, integrity, manipulation, localVsTurso },
            null,
            2,
          ),
        );
      }
    } catch (e) {
      console.error("✗", e.message);
    }
    process.exit(0);
  })();
}
