/* Normal behaviour. The six models are AMLSim's (src/main/java/amlsim/model/normal), read for their
   meaning and rewritten for agent wallets:

     single      send once to one neighbour
     fan_out     distribute to several neighbours
     fan_in      receive from several senders
     forward     send on what was received, in a similar size, a little later
     mutual      return money to a previous sender
     periodical  send to the same neighbour at a fixed interval

   plus two shapes AMLSim has no reason to model and this ledger sees all day:

     x402_micro  many tiny payments to a few sellers (an agent buying API calls)
     purchase    an occasional larger one-off payment to a new address — legitimate, and the shape
                 the drain detector is known to confuse with a drain; it is here on purpose

   A counterparty is a seller (an external address, like an x402 resource) or another agent. The
   `params` object carries AMLSim's normalModels.csv columns: count, type, schedule_id, min_accounts,
   max_accounts, min_period, max_period, and the amount band from the config's `default`. */
import { SCHEDULE } from "./engine.mjs";

function counterparty(sim, exclude) {
  const r = sim.rng;
  if (r.chance(0.6) || sim.agents.length < 2) return r.pick(sim.externals.sellers);
  let a; do { a = r.pick(sim.agents); } while (a === exclude);
  return a;
}
function window(sim, p) {
  const period = sim.rng.int(p.min_period, p.max_period);
  const start = sim.rng.int(0, Math.max(0, sim.totalSteps - period));
  return [start, start + period - 1];
}
const amountOf = (sim, p) => sim.rng.amount(p.min_amount, p.max_amount);

export const NORMAL_MODELS = {
  single(sim, p, main) {
    const [s, e] = window(sim, p);
    sim.transfer({ from: main, to: counterparty(sim, main), step: sim.rng.int(s, e), offsetS: sim.rng.int(0, 3599), amount: amountOf(sim, p), typology: "single" });
  },
  fan_out(sim, p, main) {
    const [s, e] = window(sim, p), n = sim.rng.int(p.min_accounts, p.max_accounts) - 1;
    const dates = sim.schedule(n, s, e, p.schedule_id);
    for (let i = 0; i < n; i++) sim.transfer({ from: main, to: counterparty(sim, main), step: dates[i], offsetS: sim.rng.int(0, 3599), amount: amountOf(sim, p), typology: "fan_out" });
  },
  fan_in(sim, p, main) {
    const [s, e] = window(sim, p), n = sim.rng.int(p.min_accounts, p.max_accounts) - 1;
    const dates = sim.schedule(n, s, e, p.schedule_id);
    for (let i = 0; i < n; i++) sim.transfer({ from: counterparty(sim, main), to: main, step: dates[i], offsetS: sim.rng.int(0, 3599), amount: amountOf(sim, p), typology: "fan_in" });
  },
  /* Forwarded in a LATER transaction, so by AFG's definition it is not a pass-through: the wallet
     held the money, however briefly. That is the definition, and this model exists to show it. */
  forward(sim, p, main) {
    const [s, e] = window(sim, p), amt = amountOf(sim, p), t0 = sim.rng.int(s, Math.max(s, e - 1));
    sim.transfer({ from: counterparty(sim, main), to: main, step: t0, offsetS: sim.rng.int(0, 1800), amount: amt, typology: "forward" });
    sim.transfer({ from: main, to: counterparty(sim, main), step: Math.min(e, t0 + sim.rng.int(0, 2)), offsetS: sim.rng.int(1801, 3599), amount: amt * (1 - sim.marginRatio), typology: "forward" });
  },
  mutual(sim, p, main) {
    const [s, e] = window(sim, p), other = counterparty(sim, main), t0 = sim.rng.int(s, Math.max(s, e - 1)), amt = amountOf(sim, p);
    sim.transfer({ from: main, to: other, step: t0, offsetS: sim.rng.int(0, 3599), amount: amt, typology: "mutual" });
    sim.transfer({ from: other, to: main, step: Math.min(e, t0 + sim.rng.int(1, 3)), offsetS: sim.rng.int(0, 3599), amount: amt * sim.rng.float(0.5, 1), typology: "mutual" });
  },
  periodical(sim, p, main) {
    const [s, e] = window(sim, p), other = counterparty(sim, main), n = sim.rng.int(p.min_accounts, p.max_accounts);
    const dates = sim.schedule(n, s, e, SCHEDULE.FIXED_INTERVAL), amt = amountOf(sim, p), off = sim.rng.int(0, 3599);
    for (const d of dates) sim.transfer({ from: main, to: other, step: d, offsetS: off, amount: amt, typology: "periodical" });
  },
  x402_micro(sim, p, main) {
    const [s, e] = window(sim, p), sellers = sim.rng.sample(sim.externals.sellers, sim.rng.int(1, 5)), n = sim.rng.int(p.min_accounts, p.max_accounts);
    const dates = sim.schedule(n, s, e, SCHEDULE.RANDOM_INTERVAL);
    for (const d of dates) sim.transfer({ from: main, to: sim.rng.pick(sellers), step: d, offsetS: sim.rng.int(0, 3599), amount: sim.rng.amount(p.min_amount, p.max_amount), rail: "x402", typology: "x402_micro" });
  },
  purchase(sim, p, main) {
    const [s, e] = window(sim, p);
    sim.transfer({ from: main, to: sim.external("seller"), step: sim.rng.int(s, e), offsetS: sim.rng.int(0, 3599), amount: sim.rng.rounded(p.min_amount, p.max_amount), typology: "purchase", keepShare: 0.4 });
  }
};

/* Runs every normal model row of the config. Members are drawn from the whole population; an
   agent can take part in many models, as a real wallet does. */
export function runNormal(sim, rows, defaults) {
  for (const row of rows) {
    const p = { ...defaults, ...row };
    const fn = NORMAL_MODELS[p.type];
    if (!fn) throw new Error("unknown normal model: " + p.type);
    for (let i = 0; i < p.count; i++) fn(sim, p, sim.rng.pick(sim.agents));
  }
}
