const Database = require("better-sqlite3");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { v4: uuidv4 } = require("uuid");

const oldPath = process.argv[2];
const snapPath = process.argv[3];
const apply = process.argv.includes("--apply");

if (!oldPath || !snapPath) {
  console.error("Usage: node reshape.js <old-db> <snapshot.json> [--apply]");
  process.exit(2);
}
if (!fs.existsSync(oldPath)) {
  console.error("Old DB not found: " + oldPath);
  process.exit(2);
}
if (!fs.existsSync(snapPath)) {
  console.error("Snapshot not found: " + snapPath);
  process.exit(2);
}

// ── Load hosted target from snapshot ────────────────────────────────────────
const snap = JSON.parse(fs.readFileSync(snapPath, "utf8"));
const hosted = new Map();
let hostedTotal = 0;
for (const cat of snap.categories || []) {
  for (const n of cat.nominees || []) {
    hosted.set(n.code, Number(n.votes) || 0);
    hostedTotal += Number(n.votes) || 0;
  }
}
console.log(
  "Hosted target: " +
    hostedTotal.toLocaleString() +
    " votes / " +
    hosted.size +
    " nominees",
);

// ── Copy base DB to reshaped/ ───────────────────────────────────────────────
const OUT = "reshaped";
if (!fs.existsSync(OUT)) fs.mkdirSync(OUT);
const outPath = path.join(OUT, "voting-local.db");

if (apply) {
  if (fs.existsSync(outPath))
    fs.renameSync(outPath, outPath + "." + Date.now() + ".bak");
  fs.copyFileSync(oldPath, outPath);
  for (const e of ["-wal", "-shm"]) {
    try {
      fs.unlinkSync(outPath + e);
    } catch {}
  }
  console.log("Base copied -> " + outPath);
}

const db = apply
  ? new Database(outPath)
  : new Database(oldPath, { readonly: true });

// ── Ensure required columns exist (old DBs predate some migrations) ─────────
if (apply) {
  const migrations = [
    "ALTER TABLE free_votes ADD COLUMN device_hash TEXT",
    "ALTER TABLE free_votes ADD COLUMN ip TEXT",
    "ALTER TABLE free_votes ADD COLUMN category_id TEXT",
    "ALTER TABLE free_votes ADD COLUMN user_agent TEXT",
    "ALTER TABLE free_votes ADD COLUMN fingerprint_json TEXT",
    "ALTER TABLE free_votes ADD COLUMN is_appeal INTEGER DEFAULT 0",
    "ALTER TABLE free_votes ADD COLUMN fingerprint_hash TEXT",
    "ALTER TABLE nominees ADD COLUMN stage TEXT DEFAULT 'preliminaries'",
    "ALTER TABLE nominees ADD COLUMN eliminated INTEGER DEFAULT 0",
    "ALTER TABLE nominees ADD COLUMN eliminated_stage TEXT",
    "ALTER TABLE nominees ADD COLUMN qualified_at TEXT",
    "ALTER TABLE nominees ADD COLUMN final_rank INTEGER",
  ];
  for (const sql of migrations) {
    try {
      db.exec(sql);
    } catch (e) {
      /* column already exists */
    }
  }
  console.log("Schema migrations applied");
}

// ── Read current nominees and build plan ────────────────────────────────────
const noms = db
  .prepare(
    "SELECT n.id, n.code, n.category_id, COALESCE(n.votes,0) AS stored, " +
      "(SELECT COUNT(*) FROM free_votes WHERE nominee_id = n.id) AS free_count, " +
      "(SELECT COALESCE(SUM(votes_added),0) FROM nominee_boosts WHERE nominee_id = n.id) AS boost_sum " +
      "FROM nominees n",
  )
  .all();

let toAdd = 0,
  toSub = 0,
  keep = 0,
  missing = 0;
const plan = [];
for (const n of noms) {
  const target = hosted.get(n.code);
  if (target === undefined) {
    missing++;
    plan.push({
      id: n.id,
      code: n.code,
      target: 0,
      delta: -n.free_count,
      free_count: n.free_count,
      boost_sum: n.boost_sum,
      cat: n.category_id,
      action: "not-in-hosted",
    });
    continue;
  }
  const delta = target - (n.free_count + n.boost_sum);
  const action =
    delta === 0 ? "keep" : delta > 0 ? "+" + delta + " free" : delta + " free";
  if (delta > 0) toAdd++;
  else if (delta < 0) toSub++;
  else keep++;
  plan.push({
    id: n.id,
    code: n.code,
    target,
    delta,
    free_count: n.free_count,
    boost_sum: n.boost_sum,
    cat: n.category_id,
    action,
  });
}

console.log("\ncode           hosted  stored  free  boost  action");
for (const p of plan.slice(0, 15)) {
  const n = noms.find((x) => x.code === p.code);
  console.log(
    p.code.padEnd(14) +
      " " +
      String(hosted.get(p.code) ?? "-").padStart(6) +
      " " +
      String(n.stored).padStart(7) +
      " " +
      String(n.free_count).padStart(5) +
      " " +
      String(n.boost_sum).padStart(5) +
      "  " +
      p.action,
  );
}
if (plan.length > 15) console.log("... and " + (plan.length - 15) + " more");

console.log(
  "\nPlan: " +
    keep +
    " keep, " +
    toAdd +
    " add, " +
    toSub +
    " reduce, " +
    missing +
    " not-in-hosted",
);

if (!apply) {
  console.log(
    "\nDRY RUN — re-run with --apply to write reshaped/voting-local.db",
  );
  process.exit(0);
}

// ── Apply ───────────────────────────────────────────────────────────────────
console.log("\nApplying...");
const ins = db.prepare(
  "INSERT INTO free_votes (id, voter_token, nominee_id, device_hash, ip, category_id, created_at, fingerprint_hash, is_appeal) " +
    "VALUES (?,?,?,?,?,?,?,?,0)",
);
const delV = db.prepare(
  "DELETE FROM free_votes WHERE id IN (SELECT id FROM free_votes WHERE nominee_id = ? ORDER BY created_at ASC LIMIT ?)",
);
const delB = db.prepare("DELETE FROM nominee_boosts WHERE nominee_id = ?");
const upd = db.prepare("UPDATE nominees SET votes = ? WHERE id = ?");
const now = new Date().toISOString();

const warnings = [];

// ─────────────────────────────────────────────────────────────────────────────
// CRITICAL BUG FIX:
//   db.transaction(fn) RETURNS a wrapper function; it does NOT execute fn.
//   The previous version was missing the trailing () so no writes ever ran.
//
//   I assign the wrapper to applyTx and then invoke it with applyTx() below.
// ─────────────────────────────────────────────────────────────────────────────
const applyTx = db.transaction(() => {
  for (const p of plan) {
    if (p.action === "not-in-hosted") {
      delV.run(p.id, 999999);
      delB.run(p.id);
      upd.run(0, p.id);
      continue;
    }

    if (p.delta > 0) {
      // Need more votes: synthesize free_votes rows.
      // Use uuidv4 for voter_token so re-running reshape never collides with
      // previously-synthesized rows (UNIQUE(voter_token, nominee_id)).
      for (let i = 0; i < p.delta; i++) {
        ins.run(
          uuidv4(),
          "vt_r_" + uuidv4(),
          p.id,
          crypto
            .createHash("sha256")
            .update("dev_" + p.id + "_" + i + "_" + uuidv4())
            .digest("hex")
            .slice(0, 32),
          "0.0.0.0",
          p.cat,
          now,
          crypto
            .createHash("sha256")
            .update("fp_" + p.id + "_" + i + "_" + uuidv4())
            .digest("hex")
            .slice(0, 32),
        );
      }
    } else if (p.delta < 0) {
      // Need fewer votes: trim free_votes first, then boosts.
      const need = -p.delta;
      const canRemove = Math.min(need, p.free_count);
      if (canRemove > 0) delV.run(p.id, canRemove);

      const stillNeed = need - canRemove;
      if (stillNeed > 0) {
        if (p.boost_sum > 0) {
          // Remove whole boost records until under target.
          let remaining = p.boost_sum;
          const targetBoost = p.boost_sum - stillNeed;
          const boostRows = db
            .prepare(
              "SELECT id, votes_added FROM nominee_boosts WHERE nominee_id = ? ORDER BY created_at DESC",
            )
            .all(p.id);
          for (const b of boostRows) {
            if (remaining <= targetBoost) break;
            db.prepare("DELETE FROM nominee_boosts WHERE id = ?").run(b.id);
            remaining -= b.votes_added;
          }
          if (remaining > targetBoost) {
            warnings.push(
              p.code +
                ": couldn't reduce boost enough (" +
                remaining +
                " > " +
                targetBoost +
                ")",
            );
          }
        } else {
          warnings.push(
            p.code + ": not enough free_votes/boosts to reduce by " + need,
          );
        }
      }
    }

    upd.run(p.target, p.id);
  }
});

applyTx(); // ← THE FIX: invoke the transaction wrapper

// Update stage to finals (matches hosted)
try {
  db.prepare(
    "UPDATE election_stages SET current_stage = 'finals', updated_at = CURRENT_TIMESTAMP WHERE id = 1",
  ).run();
  console.log("Stage set to finals");
} catch (e) {
  warnings.push("Could not update stage: " + e.message);
}

// ── Verify ──────────────────────────────────────────────────────────────────
const finalV = db
  .prepare("SELECT SUM(COALESCE(votes,0)) t FROM nominees")
  .get().t;
const finalF = db.prepare("SELECT COUNT(*) c FROM free_votes").get().c;
const finalB = db
  .prepare("SELECT COALESCE(SUM(votes_added),0) t FROM nominee_boosts")
  .get().t;
const finalM = db
  .prepare(
    "SELECT COUNT(*) c FROM nominees n WHERE COALESCE(n.votes,-1) != " +
      "(SELECT COUNT(*) FROM free_votes WHERE nominee_id=n.id) + " +
      "COALESCE((SELECT SUM(votes_added) FROM nominee_boosts WHERE nominee_id=n.id),0)",
  )
  .get().c;

console.log("\n━━━ RESULT ━━━");
console.log(
  "SUM(votes):   " +
    finalV.toLocaleString() +
    "  (hosted: " +
    hostedTotal.toLocaleString() +
    ")",
);
console.log("free_votes:   " + finalF.toLocaleString());
console.log("boosts:       " + finalB.toLocaleString() + " votes");
console.log("computed:     " + (finalF + finalB).toLocaleString());
console.log("mismatches:   " + finalM);

if (warnings.length) {
  console.log("\n⚠ Warnings:");
  for (const w of warnings) console.log("  " + w);
}

if (finalV === hostedTotal && finalM === 0) {
  console.log("\n✓ SUCCESS — matches hosted and internally consistent");
} else {
  console.log("\n⚠ Check above for discrepancies");
}

db.close();
