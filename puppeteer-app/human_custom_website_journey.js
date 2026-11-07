const fs = require('fs');
const path = require('path');
const config = require('./config');
const fetch = require('node-fetch');

// Parse arguments
const args = process.argv.slice(2);
const userDataDirArg = args.find(arg => arg.startsWith('--user-data-dir='));
const deviceArg = args.find(arg => arg.startsWith('--device='))?.split('=')[1] || 'desktop';

let profileId = 'Demo Test';
let family = 'DEFAULT';

if (userDataDirArg) {
    const fullPath = userDataDirArg.split('=')[1];
    const pathParts = fullPath.split(/[\\/]/);
    profileId = pathParts[pathParts.length - 1];
    family = pathParts[pathParts.length - 2];
}

console.log(`\n========================================`);
console.log(`🌐 STARTING CUSTOM WEBSITE & AD JOURNEY`);
console.log(`👤 Profile Name: ${profileId}`);
console.log(`📂 Bot Family: ${family}`);
console.log(`📱 Device Footprint: ${deviceArg}`);
console.log(`========================================\n`);

// Load personality and global configuration settings
const personalitiesPath = path.resolve(__dirname, 'personalities.json');
let personalityData = {
    description: "general explorer",
    mode: "auto",
    settings: {}
};

if (fs.existsSync(personalitiesPath)) {
    try {
        const raw = fs.readFileSync(personalitiesPath, 'utf8');
        const allPersonalities = JSON.parse(raw);
        const key = `${family}/${profileId}`;
        if (allPersonalities[key]) {
            personalityData = allPersonalities[key];
            console.log(`✅ Loaded personality settings for profile: ${key}`);
        } else {
            console.warn(`⚠️ Profile "${key}" not found in personalities.json. Using fallback default.`);
        }
    } catch (e) {
        console.error('Error reading personalities.json:', e.message);
    }
}

// Load global configuration details to get defaults
let globalConfig = { automation: {} };
const configPath = path.resolve(__dirname, 'config.json');
if (fs.existsSync(configPath)) {
    try {
        globalConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch (e) {}
}

const description = personalityData.description || 'general explorer';
const email = personalityData.email || `${profileId.toLowerCase().replace(/[^a-z0-9]/g, '')}@gmail.com`;
const age = personalityData.age || 28;

// Resolve Custom Settings with defaults fallback
const customWebsiteUrl = personalityData.settings?.customWebsiteUrl || globalConfig.automation?.customWebsiteUrl || '';
const pageViewsCount = parseInt(personalityData.settings?.customWebsitePageViews || globalConfig.automation?.customWebsitePageViews || 3);
const exploreMinSeconds = parseInt(personalityData.settings?.customWebsiteInteractionMin || globalConfig.automation?.customWebsiteInteractionMin || 30);
const exploreMaxSeconds = parseInt(personalityData.settings?.customWebsiteInteractionMax || globalConfig.automation?.customWebsiteInteractionMax || 60);
const adClickChance = parseInt(personalityData.settings?.customWebsiteAdClickChance ?? globalConfig.automation?.customWebsiteAdClickChance ?? 30);
const adInteractMin = parseInt(personalityData.settings?.customWebsiteAdInteractMin || globalConfig.automation?.customWebsiteAdInteractMin || 45);
const adInteractMax = parseInt(personalityData.settings?.customWebsiteAdInteractMax || globalConfig.automation?.customWebsiteAdInteractMax || 90);

console.log(`📋 Resolved Journey Parameters:`);
console.log(`   - Target Website URL: ${customWebsiteUrl || '[None - DeepSeek Dynamic Selection]'}`);
console.log(`   - Page Views Count: ${pageViewsCount}`);
console.log(`   - Dwell Time per Page: ${exploreMinSeconds}-${exploreMaxSeconds} sec`);
console.log(`   - Ad Click Probability: ${adClickChance}%`);
console.log(`   - Ad Dwell Duration: ${adInteractMin}-${adInteractMax} sec`);

// DeepSeek query helper
async function askDeepSeek(systemPrompt, userPrompt) {
    if (!config.deepSeekConfig || !config.deepSeekConfig.apiKey || config.deepSeekConfig.apiKey.includes('sk-0e2b915f407e4fc0bf70b3')) {
        console.warn('⚠️ DeepSeek API key not configured or using default dummy key. Skipping DeepSeek request and relying on fallback.');
        return null;
    }
    try {
        const response = await fetch(`${config.deepSeekConfig.endpoint}/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${config.deepSeekConfig.apiKey}`
            },
            body: JSON.stringify({
                model: 'deepseek-chat',
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: userPrompt }
                ],
                temperature: 0.6,
                response_format: { type: 'json_object' }
            }),
            timeout: 12000
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const resJson = await response.json();
        const content = resJson.choices[0].message.content.trim();
        return JSON.parse(content.replace(/```json|```/g, ''));
    } catch (e) {
        console.warn('⚠️ DeepSeek request failed:', e.message);
        return null;
    }
}

// Generate URL using DeepSeek if no custom URL was configured
async function generateFallbackUrl() {
    console.log('🧠 Querying DeepSeek for custom target URL matching personality...');
    const plan = await askDeepSeek(
        `You are a human simulation engine. Choose one popular website URL based on the persona interests.`,
        `Persona Bio: "${description}"
Return a JSON object: {"websiteUrl": "https://example.com"}`
    );
    if (plan && plan.websiteUrl) {
        console.log(`✨ AI Selected Fallback Website: ${plan.websiteUrl}`);
        return plan.websiteUrl;
    }
    // Static fallbacks
    if (description.toLowerCase().includes('trader') || description.toLowerCase().includes('finance')) {
        return 'https://www.tradingview.com';
    }
    if (description.toLowerCase().includes('tech') || description.toLowerCase().includes('developer')) {
        return 'https://dev.to';
    }
    return 'https://news.ycombinator.com';
}

// Local filters and xpath generation for clean navigation links
async function scanForInternalLinks(page) {
    try {
        return await page.evaluate(() => {
            const currentDomain = window.location.hostname;
            const links = Array.from(document.querySelectorAll('a'));
            const isVisible = (el) => {
                const rect = el.getBoundingClientRect();
                return rect.width > 0 && rect.height > 0 && window.getComputedStyle(el).display !== 'none' && window.getComputedStyle(el).visibility !== 'hidden';
            };
            const results = [];
            links.forEach((l, idx) => {
                if (!isVisible(l)) return;
                const href = l.getAttribute('href');
                if (!href) return;
                
                const hrefLower = href.toLowerCase();
                if (hrefLower.startsWith('#') || hrefLower.startsWith('javascript:') || hrefLower.startsWith('mailto:') || hrefLower.startsWith('tel:')) return;
                
                let targetUrl = '';
                try {
                    const parsedUrl = new URL(href, window.location.href);
                    if (parsedUrl.hostname !== currentDomain) return; // external link
                    targetUrl = parsedUrl.href;
                } catch(e) {
                    return;
                }
                
                const textLower = (l.innerText || '').toLowerCase().trim();
                const pathLower = new URL(targetUrl).pathname.toLowerCase();
                const dangerPatterns = ['login', 'logout', 'signout', 'signin', 'admin', 'delete', 'remove', 'wp-admin', 'wp-login', 'destroy', 'cancel', 'subscribe'];
                
                if (dangerPatterns.some(pat => textLower.includes(pat) || pathLower.includes(pat))) {
                    return;
                }
                
                if (textLower.length < 2 && !l.querySelector('img')) return;
                
                let selector = '';
                if (l.id) {
                    selector = `#${l.id}`;
                } else {
                    selector = `a:nth-of-type(${idx + 1})`;
                }
                
                results.push({
                    tempId: `link_${idx}`,
                    selector,
                    href: targetUrl,
                    text: textLower.substring(0, 100) || '[Image/Icon Link]'
                });
            });
            return results;
        });
    } catch (e) {
        return [];
    }
}

// Ask AI to pick next link to avoid honeypots or boring links
async function selectNextLink(page, candidates) {
    if (candidates.length === 0) return null;
    if (candidates.length === 1) return candidates[0];
    
    // Choose up to 12 candidates to prevent context overflow
    const subset = candidates.slice(0, 12);
    const serialized = subset.map(c => ({ tempId: c.tempId, text: c.text, path: new URL(c.href).pathname }));
    
    const systemPrompt = `You are an AI browsing simulation logic system. Review the candidate page links and pick one that is a standard content or post page. Reject login, signup, help, terms, or external sites.`;
    const userPrompt = `Personality Bio: "${description}"
Candidates:
${JSON.stringify(serialized, null, 2)}
Return a JSON object: {"bestLinkId": "tempId_value"}`;
    
    const choice = await askDeepSeek(systemPrompt, userPrompt);
    if (choice && choice.bestLinkId) {
        const selected = candidates.find(c => c.tempId === choice.bestLinkId);
        if (selected) return selected;
    }
    // Fallback
    return candidates[Math.floor(Math.random() * candidates.length)];
}

// Scan for advertisement elements on target page
async function scanForAds(page) {
    try {
        return await page.evaluate(() => {
            const results = [];
            const adSelectors = [
                'ins.adsbygoogle',
                'iframe[src*="googleads"]',
                'iframe[src*="doubleclick"]',
                'iframe[id*="google_ads"]',
                'a[href*="googleadservices"]',
                'div[id*="ad-"]',
                'div[class*="ad-"]',
                'a[href*="mgid.com"]',
                'div[class*="native-ad"]',
                'div[class*="sponsored-"]',
                'a[href*="taboola.com"]'
            ];
            
            const isVisible = (el) => {
                const rect = el.getBoundingClientRect();
                return rect.width > 20 && rect.height > 20 && window.getComputedStyle(el).display !== 'none' && window.getComputedStyle(el).visibility !== 'hidden';
            };
            
            let idCounter = 0;
            adSelectors.forEach(sel => {
                const elList = Array.from(document.querySelectorAll(sel));
                elList.forEach(el => {
                    if (!isVisible(el)) return;
                    const txt = (el.innerText || '').toLowerCase();
                    if (txt.includes('admin') || txt.includes('login') || txt.includes('account')) return;
                    
                    let selector = '';
                    if (el.id) {
                        selector = `#${el.id}`;
                    } else {
                        const allSame = Array.from(document.querySelectorAll(sel));
                        const idx = allSame.indexOf(el);
                        selector = `${sel}:nth-of-type(${idx + 1})`;
                    }
                    
                    results.push({
                        tempId: `ad_${idCounter++}`,
                        selector,
                        tag: el.tagName.toLowerCase(),
                        width: el.getBoundingClientRect().width,
                        height: el.getBoundingClientRect().height,
                        text: el.innerText ? el.innerText.substring(0, 100) : '[Media Ad Frame]'
                    });
                });
            });
            return results;
        });
    } catch (e) {
        return [];
    }
}

// Click ad, switch tabs, return ad page
async function clickAdOrganically(page, adSelector) {
    const element = await page.$(adSelector);
    if (!element) return null;
    console.log(`🖱️ Simulating focus and mouse travel to ad container: ${adSelector}`);
    try {
        await page.evaluate((el) => { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); }, element);
        await new Promise(r => setTimeout(r, 1500 + Math.random() * 800));
        
        const rect = await page.evaluate((el) => {
            const r = el.getBoundingClientRect();
            return { x: r.left + r.width/2, y: r.top + r.height/2 };
        }, element);
        
        const browser = page.browser();
        const newTargetPromise = new Promise(resolve => browser.once('targetcreated', resolve));
        
        await smoothMoveBezier(page, rect.x, rect.y);
        await page.mouse.click(rect.x, rect.y);
        
        const newTarget = await Promise.race([
            newTargetPromise,
            new Promise((_, reject) => setTimeout(() => reject(new Error('Ad page target timeout')), 8000))
        ]).catch(() => null);
        
        if (newTarget) {
            const adPage = await newTarget.page();
            if (adPage) {
                console.log(`✨ Opened advertiser landing page: ${adPage.url()}`);
                return adPage;
            }
        }
        return null;
    } catch (e) {
        console.warn('⚠️ Failed to click ad organically:', e.message);
        return null;
    }
}

// Find deep link on advertiser page to simulate high quality conversion
async function findAdConversionLink(page) {
    try {
        return await page.evaluate(() => {
            const links = Array.from(document.querySelectorAll('a'));
            const targetKeywords = ['about', 'contact', 'product', 'service', 'pricing', 'feature', 'help', 'info', 'shop', 'store'];
            const isVisible = (el) => {
                const rect = el.getBoundingClientRect();
                return rect.width > 0 && rect.height > 0 && window.getComputedStyle(el).display !== 'none';
            };
            
            const candidates = links.filter(l => {
                if (!isVisible(l)) return false;
                const txt = (l.innerText || '').toLowerCase();
                const href = l.getAttribute('href') || '';
                try {
                    const parsed = new URL(href, window.location.href);
                    if (parsed.hostname !== window.location.hostname) return false;
                } catch(e) {
                    return false;
                }
                return targetKeywords.some(kw => txt.includes(kw) || href.toLowerCase().includes(kw));
            });
            
            if (candidates.length > 0) {
                const best = candidates[Math.floor(Math.random() * candidates.length)];
                if (best.id) return `#${best.id}`;
                const allSame = Array.from(document.querySelectorAll('a'));
                const idx = allSame.indexOf(best);
                return `a:nth-of-type(${idx + 1})`;
            }
            return null;
        });
    } catch(e) {
        return null;
    }
}

// Cubic Bezier Mouse Travel Algorithm with tremoring
async function smoothMoveBezier(page, endX, endY) {
    if (!global.lastMousePos) global.lastMousePos = { x: 0, y: 0 };
    const startX = global.lastMousePos.x;
    const startY = global.lastMousePos.y;
    
    const controlX1 = startX + (endX - startX) * 0.25 + (Math.random() - 0.5) * 100;
    const controlY1 = startY + (endY - startY) * 0.25 + (Math.random() - 0.5) * 100;
    const controlX2 = startX + (endX - startX) * 0.75 + (Math.random() - 0.5) * 100;
    const controlY2 = startY + (endY - startY) * 0.75 + (Math.random() - 0.5) * 100;
    
    const steps = 15 + Math.floor(Math.random() * 10);
    try {
        for (let i = 0; i <= steps; i++) {
            const t = i / steps;
            const x = (1-t)**3 * startX + 3*(1-t)**2 * t * controlX1 + 3*(1-t) * t**2 * controlX2 + t**3 * endX;
            const y = (1-t)**3 * startY + 3*(1-t)**2 * t * controlY1 + 3*(1-t) * t**2 * controlY2 + t**3 * endY;
            const tremorX = (Math.random() - 0.5) * 0.6;
            const tremorY = (Math.random() - 0.5) * 0.6;
            
            await page.mouse.move(x + tremorX, y + tremorY);
            
            await page.evaluate((cx, cy) => {
                const cursor = document.getElementById('golden-mouse');
                if (cursor) {
                    cursor.style.left = cx + 'px';
                    cursor.style.top = cy + 'px';
                }
            }, Math.round(x + tremorX), Math.round(y + tremorY)).catch(() => {});
            
            await new Promise(r => setTimeout(r, 12 + Math.random() * 10));
        }
        global.lastMousePos = { x: endX, y: endY };
    } catch (e) {}
}

// Organic reader scroll and click
async function scrollAndClick(page, elementHandle) {
    if (!elementHandle) return false;
    try {
        await page.evaluate((el) => { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); }, elementHandle);
        await new Promise(r => setTimeout(r, 1200 + Math.random() * 800));
        const rect = await page.evaluate((el) => {
            const r = el.getBoundingClientRect();
            return { x: r.left + r.width/2, y: r.top + r.height/2 };
        }, elementHandle);
        await smoothMoveBezier(page, rect.x, rect.y);
        await page.mouse.click(rect.x, rect.y);
        return true;
    } catch (e) {
        return false;
    }
}

// Organic Reading Highlight selection simulation
async function highlightTextOrganically(page) {
    try {
        const elementTextSelector = await page.evaluate(() => {
            const elements = Array.from(document.querySelectorAll('p, h1, h2, h3, article, span'));
            const visibleTextElements = elements.filter(el => {
                const rect = el.getBoundingClientRect();
                const visible = rect.width > 250 && rect.height > 20 && window.getComputedStyle(el).display !== 'none';
                return visible && el.innerText.length > 60;
            });
            if (visibleTextElements.length === 0) return null;
            const el = visibleTextElements[Math.floor(Math.random() * visibleTextElements.length)];
            el.setAttribute('data-target-highlight', 'true');
            return '[data-target-highlight="true"]';
        });
        
        if (!elementTextSelector) return;
        const element = await page.$(elementTextSelector);
        if (element) {
            const box = await element.boundingBox();
            if (box) {
                const startX = box.x + 10 + Math.random() * 20;
                const startY = box.y + 10 + Math.random() * 10;
                await smoothMoveBezier(page, startX, startY);
                
                await page.mouse.down();
                await new Promise(r => setTimeout(r, 200 + Math.random() * 200));
                
                const endX = startX + Math.min(box.width - 30, 150 + Math.random() * 200);
                const endY = startY + (Math.random() > 0.8 ? 22 : 0);
                await smoothMoveBezier(page, endX, endY);
                await page.mouse.up();
                
                console.log('📝 Simulating reading highlighting selection on paragraph.');
                await new Promise(r => setTimeout(r, 1200 + Math.random() * 1200));
                await page.mouse.click(box.x + box.width + 10, box.y + box.height + 10).catch(() => {});
            }
        }
        await page.evaluate(() => {
            const el = document.querySelector('[data-target-highlight="true"]');
            if (el) el.removeAttribute('data-target-highlight');
        }).catch(() => {});
    } catch (e) {}
}

async function explorePage(page) {
    try {
        const scroll = 180 + Math.random() * 450;
        await page.evaluate((s) => window.scrollBy({ top: s, behavior: 'smooth' }), scroll);
        await new Promise(r => setTimeout(r, 1000 + Math.random() * 1000));
        
        if (Math.random() < 0.25) {
            await highlightTextOrganically(page);
        } else {
            await smoothMoveBezier(page, 150 + Math.random() * 550, 150 + Math.random() * 350);
        }
    } catch (e) {}
}

async function handleConsent(page) {
    for (let attempt = 1; attempt <= 5; attempt++) {
        try {
            const consentBtn = await page.evaluateHandle(() => {
                const buttons = Array.from(document.querySelectorAll('button, [role="button"], a'));
                const consentTerms = ['accept all', 'i agree', 'accept', 'allow all', 'ok', 'got it'];
                return buttons.find(b => {
                    const text = b.innerText.toLowerCase().trim();
                    const rect = b.getBoundingClientRect();
                    const visible = rect.width > 0 && rect.height > 0 && window.getComputedStyle(b).display !== 'none';
                    return consentTerms.some(term => {
                        if (term === 'ok') return /\bok\b/.test(text);
                        return text.includes(term);
                    }) && visible;
                });
            });
            const btnEl = consentBtn.asElement();
            if (btnEl) {
                console.log('🖱️ Cookie consent banner detected, clicking...');
                await scrollAndClick(page, btnEl);
                await new Promise(r => setTimeout(r, 2000));
                return;
            }
        } catch (e) {}
        await new Promise(r => setTimeout(r, 800));
    }
}

// Swappable ad handler
async function handlePotentialAdClick(page) {
    const chance = Math.random() * 100;
    if (chance > adClickChance) {
        console.log(`🎲 Ad click probability evaluated: ${chance.toFixed(1)}% vs target ${adClickChance}%. Skipping ad clicks for this page.`);
        return false;
    }
    
    console.log('🔍 Locating advertising placements on page...');
    const ads = await scanForAds(page);
    if (ads.length === 0) {
        console.log('ℹ️ No active ad frames detected on this page.');
        return false;
    }
    
    // Choose the best ad using local metrics/DeepSeek choice
    console.log(`📢 Detected ${ads.length} ad candidates.`);
    const systemPrompt = `You are a simulated human browser logic component. Pick the advertisement element identifier to click.`;
    const userPrompt = `Ads: ${JSON.stringify(ads.slice(0, 8))}\nReturn JSON: {"bestAdId": "tempId"}`;
    const choice = await askDeepSeek(systemPrompt, userPrompt);
    let selectedAd = ads[0];
    if (choice && choice.bestAdId) {
        const found = ads.find(a => a.tempId === choice.bestAdId);
        if (found) selectedAd = found;
    }
    
    const adPage = await clickAdOrganically(page, selectedAd.selector);
    if (adPage) {
        // Deep engagement inside ad tab
        const dwellSeconds = adInteractMin + Math.floor(Math.random() * (adInteractMax - adInteractMin));
        console.log(`⏳ Browsing advertiser website. Target Dwell: ${dwellSeconds} seconds.`);
        const adEndTime = Date.now() + (dwellSeconds * 1000);
        
        let conversionClicked = false;
        while (Date.now() < adEndTime) {
            await explorePage(adPage);
            await new Promise(r => setTimeout(r, 4000 + Math.random() * 3000));
            
            // Try secondary internal conversion click halfway through
            if (!conversionClicked && Date.now() > (adEndTime - (dwellSeconds * 500))) {
                const secondaryLink = await findAdConversionLink(adPage);
                if (secondaryLink) {
                    console.log(`🔗 Clicking secondary advertiser link: ${secondaryLink}`);
                    const linkEl = await adPage.$(secondaryLink);
                    if (linkEl) {
                        await scrollAndClick(adPage, linkEl);
                        conversionClicked = true;
                        console.log('⏳ Exploring secondary page...');
                        await new Promise(r => setTimeout(r, 12000 + Math.random() * 5000));
                    }
                }
            }
        }
        
        console.log('🚪 Closing advertiser window.');
        await adPage.close();
        return true;
    }
    return false;
}

// Main execution process
async function executeCustomWebsiteJourney() {
    let browser;
    try {
        let targetUrl = customWebsiteUrl;
        if (!targetUrl) {
            targetUrl = await generateFallbackUrl();
        }
        
        console.log(`🌐 Initializing Puppeteer stealth connection...`);
        const headlessArg = args.includes('--headless') || args.find(arg => arg.startsWith('--headless='))?.split('=')[1] === 'true';
        const page = await config.connect({ headless: headlessArg });
        browser = page.browser();
        
        console.log(`🚀 Loading URL: ${targetUrl}`);
        await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 45000 }).catch(async () => {
            console.warn('⚠️ Networkidle2 timeout, falling back to domcontentloaded...');
            await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
        });
        
        await handleConsent(page);
        
        for (let viewIdx = 1; viewIdx <= pageViewsCount; viewIdx++) {
            console.log(`\n📄 [Page View ${viewIdx} of ${pageViewsCount}] URL: ${page.url()}`);
            
            // Explore current page
            const dwell = exploreMinSeconds + Math.floor(Math.random() * (exploreMaxSeconds - exploreMinSeconds));
            console.log(`⏳ Exploring page. Target Dwell: ${dwell} seconds.`);
            const pageEndTime = Date.now() + (dwell * 1000);
            while (Date.now() < pageEndTime) {
                await explorePage(page);
                await new Promise(r => setTimeout(r, 5000 + Math.random() * 4000));
            }
            
            // Ad click test
            await handlePotentialAdClick(page);
            
            // Navigate to next page if not the final view
            if (viewIdx < pageViewsCount) {
                console.log('🔍 Identifying internal site navigation links...');
                const links = await scanForInternalLinks(page);
                if (links.length === 0) {
                    console.log('⚠️ No internal navigation links found. Ending session early.');
                    break;
                }
                const chosenLink = await selectNextLink(page, links);
                if (chosenLink) {
                    console.log(`🔗 Navigating to: ${chosenLink.text} -> ${chosenLink.href}`);
                    const linkEl = await page.$(chosenLink.selector);
                    if (linkEl) {
                        await scrollAndClick(page, linkEl);
                        await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 25000 }).catch(() => {});
                        await handleConsent(page);
                    }
                }
            }
        }
        
        console.log('\n========================================');
        console.log('🎉 CUSTOM WEBSITE JOURNEY SUCCESSFULLY COMPLETE!');
        console.log('========================================\n');
        
        // Humanized browser close
        const dims = await page.evaluate(() => ({ w: window.innerWidth })).catch(() => ({ w: 1024 }));
        await smoothMoveBezier(page, dims.w - 18, 18);
        await new Promise(r => setTimeout(r, 800));
        await browser.close();
        process.exit(0);
        
    } catch (err) {
        console.error('❌ Custom Website Journey execution error:', err);
        if (browser) {
            try {
                await browser.close();
            } catch(e) {}
        }
        process.exit(1);
    }
}

global.lastMousePos = { x: 0, y: 0 };
executeCustomWebsiteJourney();
