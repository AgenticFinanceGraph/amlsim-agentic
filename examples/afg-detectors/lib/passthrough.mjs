/* Pass-through check — shared by the payer and the hourly timer.

   A payment we record is a transfer OUT of a bound wallet. On its own that
   cannot distinguish a purchase from a hop in a routing path: in September
   2026, 402 recorded "payments" worth $702,169 turned out to be money that
   arrived in a wallet and left again in the same transaction.

   It used to run only on its own timer, an hour behind the payer — and the
   payer published totals the moment it found new payments. So every payer run
   briefly counted unverified money: on 2026-09-11 the published spending sat
   ~$53,000 above the verified figure until the next check caught up. Now the
   payer calls this on its own new rows BEFORE computing any total, and the
   timer only sweeps up whatever a failed run left behind. */

const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
/* every stablecoin leg counts: money that arrives as USDT and leaves as USDC
   in one transaction is a swap or a hop, not a purchase (27 Sep 2026) */
const STABLES = {
  [USDC]: { sym: "USDC", dec: 6 },
  "0xfde4c96c8593536e31f229ea8f37b2ada2699bb2": { sym: "USDT", dec: 6 },
  "0x60a3e35cc302bfa44cb288bc5a4f316fdb1adb42": { sym: "EURC", dec: 6 },
  "0x50c5725949a6f0c72e6c4a641f24049a917db0cb": { sym: "DAI", dec: 18 }
};
const XFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
/* Within 2% counts as "the same money". Routers skim a few basis points, and
   demanding an exact match would let every profitable route through. */
const TOLERANCE = 0.02;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeRpc(rpcs) {
  let idx = 0;
  return async function rpc(method, params, attempt = 0) {
    const url = rpcs[Math.min(rpcs.length - 1, Math.floor(attempt / 2))] || rpcs[idx++ % rpcs.length];
    try {
      const r = await fetch(url, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: AbortSignal.timeout(20000)
      });
      const j = JSON.parse(await r.text());
      if (j.error) throw new Error(JSON.stringify(j.error).slice(0, 120));
      return j.result;
    } catch (e) {
      if (attempt < 4) { await sleep(200 * (attempt + 1)); return rpc(method, params, attempt + 1); }
      throw e;
    }
  };
}

/* The rule itself, with nothing attached to it. `legs` are the stablecoin Transfer legs of one
   receipt ({from, to, usd}), `wallet` the paying wallet (lowercase). Pass-through: money arrived
   and left in the same transaction, in comparable size. A wallet that received nothing here is
   spending its own balance, which is exactly what we want to count. Exported (10 Oct 2026) so the
   offline validator can run it over synthetic receipts with known answers. */
export function classifyLegs(legs, wallet) {
  const gotIn = legs.filter((l) => l.to === wallet).reduce((s, l) => s + l.usd, 0);
  const sentOut = legs.filter((l) => l.from === wallet).reduce((s, l) => s + l.usd, 0);
  const isPass = gotIn > 0 && sentOut > 0 &&
                 Math.abs(gotIn - sentOut) / Math.max(gotIn, sentOut) < TOLERANCE;
  return { gotIn, sentOut, isPass };
}
/* The stablecoin legs of a receipt, in USD (EURC at the stored fx rate). */
export function stableLegs(receipt, fx = 1.08) {
  return (receipt.logs || [])
    .filter((l) => STABLES[l.address.toLowerCase()] && l.topics[0] === XFER && l.topics.length >= 3)
    .map((l) => { const t = STABLES[l.address.toLowerCase()]; const units = Number(BigInt(l.data)) / 10 ** t.dec; return {
      from: "0x" + l.topics[1].slice(26).toLowerCase(),
      to: "0x" + l.topics[2].slice(26).toLowerCase(),
      usd: t.sym === "EURC" ? units * fx : units
    }; });
}

export async function ensurePassThroughColumns(pool) {
  await pool.query("ALTER TABLE money_events ADD COLUMN IF NOT EXISTS pass_through boolean NOT NULL DEFAULT false");
  await pool.query("ALTER TABLE money_events ADD COLUMN IF NOT EXISTS pass_checked_at timestamptz");
  await pool.query("CREATE INDEX IF NOT EXISTS money_events_pass ON money_events (pass_through) WHERE NOT pre_registration");
}

/* Check every unchecked payment (largest first), up to `batch`. Returns what
   it did; never throws on a single bad receipt — a failed row stays unchecked
   and is retried on the next pass. */
export async function checkPassThrough(pool, rpcs, { batch = 600, pauseMs = 45 } = {}) {
  await ensurePassThroughColumns(pool);
  const rpc = makeRpc(rpcs.filter(Boolean));
  let fx = 1.08;
  try { const f = await pool.query("SELECT value FROM partner_cursors WHERE name = 'fx_eurusd'"); if (f.rows.length && Number(f.rows[0].value) > 0.8) fx = Number(f.rows[0].value); } catch (e) { /* table may not exist yet */ }
  const { rows } = await pool.query(
    `SELECT event_id, tx, from_caip10, amount_usd
     FROM money_events
     WHERE kind IN ('PAY','EARN') AND NOT pre_registration AND pass_checked_at IS NULL AND tx IS NOT NULL
     ORDER BY amount_usd DESC NULLS LAST LIMIT $1`, [batch]
  );
  let checked = 0, flagged = 0, flaggedUsd = 0, failed = 0;
  const seen = new Map();
  for (const r of rows) {
    const wallet = String(r.from_caip10 || "").replace(/^eip155:\d+:/, "").toLowerCase();
    if (!wallet) continue;
    try {
      let receipt = seen.get(r.tx);
      if (!receipt) { receipt = await rpc("eth_getTransactionReceipt", [r.tx]); seen.set(r.tx, receipt); }
      if (!receipt) { failed++; continue; }
      const { isPass } = classifyLegs(stableLegs(receipt, fx), wallet);
      await pool.query(
        "UPDATE money_events SET pass_through=$2, pass_checked_at=now() WHERE event_id=$1",
        [r.event_id, isPass]
      );
      checked++;
      if (isPass) { flagged++; flaggedUsd += Number(r.amount_usd) || 0; }
    } catch (e) {
      failed++;
      console.error("  pass-through " + String(r.tx).slice(0, 14) + "… " + (e && e.message));
    }
    if (pauseMs) await sleep(pauseMs);
  }
  const { rows: rem } = await pool.query(
    "SELECT count(*)::int n FROM money_events WHERE kind='PAY' AND NOT pre_registration AND pass_checked_at IS NULL"
  );
  return { checked, flagged, flagged_usd: +flaggedUsd.toFixed(2), failed, unchecked_remaining: rem[0].n };
}
