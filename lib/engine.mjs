/* The simulation: a population of agent wallets, a clock, a transfer list and the bookkeeping that
   turns transfers into labelled records. Behaviour models (normal.mjs) and injected patterns
   (typologies.mjs) only ever call the handful of methods here.

   The vocabulary is AMLSim's where it carries over: steps, schedules, main account, alert members,
   margin ratio. What AMLSim calls an account is an ERC-8004 agent with a bound wallet; what it calls
   a bank is gone (chains are one chain here); what it calls a SAR is `is_suspicious`. */

export const SCHEDULE = { FIXED_INTERVAL: 0, RANDOM_INTERVAL: 1, UNORDERED: 2, SIMULTANEOUS: 3 };
export const CHAIN = "eip155:8453";
export const REGISTRY = "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432";
export const TOKEN_IDS = { USDC: "USDC", USDT: "USDT", EURC: "EURC", DAI: "DAI" };

export class Sim {
  constructor(config, rng) {
    this.config = config; this.rng = rng;
    const g = config.general;
    this.base = Date.parse(g.base_date);
    this.stepMs = (g.step_minutes || 60) * 60000;
    this.totalSteps = g.total_steps;
    this.endMs = this.base + this.totalSteps * this.stepMs;
    this.marginRatio = (config.default && config.default.margin_ratio) ?? 0.1;
    this.agents = []; this.transfers = []; this.patterns = []; this.probes = [];
    this.externals = { sellers: [], routers: [], funders: [] };
    this.minters = [];
    this.nextToken = (config.population && config.population.first_token_id) || 200000;
    this.seq = 0; this.patternSeq = 0;
    this.taken = new Set();                         // agents already used as alert members (AMLSim removes them from candidates)
  }

  /* ---- clock ---- */
  at(step, offsetS = 0) { return new Date(this.base + step * this.stepMs + offsetS * 1000); }
  stepOf(date) { return Math.floor((date.getTime() - this.base) / this.stepMs); }
  /* AMLSim's four schedules: the dates of n transfers inside [start, end]. */
  schedule(n, start, end, kind) {
    const rng = this.rng, span = Math.max(0, end - start);
    if (kind === SCHEDULE.SIMULTANEOUS) return Array.from({ length: n }, () => start);
    if (kind === SCHEDULE.FIXED_INTERVAL) return Array.from({ length: n }, (_, i) => start + Math.round(n > 1 ? (span * i) / (n - 1) : 0));
    const dates = Array.from({ length: n }, () => rng.int(start, end));
    return kind === SCHEDULE.UNORDERED ? dates : dates.sort((a, b) => a - b);
  }

  /* ---- addresses and agents ---- */
  address() { return "0x" + this.rng.hex(40); }
  txHash() { return "0x" + this.rng.hex(64); }
  caip(addr) { return CHAIN + ":" + addr; }
  external(kind, meta = {}) { const e = { wallet: this.address(), external: true, kind, ...meta }; if (this.externals[kind + "s"]) this.externals[kind + "s"].push(e); return e; }
  newMinter() { const m = this.address(); this.minters.push(m); return m; }
  /* An agent: one registration (an ERC-721 mint) and one bound wallet. The minter is who paid for
     the mint, which is what the mint_burst detector groups on. */
  agent({ population = "normal", step = 0, offsetS = 0, minter = null, balance = 0, metadata = {} } = {}) {
    const id = this.nextToken++;
    const a = {
      id, actor_id: "act_8453_" + id, probe_id: CHAIN + ":" + REGISTRY + ":" + id,
      wallet: this.address(), minter: minter || this.rng.pick(this.minters), mint_tx: this.txHash(),
      registration_step: step, registration_offset_s: offsetS, registered_at: this.at(step, offsetS),
      initial_balance: +balance.toFixed(6), balance: +balance.toFixed(6), population, metadata,
      pays: 0, counted_pays: 0, counterparties: new Map(), prior_max: 0, first_counted_pay_step: null, uri_ok: true
    };
    this.agents.push(a);
    return a;
  }

  /* ---- transfers ---- */
  /* One transfer. `from`/`to` are agents or externals. `kind` is PAY (out of the from-agent's wallet) or
     EARN (into the to-agent's wallet) in AFG's vocabulary; a transfer between two agents is a PAY for
     the payer and an EARN for the payee, and is recorded once with both ids. */
  /* `empties`: the payment takes everything the wallet holds at that moment (what a drain does); the
     planned amount is then a floor the wallet is funded up to. `emptiesCap` bounds the take (a small
     wallet emptied). `keepShare`: the wallet is funded so this payment leaves at least that share of
     the balance behind (what a purchase does). Both are settled in finalize(), where balances exist. */
  transfer({ from, to, step, offsetS = 0, amount, token = "USDC", rail = "usdc_transfer", typology = "normal", instance = null,
             isRouting = false, routingReason = null, isDrain = false, tx = null, labelConfidence = 1, empties = false, emptiesCap = null, keepShare = null }) {
    if (!(amount > 0)) return null;
    const t = {
      transfer_id: "tr_" + String(++this.seq).padStart(8, "0"), step, offset_s: offsetS, timestamp: this.at(step, offsetS),
      from_agent: from.external ? null : from, to_agent: to.external ? null : to,
      from_wallet: from.wallet, to_wallet: to.wallet, token, rail, amount: +(+amount).toFixed(6),
      typology, typology_instance_id: instance ? instance.typology_instance_id : null,
      is_routing: isRouting, routing_reason: routingReason, is_drain: isDrain, tx: tx || this.txHash(), label_confidence: labelConfidence,
      empties, empties_cap: emptiesCap, keep_share: keepShare, balance_before: null, balance_after: null
    };
    this.transfers.push(t);
    if (instance) instance.transfer_ids.push(t.transfer_id);
    return t;
  }
  /* A routing hop: money arrives in the agent's wallet and leaves it again in the same transaction,
     within 2% (a router skim). This is what AFG's pass-through check excludes from "spent". */
  routingHop({ agent, from, to, step, offsetS = 0, amount, reason = "router", typology = "routing_hop", instance = null }) {
    const tx = this.txHash();
    const skim = amount * this.rng.float(0, 0.015);
    const a = this.transfer({ from, to: agent, step, offsetS, amount, typology, instance, isRouting: true, routingReason: reason, tx });
    const b = this.transfer({ from: agent, to, step, offsetS, amount: amount - skim, typology, instance, isRouting: true, routingReason: reason, tx });
    return [a, b];
  }

  /* ---- patterns ---- */
  pattern({ typology, main, participants, start, end, isSuspicious, expectedFlags, note = null, extra = {} }) {
    const p = {
      typology_instance_id: typology + "_" + String(++this.patternSeq).padStart(5, "0"), typology,
      main_agent_id: main ? main.actor_id : null, participant_agent_ids: participants.filter((x) => x && !x.external).map((x) => x.actor_id),
      start_step: start, end_step: end, is_suspicious: isSuspicious, expected_flags: expectedFlags, note, transfer_ids: [], ...extra
    };
    this.patterns.push(p);
    return p;
  }
  take(agent) { this.taken.add(agent.actor_id); }
  candidates(filter = () => true) { return this.agents.filter((a) => !this.taken.has(a.actor_id) && filter(a)); }

  /* ---- probes ---- */
  probe(agent, ok, step, offsetS = 0, endpoint = null) {
    this.probes.push({ actor_id: agent.probe_id, endpoint: endpoint || "https://sim.invalid/agent/" + agent.id, ok, http_status: ok ? 200 : null,
      protocol: "service", rtt_ms: ok ? this.rng.int(40, 900) : this.rng.int(8000, 8100), error_class: ok ? null : "network", at: this.at(step, offsetS) });
  }

  /* ---- finalize: order, labels, balances ----
     Walks every transfer in time order and keeps each agent's balance honest: a payment the wallet
     could not afford gets a funding transfer in front of it (AMLSim's cash-in; here money arriving
     from an exchange or a treasury), because a wallet that pays $300 must have held $300. */
  finalize() {
    this.transfers.sort((a, b) => a.timestamp - b.timestamp || a.transfer_id.localeCompare(b.transfer_id));
    const funders = this.externals.funders.length ? this.externals.funders : [this.external("funder")];
    const pairs = new Set(), out = [];
    const byAgent = new Map(this.agents.map((a) => [a.actor_id, a]));
    for (const a of this.agents) { a.balance = a.initial_balance; a.pays = 0; a.counted_pays = 0; a.counterparties = new Map(); a.prior_max = 0; a.first_counted_pay_step = null; }
    for (const t of this.transfers) {
      const payer = t.from_agent ? byAgent.get(t.from_agent.actor_id) : null;
      const payee = t.to_agent ? byAgent.get(t.to_agent.actor_id) : null;
      t.post_registration = payer ? t.timestamp >= payer.registered_at : false;
      t.counts_as_spent = Boolean(payer) && t.post_registration && !t.is_routing;
      const key = t.from_wallet + ">" + t.to_wallet;
      t.is_repeat_counterparty = pairs.has(key); pairs.add(key);
      if (payer && !t.is_routing) {
        const required = t.keep_share ? t.amount / (1 - t.keep_share) : t.amount;
        if (payer.balance + 1e-9 < required) {
          const need = +(required - payer.balance + this.rng.rounded(5, 60)).toFixed(6);
          const f = { transfer_id: "tr_" + String(++this.seq).padStart(8, "0"), step: t.step, offset_s: t.offset_s - 1, timestamp: new Date(t.timestamp.getTime() - 1000),
            from_agent: null, to_agent: payer, from_wallet: this.rng.pick(funders).wallet, to_wallet: payer.wallet, token: t.token, rail: "usdc_transfer", amount: need,
            typology: "funding", typology_instance_id: null, is_routing: false, routing_reason: null, is_drain: false, tx: this.txHash(), label_confidence: 1,
            post_registration: false, counts_as_spent: false, is_repeat_counterparty: false, empties: false, empties_cap: null, keep_share: null, balance_before: payer.balance, balance_after: payer.balance + need };
          out.push(f); payer.balance += need;
        }
        if (t.empties) t.amount = +Math.min(payer.balance, t.empties_cap || Infinity).toFixed(6);
        t.balance_before = +payer.balance.toFixed(6);
        payer.balance -= t.amount; payer.pays++;
        t.balance_after = +payer.balance.toFixed(6);
        if (t.counts_as_spent) {
          payer.counted_pays++; payer.prior_max = Math.max(payer.prior_max, t.amount);
          if (payer.first_counted_pay_step == null) payer.first_counted_pay_step = t.step;
          payer.counterparties.set(t.to_wallet, t.timestamp);
        }
      }
      if (payee && !t.is_routing) payee.balance += t.amount;
      out.push(t);
    }
    this.transfers = out;
    for (const a of this.agents) a.final_balance = +a.balance.toFixed(6);
    this.probes.sort((a, b) => a.at - b.at);
  }

  /* The ladder's three money rungs, computed from the generator's own bookkeeping by the published
     rule (lib/ladder.mjs): L7 one counted payment, L8 float >= $10, L9 three distinct counterparties
     in the last 30 days. The validator derives the same three numbers from the loaded tables and
     feeds them to the production score(); the two must agree. */
  expectedLevel(a) {
    const cutoff = this.endMs - 30 * 86400000;
    const distinct30 = [...a.counterparties.values()].filter((d) => d.getTime() > cutoff).length;
    let level = 0;
    if (a.counted_pays >= 1) level = 7;
    if (level >= 7 && a.final_balance >= 10) level = 8;
    if (level >= 8 && distinct30 >= 3) level = 9;
    return { level, counted_pays: a.counted_pays, float: a.final_balance, distinct_counterparties_30d: distinct30 };
  }
}
