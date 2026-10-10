#!/usr/bin/env node
/* Load a generated run into the sim database, in the live ledger's table shapes.

     node load.mjs out/afg-2k

   The database is afg_sim (AFG_SIM_DB to change it), reached with the standard PG* environment
   variables or a KEY=value file named by AFG_DB_ENV. The tables are emptied first;
   nothing here can reach the live database, because the database name is fixed here and is never
   "afg". */
import pg from "pg";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const dir = resolve(process.argv[2] || "");
if (!process.argv[2]) { console.error("usage: node load.mjs <run dir>"); process.exit(2); }
const DB = process.env.AFG_SIM_DB || "afg_sim";
if (DB === "afg") { console.error("refusing to load synthetic rows into the live database"); process.exit(2); }
/* Connection: the standard PG* environment variables (libpq), or a KEY=value file named by AFG_DB_ENV. */
const fileEnv = process.env.AFG_DB_ENV ? Object.fromEntries(readFileSync(process.env.AFG_DB_ENV, "utf8").split(/\r?\n/)
  .filter((l) => l && !l.startsWith("#") && l.includes("=")).map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")]; })) : {};
Object.assign(process.env, fileEnv);                 // pg reads the standard variables itself
const pool = new pg.Pool({ database: DB, max: 2 });
const CHAIN = "eip155:8453";
const rows = (f) => readFileSync(resolve(dir, f), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));

await pool.query(readFileSync(resolve(HERE, "schema.sql"), "utf8"));
/* the generator's books: what each paying wallet held just before each payment (the validator's
   stand-in for an on-chain balance lookup) */
await pool.query("CREATE TABLE IF NOT EXISTS sim_balance_before (tx text NOT NULL, wallet text NOT NULL, usd numeric NOT NULL, PRIMARY KEY (tx, wallet))");
await pool.query("ALTER TABLE sim_balance_before ADD COLUMN IF NOT EXISTS usd_after numeric");
await pool.query("TRUNCATE actors, bindings, money_events, probes, registrations, wallets, sim_balance_before");

async function insert(table, cols, data, mapper) {
  let n = 0;
  for (let i = 0; i < data.length; i += 500) {
    const chunk = data.slice(i, i + 500).map(mapper), vals = [], args = [];
    chunk.forEach((r, j) => { vals.push("(" + r.map((_, k) => "$" + (j * cols.length + k + 1)).join(",") + ")"); args.push(...r); });
    const res = await pool.query("INSERT INTO " + table + " (" + cols.join(",") + ") VALUES " + vals.join(",") + " ON CONFLICT DO NOTHING", args);
    n += res.rowCount;
  }
  return n;
}

const run = JSON.parse(readFileSync(resolve(dir, "run.json"), "utf8"));
const agents = rows("agents.jsonl"), transfers = rows("transfers.jsonl"), probes = rows("probes.jsonl");
const byId = new Map(agents.map((a) => [a.agent_id, a]));
const out = {};
out.registrations = await insert("registrations", ["chain_id", "token_id", "minted_at", "minted_to", "tx"], agents, (a) => [8453, a.token_id, a.registered_at, a.minter, a.mint_tx]);
out.actors = await insert("actors", ["actor_id", "display_name", "primary_wallet", "liveness", "sources", "primary_chain", "registered_at"], agents, (a) => [a.agent_id, null, CHAIN + ":" + a.wallet, 0, "{sim}", CHAIN, a.registered_at]);
out.bindings = await insert("bindings", ["actor_id", "wallet", "valid_from", "bind_method", "confidence", "evidence_uri"], agents, (a) => [a.agent_id, CHAIN + ":" + a.wallet, a.registered_at, 1, "onchain", "amlsim-agentic"]);
out.wallets = await insert("wallets", ["caip10", "kind", "first_seen", "last_seen", "usdc_float", "float_as_of", "stables_float"], agents, (a) => [CHAIN + ":" + a.wallet, "eoa", a.registered_at, run.sim_end, a.final_balance, run.sim_end, a.final_balance]);

/* One transfer becomes a PAY for the paying agent and/or an EARN for the receiving agent, as the
   ledger records a payment between two bound wallets twice, once from each side. */
const events = [];
let logIndex = 0;
for (const t of transfers) {
  logIndex += 1;
  const rail = t.rail || (t.token.toLowerCase() + "_transfer");
  if (t.from_agent_id) events.push(["evt_sim_" + t.transfer_id + "p", t.from_agent_id, "PAY", rail, CHAIN + ":" + t.from_wallet, CHAIN + ":" + t.to_wallet, t.amount, t.token, t.tx, t.timestamp, "onchain", "amlsim-agentic", !t.post_registration, t.is_routing, t.timestamp, logIndex]);
  if (t.to_agent_id) { const r = byId.get(t.to_agent_id); events.push(["evt_sim_" + t.transfer_id + "e", t.to_agent_id, "EARN", rail, CHAIN + ":" + t.from_wallet, CHAIN + ":" + t.to_wallet, t.amount, t.token, t.tx, t.timestamp, "onchain", "amlsim-agentic", new Date(t.timestamp) < new Date(r.registered_at), t.is_routing, t.timestamp, logIndex]); }
}
out.money_events = await insert("money_events", ["event_id", "actor_id", "kind", "rail", "from_caip10", "to_id", "amount_usd", "asset", "tx", "block_time", "confidence", "source", "pre_registration", "pass_through", "pass_checked_at", "log_index"], events, (r) => r);
out.balances = await insert("sim_balance_before", ["tx", "wallet", "usd", "usd_after"], transfers.filter((t) => t.from_agent_id && t.balance_before != null), (t) => [t.tx, CHAIN + ":" + t.from_wallet, t.balance_before, t.balance_after]);
out.probes = await insert("probes", ["actor_id", "endpoint", "ok", "http_status", "protocol", "rtt_ms", "error_class", "at"], probes, (p) => [p.actor_id, p.endpoint, p.ok, p.http_status, p.protocol, p.rtt_ms, p.error_class, p.at]);

/* loader fidelity: counted spending in the tables must equal the generator's own total */
const { rows: chk } = await pool.query("SELECT round(sum(amount_usd), 2)::float8 AS usd FROM money_events WHERE kind = 'PAY' AND NOT pre_registration AND NOT pass_through");
out.counted_spending_usd = { tables: chk[0].usd, generator: run.counts.counted_spending_usd, match: Math.abs(chk[0].usd - run.counts.counted_spending_usd) < 0.01 };
console.log(JSON.stringify({ database: DB, ...out }));
await pool.end();
