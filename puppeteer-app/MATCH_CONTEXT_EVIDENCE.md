# Last-five meetings, form and league tables — 29 October 2026

The features were tested; no useful incremental advantage was established.
All three model families selected their baseline using calibration data, before
the final audit was evaluated. Unqualified models remain blocked from publication.

The base Poisson forecast already applies a fixed 25% H2H adjustment. The dedicated
adaptive models previously lacked explicit last-five meetings and reconstructed
standings. The comparison adds 29 inputs: five prior H2Hs with venue orientation,
home/away-team last-five form, points per game, goal difference, rank and table
availability. H2H persists across seasons; current-season form and tables reset.

| Engine | Audit market examples | Baseline forecast loss | With H2H/form/table inputs | Calibration selection |
|---|---:|---:|---:|---|
| High Chance | 20,814 | 0.689439 | 0.689430 | Baseline |
| Safest | 359,475 | 0.470182 | 0.470187 | Baseline |
| AI Best | 170,277 | 0.308230 | 0.308247 | Baseline |

Lower forecast loss is better. These tiny differences do not establish an
economic edge or statistical significance; market examples from the same fixture
are correlated. High Chance's tiny audit improvement did not agree with calibration
selection. Safest and AI Best worsened slightly. The selected High Chance/AI Best
profit policies again had no qualified audit picks. Safest's longer probability
audit selected 2,412 picks, won 87.06%, and lost 8.85% under flat stakes.

## Integrity and availability

- Only strictly earlier completed fixtures may enter context. Simultaneous and
  future results are excluded. Duplicate fixtures are deduplicated.
- The database has no immutable official league-table snapshots. The table is
  reconstructed from earlier results, not copied from a later screenshot/table.
- The complete-table flag requires twenty teams, all earlier current-season rounds
  present, and consistent three-minute round timing. Incomplete, gapped, unknown
  or new-season tables are neutral and masked. This complete-table reconstruction
  targets the current twenty-team England competition; other formats stay unknown.
- A real upcoming Hull–Coventry fixture had five prior H2Hs and a complete table
  from the earlier round, demonstrating usable input population rather than a
  field that remains empty. This was a read-only integrity check, not a winning pick.
- Source history spans up to 120,000 fixtures. Fit/calibration/policy/audit cutoffs
  use full source kickoff chronology (60/10/10/20). To bound memory, earlier fitting,
  calibration and tuning rounds may be sampled every sixth round for Safest/AI;
  every round in the final audit remains contiguous for valid staking replays.
- Context state ingests earlier outcomes even when a fitting example is sampled.
  Schema variants preserve existing baseline model compatibility.
- A separate walk-forward Poisson bug was corrected: overall away-team attack
  previously counted away goals twice instead of combining home and away scoring.
  Its regression covers a strong team with no prior away fixtures.

The active models were not replaced by these rejected research candidates.
Future retraining compares both feature families, and publication still requires
independent historical and forward 2x profitability evidence plus EdgeGate.
Adding descriptive football statistics is not itself proof of predictive profit.
