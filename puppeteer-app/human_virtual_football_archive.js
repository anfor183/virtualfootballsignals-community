const fs = require('fs');
const path = require('path');

// Force desktop device argument before loading configuration
if (!process.argv.some(arg => arg.startsWith('--device='))) {
    process.argv.push('--device=desktop');
}
const config = require('./config');
const Database = require('better-sqlite3');
const { pruneOldSeasons } = require('./utils/db_cleaner');

const delay = (ms) => new Promise(r => setTimeout(r, ms));

const dns = require('dns');

async function isOnline() {
    return new Promise((resolve) => {
        dns.lookup('google.com', (err) => {
            if (err && err.code === "ENOTFOUND") {
                resolve(false);
            } else {
                resolve(true);
            }
        });
    });
}

async function ensureInternet() {
    let online = await isOnline();
    if (!online) {
        console.log("⚠️ NO INTERNET CONNECTION DETECTED. Pausing scraping...");
        while (!online) {
            await delay(5000);
            online = await isOnline();
        }
        console.log("✅ Internet connection restored. Resuming scraping...");
        await delay(3000);
    }
}

const desktopPath = path.join(require('os').homedir(), 'Desktop', 'Virtual_Football_Archives');
let saveDir = desktopPath;
let scrapeMode = 'head_to_head';

try {
    const settingsPath = path.join(__dirname, 'bot_settings.json');
    if (fs.existsSync(settingsPath)) {
        const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
        if (settings.outputDir) {
            saveDir = settings.outputDir;
        }
        if (settings.virtualFootballScrapeMode) {
            scrapeMode = settings.virtualFootballScrapeMode;
        }
    }
} catch (e) {
    console.error('Failed to load bot settings:', e);
}

if (!fs.existsSync(saveDir)) {
    fs.mkdirSync(saveDir, { recursive: true });
}

// Set up live logging to a txt file
const logFilePath = path.join(saveDir, `live_scraper_log_${Date.now()}.txt`);
const originalLog = console.log;
const originalError = console.error;

console.log = function (...args) {
    const msg = args.map(a => typeof a === 'object' ? JSON.stringify(a) : a).join(' ');
    originalLog.apply(console, args);
    fs.appendFileSync(logFilePath, `[${new Date().toISOString()}] ${msg}\n`);
};
console.error = function (...args) {
    const msg = args.map(a => typeof a === 'object' ? JSON.stringify(a) : a).join(' ');
    originalError.apply(console, args);
    fs.appendFileSync(logFilePath, `[ERROR] [${new Date().toISOString()}] ${msg}\n`);
};

function getSeasonTableName(prefix, seasonName) {
    if (!seasonName) return null;
    let normalized = seasonName.toLowerCase().replace(/[^a-z0-9]/g, '_').replace(/_+/g, '_');
    normalized = normalized.replace(/^_+|_+$/g, '');
    return `${prefix}_${normalized}`;
}

function cleanMatchTeamName(name) {
    if (!name) return '';
    let text = name.trim();
    const len = text.length;
    if (len > 0 && len % 2 === 0) {
        const half = text.substring(0, len / 2);
        if (half.length > 3 && /[a-zA-Z]/.test(half) && half + half === text) {
            text = half;
        }
    }
    if (text.length > 3) {
        const suffix = text.substring(text.length - 3);
        if (/^[A-Z0-9]{3}$/.test(suffix)) {
            text = text.substring(0, text.length - 3).trim();
        }
    }
    return text;
}

function extractScore(scoreStr) {
    if (!scoreStr) return null;
    let clean = scoreStr.replace(/\s+/g, '');
    const halfLen = clean.length / 2;
    if (clean.length % 2 === 0 && clean.substring(0, halfLen) === clean.substring(halfLen)) {
        clean = clean.substring(0, halfLen);
    }
    const match = clean.match(/^(\d+):(\d+)$/);
    if (match) {
        return [parseInt(match[1], 10), parseInt(match[2], 10)];
    }
    const m = clean.match(/(\d+):(\d+)/);
    if (m) {
        return [parseInt(m[1], 10), parseInt(m[2], 10)];
    }
    return null;
}

function parseDOMMatchLine(row, line) {
    if (!line.includes('|')) return null;
    const parts = line.split('|').map(p => p.trim());
    if (parts.length < 4) return null;
    
    const timeStr = parts[0];
    if (!/^\d{1,2}:\d{2}$/.test(timeStr)) return null;

    let homeTeam = '';
    let awayTeam = '';
    let htHomeScore = null;
    let htAwayScore = null;
    let homeScore = null;
    let awayScore = null;

    if (parts.length >= 6 && parts[2] === '-') {
        homeTeam = cleanMatchTeamName(parts[1]);
        awayTeam = cleanMatchTeamName(parts[3]);

        const ht = extractScore(parts[4]);
        if (ht) {
            htHomeScore = ht[0];
            htAwayScore = ht[1];
        }

        const ft = extractScore(parts[5]);
        if (ft) {
            homeScore = ft[0];
            awayScore = ft[1];
        }
    } else if (parts[1].includes('-')) {
        const teamParts = parts[1].split('-');
        if (teamParts.length < 2) return null;
        
        homeTeam = cleanMatchTeamName(teamParts[0]);
        awayTeam = cleanMatchTeamName(teamParts[1]);

        const ht = extractScore(parts[2]);
        if (ht) {
            htHomeScore = ht[0];
            htAwayScore = ht[1];
        }

        const ft = extractScore(parts[3]);
        if (ft) {
            homeScore = ft[0];
            awayScore = ft[1];
        }
    } else {
        return null;
    }

    if (!homeTeam || !awayTeam || homeTeam === awayTeam) return null;
    if (homeScore === null || awayScore === null) return null;

    const totalGoals = homeScore + awayScore;
    const o05 = totalGoals > 0 ? 'Yes' : 'No';
    const o15 = totalGoals > 1 ? 'Yes' : 'No';
    const o25 = totalGoals > 2 ? 'Yes' : 'No';
    const o35 = totalGoals > 3 ? 'Yes' : 'No';
    const o45 = totalGoals > 4 ? 'Yes' : 'No';
    const o55 = totalGoals > 5 ? 'Yes' : 'No';
    const gg_ng = (homeScore > 0 && awayScore > 0) ? 'GG' : 'NG';
    
    let matchResult = 'Draw';
    if (homeScore > awayScore) matchResult = 'Home';
    else if (awayScore > homeScore) matchResult = 'Away';

    return {
        league_name: row.league_name,
        season_name: row.season_name,
        home_team: homeTeam,
        away_team: awayTeam,
        home_score: homeScore,
        away_score: awayScore,
        ht_home_score: htHomeScore,
        ht_away_score: htAwayScore,
        total_goals: totalGoals,
        over_0_5: o05,
        over_1_5: o15,
        over_2_5: o25,
        over_3_5: o35,
        over_4_5: o45,
        over_5_5: o55,
        gg_ng: gg_ng,
        match_result: matchResult,
        match_time: timeStr
    };
}

function parseDOMStandingsLine(row, line) {
    if (!line.includes('|')) return null;
    const parts = line.split('|').map(p => p.trim());
    if (parts.length < 5) return null;

    // If the first part is a time string, it's a match, not standings
    if (/^\d{1,2}:\d{2}$/.test(parts[0])) return null;

    const pos = parseInt(parts[0], 10);
    if (isNaN(pos) || pos < 1 || pos > 24) return null;

    let teamName = cleanMatchTeamName(parts[1]);
    let numbersStart = 2;
    if (!teamName || teamName.toLowerCase() === 'team') {
        teamName = cleanMatchTeamName(parts[2]);
        numbersStart = 3;
    }
    if (!teamName || teamName.toLowerCase() === 'team') return null;

    const numbers = [];
    let goalsIndex = -1;
    let goalsStr = '';

    for (let i = numbersStart; i < parts.length; i++) {
        const val = parts[i];
        if (/^\d+:\d+$/.test(val)) {
            goalsIndex = numbers.length;
            goalsStr = val;
        } else {
            const num = parseInt(val, 10);
            if (!isNaN(num)) {
                numbers.push(num);
            }
        }
    }

    let played = 0, won = 0, drawn = 0, lost = 0, gf = 0, ga = 0, gd = 0, pts = 0;

    if (goalsStr && numbers.length >= 4) {
        played = numbers[0];
        won = numbers[1];
        drawn = numbers[2];
        lost = numbers[3];
        
        const gParts = goalsStr.split(':');
        gf = parseInt(gParts[0], 10);
        ga = parseInt(gParts[1], 10);
        gd = gf - ga;
        
        pts = numbers[numbers.length - 1];
    } else if (numbers.length >= 7) {
        played = numbers[0];
        won = numbers[1];
        drawn = numbers[2];
        lost = numbers[3];
        
        if (numbers.length === 7) {
            gf = numbers[4];
            ga = numbers[5];
            gd = gf - ga;
            pts = numbers[6];
        } else {
            gf = numbers[4];
            ga = numbers[5];
            gd = numbers[6];
            pts = numbers[7];
        }
    } else {
        return null;
    }

    return {
        league_name: row.league_name,
        season_name: row.season_name,
        position: pos,
        team_name: teamName,
        played,
        won,
        drawn,
        lost,
        goals_scored: gf,
        goals_conceded: ga,
        goal_difference: gd,
        points: pts
    };
}

async function runVirtualFootballScraper() {
    console.log(`\n========================================`);
    console.log(`🤖 STARTING VIRTUAL FOOTBALL ARCHIVE SCRAPER`);
    console.log(`========================================\n`);
    console.log(`📝 Live logs are being saved to: ${logFilePath}\n`);

    const dbPath = path.join(saveDir, 'virtual_football_archive.db');
    const db = new Database(dbPath);
    console.log(`🗄️ Initializing SQLite Database at: ${dbPath}`);
    db.exec(`
        CREATE TABLE IF NOT EXISTS seasons (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            league_name TEXT,
            season_name TEXT,
            data TEXT,
            extracted_at TEXT
        );
        CREATE TABLE IF NOT EXISTS api_feeds (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            endpoint TEXT,
            response_data TEXT,
            timestamp TEXT
        );
        CREATE TABLE IF NOT EXISTS h2h_records (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            league_name TEXT,
            season_name TEXT,
            season_id TEXT,
            team1_id TEXT,
            team1_name TEXT,
            team2_id TEXT,
            team2_name TEXT,
            h2h_data TEXT,
            extracted_at TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_h2h_lookup ON h2h_records (season_name, team1_id, team2_id);
    `);

    try { db.exec("DROP VIEW IF EXISTS betting_analytics"); } catch (e) {}
    try { db.exec("DROP TABLE IF EXISTS betting_analytics"); } catch (e) {}
    try { db.exec("DROP TABLE IF EXISTS league_tables"); } catch (e) {}

    // Clean up dynamic per-season tables if they exist
    try {
        const dynamicTables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND (name LIKE 'fixtures_%' OR name LIKE 'standings_%')").all();
        for (const tbl of dynamicTables) {
            db.exec(`DROP TABLE IF EXISTS "${tbl.name}"`);
        }
    } catch (e) {
        console.error("Error cleaning up dynamic tables:", e.message);
    }

    db.exec(`
        CREATE TABLE IF NOT EXISTS fixtures (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            league_name TEXT,
            season_name TEXT,
            match_time TEXT,
            home_team TEXT,
            away_team TEXT,
            ht_home_score INTEGER,
            ht_away_score INTEGER,
            home_score INTEGER,
            away_score INTEGER,
            bookmaker_odds TEXT,
            UNIQUE(league_name, season_name, home_team, away_team) ON CONFLICT REPLACE
        );

        CREATE TABLE IF NOT EXISTS league_standings (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            league_name TEXT,
            season_name TEXT,
            position INTEGER,
            team_name TEXT,
            played INTEGER,
            won INTEGER,
            drawn INTEGER,
            lost INTEGER,
            goals_scored INTEGER,
            goals_conceded INTEGER,
            goal_difference INTEGER,
            points INTEGER,
            UNIQUE(league_name, season_name, team_name) ON CONFLICT REPLACE
        );

        CREATE VIEW IF NOT EXISTS betting_analytics AS
        SELECT 
            id,
            league_name,
            season_name,
            home_team,
            away_team,
            home_score,
            away_score,
            ht_home_score,
            ht_away_score,
            (home_score + away_score) AS total_goals,
            CASE WHEN (home_score + away_score) > 0 THEN 'Yes' ELSE 'No' END AS over_0_5,
            CASE WHEN (home_score + away_score) > 1 THEN 'Yes' ELSE 'No' END AS over_1_5,
            CASE WHEN (home_score + away_score) > 2 THEN 'Yes' ELSE 'No' END AS over_2_5,
            CASE WHEN (home_score + away_score) > 3 THEN 'Yes' ELSE 'No' END AS over_3_5,
            CASE WHEN (home_score + away_score) > 4 THEN 'Yes' ELSE 'No' END AS over_4_5,
            CASE WHEN (home_score + away_score) > 5 THEN 'Yes' ELSE 'No' END AS over_5_5,
            CASE WHEN home_score > 0 AND away_score > 0 THEN 'GG' ELSE 'NG' END AS gg_ng,
            CASE 
                WHEN home_score > away_score THEN 'Home'
                WHEN away_score > home_score THEN 'Away'
                ELSE 'Draw'
            END AS match_result,
            match_time
        FROM fixtures;
    `);

    try {
        db.exec("ALTER TABLE fixtures ADD COLUMN bookmaker_odds TEXT");
    } catch (e) {}
    
    const insertApiFeed = db.prepare('INSERT INTO api_feeds (endpoint, response_data, timestamp) VALUES (?, ?, ?)');
    const insertSeason = db.prepare('INSERT INTO seasons (league_name, season_name, data, extracted_at) VALUES (?, ?, ?, ?)');
    const insertH2H = db.prepare(`
        INSERT INTO h2h_records (league_name, season_name, season_id, team1_id, team1_name, team2_id, team2_name, h2h_data, extracted_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const insertStanding = db.prepare(`
        INSERT INTO league_standings (
            league_name, season_name, position, team_name,
            played, won, drawn, lost, goals_scored, goals_conceded, goal_difference, points
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const insertAnalytics = db.prepare(`
        INSERT INTO fixtures (
            league_name, season_name, match_time, home_team, away_team,
            ht_home_score, ht_away_score, home_score, away_score, bookmaker_odds
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const checkH2HExists = db.prepare(`
        SELECT 1 FROM h2h_records 
        WHERE season_name = ? 
          AND ((team1_id = ? AND team2_id = ?) OR (team1_id = ? AND team2_id = ?))
        LIMIT 1
    `);

    try {
        console.log("🚀 Launching anti-detect browser...");
        const isHeadless = process.argv.includes('--headless=true') || process.argv.includes('--headless');
        const page = await config.connect({ headless: isHeadless, provider: 'bet9ja' });

        // --- API INTERCEPTION ---
        // By intercepting the raw data feeds, we get 100% of the statistical data (Over/Under, 1st Half, Home/Away) 
        // without needing to manually click every single dropdown and tab on the page!
        page.on('response', async (response) => {
            const url = response.url();
            if (url.includes('feeds') || url.includes('statistics') || url.includes('virtuals')) {
                try {
                    const contentType = response.headers()['content-type'] || '';
                    if (contentType.includes('application/json')) {
                        const json = await response.json();
                        try {
                            insertApiFeed.run(url, JSON.stringify(json), new Date().toISOString());
                            console.log(`📡 Intercepted and saved raw data feed: ${url.substring(0, 80)}...`);
                        } catch (err) {
                            console.error(`❌ Failed to save API feed to DB:`, err.message);
                        }
                    }
                } catch (e) {
                    // Ignore parsing errors for aborted/empty requests
                }
            }
        });

        console.log("🌐 Navigating to Bet9ja Virtuals...");
        await ensureInternet(); await page.goto('https://st-cdn001.akamaized.net/bet9javirtuals/en/1', { waitUntil: 'networkidle2' });
        await delay(5000);

        // Define leagues to scrape (restricted to Bundesliga for now per user request)
        const leagues = [
            "Virtual Football Bundesliga"
        ];

        let leagueData = [];

        for (const leagueName of leagues) {
            console.log(`\n⚽ Processing League: ${leagueName}`);
            
            // Re-navigate to reset state
            await ensureInternet(); await page.goto('https://st-cdn001.akamaized.net/bet9javirtuals/en/1', { waitUntil: 'networkidle2' });
            await delay(3000);

            // Step 1: Click "Virtual Football" to expand menu if needed
            console.log(`🔍 Looking for Virtual Football menu...`);
            const vfHandle = await page.evaluateHandle(() => {
                const els = Array.from(document.querySelectorAll('a, div, span, button'));
                return els.find(e => e.textContent.trim().includes('Virtual Football') && e.offsetParent !== null && e.textContent.trim().length < 30);
            });
            
            if (vfHandle && vfHandle.asElement()) {
                await ensureInternet(); await vfHandle.asElement().click(); 
            } else {
                console.log(`⚠️ Virtual Football element not found!`);
            }
            await delay(3000);

            // Step 2: Click the specific League
            console.log(`🔍 Looking for League: ${leagueName}`);
            const leagueHandle = await page.evaluateHandle((name) => {
                const els = Array.from(document.querySelectorAll('a, div, span, li, button'));
                return els.find(e => e.textContent.trim().includes(name) && e.offsetParent !== null && e.textContent.trim().length < 50);
            }, leagueName);

            if (leagueHandle && leagueHandle.asElement()) {
                await ensureInternet(); await leagueHandle.asElement().click(); 
            } else {
                console.log(`⚠️ Could not find link for ${leagueName}, skipping...`);
                continue;
            }
            await delay(5000);

            // Step 3: Click 'Archive' tab
            console.log(`📂 Opening Archive tab...`);
            const archiveHandle = await page.evaluateHandle(() => {
                const els = Array.from(document.querySelectorAll('a, div, span, button'));
                return els.find(e => e.textContent.trim() === 'Archive' && e.offsetParent !== null && e.textContent.trim().length < 20);
            });

            if (archiveHandle && archiveHandle.asElement()) {
                await ensureInternet(); await archiveHandle.asElement().click();
            } else {
                console.log(`⚠️ Could not find Archive tab for ${leagueName}, skipping...`);
                continue;
            }
            await delay(4000);

            // Step 4: Click 'Show more' until at least 60 seasons are visible
            console.log(`🔽 Loading history until at least 60 seasons are visible...`);
            let showMoreCount = 0;
            let seasonsCount = 0;
            let canShowMore = true;

            while (canShowMore) {
                // Count current seasons visible in DOM
                seasonsCount = await page.evaluate(() => {
                    const els = Array.from(document.querySelectorAll('*'));
                    const seasonEls = els.filter(e => 
                        e.textContent.includes('Virtual Football') && 
                        /\d+/.test(e.textContent) && 
                        e.offsetParent !== null && 
                        e.children.length === 0 && 
                        e.textContent.trim().length < 50
                    );
                    return new Set(seasonEls.map(e => e.textContent.trim())).size;
                });

                console.log(`      ↳ Currently visible seasons: ${seasonsCount}`);
                if (seasonsCount >= 60) {
                    console.log(`✅ Found ${seasonsCount} seasons (target is 60). Stopping pagination.`);
                    break;
                }

                const btnHandle = await page.evaluateHandle(() => {
                    const els = Array.from(document.querySelectorAll('a, div, span, button'));
                    return els.find(e => e.textContent.trim().toLowerCase() === 'show more' && e.offsetParent !== null && e.textContent.trim().length < 30);
                });

                if (btnHandle && btnHandle.asElement()) {
                    try {
                        await ensureInternet(); await btnHandle.asElement().click();
                        showMoreCount++;
                        await delay(2000); // wait for data to load
                    } catch (err) {
                        console.log(`      ↳ Native click failed: ${err.message}. Trying JS click...`);
                        try {
                            await ensureInternet(); await page.evaluate(el => el.click(), btnHandle);
                            showMoreCount++;
                            await delay(2000);
                        } catch (jsErr) {
                            console.log(`      ↳ JS click failed too: ${jsErr.message}. Stopping...`);
                            canShowMore = false;
                        }
                    }
                } else {
                    console.log(`⚠️ "Show more" button not found. No more seasons can be loaded.`);
                    canShowMore = false;
                }
            }
            console.log(`✅ Clicked 'Show more' ${showMoreCount} times.`);

            // Step 5: Extract all seasons and limit to the 60 most recent
            console.log(`📝 Extracting season links (limiting to the 60 most recent)...`);
            let seasons = await page.evaluate(() => {
                const els = Array.from(document.querySelectorAll('*'));
                // Strictly filter for leaf nodes (no children) so we don't accidentally concatenate text
                const seasonEls = els.filter(e => 
                    e.textContent.includes('Virtual Football') && 
                    /\d+/.test(e.textContent) && 
                    e.offsetParent !== null && 
                    e.children.length === 0 && 
                    e.textContent.trim().length < 50
                );
                return Array.from(new Set(seasonEls.map(e => e.textContent.trim())));
            });

            if (seasons.length > 60) {
                console.log(`✂️ Trimming list of ${seasons.length} seasons to the 60 most recent.`);
                seasons = seasons.slice(0, 60);
            }

            if (seasons.length === 0) {
                console.log(`⚠️ No seasons found for ${leagueName}.`);
                continue;
            }

            // Reverse the array to start from the oldest of these 60 to the newest
            seasons.reverse();
            console.log(`📊 Total seasons to process: ${seasons.length}. Starting extraction...`);

            for (let i = 0; i < seasons.length; i++) {
                const seasonName = seasons[i];
                console.log(`\n   ➤ Extracting: ${seasonName} (${i + 1}/${seasons.length})`);

                // We need a loop to ensure the season is visible, because SPAs often reset pagination 
                // when you use history.back(). If it's not visible, we click "Show more" until it is.
                let foundSeason = false;
                let searchAttempts = 0;
                
                while (!foundSeason && searchAttempts < 50) {
                    const seasonHandle = await page.evaluateHandle((sName) => {
                        const els = Array.from(document.querySelectorAll('a, div, span, td, tr, li'));
                        return els.find(e => e.textContent.trim() === sName && e.offsetParent !== null && e.textContent.trim().length < 60);
                    }, seasonName);

                    if (seasonHandle && seasonHandle.asElement()) {
                        await ensureInternet(); await seasonHandle.asElement().click();
                        foundSeason = true;
                        console.log(`      ↳ Found and clicked ${seasonName}!`);
                    } else {
                        // Season not found, it must be hidden behind pagination. Click "Show more".
                        const btnHandle = await page.evaluateHandle(() => {
                            const els = Array.from(document.querySelectorAll('a, div, span, button'));
                            return els.find(e => e.textContent.trim().toLowerCase() === 'show more' && e.offsetParent !== null && e.textContent.trim().length < 30);
                        });
                        if (btnHandle && btnHandle.asElement()) {
                            try {
                                await ensureInternet(); await btnHandle.asElement().click();
                                await delay(2000); // Wait for new items to load
                            } catch (err) {
                                console.log(`      ↳ Native click failed: ${err.message}. Trying JS click...`);
                                try {
                                    await ensureInternet(); await page.evaluate(el => el.click(), btnHandle);
                                    await delay(2000);
                                } catch (jsErr) {
                                    console.log(`      ↳ JS click failed too: ${jsErr.message}. Stopping...`);
                                    break;
                                }
                            }
                        } else {
                            // No "Show more" button and season not found? Break the search.
                            break;
                        }
                    }
                    searchAttempts++;
                }

                if (!foundSeason) {
                    console.log(`⚠️ CRITICAL: Could not find ${seasonName} after expanding list. Skipping...`);
                    continue;
                }
                
                await delay(3000); // Wait for season to fully load

                // Helper to scrape current view
                async function scrapeCurrentView() {
                    return await page.evaluate(() => {
                        const data = { tables: [], matches: [] };
                        const rows = Array.from(document.querySelectorAll('tr'));
                        rows.forEach(row => {
                            const cells = Array.from(row.querySelectorAll('th, td')).map(td => td.textContent.trim().replace(/\s+/g, ' '));
                            if (cells.length > 0) data.tables.push(cells.join(' | '));
                        });
                        
                        let matchesArr = [];
                        document.querySelectorAll('.match, .fixture, [class*="match"], [class*="fixture"], .event-row').forEach(match => {
                            matchesArr.push(match.textContent.trim().replace(/\s+/g, ' '));
                        });
                        
                        if (matchesArr.length === 0) {
                            document.querySelectorAll('li, .row, [class*="item"]').forEach(el => {
                                const text = el.textContent.trim().replace(/\s+/g, ' ');
                                if ((/[0-9]+\s*:\s*[0-9]+/.test(text) || /\bvs\b/i.test(text) || text.includes('-')) && text.length > 10 && text.length < 150) {
                                    matchesArr.push(text);
                                }
                            });
                        }
                        
                        const matchEls = Array.from(document.querySelectorAll('div, span, td')).filter(e => 
                            (e.textContent.includes('(FT)') || e.textContent.includes('-:-')) && /\d/.test(e.textContent) && e.offsetParent !== null && e.textContent.trim().length > 10 && e.textContent.trim().length < 100
                        );
                        data.matches = [...new Set([...matchesArr, ...matchEls.map(m => m.textContent.trim().replace(/\s+/g, ' '))])];
                        
                        return data;
                    });
                }

                let seasonData = {};

                // Helper to navigate back to the Archive list
                async function goBackToArchive() {
                    console.log(`⬅️ Navigating back to the Archive list...`);
                    await ensureInternet();
                    let returned = await page.evaluate(() => {
                        const els = Array.from(document.querySelectorAll('a, button, div, span'));
                        let archiveTab = els.find(e => e.textContent.trim().toLowerCase() === 'archive' && e.offsetParent !== null && e.textContent.trim().length < 20);
                        if (archiveTab) {
                            archiveTab.click();
                            return true;
                        }
                        return false;
                    });
                    if (returned) {
                        console.log(`✅ Successfully clicked Archive tab to return!`);
                        await delay(3500);
                    } else {
                        console.log(`🛑 Could not find Archive tab to go back. Attempting emergency reset...`);
                        await ensureInternet(); await page.goto('https://st-cdn001.akamaized.net/bet9javirtuals/en/1', { waitUntil: 'networkidle2' });
                        await delay(5000);
                    }
                }

                // 1. Wait for page load
                await delay(3000);

                // Get season ID from URL
                const currentUrl = page.url();
                const seasonIdMatch = currentUrl.match(/season\/(\d+)/);
                const seasonId = seasonIdMatch ? seasonIdMatch[1] : '';
                console.log(`      ↳ Season ID: ${seasonId}`);

                // 2. Click Tables tab to scrape league table
                console.log(`      ↳ Clicking Tables tab to scrape league table...`);
                const tablesTabHandle = await page.evaluateHandle(() => {
                    const els = Array.from(document.querySelectorAll('a, div, span, button, li'));
                    return els.find(e => e.textContent.trim().toLowerCase() === 'tables' && e.offsetParent !== null && e.textContent.trim().length < 20);
                });
                if (tablesTabHandle && tablesTabHandle.asElement()) {
                    await ensureInternet(); await tablesTabHandle.asElement().click();
                    await delay(3000);
                } else {
                    console.log(`      ⚠️ Could not find "Tables" tab!`);
                }
                const tablesData = await scrapeCurrentView();

                // 3. Click Fixtures tab
                console.log(`      ↳ Clicking Fixtures tab...`);
                const fixturesTabHandle = await page.evaluateHandle(() => {
                    const els = Array.from(document.querySelectorAll('a, div, span, button, li'));
                    return els.find(e => e.textContent.trim().toLowerCase() === 'fixtures' && e.offsetParent !== null && e.textContent.trim().length < 20);
                });
                if (fixturesTabHandle && fixturesTabHandle.asElement()) {
                    await ensureInternet(); await fixturesTabHandle.asElement().click();
                    await delay(3000);
                } else {
                    console.log(`      ⚠️ Could not find "Fixtures" tab!`);
                }

                // 4. Click Full listing sub-tab
                console.log(`      ↳ Clicking "Full listing" sub-tab...`);
                const fullListingSubTabHandle = await page.evaluateHandle(() => {
                    let el = document.querySelector('#type-tab-full');
                    if (el && el.offsetParent !== null) return el;
                    const els = Array.from(document.querySelectorAll('a, div, span, button, li'));
                    return els.find(e => e.textContent.trim().toLowerCase() === 'full listing' && e.offsetParent !== null && e.textContent.trim().length < 20);
                });
                if (fullListingSubTabHandle && fullListingSubTabHandle.asElement()) {
                    await ensureInternet(); await fullListingSubTabHandle.asElement().click();
                    await delay(3000);
                } else {
                    console.log(`      ⚠️ Could not find "Full listing" sub-tab!`);
                }

                // 5. Expand all fixtures by clicking "Show more" / "see more" until fully loaded
                console.log(`      ↳ Expanding all fixtures...`);
                let canShowMore = true;
                let showMoreCount = 0;
                while (canShowMore && showMoreCount < 40) {
                    const buttonHandle = await page.evaluateHandle(() => {
                        const btns = Array.from(document.querySelectorAll('a, div, span, button'));
                        return btns.find(e => {
                            const text = e.textContent.trim().toLowerCase();
                            return (text === 'show more' || text === 'see more') && e.offsetParent !== null && e.textContent.trim().length < 30;
                        });
                    });
                    if (buttonHandle && buttonHandle.asElement()) {
                        try {
                            await ensureInternet(); await buttonHandle.asElement().click();
                            showMoreCount++;
                            await delay(2000);
                        } catch (err) {
                            console.log(`      ↳ Native click failed: ${err.message}. Trying JS click...`);
                            try {
                                await ensureInternet(); await page.evaluate(el => el.click(), buttonHandle);
                                showMoreCount++;
                                await delay(2000);
                            } catch (jsErr) {
                                console.log(`      ↳ JS click failed too: ${jsErr.message}. Stopping...`);
                                canShowMore = false;
                            }
                        }
                    } else {
                        canShowMore = false;
                    }
                }
                console.log(`      ↳ Clicked "Show more" verification button ${showMoreCount} times.`);
                const fixturesData = await scrapeCurrentView();

                // 6. Verify completeness of the DOM scraped data
                let hasUnplayed = false;
                let matchCount = 0;
                for (const line of fixturesData.tables) {
                    if (line.includes('|')) {
                        const parts = line.split('|').map(p => p.trim());
                        if (parts.length >= 4 && /\d{2}:\d{2}/.test(parts[0]) && parts[1].includes('-')) {
                            matchCount++;
                            if (line.includes('-:-') || line.includes('- : -')) {
                                hasUnplayed = true;
                            }
                        }
                    }
                }

                console.log(`      ↳ DOM Verification: ${matchCount}/240 matches, has unplayed: ${hasUnplayed}`);
                if (matchCount < 240 || hasUnplayed) {
                    console.log(`      🔥 Season ${seasonName} (ID: ${seasonId}) is LIVE! Transitioning to Live Tracking mode...`);
                    
                    const { scrapeAndPredictLiveSeason } = require('./utils/live_companion.js');
                    let isSeasonComplete = false;
                    
                    while (!isSeasonComplete) {
                        const liveRes = await scrapeAndPredictLiveSeason(dbPath, false, page);
                        if (liveRes.success) {
                            if (liveRes.unplayedCount === 0 && liveRes.playedCount >= 240) {
                                console.log(`      ✅ Live season finished playing all matches!`);
                                isSeasonComplete = true;
                            } else {
                                console.log(`      ⏳ Live season ongoing... sleeping for 30 seconds before next check.`);
                                await delay(30000);
                            }
                        } else {
                            console.log(`      ⚠️ Live tracking pass failed: ${liveRes.error}. Retrying in 30 seconds...`);
                            await delay(30000);
                        }
                    }
                    
                    await goBackToArchive();
                    continue;
                }

                // Save both tables and fixtures in the original schema structure
                seasonData = {
                    'Overview': {
                        'default': tablesData
                    },
                    'Fixtures': {
                        'Full listing': fixturesData
                    }
                };

                leagueData.push({
                    season: seasonName,
                    extractedAt: new Date().toISOString(),
                    data: seasonData
                });

                // --- INCREMENTAL SAVE ---
                try {
                    insertSeason.run(leagueName, seasonName, JSON.stringify(seasonData), new Date().toISOString());
                    console.log(`💾 Incrementally saved ${seasonName} to database.`);
                } catch (err) {
                    console.error(`❌ Failed to save incremental JSON data to DB:`, err.message);
                }

                // --- LIVE PARSE AND SAVE TO STANDINGS AND FIXTURES ---
                try {
                    console.log(`      ↳ Parsing and live-saving standings & fixtures...`);
                    const rowObj = { league_name: leagueName, season_name: seasonName };
                    
                    // Standings
                    let standingsParsed = 0;
                    if (tablesData && tablesData.tables) {
                        for (const line of tablesData.tables) {
                            const std = parseDOMStandingsLine(rowObj, line);
                            if (std) {
                                insertStanding.run(
                                    std.league_name, std.season_name, std.position, std.team_name,
                                    std.played, std.won, std.drawn, std.lost,
                                    std.goals_scored, std.goals_conceded, std.goal_difference, std.points
                                );
                                standingsParsed++;
                            }
                        }
                    }

                    // Fixtures
                    let fixturesParsed = 0;
                    if (fixturesData && fixturesData.tables) {
                        for (const line of fixturesData.tables) {
                            const match = parseDOMMatchLine(rowObj, line);
                            if (match) {
                                insertAnalytics.run(
                                    match.league_name, match.season_name, match.match_time, match.home_team, match.away_team,
                                    match.ht_home_score, match.ht_away_score, match.home_score, match.away_score, null
                                );
                                fixturesParsed++;
                            }
                        }
                    }
                    console.log(`      ↳ Live-saved ${standingsParsed} standings rows and ${fixturesParsed} match fixtures to league_standings and fixtures.`);
                } catch (liveErr) {
                    console.error(`      ⚠️ Failed during live-save:`, liveErr.message);
                }

                // --- DATABASE PRUNING (MAX 70 SEASONS) ---
                pruneOldSeasons(db, 70);

                // --- FOOLPROOF BACK NAVIGATION ---
                console.log(`⬅️ Navigating back to the Archive list...`);
                await ensureInternet();
                    let returned = await page.evaluate(() => {
                        const els = Array.from(document.querySelectorAll('a, button, div, span'));
                    // We look for the main Archive tab or a Back button
                    let archiveTab = els.find(e => e.textContent.trim().toLowerCase() === 'archive' && e.offsetParent !== null && e.textContent.trim().length < 20);
                    if (archiveTab) {
                        archiveTab.click();
                        return true;
                    }
                    return false;
                });

                if (returned) {
                    console.log(`✅ Successfully clicked Archive tab to return!`);
                    await delay(3500); // Give it plenty of time to render the list
                } else {
                    console.log(`🛑 Could not find Archive tab to go back. Attempting emergency reset...`);
                    await ensureInternet(); await page.goto('https://st-cdn001.akamaized.net/bet9javirtuals/en/1', { waitUntil: 'networkidle2' });
                    await delay(5000);
                    break; // break the seasons loop because we lost our place in the 'Show more' list
                }
            }
        }

        console.log(`\n🎉 All leagues processed successfully!`);
        
        if (isHeadless) {
            console.log("🏁 Headless archive scraping completed successfully. Exiting process.");
            if (page && page.browser) {
                try { await page.browser().close(); } catch (e) {}
            }
            process.exit(0);
        }

        // Start monitoring for new seasons every 5 minutes (GUI / interactive mode)
        const checkIntervalMs = 5 * 60 * 1000; // 5 minutes
        const knownSeasons = new Set(leagueData.map(s => s.season));
        console.log(`🕒 Monitoring for new seasons every 5 minutes...`);
        while (true) {
            await delay(checkIntervalMs);
            await ensureInternet(); await page.reload({ waitUntil: 'networkidle2' });
            // Retrieve list of season names from archive page
            const seasonElements = await page.$$eval('a', els => els.map(e => e.textContent.trim()));
            const newSeasons = seasonElements.filter(name => name && !knownSeasons.has(name));
            if (newSeasons.length > 0) {
                console.log(`✨ New season(s) detected: ${newSeasons.join(', ')}. Restarting scraper...`);
                newSeasons.forEach(ns => knownSeasons.add(ns));
                // Return to archive start and re-run scraper to capture new data
                await goBackToArchive();
                await runVirtualFootballScraper();
                return; // exit monitoring after restart
            } else {
                console.log(`⏳ No new seasons yet. Will check again in 5 minutes...`);
            }
        }

    } catch (error) {
        console.error(`\n❌ Fatal Error:`, error);
        process.exit(1);
    }
}

runVirtualFootballScraper();
