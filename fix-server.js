#!/usr/bin/env node
/* fix-voteus.js — applies all 6 corrections to server.js in place.
 * Idempotent — safe to run multiple times.
 * Creates a timestamped backup on every run.
 */
"use strict";
const fs   = require("fs");
const path = require("path");

const FILE = path.join(__dirname, "server.js");
if (!fs.existsSync(FILE)) {
  console.error("✗ server.js not found in", __dirname);
  process.exit(1);
}

const backup = FILE + ".bak-" + Date.now();
fs.copyFileSync(FILE, backup);
console.log("✓ Backup:", path.basename(backup), "\n");

let src = fs.readFileSync(FILE, "utf8");
const original = src;
const applied  = [];
const skipped  = [];

function replaceOnce(label, target, replacement, required = true) {
  if (!src.includes(target)) {
    if (required) skipped.push(`${label} — target not found`);
    return false;
  }
  src = src.replace(target, replacement);
  applied.push(label);
  return true;
}

// ─────────────────────────────────────────────────────────────────────
// FIX 1 — remove the duplicate STAGE_WINDOWS declaration (line ~1229)
// ─────────────────────────────────────────────────────────────────────
{
  const marker = `const STAGE_WINDOWS = Object.freeze({`;
  const occurrences = src.split(marker).length - 1;
  if (occurrences === 1) {
    skipped.push("FIX 1 — only one STAGE_WINDOWS block exists (already fixed)");
  } else if (occurrences === 2) {
    // Keep the FIRST block (at top of file). Delete the SECOND one.
    // The second one is preceded by the closing of emailTick().

    if (src.includes(secondBlock)) {
      src = src.replace(secondBlock, "\n");
      applied.push("FIX 1 — removed duplicate STAGE_WINDOWS block");
    } else {
      // Fallback: find the SECOND occurrence and cut from `\nconst STAGE_WINDOWS`
      // up to the closing `const RESULTS_ANNOUNCED_AT = ...;` line.
      const firstIdx = src.indexOf(marker);
      const secondIdx = src.indexOf(marker, firstIdx + 1);
      if (secondIdx !== -1) {
        const cutStart = src.lastIndexOf("\n", secondIdx);
        const tail = "const RESULTS_ANNOUNCED_AT";
        const tailIdx = src.indexOf(tail, secondIdx);
        if (tailIdx !== -1) {
          const semi = src.indexOf("\n", tailIdx);
          const cutEnd = semi === -1 ? src.length : semi;
          src = src.slice(0, cutStart) + "\n" + src.slice(cutEnd);
          applied.push("FIX 1 — removed duplicate STAGE_WINDOWS block (fallback)");
        } else {
          skipped.push("FIX 1 — could not locate RESULTS_ANNOUNCED_AT after duplicate");
        }
      }
    }
  } else {
    skipped.push(`FIX 1 — unexpected (${occurrences} STAGE_WINDOWS blocks); manual fix required`);
  }
}

// ─────────────────────────────────────────────────────────────────────
// FIX 2 — add fraud columns to initSchema's ALTER TABLE list
// ─────────────────────────────────────────────────────────────────────
{
  const marker = `    "final_rank INTEGER",
    "frozen INTEGER DEFAULT 0",
    "frozen_at TEXT",
    "frozen_reason TEXT",
    "auto_frozen INTEGER DEFAULT 0",
    "vote_adjustment INTEGER DEFAULT 0",
  ]) {`;
  if (src.includes(`"frozen INTEGER DEFAULT 0",\n    "frozen_at TEXT"`)) {
    skipped.push("FIX 2 — frozen columns already present");
  } else if (src.includes(marker)) {
    src = src.replace(marker,
`    "final_rank INTEGER",
    "frozen INTEGER DEFAULT 0",
    "frozen_at TEXT",
    "frozen_reason TEXT",
    "auto_frozen INTEGER DEFAULT 0",
    "vote_adjustment INTEGER DEFAULT 0",
  ]) {`);
    applied.push("FIX 2 — added frozen / vote_adjustment columns to nominees");
  } else {
    skipped.push("FIX 2 — ALTER TABLE anchor not found");
  }
}

// ─────────────────────────────────────────────────────────────────────
// FIX 3 — add nominee_actions audit table to initSchema
// ─────────────────────────────────────────────────────────────────────
{
  const marker = `    CREATE INDEX IF NOT EXISTS idx_email_log_user_id ON email_log(user_id);
  \`);`;
  if (src.includes("CREATE TABLE IF NOT EXISTS nominee_actions")) {
    skipped.push("FIX 3 — nominee_actions table already present");
  } else if (src.includes(marker)) {
    src = src.replace(marker,
`    CREATE INDEX IF NOT EXISTS idx_email_log_user_id ON email_log(user_id);
    CREATE TABLE IF NOT EXISTS nominee_actions (
      id TEXT PRIMARY KEY,
      nominee_id TEXT NOT NULL,
      action TEXT NOT NULL,
      performed_by TEXT,
      performed_at TEXT DEFAULT CURRENT_TIMESTAMP,
      old_votes INTEGER,
      new_votes INTEGER,
      old_adjustment INTEGER,
      new_adjustment INTEGER,
      reason TEXT,
      metadata TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_na_nominee ON nominee_actions(nominee_id);
    CREATE INDEX IF NOT EXISTS idx_na_performed ON nominee_actions(performed_at);
  \`);`);
    applied.push("FIX 3 — created nominee_actions audit table");
  } else {
    skipped.push("FIX 3 — email_log schema anchor not found");
  }
}

// ─────────────────────────────────────────────────────────────────────
// FIX 4a — preserve vote_adjustment in /api/votes normal-vote path
// ─────────────────────────────────────────────────────────────────────
{
  const target = `        await t.execute({
          sql: \`UPDATE nominees SET votes = (SELECT COUNT(*) FROM free_votes WHERE nominee_id = ?) + (SELECT COALESCE(SUM(votes_added), 0) FROM nominee_boosts WHERE nominee_id = ?) WHERE id = ?\`,
          args: [nominee.id, nominee.id, nominee.id],
        });
        return { ok: true };`;
  const fixed = `        await t.execute({
          sql: \`UPDATE nominees SET votes = (SELECT COUNT(*) FROM free_votes WHERE nominee_id = ?) + (SELECT COALESCE(SUM(votes_added), 0) FROM nominee_boosts WHERE nominee_id = ?) + COALESCE(vote_adjustment, 0) WHERE id = ?\`,
          args: [nominee.id, nominee.id, nominee.id],
        });
        return { ok: true };`;
  if (src.includes(fixed)) {
    skipped.push("FIX 4a — /api/votes normal path already has vote_adjustment");
  } else {
    replaceOnce("FIX 4a — /api/votes normal path now preserves vote_adjustment",
      target, fixed);
  }
}

// ─────────────────────────────────────────────────────────────────────
// FIX 4b — preserve vote_adjustment in completeTransaction's vote path
// (already present in your file, but ensure it stays)
// ─────────────────────────────────────────────────────────────────────
{
  const target = `        await t.execute({
          sql: \`UPDATE nominees SET votes = (SELECT COUNT(*) FROM free_votes WHERE nominee_id = ?) + (SELECT COALESCE(SUM(votes_added), 0) FROM nominee_boosts WHERE nominee_id = ?) WHERE id = ?\`,
          args: [txRow.nominee_id, txRow.nominee_id, txRow.nominee_id],
        });
        const upd = await t.get("SELECT votes FROM nominees WHERE id = ?", [
          txRow.nominee_id,
        ]);
        extra.votes = upd?.votes || 0;
        extra.nomineeId = txRow.nominee_id;
        extra.boosted = true;`;
  const fixed = `        await t.execute({
          sql: \`UPDATE nominees SET votes = (SELECT COUNT(*) FROM free_votes WHERE nominee_id = ?) + (SELECT COALESCE(SUM(votes_added), 0) FROM nominee_boosts WHERE nominee_id = ?) + COALESCE(vote_adjustment, 0) WHERE id = ?\`,
          args: [txRow.nominee_id, txRow.nominee_id, txRow.nominee_id],
        });
        const upd = await t.get("SELECT votes FROM nominees WHERE id = ?", [
          txRow.nominee_id,
        ]);
        extra.votes = upd?.votes || 0;
        extra.nomineeId = txRow.nominee_id;
        extra.boosted = true;`;
  if (src.includes(fixed)) {
    skipped.push("FIX 4b — boost_50 vote_adjustment already present");
  } else {
    replaceOnce("FIX 4b — boost_50 recalc now preserves vote_adjustment",
      target, fixed);
  }
}

// ─────────────────────────────────────────────────────────────────────
// FIX 5 — boost corrections:
//   • don't credit votes to a frozen nominee
//   • trust meta.votes when it matches a valid tier (race-condition fix)
// ─────────────────────────────────────────────────────────────────────
{
  const boostStart = `      } else if (txRow.type === "boost_50") {
        const boostCountNow = Number(
          (
            await t.get(
              "SELECT COUNT(*) AS c FROM nominee_boosts WHERE nominee_id = ?",
              [txRow.nominee_id],
            )
          )?.c || 0,
        );
        const isFirst = boostCountNow === 0;
        const expectedVotes = isFirst ? BOOST_FIRST_VOTES : BOOST_REPEAT_VOTES;
        const storedVotes = Number(meta.votes);
        const votesToAdd = Math.max(
          1,
          Math.min(
            Number.isFinite(storedVotes) && storedVotes > 0
              ? storedVotes
              : expectedVotes,
            expectedVotes,
          ),
        );
        await t.execute({
          sql: \`INSERT OR IGNORE INTO nominee_boosts (id, nominee_id, reference, votes_added) VALUES (?, ?, ?, ?)\`,
          args: [uuidv4(), txRow.nominee_id, reference, votesToAdd],
        });`;

  const boostFixed = `      } else if (txRow.type === "boost_50") {
        const frozenRow = await t.get(
          "SELECT frozen, name FROM nominees WHERE id = ?",
          [txRow.nominee_id],
        );
        if (Number(frozenRow?.frozen) === 1) {
          await t.execute({
            sql: "INSERT INTO payment_logs (reference, event, details) VALUES (?, 'boost_rejected_frozen', ?)",
            args: [
              reference,
              JSON.stringify({
                nominee_id: txRow.nominee_id,
                nominee_name: frozenRow?.name || null,
                note: "Payment succeeded but nominee is frozen; refund required",
              }),
            ],
          });
          extra.boostRejected = true;
          extra.boostRejectionReason = "nominee_frozen";
          extra.nomineeId = txRow.nominee_id;
        } else {
        const boostCountNow = Number(
          (
            await t.get(
              "SELECT COUNT(*) AS c FROM nominee_boosts WHERE nominee_id = ?",
              [txRow.nominee_id],
            )
          )?.c || 0,
        );
        const isFirst = boostCountNow === 0;
        const expectedVotes = isFirst ? BOOST_FIRST_VOTES : BOOST_REPEAT_VOTES;
        const storedVotes = Number(meta.votes);
        const validTierVotes = [BOOST_FIRST_VOTES, BOOST_REPEAT_VOTES];
        const votesToAdd = validTierVotes.includes(storedVotes)
          ? storedVotes
          : expectedVotes;
        await t.execute({
          sql: \`INSERT OR IGNORE INTO nominee_boosts (id, nominee_id, reference, votes_added) VALUES (?, ?, ?, ?)\`,
          args: [uuidv4(), txRow.nominee_id, reference, votesToAdd],
        });`;

  const boostEnd = `        extra.votes = upd?.votes || 0;
        extra.nomineeId = txRow.nominee_id;
        extra.boosted = true;
        extra.votesAdded = votesToAdd;
      } else if (txRow.type === "vote") {`;

  const boostEndFixed = `        extra.votes = upd?.votes || 0;
        extra.nomineeId = txRow.nominee_id;
        extra.boosted = true;
        extra.votesAdded = votesToAdd;
        }
      } else if (txRow.type === "vote") {`;

  if (src.includes("boost_rejected_frozen")) {
    skipped.push("FIX 5 — boost frozen check already present");
  } else if (src.includes(boostStart) && src.includes(boostEnd)) {
    src = src.replace(boostStart, boostFixed);
    src = src.replace(boostEnd, boostEndFixed);
    applied.push("FIX 5 — boost_50 now skips frozen nominees + tier race-condition fix");
  } else {
    skipped.push("FIX 5 — boost_50 anchor not found; manual fix required");
  }
}

// ─────────────────────────────────────────────────────────────────────
// Write & report
// ─────────────────────────────────────────────────────────────────────
if (src === original) {
  console.log("No changes applied — server.js unchanged.\n");
} else {
  fs.writeFileSync(FILE, src, "utf8");
  console.log("✓ server.js updated.\n");
}

console.log("APPLIED:");
if (applied.length === 0) console.log("  (none)");
applied.forEach((a) => console.log("  ✓ " + a));

console.log("\nSKIPPED:");
if (skipped.length === 0) console.log("  (none)");
skipped.forEach((s) => console.log("  · " + s));

console.log("\nNext steps:");
console.log("  1. node --check server.js    (verify syntax)");
console.log("  2. npm start");