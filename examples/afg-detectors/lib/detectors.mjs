/* The graph detectors, as functions. 10 Oct 2026.

   incidents.mjs runs these over the live tables every hour. The offline validator (amlsim-agentic)
   runs the SAME functions over synthetic tables whose answers are known, which is how a detector's
   precision and recall get measured without pointing it at real money first.

   Nothing in this file writes. A detector returns the rows it found; the caller decides what to
   open, note or publish. The SQL is moved here verbatim from incidents.mjs (10 Oct 2026); the prose
   on why each threshold is what it is stays next to the caller. */

export const SYBIL_MIN_PER_HOUR = 25;      // registrations minted by one address within an hour
export const BURST_LIMIT = 1000;           // rows returned; the caller warns when the list is this long
export const RETRY_MIN = 50;               // identical payments to one seller...
export const RETRY_WINDOW = "10 minutes";  // ...inside this window
export const STREAK_MIN = 5;               // consecutive failed probes before it is a streak
/* drain_pattern thresholds. Calibrated on 2026-09-24 against every counted
   payment we hold (7,866): 10x/$500 fired 0 times, 5x/$250 fired on 5 agents,
   3x/$100 on 13 — 5x/$250 is rare enough for a human to read every hit. */
export const DRAIN_MULT = 5;               // payment is at least this many times the agent's previous largest
export const DRAIN_MIN_USD = 250;          // ...and at least this much in absolute terms
export const DRAIN_MIN_HISTORY = 3;        // the agent needs this many prior payments for "previous largest" to mean anything
export const DRAIN_LOOKBACK = "30 days";   // only recent payments open a detection

/* 1. mint_burst: one address minting identities in bulk. */
export async function mintBursts(pool, { limit = BURST_LIMIT } = {}) {
  const { rows } = await pool.query(
    `SELECT minted_to, date_trunc('hour', minted_at) AS hour, count(*)::int AS n,
            min(token_id) AS lo, max(token_id) AS hi
     FROM registrations
     WHERE minted_to IS NOT NULL
     GROUP BY 1, 2 HAVING count(*) >= $1
     ORDER BY n DESC LIMIT $2`,
    [SYBIL_MIN_PER_HOUR, limit]
  );
  return rows;
}

/* How much of the registry was minted in bursts at all. */
export async function burstAggregate(pool) {
  const { rows } = await pool.query(
    `SELECT count(*)::int AS burst_hours, coalesce(sum(n),0)::int AS regs FROM (
       SELECT count(*) AS n FROM registrations WHERE minted_to IS NOT NULL
       GROUP BY minted_to, date_trunc('hour', minted_at) HAVING count(*) >= $1) t`,
    [SYBIL_MIN_PER_HOUR]
  );
  return rows[0];
}

/* One pass over registrations: total, distinct minters, the top minter and the top ten's share. */
export async function mintConcentration(pool) {
  const { rows } = await pool.query(
    `WITH per AS (SELECT minted_to, count(*)::int AS n FROM registrations
                  WHERE minted_to IS NOT NULL GROUP BY minted_to),
          ranked AS (SELECT minted_to, n, row_number() OVER (ORDER BY n DESC) AS rk FROM per)
     SELECT (SELECT count(*)::int FROM registrations) AS total,
            (SELECT count(*)::int FROM per) AS minters,
            (SELECT n FROM ranked WHERE rk = 1) AS top_n,
            (SELECT minted_to FROM ranked WHERE rk = 1) AS top_minter,
            (SELECT coalesce(sum(n), 0)::int FROM ranked WHERE rk <= 10) AS top10_n`
  );
  return rows[0];
}

/* 2. retry_storm: the same payment, over and over. */
/* Every list below is capped by `limit` (100 for the hourly run, as before). A caller that gets exactly
   `limit` rows is looking at a truncated list and should say so: the synthetic scale run of 10 Oct
   2026 (100 drains plus 32 look-alikes) lost its 32 oldest drains to a silent cap. */
export const ROW_LIMIT = 100;
export async function retryStorms(pool, { limit = ROW_LIMIT } = {}) {
  const { rows } = await pool.query(
    `SELECT actor_id, to_id, count(*)::int AS n, min(block_time) AS from_t, max(block_time) AS to_t,
            round(sum(amount_usd)::numeric, 2) AS usd
     FROM money_events
     WHERE kind = 'PAY' AND NOT pre_registration AND block_time IS NOT NULL
     GROUP BY actor_id, to_id, date_trunc('hour', block_time)
     HAVING count(*) >= $1 AND max(block_time) - min(block_time) <= $2::interval
     ORDER BY n DESC LIMIT $3`,
    [RETRY_MIN, RETRY_WINDOW, limit]
  );
  return rows;
}

/* 2b. drain_pattern: a sudden large payment to a stranger. `asOf` exists for the validator, whose
   data ends when the simulation ends; live runs leave it null and the query reads now(). */
export async function drains(pool, { asOf = null, limit = ROW_LIMIT } = {}) {
  const { rows } = await pool.query(
    `WITH p AS (
       SELECT m.event_id, m.actor_id, m.from_caip10, m.to_id, m.amount_usd, m.block_time, m.tx,
              max(m.amount_usd) OVER w AS prior_max, count(*) OVER w AS prior_n
       FROM money_events m
       WHERE m.kind = 'PAY' AND NOT m.pre_registration AND NOT m.pass_through AND m.pass_checked_at IS NOT NULL AND m.block_time IS NOT NULL
       WINDOW w AS (PARTITION BY m.actor_id ORDER BY m.block_time, m.event_id
                    ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING))
     SELECT p.* FROM p
     WHERE p.block_time > coalesce($5::timestamptz, now()) - $4::interval
       AND p.prior_n >= $3 AND p.amount_usd >= $2 AND p.amount_usd >= $1 * p.prior_max
       AND NOT EXISTS (SELECT 1 FROM money_events q
                       WHERE q.actor_id = p.actor_id AND q.to_id = p.to_id AND q.kind = 'PAY'
                         AND q.block_time < p.block_time)
     ORDER BY p.block_time DESC LIMIT $6`,
    [DRAIN_MULT, DRAIN_MIN_USD, DRAIN_MIN_HISTORY, DRAIN_LOOKBACK, asOf, limit]
  );
  return rows;
}

/* ---- candidates, NOT run by incidents.mjs ----------------------------------------------------
   The synthetic validation of 10 Oct 2026 showed that bucketing by calendar hour splits a storm that
   crosses an hour boundary, and that one stray payment later in the same hour defeats the "all within
   ten minutes" test. Measured on the live ledger the same day: 28 payer-seller pairs have 50+ payments
   inside some ten-minute window; the hour-bucket query reports 7. Mint bursts: 88 minters by sliding
   window, 83 by bucket. These sliding-window versions are the proposed correction for the next
   monthly release. Published numbers stay frozen until then; the validator measures both. */
export async function retryStormsSliding(pool, { limit = ROW_LIMIT } = {}) {
  const { rows } = await pool.query(
    `WITH p AS (SELECT actor_id, to_id, block_time, amount_usd FROM money_events
                WHERE kind = 'PAY' AND NOT pre_registration AND block_time IS NOT NULL),
          w AS (SELECT actor_id, to_id, block_time, count(*) OVER win AS n, min(block_time) OVER win AS from_t, sum(amount_usd) OVER win AS usd
                FROM p WINDOW win AS (PARTITION BY actor_id, to_id ORDER BY block_time RANGE BETWEEN $2::interval PRECEDING AND CURRENT ROW))
     SELECT actor_id, to_id, max(n)::int AS n, min(from_t) AS from_t, max(block_time) AS to_t, round(max(usd)::numeric, 2) AS usd
     FROM w WHERE n >= $1
     GROUP BY actor_id, to_id, date_trunc('day', block_time)
     ORDER BY n DESC LIMIT $3`,
    [RETRY_MIN, RETRY_WINDOW, limit]
  );
  return rows;
}
export async function mintBurstsSliding(pool, { limit = BURST_LIMIT } = {}) {
  const { rows } = await pool.query(
    `WITH r AS (SELECT minted_to, minted_at, token_id FROM registrations WHERE minted_to IS NOT NULL),
          w AS (SELECT minted_to, minted_at, token_id, count(*) OVER win AS n, min(minted_at) OVER win AS from_t
                FROM r WINDOW win AS (PARTITION BY minted_to ORDER BY minted_at RANGE BETWEEN interval '60 minutes' PRECEDING AND CURRENT ROW))
     SELECT minted_to, date_trunc('day', minted_at) AS day, max(n)::int AS n, min(from_t) AS from_t, max(minted_at) AS to_t
     FROM w WHERE n >= $1
     GROUP BY 1, 2 ORDER BY n DESC LIMIT $2`,
    [SYBIL_MIN_PER_HOUR, limit]
  );
  return rows;
}

/* ---- candidate: slow drains ----
   The drain rule reads one payment. A wallet emptied in four or five payments to the same new address
   over a day or two never trips it (synthetic validation, 10 Oct 2026: 10 of 10 slow drains silent).
   This version reads the SUM to one new payee inside a window after the first payment to it, against
   the same history test. It is a superset of the single-payment rule, so it is measured on its own. */
export const SLOW_WINDOW = "72 hours";
export async function slowDrains(pool, { asOf = null, limit = ROW_LIMIT } = {}) {
  const { rows } = await pool.query(
    `WITH pay AS (
       SELECT actor_id, to_id, amount_usd, block_time, event_id, tx FROM money_events
       WHERE kind = 'PAY' AND NOT pre_registration AND NOT pass_through AND pass_checked_at IS NOT NULL AND block_time IS NOT NULL),
     firsts AS (
       SELECT actor_id, to_id, min(block_time) AS first_t FROM pay GROUP BY 1, 2),
     win AS (
       SELECT f.actor_id, f.to_id, f.first_t, sum(p.amount_usd) AS usd, count(*)::int AS payments, max(p.amount_usd) AS largest, max(p.block_time) AS last_t,
              (array_agg(p.tx ORDER BY p.block_time))[1] AS first_tx
       FROM firsts f JOIN pay p ON p.actor_id = f.actor_id AND p.to_id = f.to_id AND p.block_time >= f.first_t AND p.block_time < f.first_t + $5::interval
       WHERE f.first_t > coalesce($6::timestamptz, now()) - $4::interval
       GROUP BY 1, 2, 3),
     hist AS (
       SELECT w.actor_id, w.to_id, w.first_t, w.usd, w.payments, w.largest, w.last_t, w.first_tx,
              (SELECT count(*) FROM pay q WHERE q.actor_id = w.actor_id AND q.block_time < w.first_t) AS prior_n,
              (SELECT max(amount_usd) FROM pay q WHERE q.actor_id = w.actor_id AND q.block_time < w.first_t) AS prior_max
       FROM win w)
     SELECT * FROM hist
     WHERE prior_n >= $3 AND usd >= $2 AND usd >= $1 * prior_max
     ORDER BY usd DESC LIMIT $7`,
    [DRAIN_MULT, DRAIN_MIN_USD, DRAIN_MIN_HISTORY, DRAIN_LOOKBACK, SLOW_WINDOW, asOf, limit]
  );
  return rows;
}

/* ---- candidate: drains that emptied the wallet ----
   Every drain false alarm in the synthetic run was a first large purchase, and on payment shape
   alone the two are the same. What differs is what was left behind: a drain takes what the wallet
   held, a purchase leaves most of it. `balanceAt(walletCaip10, blockTime, tx, asset)` answers "what
   did this wallet hold just before this payment", from the chain for the live run and from the
   generator's books for the validator. The fraction is reported as evidence; `minFraction` filters. */
export const EMPTIED_FRACTION = 0.8;
export async function drainsEmptied(pool, { asOf = null, balanceAt, minFraction = EMPTIED_FRACTION, limit = ROW_LIMIT } = {}) {
  const rows = await drains(pool, { asOf, limit });
  const out = [];
  for (const r of rows) {
    const before = await balanceAt(r.from_caip10, r.block_time, r.tx, r.asset || "USDC");
    const fraction = before != null && before > 0 ? Number(r.amount_usd) / before : null;
    out.push({ ...r, balance_before_usd: before == null ? null : +before.toFixed(2), fraction_of_balance: fraction == null ? null : +Math.min(fraction, 9.99).toFixed(3), emptied: fraction != null && fraction >= minFraction });
  }
  return out.filter((r) => r.emptied || r.fraction_of_balance == null);
}
/* The live `balanceAt`: the stablecoin's balanceOf at the block before the payment, through an
   archive-capable RPC. Two calls per drain candidate (receipt, then eth_call), about 52 CU. */
const STABLE_ADDR = { USDC: ["0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", 6], USDT: ["0xfde4c96c8593536e31f229ea8f37b2ada2699bb2", 6], EURC: ["0x60a3e35cc302bfa44cb288bc5a4f316fdb1adb42", 6], DAI: ["0x50c5725949a6f0c72e6c4a641f24049a917db0cb", 18] };
export function chainBalanceAt(rpcUrl, gov = null) {
  const call = async (method, params, cu) => {
    const fn = async () => { const r = await fetch(rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(20000) }); const j = await r.json(); if (j.error) throw new Error(JSON.stringify(j.error).slice(0, 120)); return j.result; };
    if (!gov) return fn();
    const r = await gov.run("alchemy", cu, fn); if (r.skipped || r.error) throw new Error(r.reason || r.error); return r.value;
  };
  return async (walletCaip10, blockTime, tx, asset) => {
    const t = STABLE_ADDR[String(asset || "USDC").toUpperCase()]; if (!t) return null;
    const wallet = String(walletCaip10).replace(/^eip155:\d+:/, "").toLowerCase();
    const rc = await call("eth_getTransactionReceipt", [tx], 26); if (!rc || !rc.blockNumber) return null;
    const block = "0x" + (parseInt(rc.blockNumber, 16) - 1).toString(16);
    const data = "0x70a08231" + wallet.slice(2).padStart(64, "0");
    const hex = await call("eth_call", [{ to: t[0], data }, block], 26);
    return hex && hex !== "0x" ? Number(BigInt(hex)) / 10 ** t[1] : null;
  };
}

/* 3. uri_timeout_streak: an endpoint that has stopped answering. */
export async function probeStreaks(pool, { limit = ROW_LIMIT } = {}) {
  const { rows } = await pool.query(
    `WITH last_ok AS (
       SELECT actor_id, max(at) FILTER (WHERE ok) AS ok_at, max(at) AS seen_at,
              count(*) FILTER (WHERE NOT ok) AS fails, count(*) AS tries
       FROM probes GROUP BY actor_id)
     SELECT actor_id, fails, tries, ok_at, seen_at
     FROM last_ok
     WHERE ok_at IS NULL AND fails >= $1
     ORDER BY fails DESC LIMIT $2`,
    [STREAK_MIN, limit]
  );
  return rows;
}
