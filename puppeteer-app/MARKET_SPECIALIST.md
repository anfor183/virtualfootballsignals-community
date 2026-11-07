# Market Specialist and capital modes

The broad strategy described below is retired. Its writer is disabled; the dedicated Over / Under 3.5 engine now records new trials. See GOALS35_ENGINE.md. Earlier records remain available in Archive. Capital modes and the reset control continue to work.

The Market Specialist is an independent Bayesian market-selection strategy,
`market-specialist-bayes-v1`. It considers real captured fixture odds from 2.0
upwards across supported markets. No typical odds, invented outcomes or upper
odds target are used. The registry still requires a supported market and a usable
bookmaker quote/probability group.

The learner groups earlier immutable engine observations by market and odds band
(2–2.49, 2.5–3.29, 3.3–4.99, 5–9.99, 10+). It deduplicates the same fixture/market
across engines, using the earliest capture. It keeps the last250 unique outcomes,
weights them with a50-outcome half-life, and combines the weighted hit rate with
a20-observation fair-bookmaker prior at the current price. Its own later outcomes
join this learning pool. Same/future kickoff outcomes and other leagues are excluded.

A market band with20+ earlier outcomes, positive total and recent50 flat returns,
and positive estimated price-adjusted return gets priority for a paper trial.
Otherwise the strategy makes explicitly labelled exploration observations at
2.0+ odds. A positive source-market sample is not treated as proven prediction
profit. Retrospective profiles of the older engines are a seed, not a complete
historical audit of this new candidate-selection universe.

Each choice and its profile snapshot are frozen before kickoff in
`ml_pick_observations` and `market_specialist_decisions`. Published eligibility is
zero. Existing official/Telegram gates do not authorize this engine. The live
card uses the frozen pending choice once recorded; it cannot replace it with a
newer, more attractive choice. Genuine prospective results are needed before
claiming this strategy profitable or qualifying it for publication.

## Unlimited research capital

The simulator now offers Funded and Unlimited research capital. Funded stops
before an unaffordable round. Unlimited continues every eligible fixed/Martingale
stake, allows negative capital and reports the peak extra funding required to
cover stakes. Negative capital is simulated debt. Capital returned by a winner
does not erase an earlier funding requirement. These two modes answer different
research questions; unlimited debt does not satisfy the funded release criteria.
The existing historical/forward qualification wrapper remains funded.

The reset button starts a new tracking period without deleting observations,
archived periods, model training data, or old losses. Concurrent/retried reset
requests are idempotent against the last observed tracking ID. The button does
not reset or retrain the models and does not place bets.

Exact archived fixture results can now settle ML observations after the live
fixture rotates out. Season, round, home/away teams and kickoff must all match;
nearby kickoffs, conflicting scores and unknown required halftime results fail
closed. No missing scores are inferred from similar fixtures.
