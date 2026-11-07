# Candidate performance tracking

The profitability gate controls published signals. When all markets are blocked, official history can remain unchanged while fixtures continue arriving.

Safest and High Value fallback candidates are recorded separately in `paper_pick_observations`, before kickoff, using captured bookmaker prices. The shared candidate builder is used by the dashboard and the scraper. Records are immutable and unique per season, round and strategy. Exact fixture results settle observations automatically, even when no published picks are pending. HT/FT observations require a recorded halftime score.

In Market Analytics, use **Statistics source** to switch between **Paper candidates** and **Published signals**. Paper tracking is the default for the simulation section. It does not publish recommendations, send Telegram picks, manufacture high-risk AI picks, or reconstruct selections after matches finish. Existing published history is retained separately. Paper Telegram exports are disabled because the existing export uses published signals.

Validation: `node --test test_paper_pick_tracker.js` and `node test_edge_gate.js`. Build the dashboard with `npm run build` in `dashboard/`, then restart `bot-dashboard` and `vfl-scraper` after deployment.
