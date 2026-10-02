// How the numbers reconcile with what a client sees on POST /shows/:id/reserve:
//   201 responses == reservations_confirmed_total + declined{idempotent_replay}   (a replay returns the original reservation, also 201)
//   409 seat_unavailable      == declined{seat_taken}
//   409 limit_exceeded        == declined{per_user_limit}
//   409 idempotency_key_reuse == declined{idempotency_conflict}
const client = require("prom-client");
const { pool, observabilityPool } = require("./db");

const registry = new client.Registry();
client.collectDefaultMetrics({ register: registry });

// ---- reservations ----
const confirmedTotal = new client.Counter({
  name: "reservations_confirmed_total",
  help: "Reservations newly confirmed",
  registers: [registry],
});

const declinedTotal = new client.Counter({
  name: "reservations_declined_total",
  help: "Reserve requests that created nothing, by reason",
  labelNames: ["reason"],
  registers: [registry],
});

// API error code -> metric reason
const DECLINE_REASONS = {
  seat_unavailable: "seat_taken",
  limit_exceeded: "per_user_limit",
  idempotency_key_reuse: "idempotency_conflict",
};
for (const reason of [...Object.values(DECLINE_REASONS), "idempotent_replay"]) {
  declinedTotal.inc({ reason }, 0); // every reason shows up as 0 from the start
}

// These are called by the reserve route, after the transaction has finished, so a retried
// (deadlock) or rolled-back transaction can never be counted twice.
function reservationConfirmed() {
  confirmedTotal.inc();
}

function reservationReplayed() {
  declinedTotal.inc({ reason: "idempotent_replay" });
}

// Counts a 409 decline. Validation errors (400), unknown ids (404) and real faults (5xx) are not declines.
function reservationFailed(err) {
  const reason = err && err.status === 409 && DECLINE_REASONS[err.code];
  if (reason) declinedTotal.inc({ reason });
}

// ---- seats ----
new client.Gauge({
  name: "seats_available",
  help: "Seats still available, per show",
  labelNames: ["show_id"],
  registers: [registry],
  async collect() {
    this.reset();
    try {
      const { rows } = await observabilityPool.query(
        "SELECT show_id, count(*) FILTER (WHERE status = 'available')::int AS available FROM seats GROUP BY show_id"
      );
      for (const row of rows) this.set({ show_id: row.show_id }, row.available);
    } catch (err) {
      // Database down: report no seats rather than a stale number (and don't break the scrape).
      console.error("seats_available: database unavailable:", err.message);
    }
  },
});

// ---- database pool ----
new client.Gauge({
  name: "db_pool_connections",
  help: "Database connections in the main pool, by state",
  labelNames: ["state"],
  registers: [registry],
  collect() {
    this.set({ state: "total" }, pool.totalCount);
    this.set({ state: "idle" }, pool.idleCount);
    this.set({ state: "waiting" }, pool.waitingCount);
  },
});

// ---- http ----
const httpRequests = new client.Counter({
  name: "http_requests_total",
  help: "HTTP responses by method, route and status",
  labelNames: ["method", "route", "status"],
  registers: [registry],
});

const httpDuration = new client.Histogram({
  name: "http_request_duration_seconds",
  help: "HTTP request duration in seconds",
  labelNames: ["method", "route"],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [registry],
});

// Express middleware. The label is the route pattern (/shows/:showId/reserve), never the real URL,
// so thousands of show ids can't create thousands of series.
function httpMetrics(req, res, next) {
  const stop = httpDuration.startTimer();
  res.on("finish", () => {
    const route = req.route ? req.route.path : "unmatched";
    stop({ method: req.method, route });
    httpRequests.inc({ method: req.method, route, status: String(res.statusCode) });
  });
  next();
}

module.exports = { registry, httpMetrics, reservationConfirmed, reservationReplayed, reservationFailed };
