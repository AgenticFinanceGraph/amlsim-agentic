#!/usr/bin/env node
/* amlsim-agentic: generate a labelled synthetic agent-payment graph.

     node generate.mjs config/afg-2k.json out/afg-2k

   Offline and single-process; it touches no network and no database. The output directory gets
   AMLSim-style CSVs and AFG JSONL (see lib/writers.mjs). The same config and seed give the same
   files. */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { makeRng } from "./lib/rng.mjs";
import { Sim } from "./lib/engine.mjs";
import { runNormal } from "./lib/normal.mjs";
import { runTypologies } from "./lib/typologies.mjs";
import { writeAll } from "./lib/writers.mjs";

const [cfgPath, outDir] = process.argv.slice(2);
if (!cfgPath || !outDir) { console.error("usage: node generate.mjs <config.json> <out dir>"); process.exit(2); }
const config = JSON.parse(readFileSync(resolve(cfgPath), "utf8"));
const rng = makeRng(config.general.random_seed);
const sim = new Sim(config, rng);
const pop = config.population;

/* 1. the world: minters, sellers, routers, funders */
for (let i = 0; i < pop.minters; i++) sim.newMinter();
for (let i = 0; i < pop.sellers; i++) sim.external("seller");
const ROUTER_KINDS = ["router", "bridge", "escrow", "cctp"];
for (let i = 0; i < pop.routers; i++) sim.external("router", { reason: ROUTER_KINDS[i % ROUTER_KINDS.length] });
for (let i = 0; i < pop.funders; i++) sim.external("funder");

/* 2. the population: registrations spread over the run, each with a starting balance drawn from
   the config band (most agent wallets hold little; a few hold a lot) */
for (let i = 0; i < pop.agents; i++) {
  const step = rng.int(0, Math.max(0, Math.floor(sim.totalSteps * (pop.registration_spread ?? 0.9))));
  const hot = rng.chance(pop.hot_share ?? 0);
  const balance = !hot && rng.chance(pop.funded_share ?? 0.6) ? rng.rounded(pop.initial_balance[0], pop.initial_balance[1]) : 0;
  sim.agent({ population: "normal", step, offsetS: rng.int(0, 3599), balance, hot });
}

/* 3. normal behaviour, then the injected patterns (which read the history normal behaviour left) */
runNormal(sim, config.normal_models, config.default);
runTypologies(sim, config.alert_patterns, config.default, config.afg_rules);

/* 4. background probes: endpoints that answer, so the streak detector sees a realistic table */
for (const a of sim.agents) if (a.uri_ok && rng.chance(pop.probed_share ?? 0.3)) {
  const n = rng.int(1, 4);
  for (let i = 0; i < n; i++) sim.probe(a, true, rng.int(a.registration_step, sim.totalSteps - 1), rng.int(0, 3599));
}

/* 5. labels, balances, files */
sim.finalize();
sim.transferById = new Map(sim.transfers.map((t) => [t.transfer_id, t]));
writeAll(sim, resolve(outDir));
const run = JSON.parse(readFileSync(resolve(outDir, "run.json"), "utf8"));
console.log(JSON.stringify({ out: resolve(outDir), ...run.counts, patterns_by_type: sim.patterns.reduce((m, p) => (m[p.typology] = (m[p.typology] || 0) + 1, m), {}) }));
