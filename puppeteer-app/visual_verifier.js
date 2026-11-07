const fs = require('fs');
const path = require('path');

/**
 * Visual Verifier Module
 * Utilizes chosen Vision API (DeepSeek, OpenAI, Gemini, Claude) to verify Puppeteer element positions,
 * mitigating honeypot bait traps and correcting click coordinates dynamically.
 */

/**
 * Verifies if an element's bounding box matches its actual visual position in the screenshot.
 * @param {object} page - Puppeteer Page instance
 * @param {object} element - Puppeteer ElementHandle
 * @param {string} buttonDescription - Description of the button (e.g., 'Skip Ad Button')
 * @param {string} apiKey - Optional fallback API Key
 * @returns {object} Verification result { verified: boolean, x: number, y: number, reason: string }
 */
async function verifyButtonPositionWithDeepSeek(page, element, buttonDescription, apiKey) {
    const errorLogPath = path.resolve(__dirname, 'deepseek_visual_errors.log');
    const successLogPath = path.resolve(__dirname, 'deepseek_visual_success.log');

    // 1. Resolve configuration from browser-config.json
    let provider = 'deepseek';
    let key = apiKey;

    try {
        const configPath = path.resolve(__dirname, 'browser-config.json');
        if (fs.existsSync(configPath)) {
            const configData = JSON.parse(fs.readFileSync(configPath, 'utf8'));
            const aiConfig = configData.ai || {};
            provider = aiConfig.provider || 'deepseek';
            if (provider === 'deepseek') key = aiConfig.deepseekApiKey || key;
            else if (provider === 'openai') key = aiConfig.openaiApiKey;
            else if (provider === 'anthropic') key = aiConfig.anthropicApiKey;
            else if (provider === 'gemini') key = aiConfig.geminiApiKey;

            // Handle DeepSeek text-only limitation by falling back to vision-capable models if keys are present
            if (provider === 'deepseek') {
                if (aiConfig.anthropicApiKey) {
                    provider = 'anthropic';
                    key = aiConfig.anthropicApiKey;
                    console.log('🔄 DeepSeek does not support image analysis. Falling back to Anthropic/Claude for visual verification.');
                } else if (aiConfig.openaiApiKey) {
                    provider = 'openai';
                    key = aiConfig.openaiApiKey;
                    console.log('🔄 DeepSeek does not support image analysis. Falling back to OpenAI for visual verification.');
                } else if (aiConfig.geminiApiKey) {
                    provider = 'gemini';
                    key = aiConfig.geminiApiKey;
                    console.log('🔄 DeepSeek does not support image analysis. Falling back to Gemini for visual verification.');
                }
            }
        }
    } catch (err) {
        console.warn('⚠️ Could not load browser-config.json in visual verifier, falling back:', err.message);
    }

    // If we are still on DeepSeek, we bypass vision verification since deepseek-chat is text-only
    if (provider === 'deepseek') {
        try {
            const box = await element.boundingBox();
            if (box) {
                console.log(`⏭️ Bypassing visual verification for text-only DeepSeek provider. Using bounding box center for "${buttonDescription}".`);
                return { verified: true, x: box.x + box.width / 2, y: box.y + box.height / 2, reason: 'DeepSeek text-only model bypassed' };
            } else {
                const errMsg = `[${new Date().toISOString()}] ⚠️ Bounding box not found for "${buttonDescription}" (bypassed DeepSeek).`;
                console.warn(errMsg);
                fs.appendFileSync(errorLogPath, errMsg + '\n');
                return { verified: false, error: 'No bounding box' };
            }
        } catch (e) {
            return { verified: false, error: e.message };
        }
    }

    if (!key) {
        const errMsg = `[${new Date().toISOString()}] 🛑 API Key missing for visual verification (provider: ${provider}).`;
        console.warn(errMsg);
        fs.appendFileSync(errorLogPath, errMsg + '\n');
        return { verified: false, error: 'API Key missing' };
    }

    try {
        const box = await element.boundingBox();
        if (!box) {
            const errMsg = `[${new Date().toISOString()}] ⚠️ Bounding box not found for "${buttonDescription}".`;
            console.warn(errMsg);
            fs.appendFileSync(errorLogPath, errMsg + '\n');
            return { verified: false, error: 'No bounding box' };
        }

        const viewport = page.viewport();
        const viewportWidth = viewport ? viewport.width : 1024;
        const viewportHeight = viewport ? viewport.height : 768;

        console.log(`📸 Taking viewport screenshot for visual verification of "${buttonDescription}"...`);
        const base64Screenshot = await page.screenshot({ encoding: 'base64' });

        const systemPrompt = `You are an expert web automation vision assistant.
Your goal is to prevent honeypot click traps by visually verifying button coordinates on the screen.
We have identified a target button described as: "${buttonDescription}".
Puppeteer reports the button coordinates as: x=${Math.round(box.x)}, y=${Math.round(box.y)}, width=${Math.round(box.width)}, height=${Math.round(box.height)}.
Analyze the screenshot (viewport size: ${viewportWidth}x${viewportHeight}px).
Locate the actual visual button.
Verify if the Puppeteer coordinates represent the visual center of the real button.
Return a clean JSON object containing:
{
  "verified": true/false (true if Puppeteer coordinates match the actual visual center within 40px),
  "visuallyFound": true/false (true if you can visually locate the button in the screenshot),
  "x": visual center X coordinate (the actual center of the visual button),
  "y": visual center Y coordinate (the actual center of the visual button),
  "reason": "Brief explanation of your finding"
}
ONLY return the JSON. Do not include markdown code block syntax.`;

        console.log(`🤖 Querying ${provider.toUpperCase()} Vision API for confirmation...`);
        let response;
        const prov = provider.toLowerCase();

        if (prov === 'deepseek' || prov === 'openai' || prov === 'gemini') {
            let url = 'https://api.deepseek.com/v1/chat/completions';
            let model = 'deepseek-chat';

            if (prov === 'openai') {
                url = 'https://api.openai.com/v1/chat/completions';
                model = 'gpt-4o-mini';
            } else if (prov === 'gemini') {
                url = 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions';
                model = 'gemini-2.5-flash';
            }

            response = await fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${key}`
                },
                body: JSON.stringify({
                    model: model,
                    messages: [
                        {
                            role: "user",
                            content: [
                                { type: "text", text: systemPrompt },
                                { type: "image_url", image_url: { url: `data:image/png;base64,${base64Screenshot}` } }
                            ]
                        }
                    ],
                    temperature: 0.1
                })
            });
        } else if (prov === 'anthropic') {
            response = await fetch('https://api.anthropic.com/v1/messages', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-api-key': key,
                    'anthropic-version': '2023-06-01'
                },
                body: JSON.stringify({
                    model: 'claude-3-5-sonnet-latest',
                    max_tokens: 1024,
                    messages: [
                        {
                            role: "user",
                            content: [
                                {
                                    type: "image",
                                    source: {
                                        type: "base64",
                                        media_type: "image/png",
                                        data: base64Screenshot
                                    }
                                },
                                {
                                    type: "text",
                                    text: systemPrompt
                                }
                            ]
                        }
                    ],
                    temperature: 0.1
                })
            });
        } else {
            throw new Error(`Unsupported provider: ${provider}`);
        }

        if (!response.ok) {
            const rawError = await response.text();
            const logMsg = `[${new Date().toISOString()}] ❌ ${provider.toUpperCase()} API call failed: Status ${response.status}\nResponse: ${rawError}\n`;
            fs.appendFileSync(errorLogPath, logMsg);
            return { verified: false, error: `API HTTP ${response.status}` };
        }

        const data = await response.json();
        let content = '';

        if (prov === 'anthropic') {
            if (data.content && data.content[0] && data.content[0].text) {
                content = data.content[0].text.trim();
            } else {
                throw new Error('Invalid response structure from Anthropic API');
            }
        } else {
            content = data.choices[0].message.content.trim();
        }
        
        // Clean markdown JSON wrapper if present
        const jsonString = content.replace(/```json/g, '').replace(/```/g, '').trim();
        const parsed = JSON.parse(jsonString);

        console.log(`🤖 ${provider.toUpperCase()} Vision response:`, parsed);

        if (parsed.verified) {
            console.log(`✅ ${provider.toUpperCase()} confirmed position of "${buttonDescription}" successfully.`);
            const succMsg = `[${new Date().toISOString()}] ✅ SUCCESS: Verified coordinates for "${buttonDescription}" matching visual target at x=${parsed.x}, y=${parsed.y}. Reason: ${parsed.reason}\n`;
            fs.appendFileSync(successLogPath, succMsg);
            return { verified: true, x: box.x + box.width / 2, y: box.y + box.height / 2, reason: parsed.reason };
        } else {
            if (parsed.visuallyFound && typeof parsed.x === 'number' && typeof parsed.y === 'number') {
                const warnMsg = `[${new Date().toISOString()}] ⚠️ WARNING: Honeypot or position mismatch detected for "${buttonDescription}".\nPuppeteer coordinates: x=${Math.round(box.x)}, y=${Math.round(box.y)}.\n${provider.toUpperCase()} corrected coordinates: x=${parsed.x}, y=${parsed.y}.\nReason: ${parsed.reason}\n`;
                console.warn(warnMsg);
                fs.appendFileSync(errorLogPath, warnMsg);
                return { verified: false, corrected: true, x: parsed.x, y: parsed.y, reason: parsed.reason };
            } else {
                const warnMsg = `[${new Date().toISOString()}] 🛑 FAILED: ${provider.toUpperCase()} could not visually verify nor locate "${buttonDescription}" anywhere in viewport.\nReason: ${parsed.reason}\n`;
                console.warn(warnMsg);
                fs.appendFileSync(errorLogPath, warnMsg);
                return { verified: false, corrected: false, reason: parsed.reason };
            }
        }

    } catch (e) {
        const errorStack = `[${new Date().toISOString()}] ❌ EXCEPTION caught during visual verification: ${e.message}\nStack: ${e.stack}\n`;
        console.error(errorStack);
        fs.appendFileSync(errorLogPath, errorStack);
        return { verified: false, error: e.message };
    }
}

module.exports = {
    verifyButtonPositionWithDeepSeek
};
