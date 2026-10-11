/* Injected patterns with known answers.

   The first eight are IBM AMLSim's typologies (scripts/transaction_graph_generator.py, add_aml_typology),
   ported edge for edge: fan_in, fan_out, bipartite, stack, random, cycle, scatter_gather,
   gather_scatter. Their parameters are AMLSim's alertPatterns.csv columns (count, type, schedule_id,
   min_accounts, max_accounts, min_amount, max_amount, min_period, max_period, is_sar). Agents stand
   in for accounts; the bank_id column is gone because one chain is one bank.

   The rest are the shapes this ledger's detectors are built to see, each paired with a near-miss
   that is built NOT to be seen. A near-miss is as valuable as a hit: it is the measured edge of a
   detector, and it goes in the report as a blind spot rather than being argued about.

   Every instance records `expected_flags` (what the published detector definitions say should fire)
   separately from `is_suspicious` (whether the behaviour is harmful). A mint burst is a shape, not a
   harm; a slow drain is a harm the shape rules do not catch. Keeping the two apart is the point.

   `rules` are the published thresholds (config.afg_rules), kept in the config so the generator stays
   standalone; they mirror lib/detectors.mjs in the AFG pulse code. */
import { SCHEDULE } from "./engine.mjs";

const MODEL_ID = { fan_out: 1, fan_in: 2, cycle: 3, bipartite: 4, stack: 5, random: 6, scatter_gather: 7, gather_scatter: 8,
  drain: 101, drain_small: 102, drain_known_payee: 103, slow_drain: 104, routing_hop_large: 105,
  retry_storm: 111, retry_storm_slow: 112, retry_storm_straddle: 113, mint_burst: 121, mint_burst_spread: 122,
  uri_timeout_streak: 131, uri_flapping: 132, funding_quiet: 141 };
export const modelId = (t) => MODEL_ID[t] || 0;

function members(sim, k, filter) {
  const c = sim.candidates(filter);
  if (c.length < k) throw new Error("not enough free agents for a pattern of " + k + " (have " + c.length + ")");
  const m = sim.rng.sample(c, k); m.forEach((a) => sim.take(a)); return m;
}
function period(sim, p) { const n = sim.rng.int(p.min_period, p.max_period); const s = sim.rng.int(0, Math.max(0, sim.totalSteps - n)); return [s, s + n - 1]; }
const off = (sim) => sim.rng.int(0, 3599);
const HOUR_MS = 3600000;

/* Counted payment history per agent from what the background produced, for the shapes that need a
   "previous largest" to be real. Pre-registration and routing legs do not count, as in the ledger. */
export function history(sim) {
  const h = new Map();
  const sorted = sim.transfers.slice().sort((a, b) => a.timestamp - b.timestamp);
  for (const t of sorted) {
    if (!t.from_agent || t.is_routing || t.timestamp < t.from_agent.registered_at) continue;
    if (!h.has(t.from_agent.actor_id)) h.set(t.from_agent.actor_id, []);
    h.get(t.from_agent.actor_id).push({ at: t.timestamp, amount: t.amount, to: t.to_wallet });
  }
  return h;
}
function priorAt(hist, when) { const prior = hist.filter((x) => x.at < when); return { n: prior.length, max: prior.reduce((m, x) => Math.max(m, x.amount), 0), payees: new Set(prior.map((x) => x.to)) }; }
/* A victim with enough counted history before a moment inside the lookback window. */
function pickVictim(sim, H, rules, filter = () => true) {
  const lookbackMs = (rules.drain_place_window_days ?? rules.drain_lookback_days) * 86400000;
  const latestMs = sim.endMs - HOUR_MS - (rules.drain_place_end_margin_days ?? 0) * 86400000;
  const cands = sim.candidates((a) => { const h = H.get(a.actor_id); return h && h.length >= rules.drain_min_history && h[rules.drain_min_history - 1].at.getTime() < latestMs - HOUR_MS && filter(a, h); });
  if (!cands.length) return null;
  const victim = sim.rng.pick(cands); sim.take(victim);
  const h = H.get(victim.actor_id);
  const earliest = Math.max(h[rules.drain_min_history - 1].at.getTime() + HOUR_MS, sim.endMs - lookbackMs + HOUR_MS);
  const whenMs = sim.rng.float(earliest, Math.max(earliest, latestMs));
  const when = new Date(whenMs), step = sim.stepOf(when), offsetS = Math.floor((whenMs - sim.base - step * sim.stepMs) / 1000);
  return { victim, h, when, step, offsetS, prior: priorAt(h, when) };
}
function fund(sim, agent, amount, step, offsetS, instance) {
  const funder = sim.rng.pick(sim.externals.funders);
  const back = sim.rng.int(1, 48);                                   // funded one to forty-eight hours earlier
  const s = Math.max(agent.registration_step, step - back);
  sim.transfer({ from: funder, to: agent, step: s, offsetS: s === step ? Math.max(0, offsetS - 60) : offsetS, amount, typology: "funding", instance });
}

export const TYPOLOGIES = {
  /* ---------------- AMLSim's eight ---------------- */
  /* members of the AMLSim shapes are registered before the pattern starts, because the ledger (rightly)
     does not count a wallet's payments before its registration */
  fan_in(sim, p) {
    const [s, e] = period(sim, p), k = sim.rng.int(p.min_accounts, p.max_accounts), [main, ...subs] = members(sim, k, (a) => a.registration_step < s), amount = sim.rng.rounded(p.min_amount, p.max_amount);
    const inst = sim.pattern({ typology: "fan_in", main, participants: [main, ...subs], start: s, end: e, isSuspicious: p.is_sar, expectedFlags: [], note: "AMLSim fan-in: several members pay the main account the same amount; the ledger has no fan-in detector" });
    for (const o of subs) sim.transfer({ from: o, to: main, step: sim.rng.int(s, e), offsetS: off(sim), amount, typology: "fan_in", instance: inst });
  },
  fan_out(sim, p) {
    const [s, e] = period(sim, p), k = sim.rng.int(p.min_accounts, p.max_accounts), [main, ...subs] = members(sim, k, (a) => a.registration_step < s), amount = sim.rng.rounded(p.min_amount, p.max_amount);
    const inst = sim.pattern({ typology: "fan_out", main, participants: [main, ...subs], start: s, end: e, isSuspicious: p.is_sar, expectedFlags: [], note: "AMLSim fan-out: the main account pays several members the same amount" });
    for (const b of subs) sim.transfer({ from: main, to: b, step: sim.rng.int(s, e), offsetS: off(sim), amount, typology: "fan_out", instance: inst });
  },
  bipartite(sim, p) {
    const [s, e] = period(sim, p), k = sim.rng.int(p.min_accounts, p.max_accounts), all = members(sim, k, (a) => a.registration_step < s), no = Math.floor(k / 2), origs = all.slice(0, no), benes = all.slice(no);
    const inst = sim.pattern({ typology: "bipartite", main: origs[0], participants: all, start: s, end: e, isSuspicious: p.is_sar, expectedFlags: [], note: "AMLSim bipartite: every originator pays every beneficiary" });
    for (const o of origs) for (const b of benes) sim.transfer({ from: o, to: b, step: sim.rng.int(s, e), offsetS: off(sim), amount: sim.rng.amount(p.min_amount, p.max_amount), typology: "bipartite", instance: inst });
  },
  stack(sim, p) {
    const [s, e] = period(sim, p), k = sim.rng.int(p.min_accounts, p.max_accounts), all = members(sim, k, (a) => a.registration_step < s), n3 = Math.floor(k / 3);
    const origs = all.slice(0, n3), mids = all.slice(n3, 2 * n3), benes = all.slice(2 * n3);
    const inst = sim.pattern({ typology: "stack", main: origs[0], participants: all, start: s, end: e, isSuspicious: p.is_sar, expectedFlags: [], note: "AMLSim stack: two bipartite layers, originators to intermediaries to beneficiaries" });
    for (const o of origs) for (const m of mids) sim.transfer({ from: o, to: m, step: sim.rng.int(s, e), offsetS: off(sim), amount: sim.rng.amount(p.min_amount, p.max_amount), typology: "stack", instance: inst });
    for (const m of mids) for (const b of benes) sim.transfer({ from: m, to: b, step: sim.rng.int(s, e), offsetS: off(sim), amount: sim.rng.amount(p.min_amount, p.max_amount), typology: "stack", instance: inst });
  },
  random(sim, p) {
    const [s, e] = period(sim, p), k = sim.rng.int(p.min_accounts, p.max_accounts), all = members(sim, k, (a) => a.registration_step < s), amount = sim.rng.amount(p.min_amount, p.max_amount), step = sim.rng.int(s, e);
    const inst = sim.pattern({ typology: "random", main: all[0], participants: all, start: s, end: e, isSuspicious: p.is_sar, expectedFlags: [], note: "AMLSim random: a chain of members, one amount, one day" });
    let prev = all[0];
    for (let i = 1; i < k; i++) { const next = sim.rng.pick(all.filter((a) => a !== prev)); sim.transfer({ from: prev, to: next, step, offsetS: off(sim), amount, typology: "random", instance: inst }); prev = next; }
  },
  /* hops are strictly ordered in time: AMLSim sorts the dates, and money cannot go round a ring in
     any other order */
  cycle(sim, p) {
    const [s, e] = period(sim, p), k = sim.rng.int(p.min_accounts, p.max_accounts), all = members(sim, k, (a) => a.registration_step < s);
    const secs = Array.from({ length: k }, () => sim.rng.int(s * 3600, (e + 1) * 3600 - 1)).sort((x, y) => x - y);
    const inst = sim.pattern({ typology: "cycle", main: all[0], participants: all, start: s, end: e, isSuspicious: p.is_sar, expectedFlags: [], note: "AMLSim cycle: money goes round a ring of members, each keeping a margin; no cycle detector in the ledger" });
    let amount = sim.rng.amount(p.min_amount, p.max_amount);
    for (let i = 0; i < k; i++) { sim.transfer({ from: all[i], to: all[(i + 1) % k], step: Math.floor(secs[i] / 3600), offsetS: secs[i] % 3600, amount, typology: "cycle", instance: inst }); amount -= amount * sim.marginRatio; }
  },
  scatter_gather(sim, p) {
    const [s, e] = period(sim, p), k = sim.rng.int(p.min_accounts, p.max_accounts), all = members(sim, k, (a) => a.registration_step < s), orig = all[0], bene = all[k - 1], mids = all.slice(1, k - 1), mid = Math.floor((s + e) / 2);
    const inst = sim.pattern({ typology: "scatter_gather", main: orig, participants: all, start: s, end: e, isSuspicious: p.is_sar, expectedFlags: [], note: "AMLSim scatter-gather: fan-out to intermediaries, then fan-in to one beneficiary" });
    for (const m of mids) {
      const scatter = sim.rng.amount(p.min_amount, p.max_amount);
      sim.transfer({ from: orig, to: m, step: sim.rng.int(s, Math.max(s, mid - 1)), offsetS: off(sim), amount: scatter, typology: "scatter_gather", instance: inst });
      sim.transfer({ from: m, to: bene, step: sim.rng.int(mid, e), offsetS: off(sim), amount: scatter * (1 - sim.marginRatio), typology: "scatter_gather", instance: inst });
    }
  },
  gather_scatter(sim, p) {
    const [s, e] = period(sim, p), k = sim.rng.int(p.min_accounts, p.max_accounts), all = members(sim, k, (a) => a.registration_step < s), n = Math.floor((k - 1) / 2), origs = all.slice(0, n), mid = all[n], benes = all.slice(n + 1, 2 * n + 1), midDate = Math.floor((s + e) / 2);
    const inst = sim.pattern({ typology: "gather_scatter", main: mid, participants: all, start: s, end: e, isSuspicious: p.is_sar, expectedFlags: [], note: "AMLSim gather-scatter: fan-in to one intermediary, then fan-out" });
    const amount = sim.rng.amount(p.min_amount, p.max_amount);
    for (const o of origs) sim.transfer({ from: o, to: mid, step: sim.rng.int(s, Math.max(s, midDate - 1)), offsetS: off(sim), amount, typology: "gather_scatter", instance: inst });
    for (const b of benes) sim.transfer({ from: mid, to: b, step: sim.rng.int(midDate, e), offsetS: off(sim), amount, typology: "gather_scatter", instance: inst });
  },

  /* ---------------- drains ---------------- */
  /* The published shape: a counted payment at least drain_mult x the wallet's previous largest, at
     least drain_min_usd, to an address it had never paid, with drain_min_history earlier payments. */
  drain(sim, p, rules, H) {
    const v = pickVictim(sim, H, rules); if (!v) throw new Error("drain: no eligible victim");
    const amount = Math.max(rules.drain_min_usd * 1.1, v.prior.max * rules.drain_mult * 1.1) * sim.rng.float(1, 1.8);
    const sink = sim.external("sink");
    const inst = sim.pattern({ typology: "drain", main: v.victim, participants: [v.victim], start: v.step, end: v.step, isSuspicious: true, expectedFlags: ["drain_pattern"], note: "a sudden payment far above the wallet's history, to a stranger", extra: { prior_payments: v.prior.n, previous_largest_usd: +v.prior.max.toFixed(2) } });
    fund(sim, v.victim, amount * 1.05, v.step, v.offsetS, inst);
    const t = sim.transfer({ from: v.victim, to: sink, step: v.step, offsetS: v.offsetS, amount, typology: "drain", instance: inst, isDrain: true, empties: true });
    inst.drain_tx = t.tx; inst.amount_usd = t.amount;
    if (rules.victim_silent_share) { inst.victim_silent = sim.rng.chance(rules.victim_silent_share); if (inst.victim_silent) sim.silence(v.victim, v.when.getTime()); }
  },
  /* Below the $250 floor on purpose: a small wallet emptied. The floor exists so a human can read every hit. */
  drain_small(sim, p, rules, H) {
    const cap = rules.drain_min_usd / rules.drain_mult / 1.3;
    const v = pickVictim(sim, H, rules, (a, h) => h.every((x) => x.amount <= cap)); if (!v) throw new Error("drain_small: no eligible victim");
    const amount = Math.min(rules.drain_min_usd * 0.9, Math.max(v.prior.max * rules.drain_mult * 1.1, 30));
    const sink = sim.external("sink");
    const inst = sim.pattern({ typology: "drain_small", main: v.victim, participants: [v.victim], start: v.step, end: v.step, isSuspicious: true, expectedFlags: [], note: "a drain below the $" + rules.drain_min_usd + " floor; by design not flagged", extra: { prior_payments: v.prior.n, previous_largest_usd: +v.prior.max.toFixed(2) } });
    fund(sim, v.victim, amount * 1.05, v.step, v.offsetS, inst);
    const t = sim.transfer({ from: v.victim, to: sink, step: v.step, offsetS: v.offsetS, amount, typology: "drain_small", instance: inst, isDrain: true, empties: true, emptiesCap: rules.drain_min_usd * 0.9 });
    inst.drain_tx = t.tx; inst.amount_usd = t.amount;
  },
  /* To an address the wallet had paid before (a compromised or impersonated seller). The rule asks
     for a stranger, so this is a known blind spot. */
  drain_known_payee(sim, p, rules, H) {
    const v = pickVictim(sim, H, rules); if (!v) throw new Error("drain_known_payee: no eligible victim");
    const amount = Math.max(rules.drain_min_usd * 1.1, v.prior.max * rules.drain_mult * 1.1) * sim.rng.float(1, 1.8);
    const known = { wallet: sim.rng.pick([...v.prior.payees]), external: true };
    const inst = sim.pattern({ typology: "drain_known_payee", main: v.victim, participants: [v.victim], start: v.step, end: v.step, isSuspicious: true, expectedFlags: [], note: "a drain to an address the wallet had paid before; the rule requires a stranger", extra: { prior_payments: v.prior.n, previous_largest_usd: +v.prior.max.toFixed(2) } });
    fund(sim, v.victim, amount * 1.05, v.step, v.offsetS, inst);
    const t = sim.transfer({ from: v.victim, to: known, step: v.step, offsetS: v.offsetS, amount, typology: "drain_known_payee", instance: inst, isDrain: true, empties: true });
    inst.drain_tx = t.tx; inst.amount_usd = t.amount;
  },
  /* Emptied in several steps, each under drain_mult x the running "previous largest", to one sink. */
  slow_drain(sim, p, rules, H) {
    const v = pickVictim(sim, H, rules, (a, h) => h.every((x) => x.amount <= 400)); if (!v) throw new Error("slow_drain: no eligible victim");
    const n = sim.rng.int(4, 6), sink = sim.external("sink"), spanS = sim.rng.int(6, 72) * 3600;
    const inst = sim.pattern({ typology: "slow_drain", main: v.victim, participants: [v.victim], start: v.step, end: sim.stepOf(new Date(v.when.getTime() + spanS * 1000)), isSuspicious: true, expectedFlags: [], note: "the wallet is emptied in " + n + " payments, each under " + rules.drain_mult + "x the previous largest, to one sink", extra: { prior_payments: v.prior.n, previous_largest_usd: +v.prior.max.toFixed(2) } });
    let largest = Math.max(v.prior.max, 1), total = 0; const amounts = [];
    for (let i = 0; i < n; i++) { const a = +(largest * sim.rng.float(1.6, rules.drain_mult - 0.5)).toFixed(6); amounts.push(a); largest = Math.max(largest, a); total += a; }
    fund(sim, v.victim, total * 1.02, v.step, v.offsetS, inst);
    const startMs = v.when.getTime(), endMs = Math.min(startMs + spanS * 1000, sim.endMs - 60000);
    amounts.forEach((a, i) => { const ms = startMs + ((endMs - startMs) * i) / Math.max(1, n - 1); const step = sim.stepOf(new Date(ms)); sim.transfer({ from: v.victim, to: sink, step, offsetS: Math.floor((ms - sim.base - step * sim.stepMs) / 1000), amount: a, typology: "slow_drain", instance: inst, isDrain: true, empties: i === n - 1 }); });
    inst.amount_usd = +total.toFixed(2);
    if (rules.victim_silent_share) { inst.victim_silent = sim.rng.chance(rules.victim_silent_share); if (inst.victim_silent) sim.silence(v.victim, endMs); }
  },
  /* A large hop through the wallet in one transaction: the pass-through exclusion must keep this
     silent. A flag here is a false alarm, and a telling one. */
  routing_hop_large(sim, p, rules) {
    const [a] = members(sim, 1, (x) => x.registration_step < sim.totalSteps - 48), step = sim.rng.int(a.registration_step + 1, sim.totalSteps - 1), amount = sim.rng.rounded(500, 5000);
    const inst = sim.pattern({ typology: "routing_hop_large", main: a, participants: [a], start: step, end: step, isSuspicious: false, expectedFlags: [], note: "$" + amount + " in and out in one transaction; excluded from spending by the pass-through rule, so no drain flag", extra: { amount_usd: amount } });
    const router = sim.rng.pick(sim.externals.routers);
    sim.routingHop({ agent: a, from: router, to: sim.external("seller"), step, offsetS: off(sim), amount, reason: router.reason || "router", typology: "routing_hop_large", instance: inst });
  },

  /* ---------------- retry storms ---------------- */
  retry_storm(sim, p, rules) {
    const [a] = members(sim, 1, (x) => x.registration_step < sim.totalSteps - 2), seller = sim.external("seller"), n = sim.rng.int(rules.retry_min, Math.round(rules.retry_min * 2.4));
    const step = sim.rng.int(a.registration_step + 1, sim.totalSteps - 1), start = sim.rng.int(0, 3600 - rules.retry_window_s - 1);
    const inst = sim.pattern({ typology: "retry_storm", main: a, participants: [a], start: step, end: step, isSuspicious: true, expectedFlags: ["retry_storm"], note: n + " payments to one seller inside " + rules.retry_window_s / 60 + " minutes", extra: { storm_to: sim.caip(seller.wallet), storm_hour: sim.at(step, 0).toISOString().slice(0, 13), payments: n } });
    const offs = Array.from({ length: n }, () => start + sim.rng.int(0, rules.retry_window_s - 1)).sort((x, y) => x - y);
    for (const o of offs) sim.transfer({ from: a, to: seller, step, offsetS: o, amount: sim.rng.amount(0.001, 0.05), rail: "x402", typology: "retry_storm", instance: inst });
  },
  /* The same count spread over 25 to 50 minutes: outside the window by definition. */
  retry_storm_slow(sim, p, rules) {
    const [a] = members(sim, 1, (x) => x.registration_step < sim.totalSteps - 2), seller = sim.external("seller"), n = sim.rng.int(rules.retry_min, Math.round(rules.retry_min * 1.5));
    const step = sim.rng.int(a.registration_step + 1, sim.totalSteps - 1), span = sim.rng.int(rules.retry_window_s * 2.5, rules.retry_window_s * 5), start = sim.rng.int(0, 3600 - span - 1);
    const inst = sim.pattern({ typology: "retry_storm_slow", main: a, participants: [a], start: step, end: step, isSuspicious: true, expectedFlags: [], note: n + " payments to one seller over " + Math.round(span / 60) + " minutes; outside the " + rules.retry_window_s / 60 + "-minute window", extra: { storm_to: sim.caip(seller.wallet), storm_hour: sim.at(step, 0).toISOString().slice(0, 13), payments: n } });
    for (let i = 0; i < n; i++) sim.transfer({ from: a, to: seller, step, offsetS: start + Math.round((span * i) / (n - 1)), amount: sim.rng.amount(0.001, 0.05), rail: "x402", typology: "retry_storm_slow", instance: inst });
  },
  /* Inside the window, but across an hour boundary: the detector buckets by hour, so each half is
     under the count. A real blind spot of the bucketing, measured here. */
  retry_storm_straddle(sim, p, rules) {
    const [a] = members(sim, 1, (x) => x.registration_step < sim.totalSteps - 3), seller = sim.external("seller"), n = sim.rng.int(Math.round(rules.retry_min * 1.05), Math.round(rules.retry_min * 1.4));
    const step = sim.rng.int(a.registration_step + 1, sim.totalSteps - 2), start = 3600 - Math.round(rules.retry_window_s * 0.4);
    const inst = sim.pattern({ typology: "retry_storm_straddle", main: a, participants: [a], start: step, end: step + 1, isSuspicious: true, expectedFlags: [], note: n + " payments inside " + rules.retry_window_s / 60 + " minutes that cross an hour boundary; the hour buckets each hold fewer than " + rules.retry_min, extra: { storm_to: sim.caip(seller.wallet), storm_hour: sim.at(step, 0).toISOString().slice(0, 13), payments: n } });
    for (let i = 0; i < n; i++) sim.transfer({ from: a, to: seller, step, offsetS: start + Math.round((rules.retry_window_s - 1) * i / (n - 1)), amount: sim.rng.amount(0.001, 0.05), rail: "x402", typology: "retry_storm_straddle", instance: inst });
  },

  /* ---------------- mint bursts ---------------- */
  mint_burst(sim, p, rules) {
    const minter = sim.newMinter(), n = sim.rng.int(rules.burst_min_per_hour, rules.burst_min_per_hour * 8), step = sim.rng.int(0, sim.totalSteps - 1), made = [];
    for (let i = 0; i < n; i++) made.push(sim.agent({ population: "burst_minted", step, offsetS: off(sim), minter }));
    sim.pattern({ typology: "mint_burst", main: made[0], participants: made, start: step, end: step, isSuspicious: false, expectedFlags: ["mint_burst"], note: n + " registrations minted by one address inside an hour; a shape, not a harm", extra: { minter, burst_hour: sim.at(step, 0).toISOString().slice(0, 13), registrations: n } });
    made.forEach((a) => sim.take(a));
  },
  mint_burst_spread(sim, p, rules) {
    const minter = sim.newMinter(), n = sim.rng.int(rules.burst_min_per_hour + 5, Math.round(rules.burst_min_per_hour * 1.8)), hours = Math.ceil(n / (rules.burst_min_per_hour - 1)) + 1;
    const step = sim.rng.int(0, sim.totalSteps - hours), made = [];
    for (let i = 0; i < n; i++) made.push(sim.agent({ population: "burst_minted_spread", step: step + (i % hours), offsetS: off(sim), minter }));
    sim.pattern({ typology: "mint_burst_spread", main: made[0], participants: made, start: step, end: step + hours - 1, isSuspicious: false, expectedFlags: [], note: n + " registrations by one address over " + hours + " hours, each hour under " + rules.burst_min_per_hour, extra: { minter, registrations: n } });
    made.forEach((a) => sim.take(a));
  },

  /* ---------------- endpoints ---------------- */
  uri_timeout_streak(sim, p, rules) {
    const [a] = members(sim, 1), f = sim.rng.int(rules.streak_min, Math.round(rules.streak_min * 2.5)), s0 = sim.rng.int(a.registration_step, Math.max(a.registration_step, sim.totalSteps - f * 6 - 1));
    sim.pattern({ typology: "uri_timeout_streak", main: a, participants: [a], start: s0, end: s0 + f * 6, isSuspicious: false, expectedFlags: ["uri_timeout_streak"], note: f + " failed probes and never one that answered" });
    for (let i = 0; i < f; i++) sim.probe(a, false, Math.min(sim.totalSteps - 1, s0 + i * 6), off(sim));
    a.uri_ok = false;
  },
  uri_flapping(sim, p, rules) {
    const [a] = members(sim, 1), f = sim.rng.int(rules.streak_min, rules.streak_min * 2), s0 = sim.rng.int(a.registration_step, Math.max(a.registration_step, sim.totalSteps - f * 6 - 2));
    sim.pattern({ typology: "uri_flapping", main: a, participants: [a], start: s0, end: s0 + f * 6, isSuspicious: false, expectedFlags: [], note: f + " failed probes with one success among them; not a streak by definition" });
    const okAt = sim.rng.int(1, f - 1);
    for (let i = 0; i <= f; i++) sim.probe(a, i === okAt, Math.min(sim.totalSteps - 1, s0 + i * 6), off(sim));
  },

  /* ---------------- quiet money ---------------- */
  funding_quiet(sim, p, rules) {
    const step = sim.rng.int(0, sim.totalSteps - 2), a = sim.agent({ population: "funding_quiet", step, offsetS: off(sim) }); sim.take(a);
    const inst = sim.pattern({ typology: "funding_quiet", main: a, participants: [a], start: step, end: step + 1, isSuspicious: false, expectedFlags: [], note: "funded after registration and never pays; the ladder must leave it at L0" });
    sim.transfer({ from: sim.rng.pick(sim.externals.funders), to: a, step: step + 1, offsetS: off(sim), amount: sim.rng.rounded(20, 500), typology: "funding_quiet", instance: inst });
  }
};

export function runTypologies(sim, rows, defaults, rules) {
  const H = history(sim);
  for (const row of rows) {
    const p = { ...defaults, ...row };
    const fn = TYPOLOGIES[p.type];
    if (!fn) throw new Error("unknown typology: " + p.type);
    for (let i = 0; i < p.count; i++) fn(sim, p, rules, H);
  }
}
