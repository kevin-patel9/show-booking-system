const app = require("./app");
const { setupDatabase } = require("./db");

const PORT = Number(process.env.PORT || 8080);

// The database may still be starting, so try a few times.
async function waitForDatabase() {
  for (let attempt = 1; attempt <= 10; attempt++) {
    try {
      await setupDatabase();
      console.log("connected to DB");
      return;
    } catch (err) {
      console.log("Waiting for database...", err.message);
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  throw new Error("Could not connect to the database");
}

waitForDatabase().then(() => {
      app.listen(PORT, "0.0.0.0", () => console.log(`Server running on port ${PORT}`));
  })
  .catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
