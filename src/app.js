const express = require("express");
const { pool } = require("./db");
const { HttpError } = require("./errors");
const { requireUser, requireAdmin } = require("./auth");
const shows = require("./shows");
const reservations = require("./reservations");

const app = express();
app.use(express.json({ limit: "2mb" }));

// Health check
app.get("/healthz", async (req, res) => {
  try {
    await pool.query("SELECT 1");
    res.status(200).send({ status: "ok" });
  } catch (err) {
    res.status(503).send({ status: "database_unavailable" });
  }
});

// Create a show (admin only)
app.post("/shows", requireAdmin, async (req, res, next) => {
  try {
    const show = await shows.createShow(req.body || {});
    res.status(201).send(show);
  } catch (err) {
    next(err);
  }
});

// Show state
app.get("/shows/:showId", async (req, res, next) => {
  try {
    res.status(200).send(await shows.getShow(req.params.showId));
  } catch (err) {
    next(err);
  }
});

// Reserve seats
app.post("/shows/:showId/reserve", requireUser, async (req, res, next) => {
  try {
    const body = req.body || {};

    const result = await reservations.reserve({
      showId: req.params.showId,
      userId: req.userId,
      seats: body.seats,
      idempotencyKey: req.get("Idempotency-Key") || body.idempotency_key,
    });

    res.status(201).json(result.reservation);
  } catch (err) {
    next(err);
  }
});

// Cancel a reservation
app.post("/reservations/:reservationId/cancel", requireUser, async (req, res, next) => {
  try {
    const reservation = await reservations.cancel({
      reservationId: req.params.reservationId,
      userId: req.userId,
    });

    res.status(200).send(reservation);
  } catch (err) {
    next(err);
  }
});

// Unknown route
app.use((req, res, next) => {
  next(new HttpError(404, "not_found", "Route not found"));
});

// Error handler: turns errors into JSON responses
app.use((err, req, res, next) => {
  if (err instanceof HttpError) {
    return res.status(err.status).json({ error: err.code, message: err.message, ...err.extra });
  }

  if (err.type === "entity.parse.failed") {
    return res.status(400).json({ error: "bad_request", message: "Invalid JSON" });
  }

  // Database too busy or waiting too long: ask the client to retry.
  if (err.code === "55P03" || err.code === "57014") {
    res.set("Retry-After", "1");
    return res.status(503).json({ error: "busy", message: "Please retry" });
  }

  console.error(err);
  res.status(500).json({ error: "internal_error", message: "Something went wrong" });
});

module.exports = app;
