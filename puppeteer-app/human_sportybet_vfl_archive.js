const fs = require('fs');
const path = require('path');

// Force desktop device argument before loading configuration
if (!process.argv.some(arg => arg.startsWith('--device='))) {
    process.argv.push('--device=desktop');
}
const config = require('./config');
const Database = require('better-sqlite3');
const dns = require('dns');

const delay = (ms) => new Promise(r => setTimeout(r, ms));

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

let saveDir = path.join(require('os').homedir(), 'Desktop', 'Virtual_Football_Archives');
try {
    const settingsPath = path.join(__dirname, 'bot_settings.json');
    if (fs.existsSync(settingsPath)) {
        const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
        if (settings.outputDir) {
            saveDir = settings.outputDir;
        }
    }
} catch (e) {
    console.error('Failed to load bot settings:', e);
}

if (!fs.existsSync(saveDir)) {
    fs.mkdirSync(saveDir, { recursive: true });
}

// Set up live logging to a txt file
const logFilePath = path.join(saveDir, `live_scraper_log_sportybet_${Date.now()}.txt`);
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

// Team mappings from abbreviations to clean names
const TEAM_MAP = {
    'ARS': 'Arsenal',
    'AST': 'Aston Villa',
    'BOU': 'Bournemouth',
    'BHA': 'Brighton',
    'BRN': 'Brentford',
    'BUR': 'Burnley',
    'CHE': 'Chelsea',
    'CRY': 'Crystal Palace',
    'EVE': 'Everton',
    'FUL': 'Fulham',
    'LEE': 'Leeds',
    'LIV': 'Liverpool',
    'MCI': 'Manchester City',
    'MUN': 'Manchester United',
    'NEW': 'Newcastle',
    'FOR': 'Nottm Forest',
    'SUN': 'Sunderland',
    'TOT': 'Tottenham',
    'WOL': 'Wolves',
    'WHU': 'West Ham'
};

function formatTeamName(fifaCode, rawName) {
    if (fifaCode && TEAM_MAP[fifaCode]) {
        return TEAM_MAP[fifaCode];
    }
    if (rawName) {
        return rawName.split('_')
                     .map(word => word.charAt(0).toUpperCase() + word.slice(1))
                     .join(' ');
    }
    return fifaCode || '';
}

async function runSportybetArchiveScraper() {
    console.log(`\n==================================================`);
    console.log(`🤖 STARTING SPORTYBET VFL ARCHIVE SCRAPER`);
    console.log(`==================================================\n`);
    console.log(`📝 Live logs are being saved to: ${logFilePath}\n`);

    const dbPath = path.join(saveDir, 'sportybet_archive.db');
    const db = new Database(dbPath);
    console.log(`🗄️ Initializing SQLite Database at: ${dbPath}`);

    // Create sportybet tables & views
    db.exec(`
        CREATE TABLE IF NOT EXISTS sporty_fixtures (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            league_name TEXT,
            season_name TEXT,
            week INTEGER,
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
    `);
    try {
        db.exec("ALTER TABLE sporty_fixtures ADD COLUMN bookmaker_odds TEXT");
    } catch (e) {}

    try { db.exec("DROP VIEW IF EXISTS sporty_betting_analytics;"); } catch (e) {}
    db.exec(`
        CREATE VIEW IF NOT EXISTS sporty_betting_analytics AS
        SELECT 
            id,
            league_name,
            season_name,
            week,
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
        FROM sporty_fixtures;
    `);

    const insertFixture = db.prepare(`
        INSERT OR REPLACE INTO sporty_fixtures (
            league_name, season_name, week, match_time, home_team, away_team,
            ht_home_score, ht_away_score, home_score, away_score, bookmaker_odds
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    let newMatchesScraped = 0;
    const targetMatches = 10000;
    let currentMatches = db.prepare("SELECT COUNT(*) as count FROM sporty_fixtures").get().count;
    let sessionAttempt = 0;
    const maxSessions = 50;
    let consecutiveNoProgressSessions = 0;

    console.log(`📊 Current DB matches: ${currentMatches}. Target matches: ${targetMatches}`);

    while (currentMatches < targetMatches && sessionAttempt < maxSessions) {
        sessionAttempt++;
        const initialMatchesThisSession = currentMatches;
        console.log(`\n==================================================`);
        console.log(`🔄 STARTING SCRAPING SESSION #${sessionAttempt} (DB Matches: ${currentMatches}/${targetMatches})`);
        console.log(`==================================================\n`);

        let page = null;
        try {
            console.log("🚀 Launching anti-detect browser...");
            const isHeadless = process.argv.includes("--headless=true") || process.argv.includes("--headless");
            page = await config.connect({ headless: isHeadless, provider: "sportybet" });
            await page.setViewport({ width: 966, height: 714 });

            // Intercept WebSocket frames to receive results data
            const mainSession = await page.target().createCDPSession();
            await mainSession.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
            
            mainSession.on("Target.attachedToTarget", async ({ sessionId }) => {
                const childSession = mainSession.connection().session(sessionId);
                if (!childSession) return;
                try {
                    await childSession.send("Network.enable");
                    childSession.on("Network.webSocketFrameReceived", ({ response }) => {
                        try {
                            const payload = response.payloadData;
                            if (!payload || !payload.startsWith("{")) return;
                            const parsed = JSON.parse(payload);
                            if (parsed.type === "RESPONSE" && parsed.res && 
                                (parsed.res.resource === "/eventBlocks/find" || parsed.res.resource === "/eventBlocks/event/result")) {
                                const blocks = parsed.res.body || [];
                                if (!Array.isArray(blocks)) return;

                                for (const block of blocks) {
                                    if (block.playlistId !== 41104) continue;
                                    if (!block.events) continue;

                                    const week = block.data?.matchDay || block.data?.weekDay || block.data?.legOrd || 0;
                                    const eventTime = block.eventTime || "";
                                    
                                    const seasonBase = block.eBlockId - week;
                                    const seasonName = `Season ${seasonBase}`;

                                    for (const event of block.events) {
                                        if (!event.data || !event.data.participants || event.data.participants.length < 2) continue;
                                        
                                        const homeRaw = event.data.participants[0];
                                        const awayRaw = event.data.participants[1];
                                        
                                        const homeTeam = formatTeamName(homeRaw.fifaCode, homeRaw.name);
                                        const awayTeam = formatTeamName(awayRaw.fifaCode, awayRaw.name);

                                        const scores = event.result?.finalOutcome || event.result?.data?.finalOutcome;
                                        if (!scores || scores.length < 4) continue;

                                        const htHome = parseInt(scores[0], 10);
                                        const htAway = parseInt(scores[1], 10);
                                        const homeScore = htHome + parseInt(scores[2], 10);
                                        const awayScore = htAway + parseInt(scores[3], 10);

                                        const odds = event.data?.oddValues || event.data?.odds;
                                        const parsedOdds = (odds && odds.length >= 58) ? {
                                            home: parseFloat(odds[0]) || null,
                                            away: parseFloat(odds[1]) || null,
                                            draw: parseFloat(odds[2]) || null,
                                            x2: parseFloat(odds[12]) || null,
                                            dc12: parseFloat(odds[13]) || null,
                                            dc1x: parseFloat(odds[14]) || null,
                                            ng: (odds.length > 50) ? (parseFloat(odds[50]) || null) : null,
                                            gg: (odds.length > 51) ? (parseFloat(odds[51]) || null) : null,
                                            under05: (odds.length > 52) ? (parseFloat(odds[52]) || null) : null,
                                            over05: (odds.length > 53) ? (parseFloat(odds[53]) || null) : null,
                                            under15: (odds.length > 54) ? (parseFloat(odds[54]) || null) : null,
                                            over15: (odds.length > 55) ? (parseFloat(odds[55]) || null) : null,
                                            under25: (odds.length > 56) ? (parseFloat(odds[56]) || null) : null,
                                            over25: (odds.length > 57) ? (parseFloat(odds[57]) || null) : null,
                                            under35: (odds.length > 58) ? (parseFloat(odds[58]) || null) : null,
                                            over35: (odds.length > 59) ? (parseFloat(odds[59]) || null) : null,
                                            under45: (odds.length > 60) ? (parseFloat(odds[60]) || null) : null,
                                            over45: (odds.length > 61) ? (parseFloat(odds[61]) || null) : null,
                                            halftimeFulltime: {
                                                htft11: parseFloat(odds[3]) || null,
                                                htft1X: parseFloat(odds[4]) || null,
                                                htft12: parseFloat(odds[5]) || null,
                                                htftX1: parseFloat(odds[6]) || null,
                                                htftXX: parseFloat(odds[7]) || null,
                                                htftX2: parseFloat(odds[8]) || null,
                                                htft21: parseFloat(odds[9]) || null,
                                                htft2X: parseFloat(odds[10]) || null,
                                                htft22: parseFloat(odds[11]) || null
                                            }
                                        } : null;

                                        const res = insertFixture.run(
                                            "Sportybet England",
                                            seasonName,
                                            week,
                                            eventTime,
                                            homeTeam,
                                            awayTeam,
                                            htHome,
                                            htAway,
                                            homeScore,
                                            awayScore,
                                            parsedOdds ? JSON.stringify(parsedOdds) : null
                                        );

                                        if (res.changes > 0) {
                                            newMatchesScraped++;
                                        }
                                    }
                                }
                            }
                        } catch (e) {}
                    });
                } catch (e) {}
            });

            console.log("🌐 Navigating to Sportybet Virtuals...");
            await ensureInternet();
            await page.goto("https://www.sportybet.com/ng/virtual/", { waitUntil: "domcontentloaded", timeout: 45000 });
            
            console.log("⏳ Waiting 15s for Golden Race iframe to load...");
            await delay(15000);

            const frames = page.frames();
            const iframe = frames.find(f => f.url().includes("virtustec.com") || f.url().includes("golden-race"));
            if (!iframe) {
                console.log("❌ Could not find Golden Race iframe in this session!");
                continue;
            }
            console.log("✅ Found Golden Race iframe! URL:", iframe.url());

            console.log("🖱️ Clicking Football League and England...");
            try {
                await iframe.evaluate(async () => {
                    const delay = (ms) => new Promise(r => setTimeout(r, ms));
                    const triggerClick = (el) => {
                        if (!el) return;
                        try {
                            el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window }));
                            el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: window }));
                            el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
                        } catch(e) { el.click(); }
                    };

                    const isSidebarElement = (el) => {
                        if (!el) return false;
                        return el.closest("#game_league") || 
                               el.closest('[id*="playlist"]') || 
                               el.closest(".sidebar") || 
                               el.closest(".menu") || 
                               el.closest(".navigation") || 
                               el.closest(".playlist") ||
                               el.closest(".playlist-container");
                    };

                    let englandEl = document.querySelector("#playlist_41104 > a") || 
                                    document.querySelector("#playlist_41104 a") ||
                                    Array.from(document.querySelectorAll('a[title="England"]')).find(isSidebarElement);

                    if (!englandEl) {
                        const toggler = document.querySelector("#game_league > a") ||
                                        document.querySelector('a.toggler[title="Football League"]') ||
                                        document.querySelector("a.toggler.gr-icon-league") ||
                                        Array.from(document.querySelectorAll("a.toggler")).find(el => el.textContent.trim().toLowerCase().includes("football league"));
                        if (toggler && (toggler.classList.contains("collapsed") || (toggler.className || "").toString().includes("collapsed"))) {
                            triggerClick(toggler);
                            await delay(2000);
                        }
                    }

                    englandEl = document.querySelector("#playlist_41104 > a") || 
                                document.querySelector("#playlist_41104 a") ||
                                Array.from(document.querySelectorAll('a[title="England"]')).find(isSidebarElement);

                    if (englandEl) {
                        triggerClick(englandEl);
                        await delay(4000);
                    }
                });

                console.log("[Stealth Scraper] Simulating human keypress navigation...");
                const iframeElement = await page.$('iframe[src*="virtustec.com"], iframe[src*="golden-race"]');
                if (iframeElement) {
                    await iframeElement.focus();
                    await delay(500);

                    for (let i = 0; i < 4; i++) {
                        await page.keyboard.press("ArrowLeft");
                        await delay(100 + Math.random() * 50);
                    }
                    await delay(500);

                    for (let i = 0; i < 45; i++) {
                        await page.keyboard.press("ArrowDown");
                        await delay(50 + Math.random() * 30);
                    }
                    await delay(500);

                    for (let i = 0; i < 45; i++) {
                        await page.keyboard.press("ArrowUp");
                        await delay(50 + Math.random() * 30);
                    }
                    await delay(500);
                }
            } catch (journeyErr) {
                console.warn("⚠️ Warning during journey steps:", journeyErr.message);
            }

            console.log("Waiting for Results History tab inside iframe...");
            const h2hLinkExists = await iframe.waitForSelector("#game_league_results-history > a", { timeout: 15000 });
            if (h2hLinkExists) {
                console.log("Clicking Results History tab...");
                const clicked = await iframe.evaluate(() => {
                    const el = document.querySelector("#game_league_results-history > a");
                    if (el) {
                        el.click();
                        return true;
                    }
                    return false;
                });
                
                if (clicked) {
                    console.log("Successfully opened Results History. Waiting 5s...");
                    await delay(5000);

                    let clickCount = 0;
                    let noIncreaseCount = 0;
                    let lastMatchesCount = currentMatches;

                    while (currentMatches < targetMatches) {
                        await ensureInternet();
                        
                        let clickedLoadMore = false;
                        for (let retry = 0; retry < 10; retry++) {
                            clickedLoadMore = await iframe.evaluate(() => {
                                const btn = Array.from(document.querySelectorAll("button")).find(b => b.textContent.includes("Load more events"));
                                if (btn && !btn.disabled && btn.style.display !== "none") {
                                    btn.scrollIntoView({ behavior: "smooth", block: "center" });
                                    btn.click();
                                    return true;
                                }
                                return false;
                            });
                            if (clickedLoadMore) break;
                            await delay(1000);
                        }
                        
                        if (clickedLoadMore) {
                            clickCount++;
                            await delay(3500);
                            const countRow = db.prepare("SELECT COUNT(*) as count FROM sporty_fixtures").get();
                            currentMatches = countRow.count;
                            console.log(`   ↳ [Session ${sessionAttempt} | Click ${clickCount}] Clicked 'Load more events' (Total matches in DB: ${currentMatches}/${targetMatches})`);
                            
                            if (currentMatches === lastMatchesCount) {
                                noIncreaseCount++;
                                if (noIncreaseCount >= 5) {
                                    console.log(`ℹ️ Database match count did not increase for 5 consecutive clicks (stuck at ${currentMatches}). Closing browser to restart session...`);
                                    break;
                                }
                            } else {
                                noIncreaseCount = 0;
                                lastMatchesCount = currentMatches;
                            }
                        } else {
                            console.log(`⚠️ 'Load more events' button not found. Closing browser and restarting scraper session to reach ${targetMatches} matches (Current DB: ${currentMatches}/${targetMatches})...`);
                            break;
                        }
                    }
                } else {
                    console.error("❌ Failed to click Results History tab.");
                }
            } else {
                console.error("❌ Results History tab selector not found inside iframe.");
            }

        } catch (e) {
            console.error("❌ Scraper error occurred in session:", e);
        } finally {
            if (page && page.browser) {
                try { await page.browser().close(); } catch(err) {}
            }
            await delay(3000);
            
            const endMatchesThisSession = db.prepare("SELECT COUNT(*) as count FROM sporty_fixtures").get().count;
            currentMatches = endMatchesThisSession;

            if (currentMatches >= targetMatches) {
                console.log(`✅ Reached target of ${targetMatches} matches! Stopping pagination.`);
                break;
            }

            if (endMatchesThisSession === initialMatchesThisSession) {
                consecutiveNoProgressSessions++;
                if (consecutiveNoProgressSessions >= 5) {
                    console.log(`ℹ️ Match count did not increase across 5 consecutive browser sessions (stuck at ${currentMatches}). Ending scraper.`);
                    break;
                }
            } else {
                consecutiveNoProgressSessions = 0;
            }
        }
    }

    const finalCount = db.prepare("SELECT COUNT(*) as count FROM sporty_fixtures").get().count;
    console.log(`\n==================================================`);
    console.log(`🏁 SPORTYBET SCRAPING COMPLETED`);
    console.log(`✅ Matches successfully stored/updated: ${finalCount}`);
    console.log(`📝 Live logs: ${logFilePath}`);
    console.log(`==================================================\n`);
}

runSportybetArchiveScraper();
