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
console.log(`🤖 STARTING DYNAMIC PERSONALITY VISIT`);
console.log(`👤 Profile Name: ${profileId}`);
console.log(`📂 Bot Family: ${family}`);
console.log(`📱 Device Footprint: ${deviceArg}`);
console.log(`========================================\n`);

// Load personality data
const personalitiesPath = path.resolve(__dirname, 'personalities.json');
let personalityData = {
    description: "forex trader",
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

const description = personalityData.description || 'general explorer';
const email = personalityData.email || `${profileId.toLowerCase().replace(/[^a-z0-9]/g, '')}@gmail.com`;
const age = personalityData.age || 28;

console.log(`👤 Profile Identity details:`);
console.log(`   - Bio/Description: "${description}"`);
console.log(`   - Email Address: ${email}`);
console.log(`   - Person Age: ${age}`);

// Query DeepSeek to get a targeted website URL and form filling details
async function generateWebsitePlan() {
    console.log('\n🧠 Querying DeepSeek for a personalized website visit plan...');
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
                    {
                        role: 'system',
                        content: `You are a behavioral psychologist and human simulation engine.
Based on the following persona:
- Name: ${profileId}
- Age: ${age}
- Email: ${email}
- Personality/Interests: ${description}

Select ONE popular, real, and safe website URL (starts with https://) that matches this profile. The website should be highly popular for this category and ideally contain some interactive elements or forms (e.g. contact form, inquiry form, subscription form, newsletter, signup, or feedback form).

Write a highly realistic form-filling message that aligns with this personality.

Return ONLY a raw JSON object with the following fields:
1. "websiteUrl": The selected real popular website URL (e.g. https://www.tradingview.com or a finance/tech/lifestyle blog or service page depending on interests).
2. "subject": A short subject line (3-6 words) for any form inquiry.
3. "message": A 1-3 sentence highly realistic, natural inquiry, feedback, or comment that this person would write.
4. "firstName": A realistic first name based on their profile name.
5. "lastName": A realistic last name based on their profile name (or empty if name is single).

Ensure no markdown tags, no backticks, and no extra text around the JSON object.`
                    }
                ],
                temperature: 0.85
            }),
            timeout: 15000
        });

        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const resJson = await response.json();
        const content = resJson.choices[0].message.content.trim().replace(/```json|```/g, '');
        const plan = JSON.parse(content);
        console.log('✨ DeepSeek custom visit plan successfully generated:', plan);
        return plan;
    } catch (err) {
        console.error('⚠️ DeepSeek generation failed. Falling back to default plan.', err.message);
        
        let websiteUrl = 'https://news.ycombinator.com';
        let subject = 'Connecting with the community';
        let message = 'Really love the articles and insights shared here. Keep up the amazing work!';
        
        if (description.toLowerCase().includes('trader') || description.toLowerCase().includes('forex') || description.toLowerCase().includes('finance')) {
            websiteUrl = 'https://www.tradingview.com';
            subject = 'Platform feedback';
            message = 'Excellent analysis tools and trading charts. I spend a lot of time reviewing market ideas here.';
        } else if (description.toLowerCase().includes('tech') || description.toLowerCase().includes('geek') || description.toLowerCase().includes('developer')) {
            websiteUrl = 'https://dev.to';
            subject = 'Article feedback';
            message = 'Great developer community and extremely useful tech tutorials. Happy to be reading!';
        }

        const nameParts = profileId.split(' ');
        return {
            websiteUrl,
            subject,
            message,
            firstName: nameParts[0] || 'Demo',
            lastName: nameParts.slice(1).join(' ') || 'Test'
        };
    }
}

// Heuristic DOM form-scanner running inside browser (safe from context destruction)
async function scanForFormFields(page) {
    try {
        return await page.evaluate(() => {
            const inputs = Array.from(document.querySelectorAll('input, textarea, select'));
            const results = [];
            
            const getFieldText = (el) => {
                let text = '';
                if (el.placeholder) text += ' ' + el.placeholder;
                if (el.name) text += ' ' + el.name;
                if (el.id) text += ' ' + el.id;
                
                let label = null;
                if (el.id) {
                    label = document.querySelector(`label[for="${el.id}"]`);
                }
                if (!label) {
                    label = el.closest('label');
                }
                if (label) {
                    text += ' ' + label.innerText;
                }
                
                const parent = el.parentElement;
                if (parent) {
                    text += ' ' + parent.innerText;
                }
                
                return text.toLowerCase();
            };

            const isVisible = (el) => {
                const rect = el.getBoundingClientRect();
                return rect.width > 0 && rect.height > 0 && window.getComputedStyle(el).display !== 'none' && window.getComputedStyle(el).visibility !== 'hidden';
            };

            inputs.forEach(el => {
                if (!isVisible(el) || el.disabled || el.readOnly) return;
                
                const txt = getFieldText(el);
                const tagName = el.tagName.toLowerCase();
                const type = (el.getAttribute('type') || 'text').toLowerCase();
                
                // Build unique selector
                let selector = '';
                if (el.id) {
                    selector = `#${el.id}`;
                } else if (el.name) {
                    selector = `${tagName}[name="${el.name}"]`;
                } else {
                    const allSame = Array.from(document.querySelectorAll(tagName));
                    const idx = allSame.indexOf(el);
                    selector = `${tagName}:nth-of-type(${idx + 1})`;
                }

                // Heuristics:
                if (type === 'email' || txt.includes('email') || txt.includes('e-mail') || txt.includes('mail')) {
                    results.push({ type: 'email', selector });
                    return;
                }
                
                if (tagName === 'textarea' || txt.includes('message') || txt.includes('comment') || txt.includes('feedback') || txt.includes('body') || txt.includes('inquiry')) {
                    results.push({ type: 'message', selector });
                    return;
                }
                
                if (txt.includes('first name') || txt.includes('firstname') || txt.includes('first_name') || txt.includes('fname')) {
                    results.push({ type: 'firstName', selector });
                    return;
                }
                
                if (txt.includes('last name') || txt.includes('lastname') || txt.includes('last_name') || txt.includes('lname')) {
                    results.push({ type: 'lastName', selector });
                    return;
                }
                
                if (txt.includes('full name') || txt.includes('fullname') || txt.includes('full_name') || (txt.includes('name') && !txt.includes('company') && !txt.includes('card'))) {
                    results.push({ type: 'fullName', selector });
                    return;
                }
                
                if (type === 'number' && (txt.includes('age') || txt.includes('years'))) {
                    results.push({ type: 'age', selector });
                    return;
                }
                
                if (txt.includes('subject') || txt.includes('title') || txt.includes('topic')) {
                    results.push({ type: 'subject', selector });
                    return;
                }
            });

            return results;
        });
    } catch (e) {
        console.warn('⚠️ Form field scanning skipped due to page navigation or state change.');
        return [];
    }
}

// Find any visible consent checkboxes (like Accept Terms, Privacy Policy)
async function scanForConsentCheckboxes(page) {
    try {
        return await page.evaluate(() => {
            const inputs = Array.from(document.querySelectorAll('input[type="checkbox"]'));
            return inputs
                .filter(el => {
                    const rect = el.getBoundingClientRect();
                    const visible = rect.width > 0 && rect.height > 0 && window.getComputedStyle(el).display !== 'none';
                    const txt = (el.name || el.id || el.parentElement?.innerText || '').toLowerCase();
                    const isConsent = txt.includes('agree') || txt.includes('consent') || txt.includes('accept') || txt.includes('privacy') || txt.includes('terms');
                    return visible && !el.disabled && isConsent && !el.checked;
                })
                .map((el, i) => {
                    if (el.id) return `#${el.id}`;
                    if (el.name) return `input[type="checkbox"][name="${el.name}"]`;
                    return `input[type="checkbox"]:nth-of-type(${i + 1})`;
                });
        });
    } catch (e) {
        return [];
    }
}

// Scan for standard submit buttons
async function scanForSubmitButton(page) {
    try {
        return await page.evaluate(() => {
            const buttons = Array.from(document.querySelectorAll('button, input[type="submit"], input[type="button"], a.btn, a.button'));
            const isVisible = (el) => {
                const rect = el.getBoundingClientRect();
                return rect.width > 0 && rect.height > 0 && window.getComputedStyle(el).display !== 'none';
            };
            
            const subTerms = ['submit', 'send', 'subscribe', 'register', 'join', 'signup', 'sign up', 'contact', 'post', 'confirm', 'apply'];
            
            const candidates = buttons.filter(btn => {
                if (!isVisible(btn) || btn.disabled) return false;
                const txt = (btn.innerText || btn.value || '').toLowerCase();
                const type = btn.getAttribute('type') || '';
                return type === 'submit' || subTerms.some(term => txt.includes(term));
            });
            
            if (candidates.length > 0) {
                candidates.sort((a, b) => {
                    const aType = a.getAttribute('type') === 'submit' ? 1 : 0;
                    const bType = b.getAttribute('type') === 'submit' ? 1 : 0;
                    return bType - aType;
                });
                
                const best = candidates[0];
                if (best.id) return `#${best.id}`;
                if (best.name) return `${best.tagName.toLowerCase()}[name="${best.name}"]`;
                
                const allSame = Array.from(document.querySelectorAll(best.tagName.toLowerCase()));
                const idx = allSame.indexOf(best);
                return `${best.tagName.toLowerCase()}:nth-of-type(${idx + 1})`;
            }
            return null;
        });
    } catch (e) {
        return null;
    }
}

// Main execution block
async function startWebsiteVisitJourney() {
    let browser;
    try {
        const plan = await generateWebsitePlan();
        
        console.log(`🌐 Initializing Puppeteer and connecting browser...`);
        const headlessArg = args.includes('--headless') || args.find(arg => arg.startsWith('--headless='))?.split('=')[1] === 'true';
        const page = await config.connect({ headless: headlessArg });
        browser = page.browser();
        
        console.log(`🚀 Navigating to generated URL: ${plan.websiteUrl}`);
        await page.goto(plan.websiteUrl, { waitUntil: 'networkidle2', timeout: 45000 }).catch(async (err) => {
            console.warn('⚠️ Networkidle2 navigation timed out, trying domcontentloaded...');
            await page.goto(plan.websiteUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
        });
        
        await handleConsent(page);
        
        // Spreading a good amount of time interacting like a human
        console.log(`👀 Navigated successfully! Spending organic time exploring the webpage...`);
        const interactionSeconds = 25 + Math.floor(Math.random() * 20); // 25-45 seconds initially
        const endInteraction = Date.now() + (interactionSeconds * 1000);
        
        while (Date.now() < endInteraction) {
            await explorePage(page);
            await new Promise(r => setTimeout(r, 4000 + Math.random() * 4000));
        }

        // Try scanning for a form on the home page
        let fields = await scanForFormFields(page);
        let formDetected = fields && fields.length > 0;
        
        if (!formDetected) {
            console.log('🔍 No direct input form found on home page. Looking for contact or subscription links...');
            const targetLinkSelector = await page.evaluate(() => {
                const links = Array.from(document.querySelectorAll('a, button'));
                const searchTerms = ['contact', 'subscribe', 'newsletter', 'sign up', 'signup', 'register', 'join us', 'feedback'];
                const isVisible = (el) => {
                    const rect = el.getBoundingClientRect();
                    return rect.width > 0 && rect.height > 0 && window.getComputedStyle(el).display !== 'none';
                };
                
                const candidates = links.filter(l => {
                    if (!isVisible(l)) return false;
                    const txt = (l.innerText || '').toLowerCase();
                    const href = l.getAttribute('href') || '';
                    return searchTerms.some(term => txt.includes(term) || href.toLowerCase().includes(term));
                });
                
                if (candidates.length > 0) {
                    const best = candidates[0];
                    if (best.id) return `#${best.id}`;
                    const tagName = best.tagName.toLowerCase();
                    const allSame = Array.from(document.querySelectorAll(tagName));
                    const idx = allSame.indexOf(best);
                    return `${tagName}:nth-of-type(${idx + 1})`;
                }
                return null;
            }).catch(() => null);

            if (targetLinkSelector) {
                console.log(`🔗 Found organic link/button matching form entry. Clicking to navigate...`);
                const linkEl = await page.$(targetLinkSelector);
                if (linkEl) {
                    await scrollAndClick(page, linkEl);
                    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 20000 }).catch(() => {});
                    
                    // Re-scan fields on the new page
                    console.log('🔍 Scanning new page for forms...');
                    fields = await scanForFormFields(page);
                    formDetected = fields && fields.length > 0;
                }
            }
        }

        if (formDetected) {
            console.log(`📝 Organic Form Detected! Proceeding to fill fields...`);
            
            for (const field of fields) {
                try {
                    const element = await page.$(field.selector);
                    if (!element) continue;
                    
                    let valueToType = '';
                    if (field.type === 'email') valueToType = email;
                    else if (field.type === 'firstName') valueToType = plan.firstName;
                    else if (field.type === 'lastName') valueToType = plan.lastName;
                    else if (field.type === 'fullName') valueToType = `${plan.firstName} ${plan.lastName}`.trim();
                    else if (field.type === 'age') valueToType = String(age);
                    else if (field.type === 'subject') valueToType = plan.subject;
                    else if (field.type === 'message') valueToType = plan.message;
                    
                    if (valueToType) {
                        console.log(`   ✍️ Filling field [${field.type}] with: "${valueToType}"`);
                        await scrollAndClick(page, element);
                        
                        // Triple click using coordinate-based mouse click to clear existing values
                        const box = await element.boundingBox();
                        if (box) {
                            const centerX = box.x + box.width / 2;
                            const centerY = box.y + box.height / 2;
                            await page.mouse.click(centerX, centerY, { clickCount: 3 }).catch(() => {});
                        }
                        await page.keyboard.press('Backspace');
                        
                        await humanType(page, valueToType);
                        await new Promise(r => setTimeout(r, 800 + Math.random() * 800));
                    }
                } catch (err) {
                    console.warn(`⚠️ Skipped filling field ${field.type} due to minor error:`, err.message);
                }
            }

            // Scan and accept any consent/agreement checkboxes
            const checkboxes = await scanForConsentCheckboxes(page);
            for (const cbSelector of checkboxes) {
                try {
                    const cb = await page.$(cbSelector);
                    if (cb) {
                        console.log('   ☑️ Checking consent box:', cbSelector);
                        await scrollAndClick(page, cb);
                        await new Promise(r => setTimeout(r, 500 + Math.random() * 500));
                    }
                } catch (e) {}
            }

            // Find and click the submit button
            const submitBtn = await scanForSubmitButton(page);
            if (submitBtn) {
                console.log(`🚀 Click and submit form via button: ${submitBtn}`);
                const btnEl = await page.$(submitBtn);
                if (btnEl) {
                    await scrollAndClick(page, btnEl);
                    console.log('⏳ Waiting for submission processing...');
                    await new Promise(r => setTimeout(r, 6000 + Math.random() * 4000));
                    console.log('✅ Form submission operation completed!');
                }
            } else {
                console.warn('⚠️ Could not identify a submission button. Attempting to press Enter on the keyboard...');
                await page.keyboard.press('Enter');
                await new Promise(r => setTimeout(r, 6000));
            }
        } else {
            console.log('⚠️ No interactive forms could be found or resolved on this website.');
            console.log('👀 Spending additional reading time on the site before exiting...');
            await explorePage(page);
            await new Promise(r => setTimeout(r, 10000));
        }

        console.log('\n========================================');
        console.log('🎉 JOURNEY SUCCESS: Personality website visit successfully finished!');
        console.log('========================================\n');
        
        await humanClose(page, browser);

    } catch (error) {
        console.error('❌ Journey Failed with error:', error);
        if (browser) {
            try {
                await browser.close();
            } catch (e) {}
        }
        process.exit(1);
    }
}

// --- HUMAN MOUSE AND KEYBOARD EMULATION UTILITIES ---

async function scrollAndClick(page, elementHandle) {
    if (!elementHandle) return false;
    try {
        await page.evaluate((el) => { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); }, elementHandle);
        await new Promise(r => setTimeout(r, 1200 + Math.random() * 800));
        const rect = await page.evaluate((el) => {
            const r = el.getBoundingClientRect();
            return { x: r.left + r.width/2, y: r.top + r.height/2 };
        }, elementHandle);
        await smoothMove(page, rect.x, rect.y);
        await page.mouse.click(rect.x, rect.y);
        return true;
    } catch (e) {
        return false;
    }
}

async function explorePage(page) {
    try {
        const scroll = 150 + Math.random() * 500;
        await page.evaluate((s) => window.scrollBy({ top: s, behavior: 'smooth' }), scroll);
        await smoothMove(page, 150 + Math.random() * 600, 150 + Math.random() * 400);
    } catch (e) {
        // Safe skip on page transitions
    }
}

async function smoothMove(page, endX, endY) {
    if (!global.lastMousePos) global.lastMousePos = { x: 0, y: 0 };
    try {
        const steps = 12 + Math.floor(Math.random() * 6);
        for (let i = 0; i <= steps; i++) {
            const x = global.lastMousePos.x + (endX - global.lastMousePos.x) * (i / steps);
            const y = global.lastMousePos.y + (endY - global.lastMousePos.y) * (i / steps);
            await page.mouse.move(x, y);
            
            // Directly update the visual cursor element in the DOM
            await page.evaluate((x, y) => {
                const cursor = document.getElementById('golden-mouse');
                if (cursor) {
                    cursor.style.left = x + 'px';
                    cursor.style.top = y + 'px';
                }
            }, Math.round(x), Math.round(y)).catch(() => {});
            
            await new Promise(r => setTimeout(r, 15 + Math.random() * 10));
        }
        global.lastMousePos = { x: endX, y: endY };
    } catch (e) {}
}

async function humanType(page, text) {
    try {
        for (const char of text) {
            await page.keyboard.type(char);
            await new Promise(r => setTimeout(r, 40 + Math.random() * 120));
        }
    } catch (e) {}
}

async function handleConsent(page) {
    // Poll up to 6 times (total 6 seconds) to see if consent popup appears
    for (let attempt = 1; attempt <= 6; attempt++) {
        try {
            const consentBtn = await page.evaluateHandle(() => {
                const buttons = Array.from(document.querySelectorAll('button, [role="button"], a'));
                const consentTerms = [
                    'accept all', 'i agree', 'accept everything', 'agree', 
                    'consent', 'accept', 'allow all', 'ok', 'got it'
                ];
                return buttons.find(b => {
                    const text = b.innerText.toLowerCase().trim();
                    const rect = b.getBoundingClientRect();
                    const visible = rect.width > 0 && rect.height > 0 && window.getComputedStyle(b).display !== 'none';
                    return consentTerms.some(term => {
                        if (term === 'ok') return /\bok\b/.test(text);
                        if (term === 'agree') return /\bagree\b/.test(text) && !text.includes('disagree');
                        return text.includes(term);
                    }) && visible;
                });
            });

            const btnEl = consentBtn.asElement();
            if (btnEl) {
                console.log('🖱️ Consent button found! Clicking via mouse...');
                await scrollAndClick(page, btnEl);
                await new Promise(r => setTimeout(r, 2000));

                // Verify if still visible
                const isStillVisible = await page.evaluate((el) => {
                    if (!el) return false;
                    const rect = el.getBoundingClientRect();
                    return rect.width > 0 && rect.height > 0 && window.getComputedStyle(el).display !== 'none';
                }, btnEl);

                if (!isStillVisible) {
                    console.log('✅ Cookie consent popup cleared successfully.');
                    return;
                }

                console.log('⚠️ Mouse click did not clear consent popup. Falling back to DOM click...');
                await page.evaluate(el => el.click(), btnEl);
                await new Promise(r => setTimeout(r, 2000));
                return;
            }
        } catch (e) {
            console.warn(`⚠️ Consent handler attempt ${attempt} issue:`, e.message);
        }
        await new Promise(r => setTimeout(r, 1000));
    }
    console.log('ℹ️ Consent popup check finished.');
}

async function humanClose(page, browser) {
    try {
        const dims = await page.evaluate(() => ({ w: window.innerWidth })).catch(() => ({ w: 1024 }));
        await smoothMove(page, dims.w - 20, 20);
        await new Promise(r => setTimeout(r, 800));
        await browser.close();
    } catch (e) {
        if (browser) await browser.close();
    }
    process.exit(0);
}

global.lastMousePos = { x: 0, y: 0 };
startWebsiteJourney = startWebsiteVisitJourney;
startWebsiteJourney();
