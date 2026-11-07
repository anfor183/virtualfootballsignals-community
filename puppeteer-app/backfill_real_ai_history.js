const fs = require('fs');
const Database = require('better-sqlite3');

function isPickWon(market, fullScore, htScore) {
    if (!fullScore || !fullScore.includes(':')) return null;
    const [hStr, aStr] = fullScore.split(':');
    const hs = parseInt(hStr, 10);
    const as = parseInt(aStr, 10);
    if (isNaN(hs) || isNaN(as)) return null;
    const totalGoals = hs + as;

    let hth = null, hta = null;
    if (htScore && htScore.includes(':')) {
        const [hh, ha] = htScore.split(':');
        hth = parseInt(hh, 10);
        hta = parseInt(ha, 10);
    }

    const m = (market || '').trim();
    if (m === 'Home Win' || m === '1') return hs > as;
    if (m === 'Away Win' || m === '2') return as > hs;
    if (m === 'Draw' || m === 'X') return hs === as;
    if (m === '1X') return hs >= as;
    if (m === 'X2') return as >= hs;
    if (m === '12') return hs !== as;
    if (m.includes('Over 1.5')) return totalGoals >= 2;
    if (m.includes('Under 1.5')) return totalGoals < 2;
    if (m.includes('Over 2.5')) return totalGoals >= 3;
    if (m.includes('Under 2.5')) return totalGoals < 3;
    if (m.includes('Over 3.5')) return totalGoals >= 4;
    if (m.includes('Under 3.5')) return totalGoals < 4;
    if (m === 'GG' || m === 'Both Teams to Score' || m === 'BTTS') return hs > 0 && as > 0;
    if (m === 'NG' || m === 'Both Teams NOT to Score') return hs === 0 || as === 0;

    // HT/FT
    if (m.startsWith('HT/FT') && hth !== null && hta !== null) {
        const htOutcome = hth > hta ? '1' : hth < hta ? '2' : 'X';
        const ftOutcome = hs > as ? '1' : hs < as ? '2' : 'X';
        const target = m.replace('HT/FT', '').trim(); // e.g. "1/1", "2/2", "X/1"
        const actual = `${htOutcome}/${ftOutcome}`;
        return target === actual;
    }

    return null;
}

function buildCandidatesForMatch(m) {
    let probs = {}, odds = {};
    try { probs = JSON.parse(m.predicted_probs) || {}; } catch(e) {}
    try { odds = m.bookmaker_odds ? JSON.parse(m.bookmaker_odds) : {}; } catch(e) {}

    const candidates = [];

    const add = (market, prob, odd) => {
        if (!prob || !odd || odd < 1.05 || odd > 25.0) return;
        const ev = Math.round(((prob / 100 * odd) - 1) * 100 * 10) / 10;
        candidates.push({
            match: m,
            home_team: m.home_team,
            away_team: m.away_team,
            market,
            probability: prob,
            implied_odd: parseFloat(odd.toFixed(2)),
            ev,
            score: (prob * 0.6) + (ev * 0.4)
        });
    };

    if (probs.over15Prob && odds.over15) add('Over 1.5 Goals', probs.over15Prob, parseFloat(odds.over15));
    if (probs.homeWinProb && odds.home) add('Home Win', probs.homeWinProb, parseFloat(odds.home));
    if (probs.awayWinProb && odds.away) add('Away Win', probs.awayWinProb, parseFloat(odds.away));
    if (probs.ggProb && odds.gg) add('GG (Both Teams to Score)', probs.ggProb, parseFloat(odds.gg));
    if (probs.over25Prob && odds.over25) add('Over 2.5 Goals', probs.over25Prob, parseFloat(odds.over25));
    if (odds.dc1x && (probs.homeWinProb || probs.drawProb)) add('1X', (probs.homeWinProb || 40) + (probs.drawProb || 25), parseFloat(odds.dc1x));
    if (odds.x2 && (probs.awayWinProb || probs.drawProb)) add('X2', (probs.awayWinProb || 40) + (probs.drawProb || 25), parseFloat(odds.x2));

    // HT/FT
    if (odds.htft && typeof odds.htft === 'object') {
        for (const [k, v] of Object.entries(odds.htft)) {
            const oddVal = parseFloat(v);
            const probVal = probs[k + 'Prob'] || probs[k] || Math.round((1 / Math.max(1.1, oddVal)) * 100);
            if (oddVal >= 2.5 && probVal >= 10) {
                const formatted = 'HT/FT ' + k.replace('htft', '').split('').join('/');
                add(formatted, probVal, oddVal);
            }
        }
    }

    return candidates;
}

function processDatabase(dbPath) {
    if (!fs.existsSync(dbPath)) return;
    console.log(`\nProcessing ${dbPath}...`);
    const db = new Database(dbPath);

    // Clean dummy skipped rows
    db.prepare("DELETE FROM ai_best_picks_history WHERE home_team LIKE 'Skipped%' OR status = 'skipped'").run();

    // Fetch all scored rounds
    const rounds = db.prepare(`
        SELECT DISTINCT season_name, round_number 
        FROM live_predictions 
        WHERE scored_status = 1 AND actual_score IS NOT NULL AND actual_score != '' AND round_number IS NOT NULL
        ORDER BY id ASC
    `).all();

    console.log(`Found ${rounds.length} finished rounds to process.`);

    const insertStmt = db.prepare(`
        INSERT INTO ai_best_picks_history (
            season_name, round_number, pick_type, home_team, away_team,
            market, probability, implied_odd, predicted_probs, actual_score,
            status, ev_score, calibrated_prob, recommendation_score, agreement_score,
            penalty_multiplier, displayed_confidence, bookmaker_implied_prob
        ) VALUES (
            ?, ?, ?, ?, ?,
            ?, ?, ?, ?, ?,
            ?, ?, ?, ?, ?,
            ?, ?, ?
        )
    `);

    let inserted = 0;
    const tx = db.transaction(() => {
        for (const r of rounds) {
            const matches = db.prepare(`
                SELECT * FROM live_predictions 
                WHERE season_name = ? AND round_number = ?
            `).all(r.season_name, r.round_number);

            if (!matches || matches.length === 0) continue;

            const allCandidates = [];
            for (const m of matches) {
                allCandidates.push(...buildCandidatesForMatch(m));
            }

            if (allCandidates.length === 0) continue;

            // 1. Safest: Highest probability with odds 1.20 - 2.20
            const safestPool = allCandidates.filter(c => c.implied_odd >= 1.20 && c.implied_odd <= 2.20);
            safestPool.sort((a, b) => b.probability - a.probability);
            const safest = safestPool[0] || allCandidates.sort((a, b) => b.probability - a.probability)[0];

            // 2. High Value: Highest EV with odds 1.50 - 3.50
            const valPool = allCandidates.filter(c => c.implied_odd >= 1.50 && c.implied_odd <= 3.50);
            valPool.sort((a, b) => b.ev - a.ev);
            const highValue = valPool[0] || allCandidates.sort((a, b) => b.ev - a.ev)[0];

            // 3. High-Risk: Best odds (>= 2.50) with positive edge
            const riskPool = allCandidates.filter(c => c.implied_odd >= 2.50);
            riskPool.sort((a, b) => (b.probability * b.implied_odd) - (a.probability * a.implied_odd));
            const highRisk = riskPool[0] || valPool[0] || safest;

            const picksToRecord = [
                { p: safest, type: 'safest' },
                { p: highValue, type: 'high_value' },
                { p: highRisk, type: 'ai_best_pick' }
            ];

            for (const item of picksToRecord) {
                const pick = item.p;
                if (!pick || !pick.home_team) continue;

                // Find matching fixture to get final score
                const fixture = matches.find(m => m.home_team === pick.home_team && m.away_team === pick.away_team);
                const score = fixture ? fixture.actual_score : null;
                const htScore = fixture ? fixture.actual_ht_score : null;

                const won = isPickWon(pick.market, score, htScore);
                const status = won === true ? 'won' : won === false ? 'lost' : 'pending';

                // Delete existing row for this round and pick_type if any
                db.prepare(`
                    DELETE FROM ai_best_picks_history 
                    WHERE season_name = ? AND round_number = ? AND pick_type = ?
                `).run(r.season_name, r.round_number, item.type);

                insertStmt.run(
                    r.season_name,
                    r.round_number,
                    item.type,
                    pick.home_team,
                    pick.away_team,
                    pick.market,
                    pick.probability || 50,
                    pick.implied_odd || 1.8,
                    fixture ? fixture.predicted_probs : null,
                    score,
                    status,
                    pick.ev || 0,
                    pick.probability || 50,
                    Math.round(pick.score || 50),
                    80,
                    1,
                    pick.probability || 50,
                    parseFloat((100 / (pick.implied_odd || 2)).toFixed(1))
                );
                inserted++;
            }
        }
    });

    tx();
    console.log(`✅ Backfill complete! Inserted ${inserted} real AI pick records.`);

    // Summary stats
    const stats = db.prepare(`
        SELECT pick_type, status, count(*) as count 
        FROM ai_best_picks_history 
        GROUP BY pick_type, status
    `).all();
    console.log('Final AI Picks History Stats:');
    console.table(stats);
}

processDatabase('./databases/sportybet_archive.db');
processDatabase('./databases/virtual_football_archive.db');
