# Write-up

## 1. The atomic decision

Each reservation is **one PostgreSQL transaction** (`reserve()` in `src/reservations.js`). 
It locks the requested seat rows with `SELECT ... WHERE seat_name = ANY($2) ORDER BY seat_name FOR UPDATE` and reads their status *under the lock*. If any seat is not `available`, it returns `409 seat_unavailable` and rolls back. Otherwise it confirms the seats, inserts the reservation and commits.

**Why it is race-free:** two buyers of A12 both reach the lock and one waits. The winner commits `confirmed`; the waiter wakes up, re-reads the committed row (READ COMMITTED), sees `confirmed` and gets a clean 409. The schema backs this up with `PRIMARY KEY (show_id, seat_name)` and a `CHECK` that a seat is `available` exactly when it has no owner.

**Multi-seat** requests are all-or-nothing (any decline rolls everything back). 
**Deadlock:** every request locks seats in the same order (`ORDER BY seat_name`), so `[A1,A2]` and `[A2,A1]` both lock A1 first and cannot wait on each other. `withTransaction` also retries a deadlock up to 3 times.

**Per-user limit:** `pg_advisory_xact_lock(showId:userId)` makes one user's requests for one show run one at a time, so counting the seats they hold is safe.

**Evidence** (`npm run burst`, PostgreSQL 16): 500 users on one seat give 1 `201` and 499 `409`; 40 parallel requests from one user end with 4 seats; a 5,000-request stampede gives zero 5xx and no seat sold twice; `available + held + confirmed == total_seats` holds after every scenario.

## 2. Idempotency

Keys live in the table `idempotency_keys`: `PRIMARY KEY (user_id, key)`, plus a `request_hash` (SHA-256 of the show and the sorted seats) and the `reservation_id`. The first step of a reserve inserts the key with `ON CONFLICT DO NOTHING`, **in the same transaction as the booking**, so the key and the reservation commit or roll back together. A concurrent duplicate waits on the unique index, then finds the key taken.

- Same key, same seats: the original reservation is returned, never a second booking.
- Same key, different seats: `409 idempotency_key_reuse`.
- A declined request leaves no key, so it can be retried once the seat is free.

## 3. Holds and expiry

Explicit cancel: `POST /reservations/:id/cancel`. Owner only (`403` otherwise) and safe to repeat. It frees only seats whose `reservation_id` is that reservation, so an old cancel can never free a seat someone else now holds. There is no expiry, and `held` is always 0.

## 4. Consistency vs availability

PostgreSQL is the only place a decision is made; the app holds no seat state. If the database is unreachable the service writes nothing and never answers from a cache, so it **chooses consistency**: `/healthz` returns `503`, and waits are bounded (lock timeout 10 s, statement timeout 30 s, then `503 busy`). The cost: one primary is a single point of availability, and an asynchronous failover could lose the last few commits.

## 5. Observability and 2am paging

`GET /metrics`: `reservations_confirmed_total`; `reservations_declined_total{reason}` (`seat_taken`, `per_user_limit`, `idempotent_replay`, `idempotency_conflict`); `seats_available{show_id}` (read from the database on each scrape); `db_pool_connections{state}`; `http_requests_total`; `http_request_duration_seconds`. The burst script checks they match what the clients saw.

## 6. AI usage

- **Tools:** Claude and ChatGPT.
- **Written with AI help:** the migration file (Claude); 
        error handling and the database connection setup (Claude); 
        the burst script for double booking; the Docker setup; 
        the main booking transaction; 
        and the metrics (Claude: stampede counters, seats available, database pool state, HTTP counts, plus the burst check that compares them with the clients).
        
- **What I directed and decided:** *(fill in: the design I chose and what I changed or rejected.)*
- **What I can explain unaided:** *(fill in: why sorted lock order prevents deadlock, why the limit needs the advisory lock, what a duplicate key waits on.)*
- **Verified:** the burst, including the metrics checks, passed against a real PostgreSQL 16 with the app run directly under Node. The Docker build and the live deployment were not run by the AI. *(Replace with your own results and live URL.)*