const crypto = require("crypto");
const { withTransaction } = require("./db");
const { HttpError } = require("./errors");
const { UUID_REGEX } = require("./shows");

function badRequest(code, message) {
  return new HttpError(400, code, message);
}

// Clean up the seat list. Sorted so every request locks seats in the same order
// (this prevents two requests from waiting on each other forever).
function cleanSeats(seats) {
  if (!Array.isArray(seats) || seats.length === 0) {
    throw badRequest("invalid_seats", "seats must be a non-empty list");
  }
  if (seats.length > 50) {
    throw badRequest("too_many_seats", "at most 50 seats per request");
  }
  if (!seats.every((s) => typeof s === "string" && s.trim() !== "")) {
    throw badRequest("invalid_seats", "every seat must be a non-empty string");
  }

  const names = seats.map((s) => s.trim());
  if (new Set(names).size !== names.length) {
    throw badRequest("duplicate_seats", "duplicate seats in request");
  }

  return names.sort();
}

function toResponse(row) {
  return {
    reservation_id: row.id,
    show_id: row.show_id,
    user_id: row.user_id,
    seats: row.seat_names,
    amount_paise: Number(row.amount_paise),
    status: row.status,
  };
}

// Reserve seats. All-or-nothing: either every seat is booked, or none are.
async function reserve({ showId, userId, seats, idempotencyKey }) {
  if (typeof idempotencyKey !== "string" || idempotencyKey.trim() === "") {
    throw badRequest("missing_idempotency_key", "send an Idempotency-Key header or idempotency_key field");
  }

  const seatNames = cleanSeats(seats);

  if (!UUID_REGEX.test(showId)) {
    throw new HttpError(404, "show_not_found", "Show not found");
  }

  // Fingerprint of the request, used to spot a reused key with different seats.
  const requestHash = crypto
    .createHash("sha256")
    .update(JSON.stringify([showId, seatNames]))
    .digest("hex");

  return withTransaction(async (db) => {
    // 1. Find the show.
    const showResult = await db.query(
      "SELECT price_paise, per_user_limit FROM shows WHERE id = $1",
      [showId]
    );
    if (showResult.rows.length === 0) {
      throw new HttpError(404, "show_not_found", "Show not found");
    }
    const show = showResult.rows[0];

    // 2. Idempotency: try to claim the key. If someone already claimed it,
    //    return their reservation (or reject if the request is different).
    const claim = await db.query(
      "INSERT INTO idempotency_keys (user_id, key, request_hash) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING RETURNING key",
      [userId, idempotencyKey, requestHash]
    );

    if (claim.rows.length === 0) {
      const old = await db.query(
        `SELECT k.request_hash, r.*
          FROM idempotency_keys k
          JOIN reservations r ON r.id = k.reservation_id
          WHERE k.user_id = $1 AND k.key = $2`,
        [userId, idempotencyKey]
      );

      if (old.rows[0].request_hash !== requestHash) {
        throw new HttpError(409, "idempotency_key_reuse", "This key was already used for a different request");
      }
      return { replayed: true, reservation: toResponse(old.rows[0]) };
    }

    // 3. Only one request per user+show at a time, so the limit check is safe.
    await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
      `${showId}:${userId}`,
    ]);

    // 4. Lock the seats we want. Anyone else wanting them waits here.
    const seatResult = await db.query(
      `SELECT seat_name, status FROM seats
        WHERE show_id = $1 AND seat_name = ANY($2)
        ORDER BY seat_name
        FOR UPDATE`,
      [showId, seatNames]
    );

    if (seatResult.rows.length !== seatNames.length) {
      const found = seatResult.rows.map((r) => r.seat_name);
      const missing = seatNames.filter((name) => !found.includes(name));
      throw new HttpError(404, "seat_not_found", "Unknown seat(s)", { seats: missing });
    }

    const taken = seatResult.rows
      .filter((r) => r.status !== "available")
      .map((r) => r.seat_name);

    if (taken.length > 0) {
      throw new HttpError(409, "seat_unavailable", "Seat(s) already taken, nothing was reserved", { seats: taken });
    }

    // 5. Check the per-user limit.
    const owned = await db.query(
      "SELECT count(*)::int AS n FROM seats WHERE show_id = $1 AND user_id = $2",
      [showId, userId]
    );
    const alreadyHeld = owned.rows[0].n;

    if (alreadyHeld + seatNames.length > show.per_user_limit) {
      throw new HttpError(409, "limit_exceeded", `Limit is ${show.per_user_limit} seats per user`, {
        limit: show.per_user_limit,
        held: alreadyHeld,
      });
    }

    // 6. Save the reservation and mark the seats as confirmed.
    const amount = BigInt(show.price_paise) * BigInt(seatNames.length);

    const created = await db.query(
      "INSERT INTO reservations (show_id, user_id, seat_names, amount_paise, status) VALUES ($1, $2, $3, $4, 'confirmed') RETURNING *",
      [showId, userId, seatNames, amount.toString()]
    );
    const reservation = created.rows[0];

    await db.query(
      "UPDATE seats SET status = 'confirmed', user_id = $3, reservation_id = $4 WHERE show_id = $1 AND seat_name = ANY($2)",
      [showId, seatNames, userId, reservation.id]
    );

    await db.query(
      "UPDATE idempotency_keys SET reservation_id = $3 WHERE user_id = $1 AND key = $2",
      [userId, idempotencyKey, reservation.id]
    );

    return { replayed: false, reservation: toResponse(reservation) };
  });
}

// Cancel a reservation. Only the owner can do it. Safe to call more than once.
async function cancel({ reservationId, userId }) {
  if (!UUID_REGEX.test(reservationId)) {
    throw new HttpError(404, "reservation_not_found", "Reservation not found");
  }

  return withTransaction(async (db) => {
    const result = await db.query(
      "SELECT * FROM reservations WHERE id = $1 FOR UPDATE",
      [reservationId]
    );

    if (result.rows.length === 0) {
      throw new HttpError(404, "reservation_not_found", "Reservation not found");
    }

    const reservation = result.rows[0];

    if (reservation.user_id !== userId) {
      throw new HttpError(403, "forbidden", "Only the owner can cancel this reservation");
    }

    if (reservation.status === "confirmed") {
      // Only free seats that still belong to THIS reservation.
      await db.query(
        "UPDATE seats SET status = 'available', user_id = NULL, reservation_id = NULL WHERE reservation_id = $1",
        [reservationId]
      );
      await db.query(
        `UPDATE reservations SET status = 'cancelled', cancelled_at = $2  WHERE id = $1`,
        [reservationId, new Date()]
      );
      reservation.status = "cancelled";
    }

    return toResponse(reservation);
  });
}

module.exports = { reserve, cancel };
