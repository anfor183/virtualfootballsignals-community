import unittest
import datetime as dt
import numpy as np
from utils.adaptive_market_model import chronological_blocks, metrics, select_rounds, fit_policy, daytime, day_cluster_roi, replacement_window_open


class TrainingIntegrity(unittest.TestCase):
    def test_concurrent_fixtures_stay_in_the_same_chronological_block(self):
        times = np.repeat(np.arange(300), 10)
        blocks = chronological_blocks(times)
        for first, second in zip(blocks, blocks[1:]):
            self.assertLess(times[first].max(), times[second].min())
        self.assertEqual(sum(map(len, blocks)), len(times))

    def test_selection_prioritizes_precision_instead_of_biggest_payout(self):
        chosen = select_rounds([0, 1], np.array([.4, .65]), np.array([10., 3.3]),
                               np.array([0, 1]), np.array(['round1', 'round1']))
        self.assertEqual(chosen, [1])

    def test_hit_rate_and_profit_are_reported_separately(self):
        y = np.array([1]*90+[0]*10)
        stat = metrics(range(100), y, np.full(100, 1.01), np.full(100, .90))
        self.assertEqual(stat['win_rate'], 90)
        self.assertLess(stat['roi'], 0)

    def test_policy_fit_cannot_see_audit_outcomes(self):
        y = np.array([1,1,0,1]*50+[0]*100)
        prices = np.full(len(y), 3.3); p = np.full(len(y), .55)
        markets = np.zeros(len(y)); rounds = np.arange(len(y))
        original = fit_policy(np.arange(200), y, prices, p, markets, rounds)
        changed = y.copy(); changed[200:] = 1
        self.assertEqual(original, fit_policy(np.arange(200), changed, prices, p, markets, rounds))

    def test_empty_selections_are_not_reported_as_profitable(self):
        stat = metrics([], np.array([]), np.array([]), np.array([]))
        self.assertEqual(stat['n'], 0)
        self.assertIsNone(stat['roi'])

    def test_policy_audit_obeys_the_same_wat_boundary_as_inference(self):
        # 07:59 UTC = 08:59 WAT; 08:00 UTC = 09:00 WAT.
        times = np.array([7*3600000+59*60000, 8*3600000, 23*3600000])
        self.assertEqual(daytime(np.arange(3), times, 'high_chance').tolist(), [1])
        self.assertEqual(daytime(np.arange(3), times, 'safest').tolist(), [0,1,2])

    def test_clustered_evidence_requires_more_than_one_calendar_day(self):
        stat = day_cluster_roi([0,1], np.ones(2), np.full(2,1.9), np.array([1000,2000]))
        self.assertIsNone(stat['lower'])

    def test_eligible_version_gets_a_stable_forward_window_unless_real_drift_pauses_it(self):
        now = dt.datetime(2030,1,6,tzinfo=dt.timezone.utc)
        report = dict(version='v1',ready_for_deployment=True,created_at='2030-01-05T00:00:00+00:00')
        self.assertFalse(replacement_window_open(report,now=now))
        self.assertFalse(replacement_window_open(report,dict(model_version='other',paused=True),now))
        self.assertTrue(replacement_window_open(report,dict(model_version='v1',paused=True),now))
        self.assertTrue(replacement_window_open({**report,'created_at':'2030-01-01T00:00:00+00:00'},now=now))


if __name__ == '__main__':
    unittest.main()
