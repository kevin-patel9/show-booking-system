const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");

const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL || "postgres://kevinpatel:password@localhost:5432/tickets",
  max: Number(process.env.DB_POOL_SIZE || 50),
  connectionTimeoutMillis: 15000,
  options: "-c lock_timeout=10000 -c statement_timeout=30000",
});

// Run a function inside a transaction. Commits on success, rolls back on error.
// Retries if Postgres reports a deadlock.
async function withTransaction(work) {
  for (let attempt = 1; ; attempt++) {
    const client = await pool.connect();

    try {
      await client.query("BEGIN");
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});

      const isDeadlock = err.code === "40P01";
      if (isDeadlock && attempt < 3) continue;

      throw err;
    } finally {
      client.release();
    }
  }
}

// Create the tables if they don't exist yet.
async function setupDatabase() {
  const sql = fs.readFileSync(
    path.join(__dirname, "..", "migrations", "001_init.sql"),
    "utf8"
  );
  await pool.query(sql);
}

module.exports = { pool, withTransaction, setupDatabase };