// Usage: BASE_URL=http://localhost:3000 ADMIN_TOKEN=dev-admin node scripts/burst.js [stampedeUsers]
const BASE = process.env.BASE_URL || "http://localhost:8080";
const ADMIN = process.env.ADMIN_TOKEN || "dev-admin";
const STAMPEDE = Number(process.argv[2] || 5000);
let failures = 0;
const RUN = Date.now().toString(36); // makes users and keys unique on every run
const check = (ok, msg) => { console.log(`${ok ? "PASS" : "FAIL"}  ${msg}`); if (!ok) failures++; };

async function call(method, path, token, body, headers = {}) {
  if (token && token !== ADMIN) token = `${RUN}-${token}`;
  if (body && body.idempotency_key) body = { ...body, idempotency_key: `${RUN}-${body.idempotency_key}` };
  if (headers["Idempotency-Key"]) headers = { ...headers, "Idempotency-Key": `${RUN}-${headers["Idempotency-Key"]}` };
  const r = await fetch(BASE + path, {
    method, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null; try { json = await r.json(); } catch (_) {}
  return { status: r.status, json };
}
const tally = (rs) => rs.reduce((a, r) => ((a[r.status] = (a[r.status] || 0) + 1), a), {});
const mkShow = (n, extra = {}) => call("POST", "/shows", ADMIN,
  { name: "t" + Date.now(), seats: Array.from({ length: n }, (_, i) => `S${i + 1}`), price_paise: 25000, ...extra }).then((r) => r.json);
async function invariant(id, label) {
  const s = (await call("GET", `/shows/${id}`)).json;
  check(s.available + s.held + s.confirmed === s.total_seats, `${label}: available+held+confirmed == total_seats (${s.available}+${s.held}+${s.confirmed}=${s.total_seats})`);
  return s;
}

(async () => {
  // 1. hot seat
  let show = await mkShow(100);
  let rs = await Promise.all(Array.from({ length: 500 }, (_, i) =>
    call("POST", `/shows/${show.id}/reserve`, `hot-${i}`, { seats: ["S12"], idempotency_key: `k${i}` })));
  let t = tally(rs);
  check(t[201] === 1 && t[409] === 499 && Object.keys(t).length === 2, `hot seat: 500 racers -> ${JSON.stringify(t)}`);
  let s = await invariant(show.id, "hot seat"); check(s.confirmed === 1, "hot seat: exactly 1 confirmed");

  // 2. per-user limit under concurrency (same user, different keys, overlapping and distinct seats)
  show = await mkShow(100);
  rs = await Promise.all(Array.from({ length: 40 }, (_, i) =>
    call("POST", `/shows/${show.id}/reserve`, "greedy", { seats: [`S${i + 1}`], idempotency_key: `g${i}` })));
  t = tally(rs); check(t[201] === 4 && t[409] === 36, `per-user limit: 40 concurrent singles -> ${JSON.stringify(t)}`);
  rs = await Promise.all(Array.from({ length: 10 }, (_, i) =>
    call("POST", `/shows/${show.id}/reserve`, "greedy2", { seats: [`S${50 + i}`, `S${60 + i}`, `S${70 + i}`], idempotency_key: `h${i}` })));
  t = tally(rs); check(t[201] === 1 && t[409] === 9, `per-user limit: 10 concurrent triples (limit 4) -> ${JSON.stringify(t)}`);
  await invariant(show.id, "limit");

  // 3. idempotency: same key concurrently, reuse with different body, sequential retry
  show = await mkShow(20);
  rs = await Promise.all(Array.from({ length: 50 }, () =>
    call("POST", `/shows/${show.id}/reserve`, "idem", { seats: ["S1"], idempotency_key: "same" })));
  const ids = new Set(rs.map((r) => r.json.reservation_id));
  check(rs.every((r) => r.status === 201) && ids.size === 1, `idempotency: 50 concurrent identical requests -> 1 reservation (${ids.size})`);
  rs = await call("POST", `/shows/${show.id}/reserve`, "idem", { seats: ["S2"], idempotency_key: "same" });
  check(rs.status === 409, `idempotency: same key, different seats -> ${rs.status}`);
  rs = await call("POST", `/shows/${show.id}/reserve`, "idem", { seats: ["S1"] }, { "Idempotency-Key": "same" });
  check(rs.status === 201 && ids.has(rs.json.reservation_id), "idempotency: header form replays original");
  s = await invariant(show.id, "idempotency"); check(s.confirmed === 1, "idempotency: charged once");

  // 4. partial request is all-or-nothing, under concurrency
  show = await mkShow(10);
  await call("POST", `/shows/${show.id}/reserve`, "p0", { seats: ["S2"], idempotency_key: "x" });
  rs = await Promise.all(Array.from({ length: 20 }, (_, i) =>
    call("POST", `/shows/${show.id}/reserve`, `p${i + 1}`, { seats: ["S1", "S2"], idempotency_key: "y" })));
  check(rs.every((r) => r.status === 409), "partial: [S1,S2] with S2 taken -> all declined");
  s = await invariant(show.id, "partial"); check(s.seats.find((x) => x.seat === "S1").status === "available", "partial: S1 not leaked");
  rs = await Promise.all(Array.from({ length: 20 }, (_, i) =>
    call("POST", `/shows/${show.id}/reserve`, `q${i}`, { seats: i % 2 ? ["S5", "S6"] : ["S6", "S5"], idempotency_key: "z" })));
  t = tally(rs); check(t[201] === 1 && t[409] === 19, `partial: overlapping opposite-order requests, no deadlock -> ${JSON.stringify(t)}`);

  // 5. cancel
  show = await mkShow(5);
  const a = await call("POST", `/shows/${show.id}/reserve`, "alice", { seats: ["S1"], idempotency_key: "a" });
  check((await call("POST", `/reservations/${a.json.reservation_id}/cancel`, "mallory")).status === 403, "cancel: non-owner rejected");
  const cs = await Promise.all(Array.from({ length: 10 }, () => call("POST", `/reservations/${a.json.reservation_id}/cancel`, "alice")));
  check(cs.every((r) => r.status === 200 && r.json.status === "cancelled"), "cancel: owner OK, repeated cancels idempotent");
  const b = await call("POST", `/shows/${show.id}/reserve`, "bob", { seats: ["S1"], idempotency_key: "b" });
  check(b.status === 201, "cancel: released seat re-bookable");
  check((await call("POST", `/reservations/${a.json.reservation_id}/cancel`, "alice")).status === 200, "cancel: late re-cancel of old reservation");
  s = await invariant(show.id, "cancel");
  check(s.seats.find((x) => x.seat === "S1").status === "confirmed", "cancel: never resurrects/frees a seat now owned by someone else");

  // 6. stampede: many users, small hall, hot subset
  show = await mkShow(1000, { per_user_limit: 4 });
  const t0 = Date.now();
  rs = await Promise.all(Array.from({ length: STAMPEDE }, (_, i) => {
    const hot = Math.random() < 0.7;
    const pick = () => `S${1 + Math.floor(Math.random() * (hot ? 20 : 1000))}`;
    const seats = [...new Set([pick(), pick()])];
    return call("POST", `/shows/${show.id}/reserve`, `u${i % 3000}`, { seats, idempotency_key: `s${i}` });
  }));
  t = tally(rs);
  check(!Object.keys(t).some((k) => +k >= 500), `stampede: ${STAMPEDE} requests in ${Date.now() - t0}ms -> ${JSON.stringify(t)} (no 5xx)`);
  s = await invariant(show.id, "stampede");
  const mine = rs.filter((r) => r.status === 201).flatMap((r) => r.json.seats);
  check(mine.length === s.confirmed && new Set(mine).size === mine.length, `stampede: ${mine.length} seats sold to winners == ${s.confirmed} confirmed, no duplicates`);
  console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
  process.exit(failures ? 1 : 0);
})();
