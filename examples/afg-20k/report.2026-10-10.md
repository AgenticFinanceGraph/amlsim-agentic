# Detector validation on synthetic labelled data: afg-20k

Generated 2026-10-10 10:28 UTC, seed 20261011, 22,894 agents, 652,664 transfers, 721 injected patterns over 1440 steps of 60 min. Detectors imported from `../pulse` (run time 1336 ms).

Synthetic data measures the rules, not the chain: every number below says how a detector behaves on shapes with known answers, and nothing about how often those shapes occur in the real ledger.

## Detectors

| detector | expected | hit | miss | false alarms | unexpected catches | precision | recall |
|---|---|---|---|---|---|---|---|
| drain_pattern | 100 | 100 | 0 | 67 | 0 | 59.9% | 100.0% |
| retry_storm | 60 | 60 | 0 | 0 | 0 | 100.0% | 100.0% |
| mint_burst | 20 | 20 | 0 | 0 | 0 | 100.0% | 100.0% |
| uri_timeout_streak | 50 | 50 | 0 | 0 | 0 | 100.0% | 100.0% |

False alarms by the shape that caused them: drain_pattern on purchase x67.

Unexpected catches: none.


## Candidate rules (not live)

Proposed replacements, measured the same way. An unexpected catch here is a suspicious near-miss the live rule leaves silent and the candidate finds.

| candidate | for | expected | hit | miss | false alarms | unexpected catches | precision | recall |
|---|---|---|---|---|---|---|---|---|
| retry_storm_sliding_10min | retry_storm | 60 | 60 | 0 | 0 | 30 (retry_storm_straddle x30) | 100.0% | 100.0% |
| mint_burst_sliding_60min | mint_burst | 20 | 20 | 0 | 0 | 0 | 100.0% | 100.0% |
| slow_drain_72h_sum | drain_pattern | 100 | 100 | 0 | 117 (x402_micro x3, periodical x46, fan_out x1, purchase x67) | 39 (slow_drain x39) | 46.1% | 100.0% |
| drain_emptied_80pct | drain_pattern | 100 | 100 | 0 | 0 | 0 | 100.0% | 100.0% |
| slow_drain_72h_emptied_80pct | drain_pattern | 100 | 100 | 0 | 48 (x402_micro x3, periodical x44, fan_out x1) | 38 (slow_drain x38) | 67.6% | 100.0% |
| layering_cycle | cycle | 25 | 17 | 8 | 2 (normal x2) | 2 (random x2) | 89.5% | 68.0% |
| layering_cycle_wide | cycle | 25 | 17 | 8 | 2 (normal x2) | 2 (random x2) | 89.5% | 68.0% |
| layering_scatter_gather | scatter_gather | 15 | 15 | 0 | 0 | 3 (stack x3) | 100.0% | 100.0% |
| layering_gather_scatter | gather_scatter | 15 | 13 | 2 | 4 (normal x4) | 3 (stack x1, cycle x1, fan_out x1) | 76.5% | 86.7% |
| layering_fan_in_same_amount | fan_in | 20 | 20 | 0 | 0 | 9 (gather_scatter x9) | 100.0% | 100.0% |
| layering_fan_out_same_amount | fan_out | 20 | 20 | 0 | 0 | 9 (gather_scatter x9) | 100.0% | 100.0% |

Layering ran over 23,704 agent-to-agent edges (loaded in 273 ms; cycle 127 ms, cycle_wide 39 ms, scatter_gather 32 ms, gather_scatter 17 ms, fan_in_same_amount 22 ms, fan_out_same_amount 15 ms). A layering candidate's "expected" column counts the injected instances of that AMLSim shape.

## Shapes

| shape | instances | suspicious | expected flag | hit | miss | flagged unexpectedly | what it is |
|---|---|---|---|---|---|---|---|
| fan_in | 20 | yes | none | 0 | 0 | 0 | AMLSim fan-in: several members pay the main account the same amount; the ledger has no fan-in detector |
| fan_out | 20 | yes | none | 0 | 0 | 0 | AMLSim fan-out: the main account pays several members the same amount |
| cycle | 25 | yes | none | 0 | 0 | 0 | AMLSim cycle: money goes round a ring of members, each keeping a margin; no cycle detector in the ledger |
| bipartite | 12 | yes | none | 0 | 0 | 0 | AMLSim bipartite: every originator pays every beneficiary |
| stack | 12 | yes | none | 0 | 0 | 0 | AMLSim stack: two bipartite layers, originators to intermediaries to beneficiaries |
| random | 12 | yes | none | 0 | 0 | 0 | AMLSim random: a chain of members, one amount, one day |
| scatter_gather | 15 | yes | none | 0 | 0 | 0 | AMLSim scatter-gather: fan-out to intermediaries, then fan-in to one beneficiary |
| gather_scatter | 15 | yes | none | 0 | 0 | 0 | AMLSim gather-scatter: fan-in to one intermediary, then fan-out |
| drain | 100 | yes | drain_pattern | 100 | 0 | 0 | a sudden payment far above the wallet's history, to a stranger |
| drain_small | 40 | yes | none | 0 | 0 | 0 | a drain below the $250 floor; by design not flagged |
| drain_known_payee | 40 | yes | none | 0 | 0 | 0 | a drain to an address the wallet had paid before; the rule requires a stranger |
| slow_drain | 40 | yes | none | 0 | 0 | 0 | the wallet is emptied in 6 payments, each under 5x the previous largest, to one sink |
| routing_hop_large | 60 | no | none | 0 | 0 | 0 | $750 in and out in one transaction; excluded from spending by the pass-through rule, so no drain flag |
| retry_storm | 60 | yes | retry_storm | 60 | 0 | 0 | 116 payments to one seller inside 10 minutes |
| retry_storm_slow | 30 | yes | none | 0 | 0 | 0 | 54 payments to one seller over 46 minutes; outside the 10-minute window |
| retry_storm_straddle | 30 | yes | none | 0 | 0 | 0 | 56 payments inside 10 minutes that cross an hour boundary; the hour buckets each hold fewer than 50 |
| mint_burst | 20 | no | mint_burst | 20 | 0 | 0 | 67 registrations minted by one address inside an hour; a shape, not a harm |
| mint_burst_spread | 15 | no | none | 0 | 0 | 0 | 42 registrations by one address over 3 hours, each hour under 25 |
| uri_timeout_streak | 50 | no | uri_timeout_streak | 50 | 0 | 0 | 5 failed probes and never one that answered |
| uri_flapping | 25 | no | none | 0 | 0 | 0 | 6 failed probes with one success among them; not a streak by definition |
| funding_quiet | 80 | no | none | 0 | 0 | 0 | funded after registration and never pays; the ladder must leave it at L0 |

## Blind spots by design

Suspicious shapes the published rules are not written to catch, and what happened:

- **fan_in** (20): AMLSim fan-in: several members pay the main account the same amount; the ledger has no fan-in detector. Flagged anyway: 0.
- **fan_out** (20): AMLSim fan-out: the main account pays several members the same amount. Flagged anyway: 0.
- **cycle** (25): AMLSim cycle: money goes round a ring of members, each keeping a margin; no cycle detector in the ledger. Flagged anyway: 0.
- **bipartite** (12): AMLSim bipartite: every originator pays every beneficiary. Flagged anyway: 0.
- **stack** (12): AMLSim stack: two bipartite layers, originators to intermediaries to beneficiaries. Flagged anyway: 0.
- **random** (12): AMLSim random: a chain of members, one amount, one day. Flagged anyway: 0.
- **scatter_gather** (15): AMLSim scatter-gather: fan-out to intermediaries, then fan-in to one beneficiary. Flagged anyway: 0.
- **gather_scatter** (15): AMLSim gather-scatter: fan-in to one intermediary, then fan-out. Flagged anyway: 0.
- **drain_small** (40): a drain below the $250 floor; by design not flagged. Flagged anyway: 0.
- **drain_known_payee** (40): a drain to an address the wallet had paid before; the rule requires a stranger. Flagged anyway: 0.
- **slow_drain** (40): the wallet is emptied in 6 payments, each under 5x the previous largest, to one sink. Flagged anyway: 0.
- **retry_storm_slow** (30): 54 payments to one seller over 46 minutes; outside the 10-minute window. Flagged anyway: 0.
- **retry_storm_straddle** (30): 56 payments inside 10 minutes that cross an hour boundary; the hour buckets each hold fewer than 50. Flagged anyway: 0.

## Liveness ladder

Production `score()` over features derived from the loaded tables, against the level the generator expected from the published rule: 22894 of 22894 agents agree (100.0%).

| expected level | agents | agree |
|---|---|---|
| L0 | 8014 | 8014 |
| L7 | 1173 | 1173 |
| L8 | 7737 | 7737 |
| L9 | 5970 | 5970 |

## Pass-through rule

Production `classifyLegs()` over synthetic receipts: 10 of 10 cases agree with the published definition (in and out in one transaction, within 2%).

| case | expected | got |
|---|---|---|
| own balance spent (one leg out) | false | false |
| exact hop in and out | true | true |
| router skim 0.5% | true | true |
| skim 1.9% (inside tolerance) | true | true |
| skim 2.5% (outside tolerance) | false | false |
| USDT in, USDC out, same size (a swap) | true | true |
| partial forward 60% | false | false |
| received only (nothing out) | false | false |
| two legs in, one out, equal total | true | true |
| unrelated legs only | false | false |

## Address-poisoning matcher

Production `norm()` and `lookalike()` over symbols and addresses with known answers: 12 of 12 cases agree.

| case | ok |
|---|---|
| Cyrillic С in USDС normalises to USDC | yes |
| zero-width space inside U​SDC is removed | yes |
| lower case usdc | yes |
| punctuation USD-C | yes |
| Greek Ε in ΕURC | yes |
| combining acute on U is stripped | yes |
| a real symbol is unchanged | yes |
| look-alike by first 4 + last 4 names the payee | yes |
| the payee known longest is preferred among same-shape payees | yes |
| last 4 only is reported as the weaker match | yes |
| an unrelated address matches nothing | yes |
| a payee is not its own look-alike | yes |

End to end, 300 synthetic wallets with planted look-alikes (seeded): 151 of 151 losses found, 0 false losses, 0 missed. The rule: a real-token payment to an address planted in the wallet's history first, where the plant is a look-alike of a real payee (first 4 + last 4, or last 4 with a fake-symbol token).

## Fidelity

Counted spending in the loaded tables: $4,848,316.51; the generator's own total: $4,848,316.51 (match), 329,247 counted payments.
