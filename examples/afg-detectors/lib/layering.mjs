/* Layering detectors over the agent-to-agent payment graph. Candidates, 10 Oct 2026.

   AMLSim's typologies (cycle, scatter-gather, gather-scatter, fan-in, fan-out) describe money moving
   through several hands to obscure where it came from. Until today the ledger had no detector for
   any of them: the synthetic validation injected all eight AMLSim shapes and nothing fired. These
   functions are the first attempt, written against that labelled data.

   They run in JavaScript over an edge list rather than in SQL, because a cycle search is a graph walk.
   An edge is a counted payment from one bound agent wallet to another (the payee's wallet is bound to
   an agent too); payments to sellers and exchanges are not layering and are left out. On the live
   ledger that is about 260,000 edges over 90 days, which is small.

   Every function is pure: it takes edges and options and returns findings with the agents involved,
   so the validator can score it and the hourly run can open detections from it. Nothing here writes. */

/* The edge list. `sinceDays` bounds the walk; `asOf` exists for the validator. */
export async function loadEdges(pool, { sinceDays = 90, asOf = null } = {}) {
  const { rows } = await pool.query(
    `SELECT m.actor_id AS from_actor, b.actor_id AS to_actor, m.from_caip10 AS from_wallet, m.to_id AS to_wallet,
            m.amount_usd::float8 AS usd, m.block_time AS at, m.tx
     FROM money_events m JOIN bindings b ON b.wallet = m.to_id AND b.valid_to IS NULL
     WHERE m.kind = 'PAY' AND NOT m.pre_registration AND NOT m.pass_through AND m.block_time IS NOT NULL
       AND m.block_time > coalesce($2::timestamptz, now()) - ($1 || ' days')::interval
       AND m.actor_id <> b.actor_id
     ORDER BY m.block_time`, [String(sinceDays), asOf]);
  return rows.map((r) => ({ ...r, at: new Date(r.at) }));
}

const DAY = 86400000;
const byKey = (edges, key) => { const m = new Map(); for (const e of edges) { const k = key(e); if (!m.has(k)) m.set(k, []); m.get(k).push(e); } return m; };

/* ---- cycle: money leaves an agent and comes back to it through two or more others ----
   A walk forward in time (up to 12 hops: AMLSim cycles have up to 10 members, and a limit of 8 missed
   every 9- and 10-member cycle in the 10 Oct validation): each hop later than the one before, inside the window, and each hop
   carrying at least `keep` of the previous one (money mostly continuing, as AMLSim's margin models
   it). Out-degree is capped so a hub with thousands of payees does not explode the search. */
export function cycles(edges, { maxLen = 12, windowDays = 14, keep = 0.5, maxOut = 40, minUsd = 20, limit = 200 } = {}) {
  const out = byKey(edges.filter((e) => e.usd >= minUsd), (e) => e.from_actor);
  for (const [, list] of out) list.sort((a, b) => a.at - b.at);
  const found = new Map();
  for (const [start, firsts] of out) {
    for (const e0 of firsts) {
      const deadline = e0.at.getTime() + windowDays * DAY;
      const path = [e0], seen = new Set([start, e0.to_actor]);
      const walk = (node, prevUsd, prevAt, depth) => {
        if (depth > maxLen || found.size >= limit) return;
        const nexts = (out.get(node) || []).filter((e) => e.at > prevAt && e.at.getTime() <= deadline && e.usd >= keep * prevUsd);
        let n = 0;
        for (const e of nexts) {
          if (++n > maxOut) break;
          if (e.to_actor === start) {
            if (path.length >= 2) {
              const nodes = [start, ...path.map((p) => p.to_actor)];
              const key = [...new Set(nodes)].sort().join(">");
              if (!found.has(key)) found.set(key, { kind: "cycle", main: start, participants: [...new Set(nodes)], hops: path.length + 1, usd: +e0.usd.toFixed(2), returned_usd: +e.usd.toFixed(2), from_t: e0.at, to_t: e.at, txs: [...path.map((p) => p.tx), e.tx] });
            }
            continue;
          }
          if (seen.has(e.to_actor)) continue;
          seen.add(e.to_actor); path.push(e);
          walk(e.to_actor, e.usd, e.at, depth + 1);
          path.pop(); seen.delete(e.to_actor);
        }
      };
      walk(e0.to_actor, e0.usd, e0.at, 2);
      if (found.size >= limit) break;
    }
    if (found.size >= limit) break;
  }
  return [...found.values()];
}

/* ---- scatter-gather: one agent pays k or more others, each of which passes most of it on to the
   same beneficiary a little later ---- */
export function scatterGather(edges, { k = 3, windowDays = 14, keep = 0.5, minUsd = 20, limit = 200 } = {}) {
  const out = byKey(edges.filter((e) => e.usd >= minUsd), (e) => e.from_actor);
  const found = [];
  for (const [origin, firsts] of out) {
    /* candidate intermediaries: agents the origin paid; for each, where that money went next */
    const viaBene = new Map();
    for (const e1 of firsts) {
      const onward = (out.get(e1.to_actor) || []).filter((e2) => e2.at > e1.at && e2.at.getTime() <= e1.at.getTime() + windowDays * DAY && e2.usd >= keep * e1.usd && e2.to_actor !== origin);
      for (const e2 of onward) { if (!viaBene.has(e2.to_actor)) viaBene.set(e2.to_actor, new Map()); viaBene.get(e2.to_actor).set(e1.to_actor, { e1, e2 }); }
    }
    for (const [bene, mids] of viaBene) {
      if (mids.size < k) continue;
      const legs = [...mids.values()];
      found.push({ kind: "scatter_gather", main: origin, participants: [origin, ...mids.keys(), bene], beneficiary: bene, intermediaries: mids.size,
        usd: +legs.reduce((s, l) => s + l.e1.usd, 0).toFixed(2), gathered_usd: +legs.reduce((s, l) => s + l.e2.usd, 0).toFixed(2),
        from_t: new Date(Math.min(...legs.map((l) => l.e1.at))), to_t: new Date(Math.max(...legs.map((l) => l.e2.at))), txs: legs.flatMap((l) => [l.e1.tx, l.e2.tx]) });
      if (found.length >= limit) return found;
    }
  }
  return found;
}

/* ---- gather-scatter: k or more agents pay one intermediary, which then pays k or more others ---- */
export function gatherScatter(edges, { k = 3, windowDays = 14, minUsd = 20, limit = 200 } = {}) {
  const inn = byKey(edges.filter((e) => e.usd >= minUsd), (e) => e.to_actor), out = byKey(edges.filter((e) => e.usd >= minUsd), (e) => e.from_actor);
  const found = [];
  for (const [mid, ins] of inn) {
    const outs = out.get(mid) || [];
    if (ins.length < k || outs.length < k) continue;
    ins.sort((a, b) => a.at - b.at);
    /* a window of inflows from k distinct payers, followed by outflows to k distinct payees */
    for (let i = 0; i + k - 1 < ins.length; i++) {
      const start = ins[i].at.getTime(), end = start + windowDays * DAY;
      const payers = new Map(); for (const e of ins) if (e.at.getTime() >= start && e.at.getTime() <= end) payers.set(e.from_actor, e);
      if (payers.size < k) continue;
      const lastIn = Math.max(...[...payers.values()].map((e) => e.at.getTime()));
      const payees = new Map(); for (const e of outs) if (e.at.getTime() > lastIn && e.at.getTime() <= end) payees.set(e.to_actor, e);
      if (payees.size < k) continue;
      const inUsd = [...payers.values()].reduce((s, e) => s + e.usd, 0), outUsd = [...payees.values()].reduce((s, e) => s + e.usd, 0);
      if (outUsd < 0.5 * inUsd) continue;
      found.push({ kind: "gather_scatter", main: mid, participants: [...payers.keys(), mid, ...payees.keys()], payers: payers.size, payees: payees.size, usd: +inUsd.toFixed(2), scattered_usd: +outUsd.toFixed(2),
        from_t: new Date(start), to_t: new Date(Math.max(...[...payees.values()].map((e) => e.at.getTime()))), txs: [...payers.values(), ...payees.values()].map((e) => e.tx) });
      break;
    }
    if (found.length >= limit) break;
  }
  return found;
}

/* ---- fan-in and fan-out of one identical amount (AMLSim's structuring shape): k or more distinct
   agents paying the same exact amount to one agent inside the window, or the reverse ---- */
function sameAmountFans(edges, groupKey, otherKey, kind, { k = 4, windowDays = 14, minUsd = 20, limit = 200 } = {}) {
  const groups = byKey(edges.filter((e) => e.usd >= minUsd), (e) => groupKey(e) + "|" + e.usd.toFixed(2));
  const found = [];
  for (const [key, list] of groups) {
    if (list.length < k) continue;
    list.sort((a, b) => a.at - b.at);
    for (let i = 0; i + k - 1 < list.length; i++) {
      const end = list[i].at.getTime() + windowDays * DAY;
      const others = new Map(); for (const e of list) if (e.at.getTime() >= list[i].at.getTime() && e.at.getTime() <= end) others.set(otherKey(e), e);
      if (others.size < k) continue;
      const main = groupKey(list[i]);
      found.push({ kind, main, participants: [main, ...others.keys()], members: others.size, amount_usd: list[i].usd, usd: +(list[i].usd * others.size).toFixed(2),
        from_t: list[i].at, to_t: new Date(Math.max(...[...others.values()].map((e) => e.at.getTime()))), txs: [...others.values()].map((e) => e.tx) });
      break;
    }
    if (found.length >= limit) break;
  }
  return found;
}
export const fanInSameAmount = (edges, opts) => sameAmountFans(edges, (e) => e.to_actor, (e) => e.from_actor, "fan_in", opts);
export const fanOutSameAmount = (edges, opts) => sameAmountFans(edges, (e) => e.from_actor, (e) => e.to_actor, "fan_out", opts);

export async function runAll(pool, opts = {}) {
  const edges = await loadEdges(pool, opts);
  return { edges: edges.length, cycle: cycles(edges, opts), scatter_gather: scatterGather(edges, opts), gather_scatter: gatherScatter(edges, opts), fan_in: fanInSameAmount(edges, opts), fan_out: fanOutSameAmount(edges, opts) };
}
