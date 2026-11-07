# Staking calculation correction — 29 October 2026

The old All Strategies dashboard used one loss streak shared by Safest, High
Chance/High Value and AI Best. A Safest win could reset the AI Best stake. Filtering
to AI Best alone then produced a different cycle, although the combined table
looked like an independent test of each engine. It also processed simultaneous
picks one at a time, so a result could size or fund another bet at the same kickoff.
The export separately simulated engine rows, while the dashboard attributed a
single combined simulation to them. These were inconsistent economic assumptions.

## Corrected accounting

- `bankroll_simulator.mjs` supplies the dashboard, export and research replay.
  Every engine has an independent loss cycle. The dashboard defaults to uncapped
  Martingale: every loss increases the next stake until a win. Its optional Step
  cap accepts a positive whole number, including the base bet as step 1; blank
  means uncapped. After that many consecutive losses the next bet resets to base.
  The choice persists locally and applies to charts, standalone/shared tables,
  ledger and export. Another engine's result cannot reset the cycle. A void is
  neutral and does not advance it. General filter reset does not change staking.
- Qualification and automated evidence remain explicitly funded with seven total
  bets per cycle. Custom/uncapped UI replays never change release authorization.
  Capital mode is independent: funded replays stop at insufficient cash; unlimited
  research can use debt. Extremely large replays stop the entire round before
  reliable cent arithmetic is exceeded; no overflowing stake is silently skipped.
- Every stake at the same kickoff is calculated using earlier rounds only. The
  whole batch must fit opening cash before any result is used. If it cannot be
  funded, stop before that batch; do not pick an arbitrary winning subset, borrow
  against a result, add credit or continue through later winning results.
- Won net profit is `stake * (captured decimal odds - 1)`, lost net profit is
  `-stake`; currency is rounded to cents per settled bet. Total staked is turnover,
  not starting capital. ROI is net profit / turnover; capital growth is net profit
  / starting bankroll. A high win rate does not itself imply positive profit.
- Shared-portfolio KPI cards, chart, contribution table and detailed ledger use
  one account. Engine contribution rows add up to the portfolio; they do not each
  receive an extra starting bankroll or show fictitious independent balances.
- The separate Standalone engine tests table gives each engine its own starting
  capital. Under identical filters it matches selecting that engine alone,
  including Last-N horizons and the first unaffordable round. Standalone balances
  are not summed into the one-account portfolio.
- Stakes are committed before same-round settlement. The ledger displays a
  canonical accounting order; its within-round rows cannot finance other stakes.
  The equity chart and drawdown measure round closes. Sampling preserves extrema.
  The replay assumes a round settles before the next kickoff; overlapping real
  execution and slippage remain unverified. With legacy multiple same-engine
  picks at one kickoff, any win resets that engine for the next round; otherwise
  the settled losses advance its cycle.
- Source, filters and Lagos midnight use the same helper for dashboard/export.
  Outcome-filtered replays use known results and are explicitly labelled
  retrospective. Missing outcomes/odds are excluded. Negative Kelly abstains
  rather than forcing a minimum bet. The tracking epoch and archive are retained.

## Independent reconciliation of a frozen production sample

289 settled new-period observations, NGN100,000 shared capital, NGN60 base stake:

| Mode | Executed bets | Total staked | Net P/L | Ending capital | Round-close max drawdown |
|---|---:|---:|---:|---:|---:|
| Fixed | 289 | 17,340.00 | -2,424.60 | 97,575.40 | 2,647.80 |
| 1.5x cap 7 | 289 | 34,052.88 | -4,173.84 | 95,826.16 | 7,665.55 |
| 2x cap 7 | 289 | 83,580.00 | -6,615.60 | 93,384.40 | 21,829.80 |
| 3x cap 7 | 66 | 120,960.00 | -58,762.80 | 41,237.20 | 70,842.00 |

The 3x shared account stops before the next round: required 43,860.00, available
41,237.20. No later bets are counted. These figures, engine contributions and
drawdowns were independently reproduced with Python Decimal, rather than checked
only against another call to the same JavaScript implementation.

Some standalone samples are positive: High Chance has +10,033.20 under 3x on its
96 settled observations in this snapshot; under 2x it has -383.40. AI Best 3x stops
after 22 picks at 39,535.00 capital because the next 43,740.00 stake is unaffordable.
Positive sample replays are retained, not relabelled as losses. They do not satisfy
the existing current-version historical AND qualified multi-day forward 2x release
criteria. This one-period paper sample can combine research model versions; it is
not evidence that an active production engine has passed those criteria.

## Capital sensitivity
Fixed-base unlimited replays do not size stakes from capital. Changing starting capital shifts ending capital, ROC, funding shortfalls and percentage drawdown; it does not alter picks, turnover, net profit, ROI or streaks. Funded mode can change executed picks. ROC at zero initial capital is undefined (N/A), never zero percent. Percentage drawdown is undefined if any drawdown begins without a positive peak; cash drawdown remains valid. With debt, drawdown from a positive peak can exceed 100%.

## Observed minimum starting capital
For fixed-base flat/Martingale replay, minimum capital is max(0, each round stake requirement minus cumulative profit before that round). Same-round winnings cannot fund stakes. The UI displays this for the full selected sequence even if the chosen funded account stops earlier; it is independent of input capital. It is not maximum drawdown, an untouched performance audit, or a future guarantee. Capital-dependent percentage/Kelly paths do not display this calculation. Numerical incomplete replay shows unavailable.
