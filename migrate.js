require("dotenv").config();
const Database = require("better-sqlite3");
const { createClient } = require("@libsql/client");

const local = new Database("voting.db", { readonly: true });
const remote = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

const TABLES = [
  "categories",
  "users",
  "nominees",
  "transactions",
  "leaderboard_access",
  "payment_logs",
  "admins",
  "free_votes",
  "images",
];
const clean = (v) => (v === undefined ? null : v);

(async () => {
  for (const t of TABLES) {
    let rows = [];
    try {
      rows = local.prepare(`SELECT * FROM ${t}`).all();
    } catch (e) {
      console.log(`${t}: skipped (${e.message})`);
      continue;
    }

    if (!rows.length) {
      console.log(`${t}: 0 rows`);
      continue;
    }
    const cols = Object.keys(rows[0]);
    const placeholders = cols.map(() => "?").join(",");
    const sql = `INSERT OR REPLACE INTO ${t} (${cols.join(",")}) VALUES (${placeholders})`;

    let ok = 0;
    for (const row of rows) {
      try {
        await remote.execute({ sql, args: cols.map((c) => clean(row[c])) });
        ok++;
      } catch (e) {
        console.error(`${t} row failed:`, e.message, row);
      }
    }
    console.log(`${t}: ${ok}/${rows.length} rows migrated`);
  }
  console.log(
    '\n✓ Done. Verify with: turso db shell votenet "SELECT COUNT(*) FROM nominees;"',
  );
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
