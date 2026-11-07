#!/usr/bin/env python3
"""High Chance training entry point.

The legacy trainer fitted its final model before evaluating its holdout and
reported typical-price returns. Its artifacts are no longer eligible for live
inference. This entry point delegates to the independent adaptive High Chance
model, with chronological fitting/calibration/tuning/audit and actual prices.
"""
import sys
from adaptive_market_model import main

if __name__ == '__main__':
    if '--engine' not in sys.argv:
        sys.argv.extend(['--engine', 'high_chance'])
    main()
