const { pool, withTransaction } = require("./db");
const { HttpError } = require("./errors");

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function badRequest(code, message) {
  return new HttpError(400, code, message);
}

async function createShow({ name, seats, price_paise, per_user_limit }) {
  // --- validate input ---
  if (typeof name !== "string" || name.trim() === "") {
    throw badRequest("invalid_name", "name is required");
  }
  if (!Array.isArray(seats) || seats.length === 0) {
    throw badRequest("invalid_seats", "seats must be a non-empty list");
  }
  if (!seats.every((s) => typeof s === "string" && s.trim() !== "")) {
    throw badRequest("invalid_seats", "every seat must be a non-empty string");
  }
  if (!Number.isSafeInteger(price_paise) || price_paise < 0) {
    throw badRequest("invalid_price", "price_paise must be a whole number >= 0");
  }

  const limit = per_user_limit === undefined ? 4 : per_user_limit;
  if (!Number.isInteger(limit) || limit <= 0) {
    throw badRequest("invalid_limit", "per_user_limit must be a positive whole number");
  }

  const seatNames = seats.map((s) => s.trim());
  if (new Set(seatNames).size !== seatNames.length) {
    throw badRequest("duplicate_seats", "seat names must be unique");
  }

  // --- save the show and all its seats together ---
  return withTransaction(async (db) => {
    const result = await db.query(
      "INSERT INTO shows (name, price_paise, per_user_limit, total_seats) VALUES ($1, $2, $3, $4) RETURNING id",
      [name.trim(), price_paise, limit, seatNames.length]
    );
    const showId = result.rows[0].id;

    await db.query("INSERT INTO seats (show_id, seat_name) SELECT $1, unnest($2::text[])", [showId, seatNames]);

    return {
      id: showId,
      name: name.trim(),
      price_paise,
      per_user_limit: limit,
      total_seats: seatNames.length,
      available: seatNames.length,
      held: 0,
      confirmed: 0,
      seats: seatNames.map((seat) => ({ seat, status: "available" })),
    };
  });
}

async function getShow(showId) {
  if (!UUID_REGEX.test(showId)) {
    throw new HttpError(404, "show_not_found", "Show not found");
  }

  // One query, so the show and its seats are read at the same moment.
  const result = await pool.query(
    `SELECT s.id, s.name, s.price_paise, s.per_user_limit, s.total_seats, x.seat_name, x.status
      FROM shows s
      LEFT JOIN seats x ON x.show_id = s.id
      WHERE s.id = $1
      ORDER BY x.seat_name`,
    [showId]
  );

  if (result.rows.length === 0) {
    throw new HttpError(404, "show_not_found", "Show not found");
  }

  const show = result.rows[0];
  const counts = { available: 0, held: 0, confirmed: 0 };
  const seats = [];

  for (const row of result.rows) {
    counts[row.status]++;
    seats.push({ seat: row.seat_name, status: row.status });
  }

  return {
    id: show.id,
    name: show.name,
    price_paise: Number(show.price_paise),
    per_user_limit: show.per_user_limit,
    total_seats: show.total_seats,
    available: counts.available,
    held: counts.held,
    confirmed: counts.confirmed,
    seats,
  };
}

module.exports = { createShow, getShow, UUID_REGEX };
