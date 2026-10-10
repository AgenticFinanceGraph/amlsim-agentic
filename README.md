# amlsim-agentic

Labelled synthetic payment graphs for AI-agent wallets, built to test anomaly detectors against known answers before they are pointed at real money.

It is an adaptation of [IBM AMLSim](https://github.com/IBM/AMLSim) (Apache-2.0): the same idea, a background of normal behaviour with injected patterns whose labels are known, rewritten for ERC-8004 agent wallets paying in stablecoins on Base. AMLSim's eight laundering typologies are ported edge for edge; thirteen shapes specific to agent payments are added, each paired where it matters with a near-miss that is built *not* to be caught. The near-misses are the point: they measure where a detector stops.

Built and used by [Agentic Finance Graph](https://agenticfinancegraph.com), the independent ledger of money held and spent by AI agents. The first measured run is at the bottom.

## What maps to what

| AMLSim | here | kept or rebuilt |
|---|---|---|
| account | ERC-8004 agent with one bound wallet | rebuilt |
| bank, branch | gone: one chain is one bank | dropped |
| transaction | stablecoin transfer (USDC, USDT, EURC, DAI), with a transaction hash | rebuilt |
| cash in, cash out | funding from a treasury or exchange address | rebuilt |
| alert, SAR flag | `expected_flags` (what the published rules should fire) and, separately, `is_suspicious` (whether the behaviour is harmful) | kept, split in two |
| fan_in, fan_out, cycle, bipartite, stack, random, scatter_gather, gather_scatter | ported, same parameters (`alertPatterns.csv` columns) | kept |
| normal models: single, fan_out, fan_in, forward, mutual, periodical | ported for wallets | kept |
| schedule ids 0 to 3 (fixed interval, random interval, unordered, simultaneous) | ported | kept |
| margin ratio, main account, alert members | ported | kept |
| steps | one hour each by default (AMLSim's are days); sub-hour timing where a shape needs it | changed |
| routing | new: a hop in and out of a wallet in one transaction is `is_routing` and is excluded from "spent" | new |
| ranking signals | new: `expected_level` on each agent by the liveness ladder (L7 paid, L8 funded, L9 three counterparties in 30 days) | new |

## Shapes

The eight AMLSim typologies are injected as the paper describes them, labelled suspicious, with no expected flag, because the ledger has no layering detectors yet. They document that blind spot.

| shape | suspicious | expected flag | what it is |
|---|---|---|---|
| drain | yes | drain_pattern | a payment at least 5x the wallet's previous largest, at least $250, to an address never paid, after at least 3 earlier payments |
| drain_small | yes | none | the same shape below the $250 floor |
| drain_known_payee | yes | none | the same shape to an address the wallet had paid before |
| slow_drain | yes | none | emptied in 4 to 6 payments, each under 5x the running previous largest, to one sink |
| routing_hop_large | no | none | $500 to $5,000 in and out of the wallet in one transaction; must stay silent |
| retry_storm | yes | retry_storm | 50 or more payments to one address inside 10 minutes |
| retry_storm_slow | yes | none | the same count over 25 to 50 minutes |
| retry_storm_straddle | yes | none | inside 10 minutes, but across an hour boundary |
| mint_burst | no | mint_burst | 25 or more registrations by one minter inside an hour |
| mint_burst_spread | no | none | the same, spread so that no hour reaches 25 |
| uri_timeout_streak | no | uri_timeout_streak | 5 or more failed endpoint probes and never a success |
| uri_flapping | no | none | failures with one success among them |
| funding_quiet | no | none | funded, never pays; the ladder must leave it at L0 |

Normal behaviour: AMLSim's six models plus `x402_micro` (many tiny payments to a few sellers, the dominant real shape) and `purchase` (an occasional larger one-off payment to a new address, legitimate and deliberately shaped like a drain).

## Quick start

Needs Node 18 or newer. Generation touches no network and no database.

```bash
node generate.mjs config/afg-2k.json out/afg-2k
```

Loading and validating need PostgreSQL and a database that is not the live one (the loader refuses the name `afg`):

```bash
createdb -O afg afg_sim
node load.mjs out/afg-2k
node validate.mjs out/afg-2k --pulse /path/to/detector/code
```

The validator imports the detector code from `--pulse` (default: `examples/afg-detectors`, a copy of the ledger's modules): `lib/detectors.mjs` (functions returning rows: `mintBursts`, `retryStorms`, `drains`, `probeStreaks`, the thresholds, and the candidates `retryStormsSliding`, `mintBurstsSliding`, `slowDrains`, `drainsEmptied`), `lib/ladder.mjs` (`score`), `lib/passthrough.mjs` (`classifyLegs`), `lib/layering.mjs` (`cycles`, `scatterGather`, `gatherScatter`, `fanInSameAmount`, `fanOutSameAmount`) and `lib/poisonmatch.mjs` (`norm`, `lookalike`). Any detector code with those names can be measured the same way. It writes `report.md` and `report.json` into the run directory. The same config and seed produce the same files every time.

## Config

A JSON file with AMLSim's sections and column names:

- `general`: `random_seed`, `simulation_name`, `total_steps`, `step_minutes`, `base_date`
- `default`: `min_amount`, `max_amount`, `min_accounts`, `max_accounts`, `min_period`, `max_period`, `schedule_id`, `is_sar`, `margin_ratio`
- `population`: `agents`, `minters`, `sellers`, `routers`, `funders`, `initial_balance` [lo, hi], `funded_share`, `registration_spread`, `probed_share`, `first_token_id`
- `afg_rules`: the published detector thresholds the shapes are built against (`drain_mult`, `drain_min_usd`, `drain_min_history`, `drain_lookback_days`, `retry_min`, `retry_window_s`, `burst_min_per_hour`, `streak_min`)
- `normal_models`: rows of `count`, `type` and any `default` override (AMLSim's `normalModels.csv`)
- `alert_patterns`: rows of `count`, `type` and any override (AMLSim's `alertPatterns.csv`; `is_sar` becomes `is_suspicious`)

## Output

AMLSim-compatible CSVs, with AMLSim's column names first and the extra fields after them:

- `accounts.csv`: `acct_id, dsply_nm, type, acct_stat, acct_rptng_crncy, prior_sar_count, branch_id, open_dt, close_dt, initial_deposit, tx_behavior_id, bank_id, country` + `wallet, minter, registration_step, population, final_balance`
- `transactions.csv`: `tran_id, orig_acct, bene_acct, tx_type, base_amt, tran_timestamp, is_sar, alert_id` + `token, kind, rail, orig_wallet, bene_wallet, tx_hash, is_routing, routing_reason, typology, is_drain, is_repeat_counterparty, post_registration, counts_as_spent`
- `alert_transactions.csv` and `alert_accounts.csv` as in AMLSim's `schema.json`

And the labelled JSONL the loader and validator read:

- `agents.jsonl`: `agent_id, token_id, wallet, probe_id, minter, mint_tx, registration_step, registered_at, initial_balance, final_balance, is_funded, population, expected_level, expected_features, metadata`
- `transfers.jsonl`: `transfer_id, step, timestamp, from_agent_id, from_wallet, to_agent_id, to_wallet, token, rail, amount, tx, is_routing, routing_reason, typology, typology_instance_id, is_drain, is_repeat_counterparty, post_registration, counts_as_spent, label_confidence`
- `patterns.jsonl`: `typology_instance_id, typology, model_id, main_agent_id, participant_agent_ids, start_step, end_step, start_at, end_at, is_suspicious, expected_flags, note, transfer_ids, total_amount` and shape-specific fields (`drain_tx`, `storm_to`, `burst_hour`, `minter`, ...)
- `probes.jsonl`, `run.json`

`counts_as_spent` is `post_registration && !is_routing && from an agent`, the ledger's counted-spending definition, so counting logic can be run over the file unchanged.

## What the first day of measuring found (10 October 2026)

`config/afg-2k.json`, seed 20261010: 2,813 agents, 66,881 transfers, 189 injected patterns over 60 days. Detectors imported from the live ledger's code (`examples/afg-detectors` holds the same modules). The full report is `examples/afg-2k/report.md`.

The rules that run on the live ledger every hour:

| detector | expected | hit | miss | false alarms | precision | recall |
|---|---|---|---|---|---|---|
| drain_pattern | 25 | 25 | 0 | 14 | 64% | 100% |
| retry_storm | 15 | 15 | 0 | 0 | 100% | 100% |
| mint_burst | 6 | 6 | 0 | 0 | 100% | 100% |
| uri_timeout_streak | 12 | 12 | 0 | 0 | 100% | 100% |

Every drain false alarm was the `purchase` shape: an agent that had only ever paid $3 at a time buying something for $260 to $440. The ledger's own note on the detector says a one-off purchase looks the same as a drain; this is that sentence with a number on it. Every near-miss stayed silent, which measures five blind spots: drains under $250, drains to a known payee, slow drains, storms longer than ten minutes, and storms or bursts that cross an hour boundary (the live rules bucket by calendar hour). The liveness ladder agreed with the generator on all agents, the pass-through rule on all ten receipt cases, and the address-poisoning matcher on all twelve symbol and address cases.

The candidate rules written against this data, measured the same way and not yet live:

| candidate | for | hit | miss | false alarms | also caught | precision | recall |
|---|---|---|---|---|---|---|---|
| retry storm, sliding 10-minute window | retry_storm | 15 | 0 | 0 | 8 hour-straddling storms | 100% | 100% |
| mint burst, sliding 60-minute window | mint_burst | 6 | 0 | 0 | | 100% | 100% |
| drain that emptied the wallet (took 80%+ of the balance held before it) | drain_pattern | 25 | 0 | 0 | | 100% | 100% |
| slow drain (72-hour sum to one new payee) | drain_pattern | 25 | 0 | 18 | all 10 slow drains | 58% | 100% |
| layering: cycle | AMLSim cycle | 6 | 2 | 3 | | 67% | 75% |
| layering: scatter-gather | AMLSim scatter_gather | 4 | 0 | 1 | | 80% | 100% |
| layering: gather-scatter | AMLSim gather_scatter | 4 | 0 | 0 | 1 stack | 100% | 100% |
| layering: same-amount fan-in | AMLSim fan_in | 6 | 0 | 0 | 4 gather-scatters | 100% | 100% |
| layering: same-amount fan-out | AMLSim fan_out | 6 | 0 | 0 | 4 gather-scatters | 100% | 100% |

Two of these were checked against the live ledger the same day, read-only. A sliding ten-minute window finds 28 payer-to-seller pairs with fifty or more payments inside ten minutes where the calendar-hour rule reports 7; the misses include storms of 233, 195 and 185 payments. Of the nine drains the live rule had open, six had taken 80 to 100 percent of what the wallet held at the block before, two had taken less, one could not be read. The balance test is the proposed fix for drain precision; the sliding windows are the proposed fix for the bucketing. Both wait for the ledger's monthly correction release, because published numbers do not change between releases.

Synthetic data measures the rules, not the chain. The figures say how a detector behaves on shapes with known answers, and nothing about how often those shapes occur in real data.

Scale: `config/afg-20k.json` (22,584 agents, 652,898 transfers) generates in about 2.5 minutes and peaks at 2.7 GB of memory, because the generator keeps every transfer in memory before writing. Larger runs need a streaming writer.

## Differences from AMLSim worth knowing

- No Java simulator and no `networkx` 1.11; one Node process, a few seconds for thousands of agents.
- Steps are hours, not days, because retry storms live in minutes.
- No banks, branches, countries or business types; no cash transactions; no party or entity-resolution files.
- `RoundedAmount` rounds to two significant figures; AMLSim's rounding differs in detail.
- Agents are drawn from one pool; an agent can take part in many normal models, as a real wallet does. Alert members are removed from the candidate pool, as in AMLSim.

## License

Apache License 2.0. See `LICENSE` and `NOTICE`. Pattern definitions were ported from IBM AMLSim, which is Apache-2.0 as well.
