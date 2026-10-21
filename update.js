// restore-images.js — one-shot script to re-insert lost images
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const db = require("./db");

// Filenames in the SAME folder as this script
const IMAGES = [
  "01fa22f5-a953-48fe-b9ee-4f21d4891982.jpeg",
  "ca7138b0-0f86-411b-85f7-31f6f5510912.jpeg",
];

(async () => {
  console.log("→ Verifying local schema…");
  try {
    await db.prepare("SELECT 1 FROM images LIMIT 1").get();
    console.log("  ✓ images table exists locally");
  } catch (e) {
    console.error("  ✗ images table missing locally:", e.message);
    console.error(
      "    Start the server once so initSchema() creates it, then rerun this script.",
    );
    process.exit(1);
  }

  console.log("\n→ Inserting images into local DB…");
  let inserted = 0;
  for (const filename of IMAGES) {
    const filepath = path.join(__dirname, filename);
    if (!fs.existsSync(filepath)) {
      console.error(`  ✗ Missing file: ${filepath}`);
      continue;
    }

    const id = filename.replace(/\.(jpe?g|png|webp|gif)$/i, "");
    const data = fs.readFileSync(filepath);

    // Detect mime from extension
    let mime = "image/jpeg";
    if (/\.png$/i.test(filename)) mime = "image/png";
    else if (/\.webp$/i.test(filename)) mime = "image/webp";
    else if (/\.gif$/i.test(filename)) mime = "image/gif";

    await db
      .prepare(
        "INSERT OR REPLACE INTO images (id, data, mime, size) VALUES (?, ?, ?, ?)",
      )
      .run(id, data, mime, data.length);

    console.log(
      `  ✓ ${id}  (${Math.round(data.length / 1024)} KB, ${mime})`,
    );
    inserted++;
  }

  if (inserted === 0) {
    console.error("\n✗ Nothing was inserted. Check the filenames.");
    process.exit(1);
  }

  console.log("\n→ Pushing to Turso cloud…");
  try {
    const { pushed } = await db.push();
    console.log(`  ✓ Pushed ${pushed} row(s)`);
  } catch (e) {
    console.error("  ✗ Turso push failed:", e.message);
    console.error(
      "    The images are safe locally but won't survive a Render deploy.",
    );
    console.error(
      "    Make sure you deployed the latest server.js (with ensureRemoteSchema).",
    );
    process.exit(1);
  }

  console.log("\n→ Verifying…");
  for (const filename of IMAGES) {
    const id = filename.replace(/\.(jpe?g|png|webp|gif)$/i, "");
    const row = await db
      .prepare("SELECT id, size, mime FROM images WHERE id = ?")
      .get(id);
    if (row) {
      console.log(
        `  ✓ ${row.id}  ${row.size} bytes  ${row.mime}`,
      );
    } else {
      console.error(`  ✗ ${id} not found after insert`);
    }
  }

  console.log(
    "\n✓ Done. Test in a browser:\n" +
      "    https://gala.voteus.xyz/api/images/01fa22f5-a953-48fe-b9ee-4f21d4891982\n" +
      "    https://gala.voteus.xyz/api/images/ca7138b0-0f86-411b-85f7-31f6f5510912\n",
  );

  process.exit(0);
})().catch((e) => {
  console.error("\n✗ Fatal:", e);
  process.exit(1);
});
