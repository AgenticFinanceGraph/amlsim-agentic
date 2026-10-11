# Detector validation on synthetic labelled data: afg-2k-hot

Generated 2026-10-11 13:50 UTC, seed 20261011, 2,893 agents, 84,246 transfers, 189 injected patterns over 1440 steps of 60 min. Detectors imported from `../pulse` (run time 244 ms).

Synthetic data measures the rules, not the chain: every number below says how a detector behaves on shapes with known answers, and nothing about how often those shapes occur in the real ledger.

## Detectors

| detector | expected | hit | miss | false alarms | unexpected catches | precision | recall |
|---|---|---|---|---|---|---|---|
| drain_pattern | 25 | 25 | 0 | 6 | 0 | 80.6% | 100.0% |
| retry_storm | 15 | 15 | 0 | 0 | 0 | 100.0% | 100.0% |
| mint_burst | 6 | 6 | 0 | 0 | 0 | 100.0% | 100.0% |
| uri_timeout_streak | 12 | 12 | 0 | 0 | 0 | 100.0% | 100.0% |

False alarms by the shape that caused them: drain_pattern on purchase x6.

Unexpected catches: none.


## Candidate rules (not live)

Proposed replacements, measured the same way. An unexpected catch here is a suspicious near-miss the live rule leaves silent and the candidate finds.

| candidate | for | expected | hit | miss | false alarms | unexpected catches | precision | recall |
|---|---|---|---|---|---|---|---|---|
| retry_storm_sliding_10min | retry_storm | 15 | 15 | 0 | 0 | 8 (retry_storm_straddle x8) | 100.0% | 100.0% |
| mint_burst_sliding_60min | mint_burst | 6 | 6 | 0 | 0 | 0 | 100.0% | 100.0% |
| retry_storm_island_10min | retry_storm | 15 | 15 | 0 | 0 | 8 (retry_storm_straddle x8) | 100.0% | 100.0% |
| mint_burst_island_60min | mint_burst | 6 | 6 | 0 | 0 | 0 | 100.0% | 100.0% |
| slow_drain_72h_sum | drain_pattern | 25 | 25 | 0 | 9 (single x1, periodical x2, purchase x6) | 9 (slow_drain x9) | 73.5% | 100.0% |
| slow_drain_72h_dominant_share | drain_pattern | 10 | 9 | 1 | 1 (single x1) | 0 | 90.0% | 90.0% |
| drain_emptied_80pct | drain_pattern | 25 | 25 | 0 | 0 | 0 | 100.0% | 100.0% |
| slow_drain_72h_emptied_80pct | drain_pattern | 25 | 25 | 0 | 3 (single x1, periodical x2) | 9 (slow_drain x9) | 89.3% | 100.0% |
| layering_cycle | cycle | 8 | 8 | 0 | 0 | 1 (random x1) | 100.0% | 100.0% |
| layering_cycle_wide | cycle | 8 | 8 | 0 | 0 | 1 (random x1) | 100.0% | 100.0% |
| layering_scatter_gather | scatter_gather | 4 | 4 | 0 | 1 (normal x1) | 2 (stack x2) | 80.0% | 100.0% |
| layering_gather_scatter | gather_scatter | 4 | 3 | 1 | 0 | 2 (stack x2) | 100.0% | 75.0% |
| layering_fan_in_same_amount | fan_in | 6 | 6 | 0 | 0 | 2 (gather_scatter x2) | 100.0% | 100.0% |
| layering_fan_out_same_amount | fan_out | 6 | 6 | 0 | 0 | 2 (gather_scatter x2) | 100.0% | 100.0% |

Layering ran over 2,452 agent-to-agent edges (loaded in 37 ms; cycle 4 ms, cycle_wide 5 ms, scatter_gather 2 ms, gather_scatter 4 ms, fan_in_same_amount 2 ms, fan_out_same_amount 2 ms). A layering candidate's "expected" column counts the injected instances of that AMLSim shape.

## Shapes

| shape | instances | suspicious | expected flag | hit | miss | flagged unexpectedly | what it is |
|---|---|---|---|---|---|---|---|
| fan_in | 6 | yes | none | 0 | 0 | 0 | AMLSim fan-in: several members pay the main account the same amount; the ledger has no fan-in detector |
| fan_out | 6 | yes | none | 0 | 0 | 0 | AMLSim fan-out: the main account pays several members the same amount |
| cycle | 8 | yes | none | 0 | 0 | 0 | AMLSim cycle: money goes round a ring of members, each keeping a margin; no cycle detector in the ledger |
| bipartite | 4 | yes | none | 0 | 0 | 0 | AMLSim bipartite: every originator pays every beneficiary |
| stack | 4 | yes | none | 0 | 0 | 0 | AMLSim stack: two bipartite layers, originators to intermediaries to beneficiaries |
| random | 4 | yes | none | 0 | 0 | 0 | AMLSim random: a chain of members, one amount, one day |
| scatter_gather | 4 | yes | none | 0 | 0 | 0 | AMLSim scatter-gather: fan-out to intermediaries, then fan-in to one beneficiary |
| gather_scatter | 4 | yes | none | 0 | 0 | 0 | AMLSim gather-scatter: fan-in to one intermediary, then fan-out |
| drain | 25 | yes | drain_pattern | 25 | 0 | 0 | a sudden payment far above the wallet's history, to a stranger |
| drain_small | 10 | yes | none | 0 | 0 | 0 | a drain below the $250 floor; by design not flagged |
| drain_known_payee | 10 | yes | none | 0 | 0 | 0 | a drain to an address the wallet had paid before; the rule requires a stranger |
| slow_drain | 10 | yes | none | 0 | 0 | 0 | the wallet is emptied in 5 payments, each under 5x the previous largest, to one sink |
| routing_hop_large | 15 | no | none | 0 | 0 | 0 | $1800 in and out in one transaction; excluded from spending by the pass-through rule, so no drain flag |
| retry_storm | 15 | yes | retry_storm | 15 | 0 | 0 | 92 payments to one seller inside 10 minutes |
| retry_storm_slow | 8 | yes | none | 0 | 0 | 0 | 61 payments to one seller over 45 minutes; outside the 10-minute window |
| retry_storm_straddle | 8 | yes | none | 0 | 0 | 0 | 57 payments inside 10 minutes that cross an hour boundary; the hour buckets each hold fewer than 50 |
| mint_burst | 6 | no | mint_burst | 6 | 0 | 0 | 161 registrations minted by one address inside an hour; a shape, not a harm |
| mint_burst_spread | 4 | no | none | 0 | 0 | 0 | 42 registrations by one address over 3 hours, each hour under 25 |
| uri_timeout_streak | 12 | no | uri_timeout_streak | 12 | 0 | 0 | 12 failed probes and never one that answered |
| uri_flapping | 6 | no | none | 0 | 0 | 0 | 10 failed probes with one success among them; not a streak by definition |
| funding_quiet | 20 | no | none | 0 | 0 | 0 | funded after registration and never pays; the ladder must leave it at L0 |

## Blind spots by design

Suspicious shapes the published rules are not written to catch, and what happened:

- **fan_in** (6): AMLSim fan-in: several members pay the main account the same amount; the ledger has no fan-in detector. Flagged anyway: 0.
- **fan_out** (6): AMLSim fan-out: the main account pays several members the same amount. Flagged anyway: 0.
- **cycle** (8): AMLSim cycle: money goes round a ring of members, each keeping a margin; no cycle detector in the ledger. Flagged anyway: 0.
- **bipartite** (4): AMLSim bipartite: every originator pays every beneficiary. Flagged anyway: 0.
- **stack** (4): AMLSim stack: two bipartite layers, originators to intermediaries to beneficiaries. Flagged anyway: 0.
- **random** (4): AMLSim random: a chain of members, one amount, one day. Flagged anyway: 0.
- **scatter_gather** (4): AMLSim scatter-gather: fan-out to intermediaries, then fan-in to one beneficiary. Flagged anyway: 0.
- **gather_scatter** (4): AMLSim gather-scatter: fan-in to one intermediary, then fan-out. Flagged anyway: 0.
- **drain_small** (10): a drain below the $250 floor; by design not flagged. Flagged anyway: 0.
- **drain_known_payee** (10): a drain to an address the wallet had paid before; the rule requires a stranger. Flagged anyway: 0.
- **slow_drain** (10): the wallet is emptied in 5 payments, each under 5x the previous largest, to one sink. Flagged anyway: 0.
- **retry_storm_slow** (8): 61 payments to one seller over 45 minutes; outside the 10-minute window. Flagged anyway: 0.
- **retry_storm_straddle** (8): 57 payments inside 10 minutes that cross an hour boundary; the hour buckets each hold fewer than 50. Flagged anyway: 0.

## Liveness ladder

Production `score()` over features derived from the loaded tables, against the level the generator expected from the published rule: 2893 of 2893 agents agree (100.0%).

| expected level | agents | agree |
|---|---|---|
| L0 | 1411 | 1411 |
| L7 | 450 | 450 |
| L8 | 614 | 614 |
| L9 | 418 | 418 |

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

Counted spending in the loaded tables: $509,681.61; the generator's own total: $509,681.61 (match), 34,591 counted payments.
