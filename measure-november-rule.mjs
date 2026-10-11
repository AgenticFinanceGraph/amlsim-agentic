#!/usr/bin/env node
/* Measure the proposed November slow-drain rule on a loaded synthetic run. Read-only. 11 Oct 2026.

     AFG_DB_ENV=<file with PG* variables> node measure-november-rule.mjs <run dir> <sim db> [--pulse <dir>] [--lookback "60 days"]

   Rule under test (plans/2026-10-11-dominant-share-windows-for-reading-v2.md):
     dominant share (the live candidate slowDrainsDominant, unchanged)
     AND the payee was paid by fewer than MAX_PAYERS agents (all time)
     AND the payee is not a labelled service        (a synthetic ledger has no labels: every payee passes;
                                                     the payer count carries that filter here)
     AND the agent made no counted payment to anyone else in the SILENCE_D days after the WINDOW_H window.

   Two readings. Lenient: silence until the end of the data counts as silence. Strict: only windows whose
   30 days fit inside the run are scored, over the instances whose 30 days fit. A run generated with
   `victim_silent_share` carries `victim_silent` on each drain instance, and the rule is scored on the
   silent victims (its target population) and on the others (its cost) separately. */
import pg from "pg";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const runArg = args[0], dbArg = args[1];
if (!runArg || !dbArg) { console.error("usage: node measure-november-rule.mjs <run dir> <sim db> [--pulse <dir>] [--lookback <interval>]"); process.exit(2); }
if (dbArg === "afg") { console.error("refusing the live database"); process.exit(2); }
const opt = (k) => (args.includes(k) ? args[args.indexOf(k) + 1] : null);
const dir = resolve(runArg);
const pulse = resolve(opt("--pulse") || resolve(dirname(fileURLToPath(import.meta.url)), "examples/afg-detectors"));
const lookback = opt("--lookback");
const D = await import(pathToFileURL(resolve(pulse, "lib/detectors.mjs")).href);
if (process.env.AFG_DB_ENV) Object.assign(process.env, Object.fromEntries(readFileSync(process.env.AFG_DB_ENV, "utf8").split(/\r?\n/)
  .filter((l) => l && !l.startsWith("#") && l.includes("=")).map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")]; })));
const pool = new pg.Pool({ database: dbArg, max: 2 });
const rows = (f) => readFileSync(resolve(dir, f), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const run = JSON.parse(readFileSync(resolve(dir, "run.json"), "utf8"));
const asOf = run.sim_end;
const patterns = rows("patterns.jsonl"), transfers = rows("transfers.jsonl");
const inst = new Map(patterns.map((p) => [p.typology_instance_id, p]));
const txInst = new Map(), txTyp = new Map();
for (const t of transfers) { if (t.typology_instance_id) txInst.set(t.tx, t.typology_instance_id); txTyp.set(t.tx, t.typology); }
const WINDOW_H = 72, SILENCE_D = 30, MAX_PAYERS = 10;
const horizonMs = (WINDOW_H * 3600 + SILENCE_D * 86400) * 1000;

const t0 = Date.now();
const dom = await D.slowDrainsDominant(pool, { asOf, limit: 1000000, ...(lookback ? { lookback } : {}) });
const domMs = Date.now() - t0;

/* extra signals for every window, one round trip; the temp table lives in a transaction that is rolled back */
const client = await pool.connect();
let sig;
try {
  await client.query("BEGIN");
  await client.query("CREATE TEMP TABLE w AS SELECT actor_id, to_id, block_time AS first_t, tx AS first_tx FROM money_events LIMIT 0");
  for (let i = 0; i < dom.length; i += 500) {
    const chunk = dom.slice(i, i + 500), vals = [], ph = [];
    chunk.forEach((r, j) => { vals.push(r.actor_id, r.to_id, r.first_t, r.first_tx); ph.push(`($${j * 4 + 1},$${j * 4 + 2},$${j * 4 + 3},$${j * 4 + 4})`); });
    if (chunk.length) await client.query("INSERT INTO w VALUES " + ph.join(","), vals);
  }
  const q = await client.query(
    `WITH counted AS (
       SELECT actor_id, to_id, block_time FROM money_events
       WHERE kind = 'PAY' AND NOT pre_registration AND NOT pass_through AND pass_checked_at IS NOT NULL AND block_time IS NOT NULL),
     payers AS (SELECT to_id, count(DISTINCT actor_id)::int AS n FROM counted WHERE to_id IN (SELECT to_id FROM w) GROUP BY 1),
     after AS (
       SELECT w.first_tx, count(*) FILTER (WHERE c.to_id <> w.to_id)::int AS others_after, count(*)::int AS any_after
       FROM w LEFT JOIN counted c ON c.actor_id = w.actor_id
            AND c.block_time > w.first_t + ($1 || ' hours')::interval
            AND c.block_time <= w.first_t + ($1 || ' hours')::interval + ($2 || ' days')::interval
       GROUP BY 1)
     SELECT w.first_tx, coalesce(p.n, 0) AS payee_payers, a.others_after, a.any_after,
            (w.first_t + ($1 || ' hours')::interval + ($2 || ' days')::interval <= $3::timestamptz) AS evaluable
     FROM w JOIN after a USING (first_tx) LEFT JOIN payers p ON p.to_id = w.to_id`,
    [String(WINDOW_H), String(SILENCE_D), asOf]);
  sig = new Map(q.rows.map((r) => [r.first_tx, r]));
  await client.query("ROLLBACK");
} finally { client.release(); }

const win = dom.map((r) => {
  const s = sig.get(r.first_tx), p = inst.get(txInst.get(r.first_tx)) || null;
  return {
    first_tx: r.first_tx, actor: r.actor_id, payee: r.to_id, first_t: r.first_t, usd: +Number(r.usd).toFixed(2), payments: r.payments,
    payee_payers: s.payee_payers, others_after: s.others_after, any_after: s.any_after, evaluable: s.evaluable,
    instance: p ? p.typology_instance_id : null, typology: p ? p.typology : (txTyp.get(r.first_tx) || "normal"),
    victim_silent: p ? p.victim_silent === true : null,
    truth: p && p.typology === "slow_drain" ? "slow_drain" : (p && p.is_suspicious ? "other_suspicious" : "benign"),
  };
});

/* instances: when each slow drain started, whether its 30 days fit, whether its victim went silent */
const slowInst = patterns.filter((p) => p.typology === "slow_drain");
const instFirst = new Map();
for (const t of transfers) if (t.typology === "slow_drain" && t.typology_instance_id) {
  const bt = new Date(t.timestamp), cur = instFirst.get(t.typology_instance_id);
  if (!cur || bt < cur) instFirst.set(t.typology_instance_id, bt);
}
const fits = (p) => { const f = instFirst.get(p.typology_instance_id); return Boolean(f) && f.getTime() + horizonMs <= Date.parse(asOf); };
const S = (f) => new Set(slowInst.filter(f).map((p) => p.typology_instance_id));
const allInst = S(() => true), evalInst = S(fits), silentInst = S((p) => p.victim_silent === true), loudInst = S((p) => p.victim_silent !== true);
const silentEval = S((p) => p.victim_silent === true && fits(p)), loudEval = S((p) => p.victim_silent !== true && fits(p));

function score(name, keep, denom) {
  const kept = win.filter(keep);
  const hits = new Set(kept.filter((w) => w.truth === "slow_drain" && denom.has(w.instance)).map((w) => w.instance));
  const fa = kept.filter((w) => w.truth === "benign"), uc = kept.filter((w) => w.truth === "other_suspicious");
  const faTyp = {}; for (const w of fa) faTyp[w.typology] = (faTyp[w.typology] || 0) + 1;
  const prec = hits.size + fa.length ? hits.size / (hits.size + fa.length) : null;
  return { rule: name, windows: kept.length, hits: hits.size, instances: denom.size, false_alarms: fa.length, false_alarm_typologies: faTyp, unexpected_catches: uc.length,
    precision_pct: prec == null ? null : +(100 * prec).toFixed(1), recall_pct: denom.size ? +(100 * hits.size / denom.size).toFixed(1) : null };
}
const payersOk = (w) => w.payee_payers < MAX_PAYERS, silent = (w) => w.others_after === 0;
const out = {
  run: dir, db: dbArg, sim_end: asOf, lookback: lookback || "detector default", dominant_ms: domMs, dominant_windows: dom.length,
  slow_drain_instances: slowInst.length, instances_whose_30_days_fit: evalInst.size, silent_victims: silentInst.size, silent_victims_whose_30_days_fit: silentEval.size,
  thresholds: { window_hours: WINDOW_H, silence_days: SILENCE_D, max_payee_payers: MAX_PAYERS },
  rules: [
    score("A  dominant share (live candidate)", () => true, allInst),
    score("B  A + payee paid by < " + MAX_PAYERS + " agents", payersOk, allInst),
    score("C  B + agent paid no one else in the next 30 d, lenient, all instances", (w) => payersOk(w) && silent(w), allInst),
    score("C1 same, scored on silent victims only (the rule's target)", (w) => payersOk(w) && silent(w) && w.victim_silent === true, silentInst),
    score("C2 same, scored on victims that kept trading (the rule's cost)", (w) => payersOk(w) && silent(w) && w.victim_silent !== true, loudInst),
    score("D  B + silence, strict: windows whose 30 d fit, over instances whose 30 d fit", (w) => payersOk(w) && silent(w) && w.evaluable, evalInst),
    score("D1 strict, silent victims only", (w) => payersOk(w) && silent(w) && w.evaluable && w.victim_silent === true, silentEval),
    score("D2 strict, victims that kept trading", (w) => payersOk(w) && silent(w) && w.evaluable && w.victim_silent !== true, loudEval),
    score("E  A + silence only (no payer filter), lenient", silent, allInst),
  ],
  windows_by_truth: win.reduce((m, w) => (m[w.truth] = (m[w.truth] || 0) + 1, m), {}),
  payer_count_of_slow_drain_sinks: win.filter((w) => w.truth === "slow_drain").reduce((m, w) => { const k = w.payee_payers >= MAX_PAYERS ? ">=" + MAX_PAYERS : String(w.payee_payers); m[k] = (m[k] || 0) + 1; return m; }, {}),
  dropped_by_silence: win.filter((w) => w.truth === "slow_drain" && payersOk(w) && !silent(w)).map((w) => ({ instance: w.instance, victim_silent: w.victim_silent, others_after: w.others_after, evaluable: w.evaluable, usd: w.usd })),
  surviving_false_alarms: win.filter((w) => w.truth === "benign" && payersOk(w) && silent(w)).map((w) => ({ typology: w.typology, actor: w.actor, payee: w.payee, usd: w.usd, payments: w.payments, payee_payers: w.payee_payers, evaluable: w.evaluable })),
  missed_by_dominant: [...allInst].filter((id) => !win.some((w) => w.instance === id)).map((id) => ({ instance: id, victim_silent: inst.get(id).victim_silent === true })),
};
console.log(JSON.stringify(out, null, 1));
await pool.end();
