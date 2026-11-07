if (!process.argv.some(arg => arg.startsWith('--device='))) {
    process.argv.push('--device=desktop');
}
if (!process.argv.some(arg => arg.startsWith('--browser='))) {
    process.argv.push('--browser=chrome');
}

const config = require('./config');
const fs = require('fs');
const path = require('path');

const delay = (ms) => new Promise(r => setTimeout(r, ms));

async function runPolandTest() {
    console.log('================================================================');
    console.log('🇵🇱 TESTING SPORTYBET & GOLDEN RACE FOOTBALL SCHEDULE FROM POLAND');
    console.log('================================================================\n');

    // 1. IP info
    try {
        const ipRes = await fetch('https://ipinfo.io/json').then(r => r.json());
        console.log(`📍 IP Verification: ${ipRes.ip} | Country: ${ipRes.country} | City: ${ipRes.city} | Org: ${ipRes.org}\n`);
    } catch (e) {
        console.warn('⚠️ Could not verify IP with ipinfo:', e.message);
    }

    console.log('🚀 Connecting to browser via config.connect (Desktop stealth mode)...');
    let page;
    try {
        page = await config.connect({ headless: true, provider: 'sportybet' });
    } catch (e) {
        console.error('❌ Failed to launch browser:', e);
        process.exit(1);
    }

    const browser = page.browser();
    await page.setViewport({ width: 1400, height: 900 });

    const diagnostics = {
        sportybetStatus: null,
        sportybetTitle: '',
        iframeFound: false,
        iframeUrl: null,
        virtustecResponses: [],
        virtustecErrors: [],
        webSocketEvents: [],
        scheduleFound: false,
        matchCount: 0,
        matches: [],
        leagues: [],
        geoBlocked: false,
        geoBlockReason: null
    };

    // Monitor HTTP responses
    page.on('response', (res) => {
        const url = res.url();
        const status = res.status();
        if (url.includes('sportybet.com/ng/virtual') && !diagnostics.sportybetStatus) {
            diagnostics.sportybetStatus = status;
        }
        if (url.includes('virtustec') || url.includes('golden-race') || url.includes('goldenrace')) {
            diagnostics.virtustecResponses.push({ url: url.substring(0, 100), status });
            if (status >= 400) {
                diagnostics.virtustecErrors.push({ url, status });
                console.log(`⚠️ HTTP Error on Golden Race asset: ${status} ${url}`);
            }
        }
    });

    // Monitor WebSockets across main page and iframes via CDP
    try {
        const mainSession = await page.target().createCDPSession();
        await mainSession.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });

        const setupNetworkListeners = async (session, label) => {
            try {
                await session.send('Network.enable');
                session.on('Network.webSocketCreated', ({ url }) => {
                    console.log(`🔌 [${label}] WebSocket Created: ${url}`);
                    diagnostics.webSocketEvents.push({ type: 'created', url, time: new Date().toISOString() });
                });
                session.on('Network.webSocketFrameReceived', ({ response }) => {
                    const payload = response?.payloadData || '';
                    if (payload.includes('eventBlocks') || payload.includes('events') || payload.includes('playlist')) {
                        console.log(`📥 [${label}] WS Fixture/Schedule Data received (${payload.length} chars)`);
                        try {
                            const parsed = JSON.parse(payload);
                            if (parsed.res?.resource) {
                                console.log(`   -> Resource: ${parsed.res.resource} | Blocks/Events: ${parsed.res.body?.length || 0}`);
                            }
                            diagnostics.webSocketEvents.push({
                                type: 'frameReceived',
                                resource: parsed?.res?.resource,
                                eventCount: parsed?.res?.body?.length || 0,
                                snippet: payload.substring(0, 150)
                            });
                        } catch (_) {
                            diagnostics.webSocketEvents.push({ type: 'frameReceived', snippet: payload.substring(0, 150) });
                        }
                    }
                });
                session.on('Network.webSocketClosed', () => {
                    console.log(`🔌 [${label}] WebSocket Closed`);
                });
            } catch (e) {
                // Ignore session attachment errors
            }
        };

        await setupNetworkListeners(mainSession, 'Main');

        mainSession.on('Target.attachedToTarget', async ({ sessionId }) => {
            const childSession = mainSession.connection().session(sessionId);
            if (childSession) {
                await setupNetworkListeners(childSession, 'Child/Iframe');
            }
        });
    } catch (e) {
        console.warn('⚠️ CDP WebSocket listener setup failed:', e.message);
    }

    // 2. Navigate to Sportybet virtual sports
    console.log('\n🌐 [1/5] Navigating to https://www.sportybet.com/ng/virtual/ ...');
    try {
        const response = await page.goto('https://www.sportybet.com/ng/virtual/', {
            waitUntil: 'domcontentloaded',
            timeout: 50000
        });
        if (response) {
            diagnostics.sportybetStatus = response.status();
        }
        diagnostics.sportybetTitle = await page.title();
        console.log(`✅ Page loaded with status: ${diagnostics.sportybetStatus} | Title: "${diagnostics.sportybetTitle}"`);
    } catch (err) {
        console.error('❌ Error navigating to SportyBet:', err.message);
    }

    // Check if there is a "Play Now" banner button to click
    try {
        await page.evaluate(() => {
            const btns = Array.from(document.querySelectorAll('button, a, div'));
            const playNowBtn = btns.find(b => (b.innerText || '').trim().toLowerCase() === 'play now');
            if (playNowBtn) {
                console.log('Clicking "Play Now" banner button...');
                playNowBtn.click();
            }
        });
    } catch (e) {}

    // 3. Wait for Golden Race iframe
    console.log('\n⏳ [2/5] Waiting 20 seconds for Golden Race iframe and Angular shell to initialize...');
    await delay(20000);

    const frames = page.frames();
    console.log(`🖼️ Detected ${frames.length} frame(s) on page.`);

    let goldenRaceFrame = frames.find(f => f.url().includes('virtustec.com') || f.url().includes('golden-race') || f.url().includes('goldenrace'));

    if (goldenRaceFrame) {
        diagnostics.iframeFound = true;
        diagnostics.iframeUrl = goldenRaceFrame.url();
        console.log(`✅ Golden Race iframe identified! URL: ${diagnostics.iframeUrl}`);
    } else {
        console.log('⚠️ Listing all frame URLs:');
        frames.forEach((f, idx) => console.log(`   [${idx}] ${f.url()}`));
    }

    // 4. Check main page text for regional restrictions
    const pageText = await page.evaluate(() => document.body ? document.body.innerText : '');
    if (/restricted|not available in your region|geographical restrictions|access denied|blocked/i.test(pageText)) {
        diagnostics.geoBlocked = true;
        diagnostics.geoBlockReason = 'Main page text contains restriction notice';
        console.log('🚨 GEO-BLOCK DETECTED on Main Page!');
    }

    // 5. Interact with Golden Race iframe
    if (goldenRaceFrame) {
        console.log('\n⚽ [3/5] Interacting with Golden Race frame to ensure Football schedule is open...');
        try {
            const interactRes = await goldenRaceFrame.evaluate(async () => {
                const delay = (ms) => new Promise(r => setTimeout(r, ms));
                const triggerClick = (el) => {
                    if (!el) return false;
                    try {
                        el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
                        el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
                        el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
                        return true;
                    } catch (e) {
                        try { el.click(); return true; } catch(_) { return false; }
                    }
                };

                const actionsTaken = [];

                // Check for sidebar / league selectors
                const toggler = document.querySelector('#game_league > a') ||
                                document.querySelector('a.toggler[title="Football League"]') ||
                                document.querySelector('a.toggler.gr-icon-league') ||
                                Array.from(document.querySelectorAll('a.toggler')).find(el => (el.textContent || '').toLowerCase().includes('football league'));

                if (toggler && (toggler.classList.contains('collapsed') || (toggler.className || '').toString().includes('collapsed'))) {
                    triggerClick(toggler);
                    actionsTaken.push('Clicked League Toggler');
                    await delay(1500);
                }

                // Click England / Premier League playlist if available
                const englandEl = document.querySelector('#playlist_41104 > a') ||
                                  document.querySelector('#playlist_41104 a') ||
                                  Array.from(document.querySelectorAll('a[title="England"]')).find(el => el.closest('#game_league') || el.closest('.sidebar'));
                if (englandEl) {
                    triggerClick(englandEl);
                    actionsTaken.push('Clicked England playlist #playlist_41104');
                }

                // Also check if any league tab exists (e.g. .playlist-container a, .competition-item)
                const anyLeague = document.querySelector('.playlist a, [class*="playlist"] a, [class*="league"] a');
                if (!englandEl && anyLeague) {
                    triggerClick(anyLeague);
                    actionsTaken.push('Clicked first available league item');
                }

                return { actionsTaken, htmlLength: document.body ? document.body.innerHTML.length : 0 };
            });
            console.log('   Interaction Result:', interactRes);
        } catch (e) {
            console.log('ℹ️ Frame interaction note:', e.message);
        }

        console.log('⏳ Waiting 15 seconds for schedule fixtures, odds, and countdowns to stream in...');
        await delay(15000);

        // 6. Inspect Golden Race DOM for Football schedule elements
        console.log('\n🔍 [4/5] Inspecting Golden Race frame DOM for schedule and football fixtures...');
        try {
            const frameInspection = await goldenRaceFrame.evaluate(() => {
                const bodyText = document.body ? document.body.innerText : '';
                
                // Match rows / event items
                const matchElements = document.querySelectorAll(
                    '.match, .event, .fixture, [class*="match-row"], [class*="event-row"], [class*="fixture"], tr.event, [class*="event-item"], [class*="event_item"], .game-event'
                );
                
                // League tabs / navigation
                const leagueElements = document.querySelectorAll(
                    '#game_league, [id*="playlist"], .playlist-item, [class*="league-name"], [class*="competition"]'
                );

                // Timers / Countdowns
                const timerElements = document.querySelectorAll(
                    '.timer, .countdown, [class*="timer"], [class*="countdown"], [class*="clock"], [class*="time"]'
                );

                // Odds buttons
                const oddsElements = document.querySelectorAll(
                    '.odd, [class*="odd"], [class*="button-odd"], .bet-btn, [class*="selection"]'
                );

                // Extract sample match text
                const sampleMatches = [];
                for (let i = 0; i < Math.min(matchElements.length, 8); i++) {
                    const el = matchElements[i];
                    const text = el.innerText.replace(/\s+/g, ' ').trim();
                    if (text.length > 5) sampleMatches.push(text);
                }

                // Extract leagues found
                const leaguesFound = [];
                leagueElements.forEach(el => {
                    const t = (el.innerText || el.getAttribute('title') || '').trim();
                    if (t && t.length > 2 && t.length < 40 && !leaguesFound.includes(t)) {
                        leaguesFound.push(t);
                    }
                });

                return {
                    bodyLength: bodyText.length,
                    bodySnippet: bodyText.substring(0, 600).replace(/\s+/g, ' '),
                    matchCount: matchElements.length,
                    leagueCount: leagueElements.length,
                    timerCount: timerElements.length,
                    oddsCount: oddsElements.length,
                    sampleMatches,
                    leaguesFound: leaguesFound.slice(0, 10),
                    isGeoBlockedInFrame: /restricted|not allowed|country not permitted|forbidden/i.test(bodyText)
                };
            });

            diagnostics.scheduleFound = frameInspection.matchCount > 0 || frameInspection.oddsCount > 0;
            diagnostics.matchCount = frameInspection.matchCount;
            diagnostics.matches = frameInspection.sampleMatches;
            diagnostics.leagues = frameInspection.leaguesFound;
            if (frameInspection.isGeoBlockedInFrame) {
                diagnostics.geoBlocked = true;
                diagnostics.geoBlockReason = 'Golden Race iframe text explicitly states country restriction';
            }

            console.log('📊 DOM Inspection Details:');
            console.log(`   - Frame Content Length: ${frameInspection.bodyLength} characters`);
            console.log(`   - Match / Fixture Elements Found: ${frameInspection.matchCount}`);
            console.log(`   - League Nav Elements Found: ${frameInspection.leagueCount}`);
            console.log(`   - Countdown Timer Elements: ${frameInspection.timerCount}`);
            console.log(`   - Odds / Betting Buttons: ${frameInspection.oddsCount}`);
            console.log(`   - Leagues Detected: ${frameInspection.leaguesFound.join(', ') || 'None'}`);
            console.log(`   - Frame Text Snippet: "${frameInspection.bodySnippet.substring(0, 300)}..."`);

            if (frameInspection.sampleMatches.length > 0) {
                console.log('\n⚽ Sample Scheduled Fixtures:');
                frameInspection.sampleMatches.forEach((m, idx) => {
                    console.log(`   ${idx + 1}. ${m}`);
                });
            }
        } catch (err) {
            console.warn('⚠️ Error reading Golden Race frame DOM:', err.message);
        }
    }

    // 7. Capture screenshot
    console.log('\n📸 [5/5] Capturing screenshot...');
    const screenshotPath = path.join(__dirname, 'poland_sportybet_test.png');
    try {
        await page.screenshot({ path: screenshotPath, fullPage: false });
        console.log(`✅ Screenshot saved to: ${screenshotPath}`);
    } catch (e) {
        console.warn('⚠️ Screenshot capture failed:', e.message);
    }

    // 8. Output Final Comprehensive Summary
    console.log('\n================================================================');
    console.log('🏁 SUMMARY TEST REPORT: SPORTYBET GOLDEN RACE FROM POLAND (PL)');
    console.log('================================================================');
    console.log(`• SportyBet Main Site Access: ${diagnostics.sportybetStatus === 200 ? '✅ SUCCESS (HTTP 200)' : 'Status: ' + diagnostics.sportybetStatus}`);
    console.log(`• Golden Race Iframe Loaded:  ${diagnostics.iframeFound ? '✅ YES (' + diagnostics.iframeUrl?.substring(0, 60) + '...)' : '❌ NO'}`);
    console.log(`• Golden Race HTTP Requests:  ${diagnostics.virtustecResponses.length} received, ${diagnostics.virtustecErrors.length} failed`);
    console.log(`• Live WebSocket Connection:  ${diagnostics.webSocketEvents.length > 0 ? '✅ CONNECTED (' + diagnostics.webSocketEvents.length + ' events)' : '❌ NO WS EVENTS'}`);
    console.log(`• Football Schedule Visible:  ${diagnostics.scheduleFound ? '✅ YES (' + diagnostics.matchCount + ' match rows detected)' : 'Status: ' + (diagnostics.webSocketEvents.some(e => e.type === 'frameReceived') ? '✅ YES (Receiving via WebSocket)' : 'Pending')}`);
    console.log(`• Geo-Restriction / Blocking: ${diagnostics.geoBlocked ? '🚨 DETECTED: ' + diagnostics.geoBlockReason : '✅ NONE (Fully accessible from Poland)'}`);
    console.log('================================================================\n');

    await browser.close();
}

runPolandTest().catch(err => {
    console.error('Fatal execution error:', err);
    process.exit(1);
});
