// Force desktop device argument before loading configuration
if (!process.argv.some(arg => arg.startsWith('--device='))) {
    process.argv.push('--device=desktop');
}

process.env.ML_RUNNER = 'true';

function normalizeDbPath(p) {
    if (!p || typeof p !== 'string') return p;
    if (process.platform !== 'win32') {
        return p.replace(/\\/g, '/');
    }
    return p;
}

const args = process.argv.slice(2);
if (args[1]) {
    args[1] = normalizeDbPath(args[1]);
}
const command = args[0]; // 'predict', 'optimize', 'backtest', 'analyse-patterns', 'analyse-time-patterns', 'scrape-live-season', 'get-live-predictions'

if (command === 'get-live-predictions') {
    const dbPath = args[1];
    const provider = args[2] || 'bet9ja';
    const limit = args[3] ? parseInt(args[3], 10) : 300;
    try {
        const { getLivePredictions } = require('./live_predictions_reader.js');
        const result = getLivePredictions(dbPath, provider, limit);
        const outStr = JSON.stringify(result) + '\n';
        const fs = require('fs');
        fs.writeSync(1, outStr);
        process.exit(0);
    } catch (e) {
        const fs = require('fs');
        fs.writeSync(2, JSON.stringify({ success: false, error: e.message }) + '\n');
        process.exit(1);
    }
}

const mlPredictor = require('./ml_predictor.js');
const { predictMatchupML, optimizeBlendingWeights, runBacktestML, discoverBet9jaEdge, discoverBet9jaEdgeAcrossSeasons } = mlPredictor;
const { analysePatterns } = require('./pattern_analyzer.js');
const { analyseTimePatterns } = require('./time_pattern_analyzer.js');
const liveCompanion = require('./live_companion.js');
const { scrapeAndPredictLiveSeason, getLivePredictions } = liveCompanion;

if (command === 'predict') {
    const dbPath = args[1];
    const homeTeam = args[2];
    const awayTeam = args[3];
    const provider = process.env.PROVIDER || 'bet9ja';
    try {
        const result = predictMatchupML(dbPath, homeTeam, awayTeam, provider);
        console.log(JSON.stringify(result));
    } catch (e) {
        console.error(JSON.stringify({ success: false, error: e.message }));
        process.exit(1);
    }
} else if (command === 'optimize') {
    const dbPath = args[1];
    const provider = process.env.PROVIDER || 'bet9ja';
    try {
        const result = optimizeBlendingWeights(dbPath, provider);
        console.log(JSON.stringify(result));
    } catch (e) {
        console.error(JSON.stringify({ success: false, error: e.message }));
        process.exit(1);
    }
} else if (command === 'backtest') {
    const dbPath = args[1];
    const seasonName = args.slice(2).join(' ');
    const provider = process.env.PROVIDER || 'bet9ja';
    try {
        const result = runBacktestML(dbPath, seasonName, provider);
        console.log(JSON.stringify(result));
    } catch (e) {
        console.error(JSON.stringify({ success: false, error: e.message }));
        process.exit(1);
    }
} else if (command === 'analyse-patterns') {
    const dbPath = args[1];
    const provider = args[2] || 'bet9ja';
    try {
        const result = analysePatterns(dbPath, provider);
        console.log(JSON.stringify(result));
    } catch (e) {
        console.error(JSON.stringify({ success: false, error: e.message }));
        process.exit(1);
    }
} else if (command === 'analyse-time-patterns') {
    const dbPath = args[1];
    const provider = args[2] || 'bet9ja';
    const isSportybet = provider === 'sportybet';
    try {
        const result = analyseTimePatterns(dbPath, isSportybet);
        console.log(JSON.stringify(result));
    } catch (e) {
        console.error(JSON.stringify({ success: false, error: e.message }));
        process.exit(1);
    }
} else if (command === 'discover-edge') {
    const dbPath = args[1];
    let lookbackWindow = 100;
    let seasonName = '';
    if (args.length > 3) {
        const maybeWindow = parseInt(args[args.length - 1], 10);
        if (!Number.isNaN(maybeWindow)) {
            lookbackWindow = maybeWindow;
            seasonName = args.slice(2, -1).join(' ');
        } else {
            seasonName = args.slice(2).join(' ');
        }
    } else {
        seasonName = args[2] || '';
    }
    const provider = process.env.PROVIDER || 'bet9ja';
    try {
        const result = discoverBet9jaEdge(dbPath, seasonName, lookbackWindow, provider);
        console.log(JSON.stringify(result));
    } catch (e) {
        console.error(JSON.stringify({ success: false, error: e.message }));
        process.exit(1);
    }
} else if (command === 'discover-edge-across-seasons') {
    const dbPath = args[1];
    const minOdds = parseFloat(args[2]) || 4;
    const maxOdds = parseFloat(args[3]) || 50;
    const lookbackWindow = args[4] ? parseInt(args[4], 10) : 100;
    const provider = process.env.PROVIDER || 'bet9ja';
    try {
        // For high-odds targets (implied odds >= 3.0), a 55% win-rate is
        // impossible (prob <= 33%).  Lower to 0.02 and let ROI filter instead.
        const effectiveWinRateThreshold = minOdds >= 3.0 ? 0.02 : 0.55;
        const result = discoverBet9jaEdgeAcrossSeasons(dbPath, provider, {
            lookbackWindow,
            minImpliedOdd: minOdds,
            maxImpliedOdd: maxOdds,
            minProbability: 0,
            minSamples: 5,
            winRateThreshold: effectiveWinRateThreshold,
            roiThreshold: 0.05
        });
        console.log(JSON.stringify(result));
    } catch (e) {
        console.error(JSON.stringify({ success: false, error: e.message }));
        process.exit(1);
    }
} else if (command === 'scrape-live-season') {
    const dbPath = args[1];
    const isHeadless = args[2] !== 'false';
    const provider = args[3] || 'bet9ja';
    const leagueId = args[4] ? parseInt(args[4], 10) : 41104; // Default: Sportybet England
    const isContinuous = args[5] === 'true';
    if (provider === 'sportybet') {
        const { scrapeAndPredictLiveSportySeason } = require('./live_companion_sporty.js');
        scrapeAndPredictLiveSportySeason(dbPath, isHeadless, leagueId, isContinuous)
            .then(result => {
                console.log(JSON.stringify(result));
                process.exit(0);
            })
            .catch(e => {
                console.error(JSON.stringify({ success: false, error: e.message }));
                process.exit(1);
            });
    } else {
        scrapeAndPredictLiveSeason(dbPath, isHeadless, isContinuous)
            .then(result => {
                console.log(JSON.stringify(result));
                process.exit(0);
            })
            .catch(e => {
                console.error(JSON.stringify({ success: false, error: e.message }));
                process.exit(1);
            });
    }
} else if (command === 'generate-strategy-report') {
    const dbPath = args[1];
    const { generateStrategyReport } = require('./strategy_report_generator');
    generateStrategyReport(dbPath)
        .then(result => {
            console.log(JSON.stringify(result));
            process.exit(0);
        })
        .catch(e => {
            console.error(JSON.stringify({ success: false, error: e.message }));
            process.exit(1);
        });
} else if (command === 'get-market-report') {
    const dbPath = args[1];
    try {
        const Database = require('better-sqlite3');
        const db = new Database(dbPath);
        
        let highRiskMinOdds = 3.3; // Default fallback
        try {
            const fs = require('fs');
            const path = require('path');
            const configPath = path.resolve(__dirname, '../browser-config.json');
            if (fs.existsSync(configPath)) {
                const browserConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
                if (browserConfig && browserConfig.ai && typeof browserConfig.ai.highRiskMinOdds === 'number') {
                    highRiskMinOdds = browserConfig.ai.highRiskMinOdds;
                }
            }
        } catch (configErr) {
            // ignore
        }

        const historyRows = db.prepare(`
          SELECT
            market,
            COUNT(*) as total,
            SUM(CASE WHEN actual_odd >= ? THEN 1 ELSE 0 END) as odds_3_3_plus
          FROM market_odds_history
          WHERE actual_odd IS NOT NULL
          GROUP BY market
        `).all(highRiskMinOdds);

        const rows = historyRows.length > 0 ? historyRows : db.prepare(`
          SELECT
            market,
            COUNT(*) as total,
            SUM(CASE WHEN implied_odd >= ? THEN 1 ELSE 0 END) as odds_3_3_plus
          FROM ai_best_picks_history
          GROUP BY market
          ORDER BY total DESC
        `).all(highRiskMinOdds);
        
        const analysis = {};
        for (const row of rows) {
          const percentage = row.total > 0 ? ((row.odds_3_3_plus / row.total) * 100).toFixed(1) : 0;
          analysis[row.market] = {
            total: row.total,
            odds_3_3_plus: row.odds_3_3_plus,
            percentage: parseFloat(percentage),
            confidence: Math.min(100, (row.total / 30) * 100)
          };
        }

        let aiPickSummary = null;
        let overallPickSummary = null;
        let topAIPredictions = [];
        let stakeUnitsSummary = null;
        let settledPicks = [];
        try {
          const hasAITable = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='ai_best_picks_history'").get();
          if (hasAITable) {
            // Overall summary (all picks combined in the table)
            const overallSummary = db.prepare(`
              SELECT
                COUNT(*) as total,
                SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending,
                SUM(CASE WHEN status = 'won' THEN 1 ELSE 0 END) as won,
                SUM(CASE WHEN status = 'lost' THEN 1 ELSE 0 END) as lost
              FROM ai_best_picks_history
            `).get();

            // AI Best Pick summary (only pick_type = 'ai_best_pick')
            const aiSummary = db.prepare(`
              SELECT
                COUNT(*) as total,
                SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending,
                AVG(implied_odd) as avg_implied_odd,
                AVG(probability) as avg_probability,
                SUM(CASE WHEN status = 'won' THEN 1 ELSE 0 END) as won,
                SUM(CASE WHEN status = 'lost' THEN 1 ELSE 0 END) as lost
              FROM ai_best_picks_history
              WHERE pick_type = 'ai_best_pick'
            `).get();

            aiPickSummary = {
              totalPicks: aiSummary.total || 0,
              pendingPicks: aiSummary.pending || 0,
              highOddsPending: aiSummary.pending || 0,
              avgImpliedOdd: aiSummary.avg_implied_odd ? parseFloat(parseFloat(aiSummary.avg_implied_odd).toFixed(2)) : 0,
              avgProbability: aiSummary.avg_probability ? parseFloat(parseFloat(aiSummary.avg_probability).toFixed(1)) : 0,
              winRate: aiSummary.won + aiSummary.lost > 0 ? parseFloat(((aiSummary.won / (aiSummary.won + aiSummary.lost)) * 100).toFixed(1)) : 0
            };

            overallPickSummary = {
              totalPicks: overallSummary.total || 0,
              pendingPicks: overallSummary.pending || 0,
              winRate: overallSummary.won + overallSummary.lost > 0 ? parseFloat(((overallSummary.won / (overallSummary.won + overallSummary.lost)) * 100).toFixed(1)) : 0
            };

            // Compute the worst-ever max consecutive loss streak
            try {
              // 1. Overall mixed streak (ordered by id to preserve exact chronological order)
              const allPicks = db.prepare(`
                SELECT status
                FROM ai_best_picks_history
                WHERE status IN ('won', 'lost')
                ORDER BY id ASC
              `).all();

              let maxConsecLosses = 0;
              let currentStreak = 0;
              for (const p of allPicks) {
                if (p.status === 'lost') {
                  currentStreak++;
                  if (currentStreak > maxConsecLosses) maxConsecLosses = currentStreak;
                } else {
                  currentStreak = 0;
                }
              }
              overallPickSummary.maxConsecutiveLosses = maxConsecLosses;
              overallPickSummary.settledPicks = allPicks.length;

              // 2. AI Best Pick streak (only pick_type = 'ai_best_pick')
              const aiBestPicks = db.prepare(`
                SELECT status
                FROM ai_best_picks_history
                WHERE status IN ('won', 'lost')
                  AND pick_type = 'ai_best_pick'
                ORDER BY id ASC
              `).all();

              let maxConsecLossesHigh = 0;
              let currentStreakHigh = 0;
              for (const p of aiBestPicks) {
                if (p.status === 'lost') {
                  currentStreakHigh++;
                  if (currentStreakHigh > maxConsecLossesHigh) maxConsecLossesHigh = currentStreakHigh;
                } else {
                  currentStreakHigh = 0;
                }
              }
              aiPickSummary.maxConsecutiveLosses = maxConsecLossesHigh;
              aiPickSummary.maxConsecutiveLossesHighOdds = maxConsecLossesHigh;
              aiPickSummary.highOddsSettledPicks = aiBestPicks.length;
            } catch (streakErr) {
              aiPickSummary.maxConsecutiveLosses = null;
              aiPickSummary.maxConsecutiveLossesHighOdds = null;
              aiPickSummary.highOddsSettledPicks = 0;
              overallPickSummary.maxConsecutiveLosses = null;
              overallPickSummary.settledPicks = 0;
            }

            topAIPredictions = db.prepare(`
              SELECT season_name, round_number, home_team, away_team, market, pick_type, status, implied_odd, probability
              FROM ai_best_picks_history
              WHERE implied_odd >= ? AND status = 'pending'
              ORDER BY implied_odd DESC
              LIMIT 5
            `).all(highRiskMinOdds);

            // Calculate 100-unit stake performance
            stakeUnitsSummary = null;
            try {
              const picks = db.prepare(`
                SELECT id, season_name, round_number, home_team, away_team, market, pick_type, probability, implied_odd, status, actual_score, kickoff_timestamp
                FROM ai_best_picks_history
                WHERE status IN ('won', 'lost', 'void')
                ORDER BY id ASC
              `).all();
              settledPicks = picks;

              const stakeStats = {
                overall: { played: 0, won: 0, lost: 0, void: 0, profit: 0, winRate: 0, roi: 0 },
                safest: { played: 0, won: 0, lost: 0, void: 0, profit: 0, winRate: 0, roi: 0 },
                high_value: { played: 0, won: 0, lost: 0, void: 0, profit: 0, winRate: 0, roi: 0 },
                ai_best_pick: { played: 0, won: 0, lost: 0, void: 0, profit: 0, winRate: 0, roi: 0 }
              };

              const updateStats = (statObj, status, odd) => {
                if (status === 'void') {
                  statObj.void++;
                } else {
                  statObj.played++;
                  if (status === 'won') {
                    statObj.won++;
                    statObj.profit += (odd - 1.0) * 100.0;
                  } else if (status === 'lost') {
                    statObj.lost++;
                    statObj.profit -= 100.0;
                  }
                }
              };

              for (const p of picks) {
                const type = p.pick_type;
                const odd = p.implied_odd && p.implied_odd > 0
                  ? p.implied_odd
                  : (p.probability > 0 ? parseFloat((100 / p.probability).toFixed(2)) : 1.0);

                if (stakeStats[type]) {
                  updateStats(stakeStats[type], p.status, odd);
                }
                updateStats(stakeStats.overall, p.status, odd);
              }

              for (const key of Object.keys(stakeStats)) {
                const s = stakeStats[key];
                s.winRate = s.played > 0 ? parseFloat(((s.won / s.played) * 100).toFixed(1)) : 0;
                s.roi = s.played > 0 ? parseFloat(((s.profit / (s.played * 100)) * 100).toFixed(1)) : 0;
                s.profit = parseFloat(s.profit.toFixed(2));
              }
              stakeUnitsSummary = stakeStats;
            } catch (stakeErr) {
              console.warn("[Market Report] Error calculating stake units summary:", stakeErr.message);
            }
          }
        } catch (aiErr) {
          // Ignore
        }
        
        const publicationRows = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='ai_best_picks_history'").get() ? db.prepare("SELECT id,season_name,round_number,home_team,away_team,market,pick_type,probability,implied_odd,status,actual_score,kickoff_timestamp FROM ai_best_picks_history ORDER BY kickoff_timestamp,id").all() : [];
        const paperTracking = require('./paper_pick_tracker').getPaperTrackingReport(db);
        db.close();
        const reportJson = JSON.stringify({ 
          success: true, 
          report: {
            paperTracking,
            publicationRows,
            generatedAt: new Date().toISOString(),
            markets: analysis,
            aiPickSummary,
            overallPickSummary,
            topAIPredictions,
            stakeUnitsSummary,
            settledPicks
          }
        });
        process.stdout.write(reportJson + '\n', () => {
          process.exit(0);
        });
    } catch (e) {
        process.stderr.write(JSON.stringify({ success: false, error: e.message }) + '\n', () => {
          process.exit(1);
        });
    }
} else if (command === 'scrape-results-history') {
    const dbPath = args[1];
    const livePlatform = args[2] || 'sportybet';
    const targetLeagueId = args[3] ? parseInt(args[3], 10) : 41104;
    if (livePlatform === 'sportybet') {
        try {
            const { scrapeHistoricalResultsSync } = require('./live_companion_sporty.js');
            scrapeHistoricalResultsSync(dbPath, targetLeagueId)
                .then(result => {
                    console.log(JSON.stringify(result));
                    process.exit(0);
                })
                .catch(e => {
                    console.error(JSON.stringify({ success: false, error: e.message }));
                    process.exit(1);
                });
        } catch (e) {
            console.error(JSON.stringify({ success: false, error: e.message }));
            process.exit(1);
        }
    } else {
        console.error(JSON.stringify({ success: false, error: 'Historical sync is currently only supported for Sportybet.' }));
        process.exit(1);
    }
} else if (command === 'auto-train') {
    const dbPath = args[1];
    const { runFullModelTrainingPipeline } = require('./auto_trainer');
    runFullModelTrainingPipeline(dbPath, { force: true })
        .then(result => {
            console.log(JSON.stringify(result));
            process.exit(0);
        })
        .catch(e => {
            console.error(JSON.stringify({ success: false, error: e.message }));
            process.exit(1);
        });
} else if (command === 'auto-optimize-db') {
    const dbPath = args[1];
    const force = args[2] === 'true' || args[2] === 'force';
    const targetKeep = args[3] ? parseInt(args[3], 10) : undefined;
    const { autoOptimizeDatabase } = require('./db_optimizer');
    try {
        const result = autoOptimizeDatabase(dbPath, { force, targetKeep });
        console.log(JSON.stringify(result));
        process.exit(0);
    } catch (e) {
        console.error(JSON.stringify({ success: false, error: e.message }));
        process.exit(1);
    }
} else if (command === 'check-db-optimization') {
    const dbPath = args[1];
    const { analyzeOptimalDbTrim } = require('./db_optimizer');
    try {
        const result = analyzeOptimalDbTrim(dbPath);
        console.log(JSON.stringify(result));
        process.exit(0);
    } catch (e) {
        console.error(JSON.stringify({ success: false, error: e.message }));
        process.exit(1);
    }
} else {
    console.error(JSON.stringify({ success: false, error: 'Unknown command' }));
    process.exit(1);
}
