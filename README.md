# Seat Booking API

Node.js + Express + PostgreSQL. Sells assigned seats without ever double-selling.

## Run

    docker compose up --build

API runs at http://localhost:3000. Tables are created automatically.
Settings (env vars): `DATABASE_URL`, `ADMIN_TOKEN` (default `dev-admin`), `PORT`, `DB_POOL_SIZE`.

## Auth

Send `Authorization: Bearer <token>`.
- `ADMIN_TOKEN` can create shows.
- Any other token is a user. The token is the user id.

## Endpoints

| Method | Path | Who | Purpose |
|---|---|---|---|
| POST | /shows | admin | create a show |
| GET | /shows/:id | anyone | seat status and counts |
| POST | /shows/:id/reserve | user | reserve seats |
| POST | /reservations/:id/cancel | owner | cancel and free the seats |
| GET | /healthz | anyone | health check |

Reserve body: `{ "seats": ["A12"], "idempotency_key": "abc" }` (or an `Idempotency-Key` header).

## Rules

- A seat can only go to one person. Losers get `409 seat_unavailable`.
- Multi-seat requests are all-or-nothing.
- Max seats per user per show: `per_user_limit` (default 4), otherwise `409 limit_exceeded`.
- Same idempotency key = same reservation returned. Same key with different seats = `409`.
- Cancelling frees only that reservation's seats.
- Seats are confirmed immediately, so `held` is always 0.

## Test

    npm run burst
