#!/usr/bin/env node
/* Run the ledger's own detectors over a loaded run and score them against the labels.

     node validate.mjs out/afg-2k [--pulse <dir holding lib/detectors.mjs, lib/ladder.mjs, lib/passthrough.mjs>]

   The detector functions, the liveness ladder and the pass-through rule are imported from the
   production code (lib/detectors.mjs, lib/ladder.mjs, lib/passthrough.mjs under --pulse), not
   re-implemented here, so what is measured is what runs on the live ledger every hour.

   Vocabulary. For each detector kind: an instance whose expected_flags name the kind is a HIT if the
   detector found it and a MISS if not; a detection on anything else is a FALSE ALARM, unless it lands
   on an instance labelled suspicious that the rules were not expected to catch, which is an
   UNEXPECTED CATCH (good news, listed separately so it cannot inflate precision by accident). */
import pg from "pg";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname, relative } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const dir = resolve(args[0] || "");
if (!args[0]) { console.error("usage: node validate.mjs <run dir> [--pulse <detector code dir>]"); process.exit(2); }
const HERE = dirname(fileURLToPath(import.meta.url));
const pulse = args.includes("--pulse") ? resolve(args[args.indexOf("--pulse") + 1]) : resolve(HERE, "examples/afg-detectors");
const D = await import(pathToFileURL(resolve(pulse, "lib/detectors.mjs")).href);
const { score } = await import(pathToFileURL(resolve(pulse, "lib/ladder.mjs")).href);
const { classifyLegs } = await import(pathToFileURL(resolve(pulse, "lib/passthrough.mjs")).href);

const DB = process.env.AFG_SIM_DB || "afg_sim";
if (DB === "afg") { console.error("refusing to validate against the live database"); process.exit(2); }
/* Connection: the standard PG* environment variables (libpq), or a KEY=value file named by AFG_DB_ENV. */
const fileEnv = process.env.AFG_DB_ENV ? Object.fromEntries(readFileSync(process.env.AFG_DB_ENV, "utf8").split(/\r?\n/)
  .filter((l) => l && !l.startsWith("#") && l.includes("=")).map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")]; })) : {};
Object.assign(process.env, fileEnv);                 // pg reads the standard variables itself
const pool = new pg.Pool({ database: DB, max: 2 });
const pulseLabel = relative(HERE, pulse) || ".";
const rows = (f) => readFileSync(resolve(dir, f), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const run = JSON.parse(readFileSync(resolve(dir, "run.json"), "utf8"));
const asOf = run.sim_end;
const agents = rows("agents.jsonl"), transfers = rows("transfers.jsonl"), patterns = rows("patterns.jsonl");
const byActor = new Map(agents.map((a) => [a.agent_id, a])), byProbe = new Map(agents.map((a) => [a.probe_id, a]));
const inst = new Map(patterns.map((p) => [p.typology_instance_id, p]));
const txInst = new Map(), txTyp = new Map();
for (const t of transfers) { if (t.typology_instance_id) txInst.set(t.tx, t.typology_instance_id); txTyp.set(t.tx, t.typology); }
const instByMain = new Map(); for (const p of patterns) { if (!instByMain.has(p.main_agent_id)) instByMain.set(p.main_agent_id, []); instByMain.get(p.main_agent_id).push(p); }
const instByMinter = new Map(); for (const p of patterns) if (p.minter) { if (!instByMinter.has(p.minter)) instByMinter.set(p.minter, []); instByMinter.get(p.minter).push(p); }
const hourOf = (d) => new Date(d).toISOString().slice(0, 13);

const t0 = Date.now();
/* no cap: a validation must see every row the rule produces, not the hourly run's first hundred */
const BIG = 1000000;
const found = { mint_burst: await D.mintBursts(pool, { limit: BIG }), retry_storm: await D.retryStorms(pool, { limit: BIG }), drain_pattern: await D.drains(pool, { asOf, limit: BIG }), uri_timeout_streak: await D.probeStreaks(pool, { limit: BIG }) };
const detectorMs = Date.now() - t0;

/* ---- match detections to instances ---- */
const caught = new Set(), outcomes = {};
function tally(kind, verdict, detail) { (outcomes[kind] ||= { hit: [], miss: [], false_alarm: [], unexpected_catch: [] })[verdict].push(detail); }
function judge(kind, p, detail) {
  if (p && p.expected_flags.includes(kind)) { if (!caught.has(p.typology_instance_id + "|" + kind)) { caught.add(p.typology_instance_id + "|" + kind); tally(kind, "hit", { instance: p.typology_instance_id, ...detail }); } }
  else if (p && p.is_suspicious) tally(kind, "unexpected_catch", { instance: p.typology_instance_id, typology: p.typology, ...detail });
  else tally(kind, "false_alarm", { instance: p ? p.typology_instance_id : null, typology: p ? p.typology : detail.typology || "normal", ...detail });
}
for (const r of found.drain_pattern) {
  const p = inst.get(txInst.get(r.tx));
  judge("drain_pattern", p, { actor: r.actor_id, tx: r.tx, usd: +Number(r.amount_usd).toFixed(2), previous_largest_usd: +Number(r.prior_max).toFixed(2), prior_payments: Number(r.prior_n), typology: txTyp.get(r.tx) });
}
for (const r of found.retry_storm) {
  const p = (instByMain.get(r.actor_id) || []).find((x) => x.storm_to === r.to_id) || null;
  judge("retry_storm", p, { actor: r.actor_id, counterparty: r.to_id, payments: r.n, hour: hourOf(r.from_t), typology: p ? p.typology : "periodical" });
}
for (const r of found.mint_burst) {
  const p = (instByMinter.get(r.minted_to) || []).find((x) => x.burst_hour === hourOf(r.hour)) || (instByMinter.get(r.minted_to) || [])[0] || null;
  judge("mint_burst", p, { minter: r.minted_to, hour: hourOf(r.hour), registrations: r.n });
}
for (const r of found.uri_timeout_streak) {
  const a = byProbe.get(r.actor_id);
  const p = a ? (instByMain.get(a.agent_id) || []).find((x) => /^uri_/.test(x.typology)) || null : null;
  judge("uri_timeout_streak", p, { actor: a ? a.agent_id : r.actor_id, failed_probes: Number(r.fails) });
}
for (const p of patterns) for (const k of p.expected_flags) if (!caught.has(p.typology_instance_id + "|" + k)) tally(k, "miss", { instance: p.typology_instance_id, typology: p.typology, note: p.note, ...(p.amount_usd ? { usd: p.amount_usd } : {}) });

const detectors = {};
for (const k of ["drain_pattern", "retry_storm", "mint_burst", "uri_timeout_streak"]) {
  const o = outcomes[k] || { hit: [], miss: [], false_alarm: [], unexpected_catch: [] };
  const tp = o.hit.length, fn = o.miss.length, fp = o.false_alarm.length;
  detectors[k] = { expected: tp + fn, hit: tp, miss: fn, false_alarm: fp, unexpected_catch: o.unexpected_catch.length,
    precision: tp + fp ? +(tp / (tp + fp)).toFixed(3) : null, recall: tp + fn ? +(tp / (tp + fn)).toFixed(3) : null, detections: found[k].length,
    false_alarms_by_shape: o.false_alarm.reduce((m, x) => (m[x.typology] = (m[x.typology] || 0) + 1, m), {}),
    unexpected_catches_by_shape: o.unexpected_catch.reduce((m, x) => (m[x.typology] = (m[x.typology] || 0) + 1, m), {}), detail: o };
}

/* ---- candidate rules: measured the same way, reported apart, never wired into the live run ---- */
const candidates = {};
/* `target` names a typology the candidate is meant to find (for shapes no live rule covers, such as
   AMLSim's); otherwise the expectation is the instance's expected_flags for `kind`. */
async function candidate(name, kind, rows, matchFn, { target = null } = {}) {
  const isExpected = (p) => (target ? p.typology === target : p.expected_flags.includes(kind));
  const o = { hit: [], miss: [], false_alarm: [], unexpected_catch: [] }, seen = new Set();
  for (const r of rows) {
    const { p, detail } = matchFn(r);
    if (p && isExpected(p)) { if (!seen.has(p.typology_instance_id)) { seen.add(p.typology_instance_id); o.hit.push({ instance: p.typology_instance_id, ...detail }); } }
    else if (p && p.is_suspicious) { if (!seen.has(p.typology_instance_id)) { seen.add(p.typology_instance_id); o.unexpected_catch.push({ instance: p.typology_instance_id, typology: p.typology, ...detail }); } }
    else o.false_alarm.push({ instance: p ? p.typology_instance_id : null, typology: p ? p.typology : detail.typology || "normal", ...detail });
  }
  for (const p of patterns) if (isExpected(p) && !seen.has(p.typology_instance_id)) o.miss.push({ instance: p.typology_instance_id, typology: p.typology });
  const tp = o.hit.length, fn = o.miss.length, fp = o.false_alarm.length;
  candidates[name] = { kind, expected: tp + fn, hit: tp, miss: fn, false_alarm: fp, unexpected_catch: o.unexpected_catch.length, precision: tp + fp ? +(tp / (tp + fp)).toFixed(3) : null, recall: tp + fn ? +(tp / (tp + fn)).toFixed(3) : null, detections: rows.length,
    unexpected_catches_by_shape: o.unexpected_catch.reduce((m, x) => (m[x.typology] = (m[x.typology] || 0) + 1, m), {}), false_alarms_by_shape: o.false_alarm.reduce((m, x) => (m[x.typology] = (m[x.typology] || 0) + 1, m), {}), detail: o };
}
if (D.retryStormsSliding) await candidate("retry_storm_sliding_10min", "retry_storm", await D.retryStormsSliding(pool, { limit: BIG }), (r) => { const p = (instByMain.get(r.actor_id) || []).find((x) => x.storm_to === r.to_id) || null; return { p, detail: { actor: r.actor_id, counterparty: r.to_id, payments: r.n, typology: p ? p.typology : "periodical" } }; });
if (D.mintBurstsSliding) await candidate("mint_burst_sliding_60min", "mint_burst", await D.mintBurstsSliding(pool, { limit: BIG }), (r) => ({ p: (instByMinter.get(r.minted_to) || [])[0] || null, detail: { minter: r.minted_to, registrations: r.n } }));
if (D.slowDrains) await candidate("slow_drain_72h_sum", "drain_pattern", await D.slowDrains(pool, { asOf, limit: BIG }), (r) => { const p = inst.get(txInst.get(r.first_tx)) || null; return { p, detail: { actor: r.actor_id, payee: r.to_id, usd: +Number(r.usd).toFixed(2), payments: r.payments, typology: p ? p.typology : txTyp.get(r.first_tx) } }; });
if (D.drainsEmptied) {
  const bal = new Map((await pool.query("SELECT tx, wallet, usd::float8 AS usd, usd_after::float8 AS usd_after FROM sim_balance_before")).rows.map((r) => [r.tx + "|" + r.wallet, r]));
  const balanceAt = async (w, t, tx, asset, { after = false } = {}) => { const r = bal.get(tx + "|" + w); return r ? (after ? r.usd_after : r.usd) : null; };
  await candidate("drain_emptied_80pct", "drain_pattern", await D.drainsEmptied(pool, { asOf, balanceAt, limit: BIG }),
    (r) => { const p = inst.get(txInst.get(r.tx)) || null; return { p, detail: { actor: r.actor_id, tx: r.tx, usd: +Number(r.amount_usd).toFixed(2), fraction_of_balance: r.fraction_of_balance, typology: p ? p.typology : txTyp.get(r.tx) } }; });
}
if (D.slowDrainsEmptied) {
  const bal = new Map((await pool.query("SELECT tx, wallet, usd::float8 AS usd, usd_after::float8 AS usd_after FROM sim_balance_before")).rows.map((r) => [r.tx + "|" + r.wallet, r]));
  const balanceAt = async (w, t, tx, asset, { after = false } = {}) => { const r = bal.get(tx + "|" + w); return r ? (after ? r.usd_after : r.usd) : null; };
  await candidate("slow_drain_72h_emptied_80pct", "drain_pattern", await D.slowDrainsEmptied(pool, { asOf, balanceAt, limit: BIG }),
    (r) => { const p = inst.get(txInst.get(r.first_tx)) || null; return { p, detail: { actor: r.actor_id, payee: r.to_id, usd: +Number(r.usd).toFixed(2), payments: r.payments, fraction_of_balance: r.fraction_of_balance, typology: p ? p.typology : txTyp.get(r.first_tx) } }; });
}
/* layering: the detectors that did not exist before the synthetic data did */
const LY = await import(pathToFileURL(resolve(pulse, "lib/layering.mjs")).href).catch(() => null);
let layering = null;
if (LY) {
  const t1 = Date.now(); const edges = await LY.loadEdges(pool, { sinceDays: 90, asOf });
  const overlap = (det, p) => { const s = new Set(p.participant_agent_ids); return det.participants.filter((a) => s.has(a)).length / Math.max(1, s.size); };
  const withMembers = patterns.filter((p) => p.participant_agent_ids.length >= 3);
  const matchAny = (det) => { let best = null, bo = 0; for (const p of withMembers) { const o = overlap(det, p); if (o > bo) { bo = o; best = p; } } return bo >= 0.5 ? best : null; };
  layering = { edges: edges.length, load_ms: Date.now() - t1, ms: {} };
  for (const [name, fn, typ, opts] of [["cycle", LY.cycles, "cycle", {}], ["cycle_wide", LY.cycles, "cycle", { maxOut: 200, keep: 0.4 }], ["scatter_gather", LY.scatterGather, "scatter_gather", {}], ["gather_scatter", LY.gatherScatter, "gather_scatter", {}], ["fan_in_same_amount", LY.fanInSameAmount, "fan_in", {}], ["fan_out_same_amount", LY.fanOutSameAmount, "fan_out", {}]]) {
    const s = Date.now(); const rows = fn(edges, { limit: BIG, ...opts }); layering.ms[name] = Date.now() - s;
    await candidate("layering_" + name, typ, rows, (r) => { const p = matchAny(r); return { p, detail: { main: r.main, members: r.participants.length, usd: r.usd, typology: p ? p.typology : "normal" } }; }, { target: typ });
  }
}
/* the address-poisoning matcher, on symbols and addresses with known answers */
const PM = await import(pathToFileURL(resolve(pulse, "lib/poisonmatch.mjs")).href).catch(() => null);
let poisoning = null;
if (PM) {
  const A = "0xabcd00000000000000000000000000000000001234", B = "0x1111000000000000000000000000000000009999", C = "0xabcd11111111111111111111111111111111111234";
  const ix = PM.payeeIndex([C, A, B], new Map([[A, 1000], [B, 2000], [C, 3000]]));
  const probe = "0xabcd99999999999999999999999999999999991234";
  const cases = [
    ["Cyrillic С in USDС normalises to USDC", PM.norm("USDС") === "USDC"],
    ["zero-width space inside U​SDC is removed", PM.norm("U​SDC") === "USDC"],
    ["lower case usdc", PM.norm("usdc") === "USDC"],
    ["punctuation USD-C", PM.norm("USD-C") === "USDC"],
    ["Greek Ε in ΕURC", PM.norm("ΕURC") === "EURC"],
    ["combining acute on U is stripped", PM.norm("ÚSDC") === "USDC"],
    ["a real symbol is unchanged", PM.norm("USDT") === "USDT"],
    ["look-alike by first 4 + last 4 names the payee", (() => { const r = PM.lookalike(probe, ix, new Date(5000)); return !!r && r.m === "f4l4" && r.r === A; })()],
    ["the payee known longest is preferred among same-shape payees", (() => { const r = PM.lookalike(probe, ix, new Date(5000)); return !!r && r.r === A; })()],
    ["last 4 only is reported as the weaker match", (() => { const r = PM.lookalike("0x5555000000000000000000000000000000009999", ix, new Date(5000)); return !!r && r.m === "l4" && r.r === B; })()],
    ["an unrelated address matches nothing", PM.lookalike("0x7777000000000000000000000000000000007777", ix, new Date(5000)) === null],
    ["a payee is not its own look-alike", PM.lookalike(B, ix, new Date(5000)) === null]
  ];
  poisoning = { cases: cases.length, agree: cases.filter((c) => c[1]).length, detail: cases.map(([n, ok]) => ({ case: n, ok })) };

  /* end to end: synthetic wallets with payee histories, planted look-alikes, then a payment. The
     rule under test is the worker's: a LOSS is a real-token payment to an address that was planted
     in that wallet's history first (by a zero-value real-token transfer, or a fake-symbol transfer),
     where the planted address is a look-alike of a real payee. Seeded, so the cases repeat. */
  const { makeRng } = await import(pathToFileURL(resolve(HERE, "lib/rng.mjs")).href);
  const rng = makeRng(777), hex = (n) => rng.hex(n);
  const addr = () => "0x" + hex(40);
  const lookalikeOf = (a, kind) => (kind === "f4l4" ? a.slice(0, 6) + hex(32) + a.slice(-4) : "0x" + hex(36) + a.slice(-4));
  const e2e = { wallets: 0, planted: 0, losses_expected: 0, losses_found: 0, false_losses: 0, missed: 0, detail: [] };
  for (let w = 0; w < 300; w++) {
    const payees = Array.from({ length: rng.int(2, 8) }, () => addr());
    const first = new Map(payees.map((p, i) => [p, 1000 + i * 1000]));
    const ix2 = PM.payeeIndex(payees, first);
    const history = [];                                                  // {t, to, token, value, fake}
    const victimPays = [];                                               // real payments after the plants
    const scenario = rng.pick(["f4l4_zero", "l4_fake", "f4l4_fake", "clean_new_payee", "l4_real_token_only", "payee_again"]);
    const target = rng.pick(payees);
    let plantedAddr = null, expectLoss = false;
    if (scenario === "f4l4_zero") { plantedAddr = lookalikeOf(target, "f4l4"); history.push({ t: 20000, to: plantedAddr, real: true, value: 0n, fake: false }); expectLoss = true; }
    if (scenario === "l4_fake") { plantedAddr = lookalikeOf(target, "l4"); history.push({ t: 20000, to: plantedAddr, real: false, value: 50n, fake: true }); expectLoss = true; }
    if (scenario === "f4l4_fake") { plantedAddr = lookalikeOf(target, "f4l4"); history.push({ t: 20000, to: plantedAddr, real: false, value: 50n, fake: true }); expectLoss = true; }
    if (scenario === "l4_real_token_only") { plantedAddr = lookalikeOf(target, "l4"); history.push({ t: 20000, to: plantedAddr, real: true, value: 0n, fake: false }); expectLoss = false; }   // last-4 alone needs a fake symbol
    if (scenario === "clean_new_payee") { plantedAddr = addr(); expectLoss = false; }
    if (scenario === "payee_again") { plantedAddr = target; expectLoss = false; }
    victimPays.push({ t: 30000, to: plantedAddr, usd: rng.rounded(10, 200) });
    /* the worker's classification, step by step */
    const plants = new Map();
    for (const h of history) {
      const lk = PM.lookalike(h.to, ix2, new Date(h.t));
      let kind = null;
      if (h.real) { if (h.value === 0n) kind = lk ? "zero_value" : null; }
      else if (lk && h.fake) kind = "fake_symbol";
      else if (lk && lk.m === "f4l4") kind = "lookalike_token";
      if (kind && lk && (lk.m === "f4l4" || h.fake)) plants.set(h.to, { t: h.t, kind, of: lk.r });
    }
    e2e.wallets++; e2e.planted += plants.size;
    for (const p of victimPays) {
      const planted = plants.get(p.to);
      const isLoss = Boolean(planted && planted.t < p.t && !ix2.set.has(p.to));
      if (expectLoss) e2e.losses_expected++;
      if (isLoss && expectLoss) e2e.losses_found++;
      else if (isLoss && !expectLoss) { e2e.false_losses++; e2e.detail.push({ scenario, verdict: "false loss" }); }
      else if (!isLoss && expectLoss) { e2e.missed++; e2e.detail.push({ scenario, verdict: "missed" }); }
    }
  }
  poisoning.end_to_end = e2e;
}

/* ---- per typology ---- */
const typologies = {};
for (const p of patterns) {
  const t = (typologies[p.typology] ||= { instances: 0, suspicious: p.is_suspicious, expected_flags: p.expected_flags, hit: 0, miss: 0, flagged_unexpectedly: 0, note: p.note });
  t.instances++;
  for (const k of p.expected_flags) { if (caught.has(p.typology_instance_id + "|" + k)) t.hit++; else t.miss++; }
}
for (const k of Object.keys(outcomes)) for (const x of outcomes[k].unexpected_catch.concat(outcomes[k].false_alarm)) if (x.instance && typologies[inst.get(x.instance).typology]) typologies[inst.get(x.instance).typology].flagged_unexpectedly++;

/* ---- the liveness ladder: production score() over features derived from the loaded tables ---- */
const { rows: feats } = await pool.query(
  `SELECT a.actor_id, coalesce(w.usdc_float, 0)::float8 AS float_usd,
          count(m.event_id) FILTER (WHERE m.kind = 'PAY' AND NOT m.pre_registration AND NOT m.pass_through)::int AS pays,
          count(DISTINCT m.to_id) FILTER (WHERE m.kind = 'PAY' AND NOT m.pre_registration AND NOT m.pass_through AND m.block_time > $1::timestamptz - interval '30 days')::int AS d30
   FROM actors a LEFT JOIN wallets w ON w.caip10 = a.primary_wallet LEFT JOIN money_events m ON m.actor_id = a.actor_id
   GROUP BY 1, 2`, [asOf]);
const ladder = { agents: 0, agree: 0, by_expected_level: {}, disagreements: [] };
for (const f of feats) {
  const a = byActor.get(f.actor_id); if (!a) continue;
  const got = score({ hasIdentity: true, nonInferredPayCount: f.pays, stableFloatUsd: f.float_usd, distinctCounterparties30d: f.d30 });
  ladder.agents++; const b = (ladder.by_expected_level[a.expected_level] ||= { agents: 0, agree: 0 }); b.agents++;
  if (got === a.expected_level) { ladder.agree++; b.agree++; } else if (ladder.disagreements.length < 20) ladder.disagreements.push({ agent: a.agent_id, expected: a.expected_level, got, features: { pays: f.pays, float_usd: f.float_usd, d30: f.d30 }, generator_features: a.expected_features });
}

/* ---- the pass-through rule over synthetic receipts with known answers ---- */
const W = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", X = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", Y = "0xcccccccccccccccccccccccccccccccccccccccc";
const PT_CASES = [
  { name: "own balance spent (one leg out)", legs: [{ from: W, to: X, usd: 100 }], expect: false },
  { name: "exact hop in and out", legs: [{ from: X, to: W, usd: 100 }, { from: W, to: Y, usd: 100 }], expect: true },
  { name: "router skim 0.5%", legs: [{ from: X, to: W, usd: 100 }, { from: W, to: Y, usd: 99.5 }], expect: true },
  { name: "skim 1.9% (inside tolerance)", legs: [{ from: X, to: W, usd: 100 }, { from: W, to: Y, usd: 98.1 }], expect: true },
  { name: "skim 2.5% (outside tolerance)", legs: [{ from: X, to: W, usd: 100 }, { from: W, to: Y, usd: 97.5 }], expect: false },
  { name: "USDT in, USDC out, same size (a swap)", legs: [{ from: X, to: W, usd: 250 }, { from: W, to: Y, usd: 249 }], expect: true },
  { name: "partial forward 60%", legs: [{ from: X, to: W, usd: 100 }, { from: W, to: Y, usd: 60 }], expect: false },
  { name: "received only (nothing out)", legs: [{ from: X, to: W, usd: 100 }], expect: false },
  { name: "two legs in, one out, equal total", legs: [{ from: X, to: W, usd: 40 }, { from: Y, to: W, usd: 60 }, { from: W, to: X, usd: 100 }], expect: true },
  { name: "unrelated legs only", legs: [{ from: X, to: Y, usd: 100 }], expect: false }
];
const passthrough = { cases: PT_CASES.length, agree: 0, detail: [] };
for (const c of PT_CASES) { const r = classifyLegs(c.legs, W); const ok = r.isPass === c.expect; if (ok) passthrough.agree++; passthrough.detail.push({ case: c.name, expected: c.expect, got: r.isPass, ok }); }

/* ---- fidelity: the loaded tables agree with the generator on counted spending ---- */
const { rows: chk } = await pool.query("SELECT round(sum(amount_usd), 2)::float8 AS usd, count(*)::int AS n FROM money_events WHERE kind = 'PAY' AND NOT pre_registration AND NOT pass_through");
const fidelity = { counted_spending_tables: chk[0].usd, counted_spending_generator: run.counts.counted_spending_usd, counted_events: chk[0].n, match: Math.abs(chk[0].usd - run.counts.counted_spending_usd) < 0.01 };

const report = { run: run.config.general, generated_at: run.generated_at, validated_at: new Date().toISOString(), as_of: asOf, detector_code: pulseLabel, counts: run.counts, detector_ms: detectorMs,
  rules: { DRAIN_MULT: D.DRAIN_MULT, DRAIN_MIN_USD: D.DRAIN_MIN_USD, DRAIN_MIN_HISTORY: D.DRAIN_MIN_HISTORY, DRAIN_LOOKBACK: D.DRAIN_LOOKBACK, RETRY_MIN: D.RETRY_MIN, RETRY_WINDOW: D.RETRY_WINDOW, SYBIL_MIN_PER_HOUR: D.SYBIL_MIN_PER_HOUR, STREAK_MIN: D.STREAK_MIN },
  detectors, candidates, layering, poisoning, typologies, ladder, passthrough, fidelity };
writeFileSync(resolve(dir, "report.json"), JSON.stringify(report, null, 2) + "\n");

/* ---- the human-readable report ---- */
const pct = (x) => (x == null ? "n/a" : (100 * x).toFixed(1) + "%");
const L = [];
L.push("# Detector validation on synthetic labelled data: " + run.config.general.simulation_name, "",
  "Generated " + run.generated_at.slice(0, 16).replace("T", " ") + " UTC, seed " + run.config.general.random_seed + ", " + run.counts.agents.toLocaleString("en-US") + " agents, " + run.counts.transfers.toLocaleString("en-US") + " transfers, " + run.counts.patterns + " injected patterns over " + run.config.general.total_steps + " steps of " + run.config.general.step_minutes + " min. Detectors imported from `" + pulseLabel + "` (run time " + detectorMs + " ms).", "",
  "Synthetic data measures the rules, not the chain: every number below says how a detector behaves on shapes with known answers, and nothing about how often those shapes occur in the real ledger.", "",
  "## Detectors", "", "| detector | expected | hit | miss | false alarms | unexpected catches | precision | recall |", "|---|---|---|---|---|---|---|---|");
for (const [k, d] of Object.entries(detectors)) L.push("| " + k + " | " + d.expected + " | " + d.hit + " | " + d.miss + " | " + d.false_alarm + " | " + d.unexpected_catch + " | " + pct(d.precision) + " | " + pct(d.recall) + " |");
L.push("", "False alarms by the shape that caused them: " + Object.entries(detectors).flatMap(([k, d]) => Object.entries(d.false_alarms_by_shape).map(([s, n]) => k + " on " + s + " x" + n)).join("; ") + ".", "",
  "Unexpected catches: " + (Object.entries(detectors).flatMap(([k, d]) => Object.entries(d.unexpected_catches_by_shape).map(([s, n]) => k + " on " + s + " x" + n)).join("; ") || "none") + ".", "",
  "");
if (Object.keys(candidates).length) {
  L.push("## Candidate rules (not live)", "", "Proposed replacements, measured the same way. An unexpected catch here is a suspicious near-miss the live rule leaves silent and the candidate finds.", "",
    "| candidate | for | expected | hit | miss | false alarms | unexpected catches | precision | recall |", "|---|---|---|---|---|---|---|---|---|");
  for (const [n, c] of Object.entries(candidates)) L.push("| " + n + " | " + c.kind + " | " + c.expected + " | " + c.hit + " | " + c.miss + " | " + c.false_alarm + (Object.keys(c.false_alarms_by_shape).length ? " (" + Object.entries(c.false_alarms_by_shape).map(([s, k]) => s + " x" + k).join(", ") + ")" : "") + " | " + c.unexpected_catch + (Object.keys(c.unexpected_catches_by_shape).length ? " (" + Object.entries(c.unexpected_catches_by_shape).map(([s, k]) => s + " x" + k).join(", ") + ")" : "") + " | " + pct(c.precision) + " | " + pct(c.recall) + " |");
  if (layering) L.push("", "Layering ran over " + layering.edges.toLocaleString("en-US") + " agent-to-agent edges (loaded in " + layering.load_ms + " ms; " + Object.entries(layering.ms).map(([k, v]) => k + " " + v + " ms").join(", ") + "). A layering candidate's \"expected\" column counts the injected instances of that AMLSim shape.");
  L.push("");
}
L.push("## Shapes", "", "| shape | instances | suspicious | expected flag | hit | miss | flagged unexpectedly | what it is |", "|---|---|---|---|---|---|---|---|");
for (const [t, v] of Object.entries(typologies)) L.push("| " + t + " | " + v.instances + " | " + (v.suspicious ? "yes" : "no") + " | " + (v.expected_flags.join(", ") || "none") + " | " + v.hit + " | " + v.miss + " | " + v.flagged_unexpectedly + " | " + v.note + " |");
L.push("", "## Blind spots by design", "", "Suspicious shapes the published rules are not written to catch, and what happened:", "");
for (const [t, v] of Object.entries(typologies)) if (v.suspicious && !v.expected_flags.length) L.push("- **" + t + "** (" + v.instances + "): " + v.note + ". Flagged anyway: " + v.flagged_unexpectedly + ".");
L.push("", "## Liveness ladder", "", "Production `score()` over features derived from the loaded tables, against the level the generator expected from the published rule: " + ladder.agree + " of " + ladder.agents + " agents agree (" + pct(ladder.agree / ladder.agents) + ").", "",
  "| expected level | agents | agree |", "|---|---|---|");
for (const [lv, b] of Object.entries(ladder.by_expected_level)) L.push("| L" + lv + " | " + b.agents + " | " + b.agree + " |");
if (ladder.disagreements.length) { L.push("", "Disagreements (first " + ladder.disagreements.length + "):", ""); for (const d of ladder.disagreements) L.push("- " + d.agent + ": expected L" + d.expected + ", got L" + d.got + "; tables " + JSON.stringify(d.features) + ", generator " + JSON.stringify(d.generator_features)); }
L.push("", "## Pass-through rule", "", "Production `classifyLegs()` over synthetic receipts: " + passthrough.agree + " of " + passthrough.cases + " cases agree with the published definition (in and out in one transaction, within 2%).", "", "| case | expected | got |", "|---|---|---|");
for (const c of passthrough.detail) L.push("| " + c.case + " | " + c.expected + " | " + c.got + (c.ok ? "" : " (DISAGREES)") + " |");
if (poisoning) {
  L.push("", "## Address-poisoning matcher", "", "Production `norm()` and `lookalike()` over symbols and addresses with known answers: " + poisoning.agree + " of " + poisoning.cases + " cases agree.", "", "| case | ok |", "|---|---|");
  for (const c of poisoning.detail) L.push("| " + c.case + " | " + (c.ok ? "yes" : "NO") + " |");
  if (poisoning.end_to_end) { const e = poisoning.end_to_end; L.push("", "End to end, " + e.wallets + " synthetic wallets with planted look-alikes (seeded): " + e.losses_found + " of " + e.losses_expected + " losses found, " + e.false_losses + " false losses, " + e.missed + " missed. The rule: a real-token payment to an address planted in the wallet's history first, where the plant is a look-alike of a real payee (first 4 + last 4, or last 4 with a fake-symbol token)."); }
}
L.push("", "## Fidelity", "", "Counted spending in the loaded tables: $" + fidelity.counted_spending_tables.toLocaleString("en-US") + "; the generator's own total: $" + fidelity.counted_spending_generator.toLocaleString("en-US") + " (" + (fidelity.match ? "match" : "MISMATCH") + "), " + fidelity.counted_events.toLocaleString("en-US") + " counted payments.", "");
writeFileSync(resolve(dir, "report.md"), L.join("\n"));

console.log(JSON.stringify({ detectors: Object.fromEntries(Object.entries(detectors).map(([k, d]) => [k, { expected: d.expected, hit: d.hit, miss: d.miss, false_alarm: d.false_alarm, unexpected_catch: d.unexpected_catch, precision: d.precision, recall: d.recall }])),
  ladder: { agents: ladder.agents, agree: ladder.agree }, passthrough: { cases: passthrough.cases, agree: passthrough.agree }, fidelity: fidelity.match, report: resolve(dir, "report.md") }));
await pool.end();
