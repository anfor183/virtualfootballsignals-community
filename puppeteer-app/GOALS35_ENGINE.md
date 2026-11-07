# Dedicated Over / Under 3.5 engine

This separate-side trial is retired. The user clarified that the choices must belong to one engine, now expanded to both 2.5 and 3.5 goal lines. See GOALS_ENGINE.md for the active combined engine. Old records remain archived; its writer is disabled and settlement/learning helpers remain available.

Replaces the broad Market Specialist trial. Only Over 3.5 Goals (four or more goals) and Under 3.5 Goals (zero through three) are eligible. Both quoted bookmaker prices must be valid and greater than one; there is no minimum price of two.

The dedicated binary learner starts with the bookmaker's normalized two-sided probability and learns shrunk league/probability-band and team forecast errors. It uses at most 1,000 earlier distinct fixtures, with recency weighting. Once 100 fixtures exist, an earlier chronological 80/20 split selects the adjustment weight by log loss; zero adjustment is allowed when learning hurts calibration. Opposing probabilities on the same fixture sum to one. Each side independently selects its highest-probability fixture in each round; this targets likelihood of winning, without claiming a profit edge.

Both side choices, prices, probabilities, model recipe and decision summaries are frozen before kickoff. Their engine IDs are `over35` and `under35`, each with its own statistics and staking cycle. Every valid fixture's paired prices and probability are also captured in `goals35_candidates`, so later learning is not restricted to winning selections. Exact fixture results settle these records; absent or conflicting results stay unresolved. Learning excludes late captures, future/same-kickoff results, other leagues and duplicated correlated observations. Earlier 3.5-goal observations can seed the learner; that seed is not an untouched historical profitability audit.

These are prospective paper trials. No real bets, Telegram dispatch or official publications are enabled. Existing publication gates and funded qualification remain unchanged. Unlimited research capital is only a simulation option and does not prove funded profitability. The new engine has no demonstrated profitable historical/forward record at launch.

The retired `market_specialist` writer is disabled. Its immutable results remain in Archive paper candidates, with archive accounting retained. New-system summaries exclude the retired trial. Existing tracking periods, losing evidence, reset control and the three original engines are preserved.
