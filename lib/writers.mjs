/* Two output sets from one run.

   AMLSim-compatible CSVs (accounts, transactions, alert_transactions, alert_accounts) use the column
   names from AMLSim's schema.json, so tools built for AMLSim output read them; AFG's extra fields
   are appended as further columns. The AFG JSONL files (agents, transfers, patterns) carry the full
   labels and are what the loader and validator read. */
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { modelId } from "./typologies.mjs";

const csvCell = (v) => { if (v == null) return ""; const s = v instanceof Date ? v.toISOString() : String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
const csv = (header, rows) => [header.join(","), ...rows.map((r) => r.map(csvCell).join(","))].join("\n") + "\n";
const jsonl = (rows) => rows.map((r) => JSON.stringify(r)).join("\n") + "\n";

export function writeAll(sim, dir) {
  mkdirSync(dir, { recursive: true });
  const byInstance = new Map(sim.patterns.map((p) => [p.typology_instance_id, p]));
  const sar = (t) => { const p = t.typology_instance_id && byInstance.get(t.typology_instance_id); return p ? p.is_suspicious : false; };
  const spent = (t) => t.counts_as_spent;

  /* AMLSim: accounts.csv */
  writeFileSync(join(dir, "accounts.csv"), csv(
    ["acct_id", "dsply_nm", "type", "acct_stat", "acct_rptng_crncy", "prior_sar_count", "branch_id", "open_dt", "close_dt", "initial_deposit", "tx_behavior_id", "bank_id", "country",
     "wallet", "minter", "registration_step", "population", "final_balance"],
    sim.agents.map((a) => [a.id, a.actor_id, "AGENT", "A", "USD", 0, "", a.registered_at, "", a.initial_balance, 0, "base", "XX", a.wallet, a.minter, a.registration_step, a.population, a.final_balance])));
  /* AMLSim: transactions.csv */
  const txHeader = ["tran_id", "orig_acct", "bene_acct", "tx_type", "base_amt", "tran_timestamp", "is_sar", "alert_id",
    "token", "kind", "rail", "orig_wallet", "bene_wallet", "tx_hash", "is_routing", "routing_reason", "typology", "is_drain", "is_repeat_counterparty", "post_registration", "counts_as_spent", "balance_before", "balance_after"];
  const txRow = (t) => [t.transfer_id, t.from_agent ? t.from_agent.id : "", t.to_agent ? t.to_agent.id : "", "TRANSFER", t.amount, t.timestamp, sar(t), t.typology_instance_id || "",
    t.token, t.from_agent ? "PAY" : "EARN", t.rail, t.from_wallet, t.to_wallet, t.tx, t.is_routing, t.routing_reason || "", t.typology, t.is_drain, t.is_repeat_counterparty, t.post_registration, spent(t), t.balance_before ?? "", t.balance_after ?? ""];
  writeFileSync(join(dir, "transactions.csv"), csv(txHeader, sim.transfers.map(txRow)));
  /* AMLSim: alert_transactions.csv and alert_accounts.csv */
  const alertTx = sim.transfers.filter((t) => t.typology_instance_id).map((t) => {
    const p = byInstance.get(t.typology_instance_id);
    return [p.typology_instance_id, p.typology, p.is_suspicious, t.transfer_id, t.from_agent ? t.from_agent.id : "", t.to_agent ? t.to_agent.id : "", "TRANSFER", t.amount, t.timestamp];
  });
  writeFileSync(join(dir, "alert_transactions.csv"), csv(["alert_id", "alert_type", "is_sar", "tran_id", "orig_acct", "bene_acct", "tx_type", "base_amt", "tran_timestamp"], alertTx));
  const byActor = new Map(sim.agents.map((a) => [a.actor_id, a]));
  const alertAcc = sim.patterns.flatMap((p) => p.participant_agent_ids.map((id) => { const a = byActor.get(id); return [p.typology_instance_id, p.typology, p.is_suspicious, a.id, a.actor_id, modelId(p.typology), sim.at(p.start_step), sim.at(p.end_step), p.schedule_id ?? "", "base"]; }));
  writeFileSync(join(dir, "alert_accounts.csv"), csv(["alert_id", "alert_type", "is_sar", "acct_id", "acct_name", "model_id", "start", "end", "schedule_id", "bank_id"], alertAcc));

  /* AFG: agents.jsonl */
  writeFileSync(join(dir, "agents.jsonl"), jsonl(sim.agents.map((a) => {
    const lv = sim.expectedLevel(a);
    return { agent_id: a.actor_id, token_id: a.id, wallet: a.wallet, probe_id: a.probe_id, minter: a.minter, mint_tx: a.mint_tx, registration_step: a.registration_step, registered_at: a.registered_at,
      initial_balance: a.initial_balance, final_balance: a.final_balance, is_funded: a.initial_balance > 0 || a.final_balance > 0 || sim.transfers.some((t) => t.to_agent === a), population: a.population,
      expected_level: lv.level, expected_features: { counted_pays: lv.counted_pays, float_usd: lv.float, distinct_counterparties_30d: lv.distinct_counterparties_30d }, metadata: a.metadata };
  })));
  /* AFG: transfers.jsonl */
  writeFileSync(join(dir, "transfers.jsonl"), jsonl(sim.transfers.map((t) => ({
    transfer_id: t.transfer_id, step: t.step, timestamp: t.timestamp, from_agent_id: t.from_agent ? t.from_agent.actor_id : null, from_wallet: t.from_wallet,
    to_agent_id: t.to_agent ? t.to_agent.actor_id : null, to_wallet: t.to_wallet, token: t.token, rail: t.rail, amount: t.amount, tx: t.tx,
    is_routing: t.is_routing, routing_reason: t.routing_reason, typology: t.typology, typology_instance_id: t.typology_instance_id, is_drain: t.is_drain,
    is_repeat_counterparty: t.is_repeat_counterparty, post_registration: t.post_registration, counts_as_spent: t.counts_as_spent, label_confidence: t.label_confidence,
    balance_before: t.balance_before, balance_after: t.balance_after, empties_wallet: Boolean(t.empties)
  }))));
  /* AFG: patterns.jsonl */
  writeFileSync(join(dir, "patterns.jsonl"), jsonl(sim.patterns.map((p) => {
    const { transfer_ids, ...rest } = p;
    const total = transfer_ids.reduce((s, id) => s + (sim.transferById.get(id)?.amount || 0), 0);
    if (rest.drain_tx) { const d = sim.transfers.find((t) => t.tx === rest.drain_tx); if (d) rest.amount_usd = d.amount; }
    return { ...rest, model_id: modelId(p.typology), start_at: sim.at(p.start_step), end_at: sim.at(p.end_step + 1), transfer_ids, total_amount: +total.toFixed(6) };
  })));
  /* probes.jsonl (the endpoint checks the streak detector reads) */
  writeFileSync(join(dir, "probes.jsonl"), jsonl(sim.probes));
  writeFileSync(join(dir, "run.json"), JSON.stringify({
    generator: "amlsim-agentic 0.1.0", generated_at: new Date().toISOString(), config: sim.config,
    counts: { agents: sim.agents.length, transfers: sim.transfers.length, patterns: sim.patterns.length, probes: sim.probes.length,
      counted_spending_usd: +sim.transfers.filter(spent).reduce((s, t) => s + t.amount, 0).toFixed(2), routing_usd: +sim.transfers.filter((t) => t.is_routing && t.from_agent).reduce((s, t) => s + t.amount, 0).toFixed(2) },
    sim_start: new Date(sim.base).toISOString(), sim_end: new Date(sim.endMs).toISOString()
  }, null, 2) + "\n");
}
