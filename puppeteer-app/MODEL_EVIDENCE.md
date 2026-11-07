# Initial evidence review — 29 October 2026 (WAT)

No engine has established profitable 2x Martingale performance on both an untouched
model audit and qualified prospective results. This is the measured outcome, not a
promise that software changes can turn a negative expectation into profit.

Test bankroll: NGN100,000 per engine. Base stake: NGN60. Seven total bets per losing
cycle, reset to base after the seventh loss; reset immediately on a win. Captured
fixture prices only, no credit or replenishment. Stakes stop when unfunded. The
replay funds simultaneous stakes before same-round settlement, assumes each round
settles before the next kickoff, and does not validate execution timing. See
STAKING_CALCULATIONS.md for the portfolio/standalone accounting correction.
Historical fitting and audit periods are separated, but immutable capture times
for the older archived base forecasts are unavailable. Genuine forward ledgers
are therefore essential to verify live performance and forecast provenance.

## Model audit: unfiltered experimental selections, 2x cap 7

| Engine | Audit picks | Win rate | Net P/L (NGN) | Maximum drawdown (NGN) |
|---|---:|---:|---:|---:|
| Safest | 222 | 88.74% | -933.60 | 958.80 |
| High Chance v2 | 2,412 | 57.17% | -5,576.40 | 18,278.40 |
| AI Best (active version at audit) | 222 | 27.93% | -10,494.00 | 29,406.60 |

These are experimental top-ranked choices, not approved betting signals. Safest's
short prices explain why a high hit rate can still lose money. High Chance and AI
Best had zero selections passing their audited profit policies. Their abstention
is not counted as a profitable strategy or as wins.

High Chance trained on 104,207 eligible real-price examples from a chronological
120,000-fixture archive. Three fitting windows were compared using calibration
data only. Its final audit forecast log loss was 0.68945, versus 0.68921 for fair
bookmaker probabilities (lower is better). It did not establish predictive value
or qualify for publication. It remains in shadow learning. BTTS exclusions were
preserved; no market was unblocked to improve the displayed result.

## Forward observations before the new tracking epoch

At the evidence snapshot, Safest had 102 settled experimental observations:
83.33% wins and -NGN979.20 under 2x. The active AI Best version had 31 observations:
35.48% wins and -NGN4,177.80. Across both successive AI Best versions, 102 records
gave +NGN1,849.80 under 2x; this mixed-version sample spans only two WAT dates and
does not establish a profitable active model. High Chance v2 had no forward
results yet. The dashboard recomputes these figures as genuine records settle.

The new tracking epoch starts after deployment and its forward figures start at
zero. Earlier results remain archived and are not relabelled as new-system proof.
No missing historical selections are backfilled as genuine forward decisions.

## Midnight and discipline reference replay

The independent reference replay covered 161,995 archived fixtures and 16,275
one-per-round raw-forecast selections, using captured odds in High Chance's range
and the current market exclusions. It is not the new trained model's OOS audit.

| Reference cohort | Picks | Flat-stake ROI |
|---|---:|---:|
| All hours | 16,275 | -5.66% |
| Daytime (09:00–23:59 WAT) | 10,196 | -6.23% |
| Overnight (00:00–08:59 WAT) | 6,079 | -4.71% |
| Fixed probability >=75% and EV >=3% rule | 7 | -75.14% |

This does not support a claim that midnight is reliably the worse betting window.
Day/night cohorts differ and archived forecasts lack immutable capture timestamps;
this retrospective comparison is not causal or forward-test evidence. The tiny
high-confidence cohort is insufficient and losing. No-bet avoids exposure when an
edge is unvalidated; abstaining is not proof that a winning strategy exists.

On this reference, 2x all-hours and daytime replays eventually could not fund the
next stake. This demonstrates why uncapped or unfunded equity curves are invalid.
The midnight rule remains a stated precaution under evaluation; UI copy no longer
presents its benefit as statistically proven.

## What can earn a stronger conclusion

The app continues freezing actual pre-kickoff experimental and qualified policy
decisions, versions and prices. High Chance requires independent historical and
prospective evidence before publishing. All publication still passes EdgeGate.
Model challengers need genuinely new results, rather than a better-looking replay
of the same audit period. Profitability cannot be established by changing rules
after inspecting the final audit or by resetting the visible statistics.
