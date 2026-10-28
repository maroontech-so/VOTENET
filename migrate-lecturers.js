require("dotenv").config();
const db = require("./db");
const { v4: uuidv4 } = require("uuid");

const TARGET_CATEGORY = "BEST DIPLOMA LECTURER OF THE YEAR";
const CODES_TO_MOVE = ["VOTE_MK843", "VOTE_MK685"];

(async () => {
  try {
    console.log(`\n⏳ Starting migration to "${TARGET_CATEGORY}"...\n`);

    // 1. Find or create the target category
    let category = await db.prepare("SELECT id FROM categories WHERE name = ?").get(TARGET_CATEGORY);
    let catId;
    
    if (!category) {
      catId = uuidv4();
      await db.prepare("INSERT INTO categories (id, name) VALUES (?, ?)").run(catId, TARGET_CATEGORY);
      console.log(`✓ Created new category: ${TARGET_CATEGORY} (ID: ${catId})`);
    } else {
      catId = category.id;
      console.log(`✓ Found existing category: ${TARGET_CATEGORY} (ID: ${catId})`);
    }

    // 2. Move the nominees
    for (const code of CODES_TO_MOVE) {
      const nominee = await db.prepare("SELECT id, name, votes FROM nominees WHERE code = ?").get(code);
      
      if (!nominee) {
        console.log(`✗ Nominee not found: ${code} — skipping`);
        continue;
      }

      // Update just the nominee's current category
      await db.prepare("UPDATE nominees SET category_id = ? WHERE id = ?").run(catId, nominee.id);
      
      console.log(`✓ Moved ${nominee.name} (${code}) with ${nominee.votes} votes to the new category.`);
    }

    // 3. Push the changes to Turso Cloud
    console.log(`\n⏳ Pushing changes to Turso cloud...`);
    const { pushed } = await db.push();
    console.log(`✓ Successfully pushed ${pushed} write(s) to Turso.`);
    console.log(`\n🎉 Migration complete. The changes are live!\n`);

  } catch (e) {
    console.error(`\n✗ Migration failed:`, e.message);
    console.error(e.stack);
  }
  process.exit(0);
})();
