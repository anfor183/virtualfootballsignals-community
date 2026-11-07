# Independent adaptive selection engines

Safest, High Chance and AI Best use separate XGBoost weights, calibration, versioned model bundles and promotion decisions. They share a feature schema and validation implementation, not a trained model.

- Safest selects the highest calibrated win probability across supported markets. Its selection objective imposes no odds reward, minimum payout target or positive-EV requirement.
- AI Best searches the configured high-odds range (browser-config.ai.highRiskMinOdds) across supported markets and ranks qualified choices by calibrated win probability, using EV only to break ties. It is no longer restricted to HT/FT.
- High Chance now has its own adaptive market classifier for Over 2.5 / BTTS, actual odds 1.65–3.50, retaining configured blocked markets (BTTS is currently blocked). It ranks qualified selections by win probability.

## Learning and validation

The shared registry supports 1X2, goal totals, BTTS, HT/FT and double chance. Quotes must come from the actual fixture. Invalid/missing prices and invalid scores are excluded. Training uses completed pre-predicted fixtures from live_predictions, ordered by kickoff rather than insertion id. Same-kickoff matches do not enter each other's rolling features; leagues remain separate.

The feature set includes captured prices and fair-price probabilities, raw model forecasts, and recent 50/250-match market results. Separate recent training windows and recency weights allow new patterns to affect forecasts. Chronological blocks separate fitting, probability calibration, policy tuning and untouched audit. Both audit and production select one pick per round with the same probability-first ranking.

Safest readiness requires at least 100 audit selections, a one-sided win-rate lower bound of 80%, acceptable calibration and competitive forecast loss. AI Best requires at least 50 audit selections, a positive lower confidence bound on actual-price ROI, positive results in both audit halves and a forecast-loss improvement over the bookmaker baseline. A candidate is never made ready using typical prices or training-set profits.

Challenger promotion requires genuinely new results after the incumbent's full audited period. It must improve log loss and preserve readiness; a validated incumbent cannot be replaced by a candidate with worse measured new-result hit rate. Each artifact bundle includes a replayable audit_picks.json ledger. The active pointer changes atomically. Model-setting changes require revalidation, and an in-flight version change fails closed.

## Prospective monitoring and publishing

Pre-kickoff model selections are frozen in ml_pick_observations with engine, model version, confidence, actual price and qualification status. Missing HT scores do not settle HT/FT observations. The three engines are monitored independently on up to 200 prospective results. After enough observations, calibration/performance drift pauses model publication and accelerates retraining. All observations remain explicitly paper/experimental; publishing still passes the existing profitability gate. No new insert path bypasses that gate.

Market Analytics includes experimental AI Best and independent Safest observations in the Paper candidates source. Published history is retained separately. AI Engine management shows real audit and prospective counts/win rates; trained-but-unqualified models are labelled SHADOW VALIDATION.

The trainer uses newly completed prediction IDs, so archive trimming cannot hide new results. Cross-process pipeline and per-engine locks prevent concurrent training. Retraining has a cooldown and a minimum new-data requirement. It does not guarantee a lasting win rate or profitability. A high short-price hit rate can still lose money.

## Operations

Run separately: python3 utils/adaptive_market_model.py --engine safest --db databases/sportybet_archive.db
and python3 utils/adaptive_market_model.py --engine ai_best --db databases/sportybet_archive.db.

The daemon trains all three automatically. Versioned artifacts, manifests and monitors are runtime state excluded from Git. A fresh installation bootstraps them through the daemon or the manual controls.

Validation: node --test test_adaptive_markets.js test_paper_pick_tracker.js; python3 -m unittest test_adaptive_training.py; node test_edge_gate.js; dashboard npm run build.

Method references: https://scikit-learn.org/stable/common_pitfalls.html#data-leakage and https://xgboost.readthedocs.io/en/stable/parameter.html .
# Overnight selection policy

High Value and AI Best recommendations are paused for fixtures kicking off from
00:00 through 08:59 WAT (Africa/Lagos). Qualification resumes at 09:00 WAT; this
does not guarantee a pick. Safest remains exempt. The fixture epoch is authoritative;
legacy `match_time` is interpreted as WAT only when no epoch is stored. Unknown or
corrupt times block risky recommendations.

The same policy guards ML candidate selection, final published-history insertion,
API metadata, dashboard cards/schedules, and bundled/single Telegram publishing
(including forced publishing). It does not interrupt result settlement. Immutable
experimental paper observations continue overnight for learning; they are separate
from approved signals. The Safest preview labels these as ML paper tips.

High Value and AI Best cards never fabricate a fallback recommendation when no
approved backend record exists. Such rounds show Paused or Disciplined No-Bet.
The active round cannot borrow a previous settled pick. Displayed probabilities
are rounded to one decimal; model calculations and recorded values retain precision.


## High Chance validation and strategy evidence

The old High Chance trainer fitted its final model on the purported holdout and
used typical prices in ROI calculations. Those artifacts are retired from live
inference. The replacement has its own versioned model, calibration and policy,
with seven extra features describing earlier forecast errors and price/team
contexts. Losses and wins are both binary training labels; no losing-streak
recovery assumption enters forecasts. Compact declared input fields allow larger
history windows without Node's single-string size limit.

High Chance compares recent 4,000/12,000/full fitting windows with recency weights.
Its default 120,000-fixture archive is split chronologically 60/10/10/20 for fitting,
calibration/model selection, policy tuning and untouched audit. Configured blocked
markets are canonicalized and retained. Its probability floor is at least 75%; no
threshold is lowered to manufacture picks. Historical readiness additionally needs
100 qualified audit picks, a 65% one-sided win-rate lower bound, five WAT days with
a positive day-cluster ROI lower bound, both audit halves profitable, acceptable
calibration and forecast-loss improvement over fair bookmaker probabilities.

Even a historically qualified High Chance model must pass prospective validation
before publication: 100 qualified paper results across at least five WAT days,
70% observed wins and a positive day-cluster ROI lower bound. Existing EdgeGate
checks still apply. No raw forecast or rule-based fallback replaces a rejected ML
selection. All three engines participate in drift-triggered retraining and watermark
advancement requires all three training steps to finish.

`ml_pick_observations` freezes the experimental top-ranked choice before kickoff.
`ml_policy_observations` separately freezes the actual threshold-qualified choice,
which can differ from that top choice. The latter is recorded even overnight to
permit a frozen counterfactual comparison; overnight risky picks never publish.
Both settle on exact fixtures. No historic policy decisions are reconstructed.

`strategy_evidence.js` and `strategy_backtest.mjs` compare flat, 1.5x, 2x and 3x
staking on immutable model audit ledgers and genuine forward ledgers. User test
parameters: NGN100,000 bankroll, NGN60 base stake, seven total bets per cycle.
After seven consecutive losses reset to base; a win resets immediately. No credit
or replenishment is assumed, and simulation stops if the next stake is unfunded.
Every engine has a separate bankroll. Sequential settlement is an explicit
assumption; execution latency/slippage are not verified. Day-cluster uncertainty
bounds are descriptive, and profit in a replay does not guarantee future profit.
The browser uses the same staking cycle and stops at an unfunded stake.

`audit_pick_policies.js` replays a fixed raw-forecast High Chance reference from
archived prices. This is separate from model OOS validation: old forecast capture
times are unavailable, and day/night differences are observational. Midnight is a
precaution under evaluation, not a demonstrated universal profit advantage.

A new `tracking_runs` epoch starts after deployment. Market Analytics defaults to
new-period ML paper tracking; approved signals have a separate new-period view.
All old observations, published results and training fixtures remain available in
Archive. Resetting the view never resets evidence, model history, or losing results.

Validation commands: node --test test_adaptive_markets.js test_paper_pick_tracker.js
test_pick_policy.js test_high_chance.js test_staking_cycle.js test_strategy_backtest.js
test_tracking_run.js; python3 -m unittest test_adaptive_training.py; node test_edge_gate.js;
production dashboard build. See MODEL_EVIDENCE.md for the initial measured outcomes.


All three engine publication paths now also require version-bound 2x cap-7 release
evidence. Both qualified historical and qualified forward samples need at least
100 results across five WAT days, positive net profit and a positive day-cluster
profit lower bound, with no unfunded stake. Derived proof files expire after six
hours and are refreshed automatically after settlement or evidence requests. A new
model version cannot inherit another version's release proof. A profitable shadow
curve does not satisfy this check. Model validation and EdgeGate still apply.


## Last-five meetings and table comparison

Retraining now compares the existing feature family with 29 additional earlier-only
H2H5, current-season form5 and reconstructed-table inputs. Calibration selects the
feature family and fitting window; final audit results cannot choose the winner.
Missing/incomplete tables are neutral and explicitly masked, and existing baseline
models remain compatible. See MATCH_CONTEXT_EVIDENCE.md for the measured comparison.

All engines now use up to 120,000 source fixtures with 60/10/10/20 full-source
chronological cutoffs. Earlier Safest/AI fitting/calibration/tuning rounds may be
sampled for memory limits, while the entire contiguous final audit is retained.
This permits a multi-day audit without altering Martingale sequences. H2H/table
state ingests every earlier result, including unsampled fitting examples. JSON
feature export is chunked to avoid the Node single-string limit.


The analytics period selector now scopes every pick-derived card, market summary,
win-rate, pending count, losing-streak and bankroll result. Live published-history
cards also default to the active tracking period. Archive retains older records.
No selected-period view falls back to the old lifetime 37-pick AI Best aggregate.
High-odds share is labelled as price availability, not betting success, and actual
settled win rate is displayed separately. The historically eligible active version
gets a stable five-day forward window before replacement, unless same-version drift
pauses it; candidate research can continue without repeatedly resetting that cohort.
