// ===== REBROWSER PATCHES CONFIGURATION =====
// Must be set BEFORE any puppeteer-related modules are loaded.
// 'addBinding' runs scripts in the main world (required for WebGL/Canvas spoofing to work).
// 'alwaysIsolated' (the puppeteer-real-browser default) breaks fingerprint injection.
process.env.REBROWSER_PATCHES_RUNTIME_FIX_MODE = 'addBinding';
// Hide the '//# sourceURL=pptr:evaluateOnNewDocument' artifact that bot detectors check for.
process.env.REBROWSER_PATCHES_SOURCE_URL = 'app.js';
// Change the utility world name from the detectable '__puppeteer_utility_world__+version' default.
process.env.REBROWSER_PATCHES_UTILITY_WORLD_NAME = 'util';
// ==============================================

const OpenAI = require('openai');
const os = require('os');
const browserConfig = require('./browser-config.json');
browserConfig.paths = browserConfig.paths || {};
browserConfig.proxy = browserConfig.proxy || {
    enabled: false,
    host: '',
    port: 0,
    protocol: 'http',
    username: '',
    password: '',
    fallback: { useDirectConnection: true },
    scamalytics: { enabled: false }
};
browserConfig.hardware = browserConfig.hardware || { acceleration: { enabled: false } };
browserConfig.privacy = browserConfig.privacy || { webrtc: { block: false }, fingerprint: { overrideDate: true } };
browserConfig.randomWeights = browserConfig.randomWeights || {};
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');

// Dynamically resolve Chrome and UserDataDir paths to avoid hardcoded machine-specific paths
(function resolveDynamicPaths() {
    if (browserConfig && browserConfig.paths) {
        // 1. Resolve Chrome executable path
        const isWindows = process.platform === 'win32';
        const targetName = isWindows ? 'chrome.exe' : 'chrome';
        const { execFileSync } = require('child_process');
        let chromeValid = false;

        if (browserConfig.paths.chrome && fs.existsSync(browserConfig.paths.chrome)) {
            try {
                execFileSync(browserConfig.paths.chrome, ['--version'], { stdio: 'ignore', timeout: 3000 });
                chromeValid = true;
            } catch (e) {
                console.log(`[Bot Config] ⚠️ Chrome binary at "${browserConfig.paths.chrome}" failed execution test (${e.message}). Searching for working alternative...`);
            }
        }

        if (!chromeValid) {
            const homeDir = process.env.HOME || process.env.USERPROFILE || os.homedir();
            const systemPaths = isWindows ? [
                'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
                'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
                process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Google\\Chrome\\Application\\chrome.exe') : null
            ].filter(Boolean) : [
                path.join(homeDir, '.local/opt/google/chrome/google-chrome'),
                path.join(homeDir, '.local/bin/google-chrome'),
                '/usr/bin/google-chrome-stable',
                '/usr/local/bin/google-chrome',
                '/usr/local/bin/chromium',
                '/usr/local/bin/chromium-browser',
                '/usr/bin/google-chrome',
                '/usr/bin/chromium-browser',
                '/usr/bin/chromium'
            ];

            for (const sysPath of systemPaths) {
                if (fs.existsSync(sysPath)) {
                    try {
                        execFileSync(sysPath, ['--version'], { stdio: 'ignore', timeout: 3000 });
                        console.log(`[Bot Config] ✅ Found working system Chrome executable: ${sysPath}`);
                        browserConfig.paths.chrome = sysPath;
                        chromeValid = true;
                        break;
                    } catch (e) { }
                }
            }

            if (!chromeValid) {
                console.log(`[Bot Config] 🔍 Searching local "chrome/" directory...`);
                const localChromeDir = path.join(__dirname, 'chrome');
                if (fs.existsSync(localChromeDir)) {
                    const queue = [localChromeDir];
                    let foundPath = null;
                    while (queue.length > 0) {
                        const currentDir = queue.shift();
                        let files = [];
                        try {
                            files = fs.readdirSync(currentDir, { withFileTypes: true });
                        } catch (e) { }
                        for (const file of files) {
                            const fullPath = path.join(currentDir, file.name);
                            if (file.isDirectory()) {
                                queue.push(fullPath);
                            } else if (file.isFile() && file.name.toLowerCase() === targetName) {
                                try {
                                    execFileSync(fullPath, ['--version'], { stdio: 'ignore', timeout: 3000 });
                                    foundPath = fullPath;
                                    break;
                                } catch (e) { }
                            }
                        }
                        if (foundPath) break;
                    }

                    if (foundPath) {
                        console.log(`[Bot Config] ✅ Dynamically found working local Chrome executable: ${foundPath}`);
                        browserConfig.paths.chrome = foundPath;
                    } else {
                        console.warn(`[Bot Config] ❌ Could not find a working Chrome executable.`);
                    }
                } else {
                    console.warn(`[Bot Config] ❌ Local "chrome/" directory does not exist at: ${localChromeDir}`);
                }
            }
        }

        // 2. Resolve UserDataDir path
        let driveExists = true;
        const userDataPath = browserConfig.paths.userDataDir;
        if (userDataPath && isWindows && /^[a-zA-Z]:/.test(userDataPath)) {
            const drive = userDataPath.substring(0, 3); // e.g. "E:\\"
            try {
                driveExists = fs.existsSync(drive);
            } catch (e) {
                driveExists = false;
            }
        }
        if (!driveExists && userDataPath) {
            const defaultUserDir = path.join(__dirname, 'profiles', 'Default');
            console.warn(`[Bot Config] ⚠️ UserDataDir drive does not exist for: "${userDataPath}". Falling back to: "${defaultUserDir}"`);
            browserConfig.paths.userDataDir = defaultUserDir;
        }
    }
})();

// Normalize userDataDir to avoid duplicated path segments (e.g., "Profile 27\\Profile 27")
(function normalizeUserDataDir() {
    try {
        if (browserConfig && browserConfig.paths && browserConfig.paths.userDataDir) {
            const original = browserConfig.paths.userDataDir;
            const normalized = path.normalize(original);
            const parts = normalized.split(path.sep);
            const collapsedParts = parts.filter((seg, idx) => idx === 0 || seg !== parts[idx - 1]);
            const collapsed = collapsedParts.join(path.sep);
            if (collapsed !== original) {
                console.log('[Bot Config] Normalized userDataDir:', original, '->', collapsed);
                browserConfig.paths.userDataDir = collapsed;
            }
        }
    } catch (e) {
        // ignore
    }
})();



// Parse command line arguments for multi-bot support
const args = process.argv.slice(2);
const userDataDirArg = args.find(arg => arg.startsWith('--user-data-dir='))?.split('=')[1];
let deviceArg = (args.find(arg => arg.startsWith('--device='))?.split('=')[1] || 'random').toLowerCase().trim();
const headlessArgVal = args.find(arg => arg.startsWith('--headless='))?.split('=')[1];
const defaultHeadless = headlessArgVal === 'true' || args.includes('--headless');

if (deviceArg === 'random') {
    const weights = browserConfig.randomWeights?.device || { desktop: 25, mac: 25, linux: 25, mobile: 25 };
    const totalWeight = Object.values(weights).reduce((a, b) => a + b, 0);
    if (totalWeight <= 0) {
        const devices = ['desktop', 'mac', 'linux', 'mobile'];
        deviceArg = devices[Math.floor(Math.random() * devices.length)];
    } else {
        const roll = Math.random() * totalWeight;
        let sum = 0;
        for (const key of ['desktop', 'mac', 'linux', 'mobile']) {
            sum += weights[key] ?? 0;
            if (roll <= sum) {
                deviceArg = key;
                break;
            }
        }
        if (!deviceArg || deviceArg === 'random') deviceArg = 'desktop';
    }
    if (process.env.ML_RUNNER !== 'true') {
        console.log(`🎲 Weighted random device selected: ${deviceArg} (${JSON.stringify(weights)})`);
    }
}

let isMobileDevice = deviceArg === 'mobile';

let browserArg = (args.find(arg => arg.startsWith('--browser='))?.split('=')[1] || 'random').toLowerCase().trim();

if (browserArg === 'random') {
    const weights = browserConfig.randomWeights?.browser || { chrome: 60, firefox: 15, safari: 15, edge: 10 };
    const totalWeight = Object.values(weights).reduce((a, b) => a + b, 0);
    if (totalWeight <= 0) {
        browserArg = 'chrome';
    } else {
        const roll = Math.random() * totalWeight;
        let sum = 0;
        for (const key of ['chrome', 'firefox', 'safari', 'edge']) {
            sum += weights[key] ?? 0;
            if (roll <= sum) {
                browserArg = key;
                break;
            }
        }
        if (!browserArg || browserArg === 'random') browserArg = 'firefox';
    }
    if (process.env.ML_RUNNER !== 'true') {
        console.log(`🎲 Weighted random browser selected: ${browserArg} (${JSON.stringify(weights)})`);
    }
}

//-----------------------------------------------//
const customConfig = {
    executablePath: browserConfig.paths.chrome,
    chromePath: browserConfig.paths.chrome,
    userDataDir: userDataDirArg === 'TEMP' ? undefined : (userDataDirArg && userDataDirArg.startsWith('Profile ') ? browserConfig.paths.userDataDir.replace(/Profile \d+/g, userDataDirArg) : (userDataDirArg || browserConfig.paths.userDataDir)),
    profilePath: browserConfig.paths.profilePath,
    cursorPath: browserConfig.paths.cursorPath,
    args: [
        '--start-maximized',
        '--enable-automation=false',
        '--disable-blink-features=AutomationControlled',
        '--disable-notifications',
        '--js-flags=--expose-gc',
        '--disable-dev-shm-usage',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--enable-webgl',
        //'--ignore-gpu-blocklist',
        '--disable-session-crashed-bubble',
        '--hide-crash-restore-bubble',
        '--restore-last-session=false',
        '--disable-save-password-bubble',
        '--disable-prompt-on-repost',
        '--disable-features=TabRestoreService,Notifications,GeolocationAPI'
    ],
    viewport: null
};
//-----------------------------------------------//
const deepSeekConfig = {
    apiKey: 'sk-0e2b915f407e4fc0bf70b34608e14a73', // Your DeepSeek API key
    endpoint: 'https://api.deepseek.com/v1'
};
//-----------------------------------------------//
// Browser connection helper
let isInitialized = false;


//-----------------------------------------------//
// Add Scamalytics check function
async function checkScamalytics(ipAddress) {
    // Check if proxy and scamalytics configs exist
    if (!browserConfig.proxy?.scamalytics?.enabled) {
        console.log('Scamalytics check skipped - not configured');
        return true;
    }

    const { hostname, username, apiKey } = browserConfig.proxy.scamalytics;

    if (!hostname || !username || !apiKey) {
        console.warn('Scamalytics configuration incomplete - skipping check');
        return true;
    }

    const apiUrl = `https://api12.scamalytics.com/${username}/?key=${apiKey}&ip=${ipAddress}`;
    console.log(`Checking IP ${ipAddress} with Scamalytics...`);

    try {
        const response = await fetch(apiUrl, {
            method: 'GET',
            headers: {
                'Accept': 'application/json'
            },
            timeout: 10000
        });

        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        const data = await response.json();
        console.log('Scamalytics response:', JSON.stringify(data, null, 2));

        // Log credits information
        if (data.credits) {
            console.log('\nScamalytics Credits:');
            console.log('─────────────────────');
            console.log(`Used this month: ${data.credits.used}`);
            console.log(`Remaining: ${data.credits.remaining}`);
            console.log('─────────────────────\n');
        }

        if (data.status !== 'ok') {
            console.error(`Scamalytics API error: ${data.error || 'Unknown error'}`);
            return false;
        }

        // Log all checks
        const checks = {
            riskScore: parseInt(data.score) > (browserConfig.proxy.scamalytics.maxRiskScore || 50),
            blacklisted: data.is_blacklisted_external === true,
            proxyType: ['DCH', 'VPN', 'TOR', 'PUB', 'WEB', 'SES'].includes(data.proxy_type || '0')
        };

        console.log('Security checks:', checks);

        if (checks.riskScore) {
            console.error(`IP risk score too high: ${data.score}`);
            return false;
        }

        if (checks.blacklisted) {
            console.error('IP is blacklisted externally');
            return false;
        }

        if (checks.proxyType) {
            console.error(`IP detected as ${data.proxy_type}`);
            return false;
        }

        console.log('Scamalytics check passed successfully');
        return true;
    } catch (error) {
        console.error('Scamalytics check error:', {
            message: error.message,
            type: error.type,
            code: error.code,
            url: apiUrl
        });

        if (browserConfig.proxy.fallback?.useDirectConnection) {
            console.log('Continuing due to fallback configuration...');
            return true;
        }
        throw error;
    }
}
//-----------------------------------------------//
// Add this function near the top with other imports/constants
async function getIPBasedTimezone(page) {
    try {
        // Get IP and location data using the browser's context
        const ipData = await page.evaluate(async () => {
            let errs = [];
            const getOffset = (timeZone) => {
                try {
                    const d = new Date();
                    const tzDate = new Date(d.toLocaleString('en-US', { timeZone }));
                    const utcDate = new Date(d.toLocaleString('en-US', { timeZone: 'UTC' }));
                    return Math.round((tzDate.getTime() - utcDate.getTime()) / 60000);
                } catch (e) { return 0; }
            };

            try {
                const response = await fetch('https://ipwhois.app/json/');
                const data = await response.json();
                if (data && data.success && data.timezone) {
                    return {
                        timezone: data.timezone,
                        offsetMinutes: Math.round(data.timezone_gmtOffset / 60)
                    };
                }
            } catch (e) { errs.push('ipwhois: ' + e.message); }

            try {
                const response = await fetch('https://lumtest.com/myip.json');
                const data = await response.json();
                if (data && data.geo && data.geo.tz) {
                    return {
                        timezone: data.geo.tz,
                        offsetMinutes: getOffset(data.geo.tz)
                    };
                }
            } catch (e) { errs.push('lumtest: ' + e.message); }

            try {
                const response = await fetch('http://ip-api.com/json');
                const data = await response.json();
                if (data && data.timezone) {
                    return {
                        timezone: data.timezone,
                        offsetMinutes: getOffset(data.timezone)
                    };
                }
            } catch (e) { errs.push('ip-api: ' + e.message); }

            try {
                const response = await fetch('https://ipapi.co/json/');
                const data = await response.json();
                if (data && data.timezone) {
                    let offsetMins = null;
                    if (data.utc_offset) {
                        const sign = data.utc_offset.startsWith('-') ? -1 : 1;
                        const hours = parseInt(data.utc_offset.substring(1, 3), 10);
                        const mins = parseInt(data.utc_offset.substring(3, 5), 10);
                        offsetMins = sign * ((hours * 60) + mins);
                    }
                    return {
                        timezone: data.timezone,
                        offsetMinutes: offsetMins !== null ? offsetMins : getOffset(data.timezone)
                    };
                }
            } catch (err) { errs.push('ipapi.co: ' + err.message); }
            return { error: 'Unknown - Errors: ' + errs.join(', ') };
        });

        if (!ipData || !ipData.timezone) {
            console.warn('Failed to detect timezone - IP geolocation service returned invalid data or failed. Falling back to UTC.');
            return {
                timezone: 'UTC',
                offset: 'UTC',
                offsetMinutes: 0
            };
        }

        return {
            timezone: ipData.timezone,
            offset: new Date().toLocaleString('en-US', { timeZone: ipData.timezone, timeZoneName: 'short' }).split(' ').pop(),
            offsetMinutes: ipData.offsetMinutes !== null ? ipData.offsetMinutes : -(new Date().getTimezoneOffset())
        };
    } catch (error) {
        console.error('Failed to get timezone from IP:', error);
        return {
            timezone: 'UTC',
            offset: 'UTC',
            offsetMinutes: 0
        };
    }
}

async function fixCrashedSession(userDataDir, profilePath = 'Default') {
    if (!userDataDir) return;
    const paths = [
        path.join(userDataDir, 'Preferences'),
        path.join(userDataDir, 'Local State')
    ];

    try {
        if (fs.existsSync(userDataDir)) {
            const files = fs.readdirSync(userDataDir);
            for (const file of files) {
                const fullPath = path.join(userDataDir, file);
                if (fs.statSync(fullPath).isDirectory()) {
                    const prefPath = path.join(fullPath, 'Preferences');
                    if (fs.existsSync(prefPath)) {
                        paths.push(prefPath);
                    }
                }
            }
        }
    } catch (e) {
        console.warn('⚠️ Error listing profile directories for crashed session fix:', e.message);
    }

    if (profilePath) {
        paths.push(path.join(userDataDir, profilePath, 'Preferences'));
    }

    for (const preferencesPath of paths) {
        try {
            const isLocalState = path.basename(preferencesPath) === 'Local State';
            if (isLocalState && !fs.existsSync(preferencesPath)) {
                continue; // Skip pre-creating Local State if it doesn't exist
            }

            // Ensure parent directory of Preferences exists if we want to pre-create it
            const parentDir = path.dirname(preferencesPath);
            if (!fs.existsSync(parentDir)) {
                fs.mkdirSync(parentDir, { recursive: true });
            }

            let prefs = {};
            if (fs.existsSync(preferencesPath)) {
                try {
                    prefs = JSON.parse(fs.readFileSync(preferencesPath, 'utf8'));
                } catch (e) {
                    console.warn(`⚠️ Error reading existing Preferences file at ${preferencesPath}, resetting it.`);
                }
            }

            let changed = false;
            if (prefs.profile) {
                if (prefs.profile.exit_type !== 'Normal' || prefs.profile.exited_cleanly !== true) {
                    prefs.profile.exit_type = 'Normal';
                    prefs.profile.exited_cleanly = true;
                    changed = true;
                }
            }
            if (prefs.browser) {
                if (prefs.browser.exit_type !== 'Normal' || prefs.browser.exited_cleanly !== true) {
                    prefs.browser.exit_type = 'Normal';
                    prefs.browser.exited_cleanly = true;
                    changed = true;
                }
            }

            // Enforce open new tab at startup (restore_on_startup: 5)
            // Skip for Local State as it doesn't contain profile-level session settings
            if (path.basename(preferencesPath) === 'Preferences') {
                if (!prefs.session) {
                    prefs.session = {};
                }
                if (prefs.session.restore_on_startup !== 5) {
                    prefs.session.restore_on_startup = 5;
                    changed = true;
                }
            }

            if (changed || !fs.existsSync(preferencesPath)) {
                fs.writeFileSync(preferencesPath, JSON.stringify(prefs, null, 4));
                console.log(`🧹 Repaired crash state and set default startup tab in: ${preferencesPath}`);
            }
        } catch (e) {
            console.error(`⚠️ Failed to repair or configure profile preferences at ${preferencesPath}:`, e.message);
        }
    }
}

function cleanOldChromiumCache(userDataDir) {
    if (!userDataDir || !fs.existsSync(userDataDir)) return;
    
    // Ensure "First Run" sentinel file exists so Chrome never shows the welcome popup
    try {
        const firstRunPath = path.join(userDataDir, 'First Run');
        if (!fs.existsSync(firstRunPath)) {
            fs.writeFileSync(firstRunPath, '');
        }
    } catch (_) {}

    const cacheDirectories = [
        'Cache',
        'Code Cache',
        'GPUCache',
        'DawnCache',
        'GrShaderCache',
        'ShaderCache',
        'Crashpad',
        path.join('Default', 'Cache'),
        path.join('Default', 'Code Cache'),
        path.join('Default', 'GPUCache'),
        path.join('Default', 'DawnCache'),
        path.join('Default', 'GrShaderCache'),
        path.join('Default', 'Service Worker', 'CacheStorage'),
        path.join('Default', 'Service Worker', 'ScriptCache')
    ];
    let cleanedCount = 0;
    for (const relDir of cacheDirectories) {
        try {
            const targetDir = path.join(userDataDir, relDir);
            if (fs.existsSync(targetDir)) {
                fs.rmSync(targetDir, { recursive: true, force: true });
                cleanedCount++;
            }
        } catch (_) {}
    }
    if (cleanedCount > 0) {
        console.log(`[Chromium Optimizer] Auto-cleaned ${cleanedCount} cached temporary data directories in ${path.basename(userDataDir)} to free RAM/disk.`);
    }
}

//-----------------------------------------------//
const connect = async function (options = {}) {
    if (options.headless === undefined) {
        options.headless = defaultHeadless;
    }

    let targetUserDataDir = options.userDataDir || customConfig.userDataDir;
    const isTempProfile = options.profile === 'Temporary' || options.useTempProfile;

    if (targetUserDataDir && !isTempProfile) {
        cleanOldChromiumCache(targetUserDataDir);
    }

    if (isTempProfile) {
        targetUserDataDir = undefined;
        console.log('👤 Using a clean Temporary Chrome profile (Wipe on Close)');
    } else if (options.provider && targetUserDataDir && !targetUserDataDir.endsWith('_' + options.provider)) {
        const originalDir = targetUserDataDir;
        targetUserDataDir = targetUserDataDir + '_' + options.provider;

        // Inherit proxy and fingerprint configuration from the base profile
        const fs = require('fs');
        const path = require('path');
        if (fs.existsSync(originalDir)) {
            if (!fs.existsSync(targetUserDataDir)) {
                fs.mkdirSync(targetUserDataDir, { recursive: true });
            }
            ['proxy.json', 'fingerprint.json', 'history.json'].forEach(file => {
                const src = path.join(originalDir, file);
                const dest = path.join(targetUserDataDir, file);
                if (fs.existsSync(src) && !fs.existsSync(dest)) {
                    fs.copyFileSync(src, dest);
                }
            });
        }
        console.log(`👤 Isolated browser user data directory for ${options.provider}: ${targetUserDataDir}`);

        // Clean up any stale LOCK or SingletonLock files in the profile directory to prevent startup hangs
        const cleanLocks = (currentDir) => {
            if (!fs.existsSync(currentDir)) return;
            let files = [];
            try {
                files = fs.readdirSync(currentDir);
            } catch (e) {
                return;
            }
            for (const file of files) {
                const fullPath = path.join(currentDir, file);
                let stat;
                try {
                    stat = fs.statSync(fullPath);
                } catch (e) {
                    continue;
                }
                if (stat.isDirectory()) {
                    cleanLocks(fullPath);
                } else if (file === 'LOCK' || file === 'SingletonLock') {
                    try {
                        fs.unlinkSync(fullPath);
                    } catch (e) { }
                }
            }
        };
        try {
            cleanLocks(targetUserDataDir);
        } catch (e) { }
    }
    // puppeteer-real-browser is the DEFAULT — it patches navigator.webdriver, WebGL, and
    // canvas fingerprints so bot detectors cannot identify the session as automated.
    // Only set options.useRealBrowser = false to skip stealth (e.g. in unit tests).
    const useRealBrowser = options.useRealBrowser !== false;
    const puppeteer = useRealBrowser ? require('puppeteer-real-browser') : require('puppeteer');
    const proxyChain = require('proxy-chain');
    const { testProxyConnectivity, checkScamalytics } = require('./utils/pre-launch-proxy-check');
    const { detectTimezonePreLaunch } = require('./utils/ip-utils');
    console.log(`Attempting to connect to browser instance...`);

    // --- Profile-Specific Proxy Loading ---
    if (targetUserDataDir) {
        const profileProxyPath = path.join(targetUserDataDir, 'proxy.json');
        if (fs.existsSync(profileProxyPath)) {
            try {
                const profileProxy = JSON.parse(fs.readFileSync(profileProxyPath, 'utf8'));
                if (profileProxy === null) {
                    console.log('🔌 Profile explicitly configured to use System IP (Direct Connection). Disabling proxy.');
                    browserConfig.proxy = {
                        ...browserConfig.proxy,
                        enabled: false
                    };
                } else if (profileProxy.type === 'residential_tunnel') {
                    const tunnelPort = browserConfig.proxy?.residential?.proxyPort || 1080;
                    console.log(`🔌 Profile explicitly configured to route traffic through Residential TCP Tunnel on port ${tunnelPort}`);
                    browserConfig.proxy = {
                        ...browserConfig.proxy,
                        enabled: true,
                        host: '127.0.0.1',
                        port: tunnelPort,
                        protocol: 'http',
                        username: '',
                        password: ''
                    };
                } else {
                    console.log(`🔌 Overriding global proxy settings with profile-specific proxy: ${profileProxy.host}:${profileProxy.port}`);
                    browserConfig.proxy = {
                        ...browserConfig.proxy,
                        enabled: true,
                        host: profileProxy.host,
                        port: profileProxy.port,
                        protocol: profileProxy.protocol || 'http',
                        username: profileProxy.username,
                        password: profileProxy.password
                    };
                }
            } catch (err) {
                console.error(`❌ Error parsing profile-specific proxy.json: ${err.message}`);
            }
        } else {
            console.log('ℹ️ No profile-specific proxy.json found. Using global proxy configurations or direct connection.');
        }
    }

    // --- Residential Proxy Tunnel Override ---
    if (browserConfig.proxy?.residential?.enabled && browserConfig.proxy?.residential?.useForBot) {
        if (!browserConfig.proxy.enabled) {
            console.log(`🔌 Routing traffic through active Residential TCP Tunnel on port ${browserConfig.proxy.residential.proxyPort || 1080}`);
            browserConfig.proxy = {
                ...browserConfig.proxy,
                enabled: true,
                host: '127.0.0.1',
                port: browserConfig.proxy.residential.proxyPort || 1080,
                protocol: 'http',
                username: '',
                password: ''
            };
        }
    }

    const useCustomCursor = browserConfig.paths?.useCustomCursor !== false && browserConfig.useCustomCursor !== false;
    let mouseBase64 = '';

    if (useCustomCursor) {
        let mouseCandidate = browserConfig.paths?.cursorPath
            ? (path.isAbsolute(browserConfig.paths.cursorPath) ? browserConfig.paths.cursorPath : path.resolve(__dirname, browserConfig.paths.cursorPath))
            : path.resolve(__dirname, 'gold_mouse.png');

        if (!fs.existsSync(mouseCandidate)) {
            mouseCandidate = path.resolve(__dirname, 'gold_mouse.png');
        }

        try {
            if (fs.existsSync(mouseCandidate)) {
                mouseBase64 = fs.readFileSync(mouseCandidate, 'base64');
                console.log(`✅ Custom mouse cursor loaded successfully (${mouseCandidate})`);
            } else {
                console.warn(`⚠️ Custom cursor image not found at ${mouseCandidate}`);
            }
        } catch (e) {
            console.warn('⚠️ Could not load custom cursor overlay image:', e.message);
        }
    } else {
        console.log('ℹ️ Custom mouse cursor overlay is disabled. Standard browser cursor active.');
    }

    const { FingerprintGenerator } = require('fingerprint-generator');
    const { FingerprintInjector } = require('fingerprint-injector');

    // Initialize BrowserHeadersGenerator (disabled network fetch to speed up startup)
    let randomBrowserHeaders = {};
    // We rely on fingerprint-generator's default headers instead to prevent the 15-second hang.

    let targetOS = 'windows';
    if (deviceArg === 'mac') targetOS = 'macos';
    else if (deviceArg === 'linux') targetOS = 'linux';
    else if (deviceArg === 'mobile') targetOS = 'android';

    if (browserArg === 'safari') {
        targetOS = 'macos';
    }

    const getFingerprintSafe = (bName, isMob, osVal) => {
        try {
            const gen = new FingerprintGenerator({
                browsers: [{ name: bName, minVersion: 100 }],
                devices: isMob ? ['mobile'] : ['desktop'],
                operatingSystems: [osVal],
            });
            return gen.getFingerprint({ locales: ['en-US', 'en'] });
        } catch (err) {
            const fallbackB = 'chrome';
            const fallbackOS = isMob ? 'android' : 'windows';
            console.warn(`⚠️ Fingerprint generation failed for browser: ${bName}, device: ${isMob ? 'mobile' : 'desktop'}, OS: ${osVal}. Falling back to ${fallbackB} on ${fallbackOS}. Error: ${err.message}`);
            const gen = new FingerprintGenerator({
                browsers: [{ name: fallbackB, minVersion: 100 }],
                devices: isMob ? ['mobile'] : ['desktop'],
                operatingSystems: [fallbackOS],
            });
            return gen.getFingerprint({ locales: ['en-US', 'en'] });
        }
    };

    // --- Fingerprint Persistence ---
    const fingerprintPath = targetUserDataDir ? path.join(targetUserDataDir, 'fingerprint.json') : null;
    let generatedFingerprint;

    if (fingerprintPath && fs.existsSync(fingerprintPath)) {
        console.log('Reusing existing device configuration from fingerprint.json');
        try {
            generatedFingerprint = JSON.parse(fs.readFileSync(fingerprintPath, 'utf8'));
        } catch (e) {
            console.error('Error reading fingerprint.json, generating new one:', e);
            generatedFingerprint = getFingerprintSafe(browserArg, isMobileDevice, targetOS);
            try {
                fs.writeFileSync(fingerprintPath, JSON.stringify(generatedFingerprint, null, 2));
            } catch (err) {
                console.warn('Failed to save fingerprint.json:', err.message);
            }
        }
    } else {
        console.log('Generating new device configuration...');
        generatedFingerprint = getFingerprintSafe(browserArg, isMobileDevice, targetOS);

        // Only save for permanent profiles (temp profiles will be deleted anyway)
        // We can check if userDataDir is in the temp directory
        if (targetUserDataDir && !targetUserDataDir.includes(os.tmpdir())) {
            try {
                if (!fs.existsSync(targetUserDataDir)) {
                    fs.mkdirSync(targetUserDataDir, { recursive: true });
                }
                if (fingerprintPath) {
                    fs.writeFileSync(fingerprintPath, JSON.stringify(generatedFingerprint, null, 2));
                }
            } catch (e) {
                console.warn('Failed to save fingerprint.json:', e.message);
            }
        }
    }
    // -------------------------------

    // Update isMobileDevice based on the actually loaded/reused user agent
    const loadedUAStr = generatedFingerprint.fingerprint?.navigator?.userAgent || '';
    isMobileDevice = /Android|iPhone|iPad|Mobile/i.test(loadedUAStr);

    // Ensure realistic hardware combinations to prevent ML detection
    if (generatedFingerprint.fingerprint.navigator.deviceMemory) {
        const mem = generatedFingerprint.fingerprint.navigator.deviceMemory;
        let cores = 8;
        if (mem <= 4) cores = 4;
        else if (mem === 8) cores = 8;
        else if (mem >= 16) cores = 16;
        generatedFingerprint.fingerprint.navigator.hardwareConcurrency = cores;
    }

    let ua = generatedFingerprint.fingerprint.navigator.userAgent;

    // Extract actual version from the chrome path to mirror the actual Chromium browser
    const actualChromePath = customConfig.chromePath || browserConfig.paths.chrome || '';
    const pathVersionMatch = actualChromePath.match(/(\d+\.\d+\.\d+\.\d+)/);

    let chromeVersionMatch = ua.match(/Chrome\/(\d+)/);
    let chromeFullVersionMatch = ua.match(/Chrome\/(\d+\.\d+\.\d+\.\d+)/);
    let chromeVersion = chromeVersionMatch ? chromeVersionMatch[1] : '147';
    let chromeVersionFull = chromeFullVersionMatch ? chromeFullVersionMatch[1] : `${chromeVersion}.0.0.0`;
    let chromeFullVersionValue = chromeVersionFull;

    if (pathVersionMatch) {
        chromeFullVersionValue = pathVersionMatch[1];
        chromeVersion = chromeFullVersionValue.split('.')[0];
        chromeVersionFull = chromeFullVersionValue;
        // Replace the version in the generated User-Agent string to match exactly, using reduced user agent format (e.g., 148.0.0.0)
        ua = ua.replace(/Chrome\/\d+\.\d+\.\d+\.\d+/, `Chrome/${chromeVersion}.0.0.0`);
        generatedFingerprint.fingerprint.navigator.userAgent = ua;
    }

    const uaData = generatedFingerprint.fingerprint.navigator.userAgentData;
    if (uaData) {
        if (uaData.brands) {
            uaData.brands = uaData.brands.map(b => {
                if (/Chrome|Chromium/i.test(b.brand)) {
                    return { brand: b.brand, version: chromeVersion };
                }
                return b;
            });
        } else {
            uaData.brands = [
                { brand: 'Not(A:Brand', version: '99' },
                { brand: 'Google Chrome', version: chromeVersion },
                { brand: 'Chromium', version: chromeVersion }
            ];
        }
        uaData.mobile = isMobileDevice ? true : (uaData.mobile !== undefined ? uaData.mobile : false);

        let platform = 'Windows';
        if (ua.includes('Mac OS X')) platform = 'macOS';
        else if (ua.includes('Linux')) platform = 'Linux';
        else if (ua.includes('Android')) platform = 'Android';
        else if (ua.includes('iPhone') || ua.includes('iPad')) platform = 'iOS';

        uaData.platform = uaData.platform || platform;

        uaData.wow64 = uaData.wow64 !== undefined ? uaData.wow64 : false;
        uaData.formFactors = isMobileDevice ? ['Mobile'] : (uaData.formFactors || ['Desktop']);
        uaData.architecture = uaData.architecture || 'x86';
        uaData.bitness = uaData.bitness || '64';
        uaData.model = uaData.model || '';
        uaData.platformVersion = uaData.platformVersion || '10.0.0';

        const chromeBrandFullVersion = (uaData.brands || []).find(b => /Chrome|Chromium/i.test(b.brand))?.version || chromeVersion;
        chromeFullVersionValue = chromeBrandFullVersion.includes('.') ? chromeBrandFullVersion : chromeVersionFull;

        if (uaData.brands) {
            const brandsStr = uaData.brands.map(b => `"${b.brand}";v="${b.version}"`).join(', ');
            const fullBrandsStr = uaData.brands.map(b => {
                const version = b.version.includes('.') ? b.version : (/Chrome|Chromium/i.test(b.brand) ? chromeFullVersionValue : `${b.version}.0.0.0`);
                return `"${b.brand}";v="${version}"`;
            }).join(', ');

            randomBrowserHeaders['sec-ch-ua'] = brandsStr;
            randomBrowserHeaders['sec-ch-ua-mobile'] = uaData.mobile ? '?1' : '?0';
            randomBrowserHeaders['sec-ch-ua-platform'] = `"${uaData.platform}"`;
            randomBrowserHeaders['sec-ch-ua-full-version-list'] = fullBrandsStr;
            randomBrowserHeaders['sec-ch-ua-arch'] = `"${uaData.architecture}"`;
            randomBrowserHeaders['sec-ch-ua-bitness'] = `"${uaData.bitness}"`;
            randomBrowserHeaders['sec-ch-ua-wow64'] = uaData.wow64 ? '?1' : '?0';
            randomBrowserHeaders['sec-ch-ua-model'] = `"${uaData.model}"`;
            randomBrowserHeaders['sec-ch-ua-platform-version'] = `"${uaData.platformVersion}"`;
            randomBrowserHeaders['sec-ch-lang'] = `"${(generatedFingerprint.fingerprint.navigator.language || 'en-US,en').split(',')[0]}"`;
            randomBrowserHeaders['sec-ch-ua-full-version'] = `"${chromeFullVersionValue}"`;
            randomBrowserHeaders['sec-ch-ua-form-factors'] = `"${uaData.formFactors[0]}"`;

            // Inject hardware info into client hints to match JS fingerprint
            if (generatedFingerprint.fingerprint.navigator.deviceMemory) {
                randomBrowserHeaders['device-memory'] = String(generatedFingerprint.fingerprint.navigator.deviceMemory);
                randomBrowserHeaders['sec-ch-ua-device-memory'] = String(generatedFingerprint.fingerprint.navigator.deviceMemory);
            }
            if (generatedFingerprint.fingerprint.navigator.hardwareConcurrency) {
                // hardware concurrency doesn't have a standard sec-ch-ua header, but we ensure device-memory is present
            }

            randomBrowserHeaders['user-agent'] = generatedFingerprint.fingerprint.navigator.userAgent;

            const langs = generatedFingerprint.fingerprint.navigator.languages || ['en-US', 'en'];
            randomBrowserHeaders['accept-language'] = langs.map((lang, index) => index === 0 ? lang : `${lang};q=${(1 - index * 0.1).toFixed(1)}`).join(',');
        }
    }

    console.log('--- Generated WebGL Info ---', generatedFingerprint.fingerprint.videoCard);

    const fingerprintInjector = new FingerprintInjector();

    const uaDataScript = `
        try {
            const uaDataObj = window.navigator.userAgentData || navigator.userAgentData;
            if (uaDataObj) {
                const proto = Object.getPrototypeOf(uaDataObj);
                const brands = ${JSON.stringify(uaData?.brands || [])};
                const mobile = ${JSON.stringify(uaData?.mobile || false)};
                const platform = ${JSON.stringify(uaData?.platform || 'Windows')};
                const injectedChromeFullVersionValue = "${chromeFullVersionValue}";
                const fullVersionList = brands.map(b => ({
                    brand: b.brand,
                    version: b.version.includes('.') ? b.version : (/Chrome|Chromium/i.test(b.brand) ? injectedChromeFullVersionValue : b.version + '.0.0.0')
                }));
                
                Object.defineProperties(proto, {
                    brands: { get: () => brands, enumerable: true, configurable: true },
                    mobile: { get: () => mobile, enumerable: true, configurable: true },
                    platform: { get: () => platform, enumerable: true, configurable: true }
                });
                
                const originalGetHEV = proto.getHighEntropyValues;
                if (typeof originalGetHEV === 'function') {
                    proto.getHighEntropyValues = new Proxy(originalGetHEV, {
                        apply: async function(target, thisArg, argumentsList) {
                            const hints = argumentsList[0] || [];
                            let result = {};
                            try {
                                result = await Reflect.apply(target, thisArg, argumentsList);
                            } catch(e) {}
                            
                            if (hints.includes('fullVersionList')) result.fullVersionList = fullVersionList;
                            if (hints.includes('architecture')) result.architecture = "${uaData?.architecture || 'x86'}";
                            if (hints.includes('bitness')) result.bitness = "${uaData?.bitness || '64'}";
                            if (hints.includes('model')) result.model = "${uaData?.model || ''}";
                            if (hints.includes('platformVersion')) result.platformVersion = "${uaData?.platformVersion || '10.0.0'}";
                            if (hints.includes('uaFullVersion')) result.uaFullVersion = injectedChromeFullVersionValue;
                            if (hints.includes('brands')) result.brands = brands;
                            if (hints.includes('mobile')) result.mobile = mobile;
                            if (hints.includes('platform')) result.platform = platform;
                            return result;
                        }
                    });
                }
            }
        } catch(e) {}
    `;

    // hardwareScript: Uses Proxy via __proto__ assignment — zero Object.* calls.
    // CDP handles hardwareConcurrency and screen via Emulation commands (see setupPage).
    const hardwareScript = `
        (() => {
            try {
                const fp = ${JSON.stringify(generatedFingerprint.fingerprint)};

                // --- navigator properties via Proxy on __proto__ ---
                // Uses __proto__ setter (not Object.setPrototypeOf) with Proxy interception.
                // Object.getOwnPropertyDescriptor(navigator, 'deviceMemory') still returns undefined,
                // making this invisible to the most common antidetect detection checks.
                try {
                    const _mem  = fp.navigator.deviceMemory  || 8;
                    const _vend = fp.navigator.vendor        || 'Google Inc.';
                    const _plat = fp.navigator.platform      || 'Win32';
                    const _mtp  = fp.navigator.maxTouchPoints || 0;
                    navigator.__proto__ = new Proxy(navigator.__proto__, {
                        get(target, prop, receiver) {
                            if (prop === 'deviceMemory')   return _mem;
                            if (prop === 'vendor')          return _vend;
                            if (prop === 'platform')        return _plat;
                            if (prop === 'maxTouchPoints')  return _mtp;
                            return Reflect.get(target, prop, receiver);
                        },
                        getPrototypeOf(target) { return target; }
                    });
                } catch(e) {}

                // --- screen properties via Proxy on __proto__ ---
                try {
                    const _sw  = fp.screen.width;
                    const _sh  = fp.screen.height;
                    const _saw = fp.screen.availWidth  || fp.screen.width;
                    const _sah = fp.screen.availHeight || fp.screen.height;
                    const _scd = fp.screen.colorDepth  || 24;
                    const _spd = fp.screen.pixelDepth  || 24;
                    screen.__proto__ = new Proxy(screen.__proto__, {
                        get(target, prop, receiver) {
                            if (prop === 'width')       return _sw;
                            if (prop === 'height')      return _sh;
                            if (prop === 'availWidth')  return _saw;
                            if (prop === 'availHeight') return _sah;
                            if (prop === 'colorDepth')  return _scd;
                            if (prop === 'pixelDepth')  return _spd;
                            return Reflect.get(target, prop, receiver);
                        },
                        getPrototypeOf(target) { return target; }
                    });
                } catch(e) {}

            } catch(e) {}
        })();
    `;



    try {
        const browserOptions = {
            headless: options.headless ? 'new' : false,
            userAgent: generatedFingerprint.fingerprint.navigator.userAgent,
            executablePath: browserConfig.paths.chrome,
            userDataDir: targetUserDataDir,
            customConfig: {
                ...customConfig,
                userDataDir: targetUserDataDir
            },
            turnstile: false,
            connectOption: {
                defaultViewport: isMobileDevice ? { width: 412, height: 915, isMobile: true, hasTouch: true } : { width: 1400, height: 900 },
                protocolTimeout: 180000,
                timeout: 180000
            },
            disableXvfb: options.disableXvfb !== undefined ? options.disableXvfb : (!options.headless && (process.platform !== 'linux' || !!process.env.DISPLAY)),
            ignoreAllFlags: true,
            args: [
                isMobileDevice ? '--window-size=412,915' : '--window-size=1400,900',
                '--disable-features=Notifications,GeolocationAPI',
                '--disable-geolocation',
                '--deny-permission-prompts',
                `--user-agent=${generatedFingerprint.fingerprint.navigator.userAgent}`,
                `--lang=${generatedFingerprint.fingerprint.navigator.languages?.[0] || 'en-US'}`,
                `--accept-lang=${(generatedFingerprint.fingerprint.navigator.languages || ['en-US', 'en']).join(',')}`,
                // Enable WebGL via Mesa/Xvfb system GL — identical to the user's regular Linux browser.
                // IMPORTANT: do NOT add --disable-gpu-rasterization here.
                // That flag disables GPU tile compositing which causes WebGL canvases to render black,
                // even when WebGL contexts are successfully created (the bug causing the blank game area).
                '--enable-webgl',
                '--ignore-gpu-blocklist',
                '--use-gl=egl',                   // Use EGL/Mesa for GL — works on Xvfb without real GPU
                '--enable-gpu-rasterization',      // Keep GPU rasterization ON so WebGL composites correctly
                '--enable-zero-copy',
            ]
        };

        browserOptions.args.push(
            '--no-first-run',
            '--no-default-browser-check',
            '--disable-session-crashed-bubble',
            '--disable-infobars',
            '--disable-notifications',
            '--disable-prompt-on-repost',
            '--mute-audio',
            '--disable-features=Notifications,GeolocationAPI,AudioServiceOutOfProcess'
        );

        const isLowRamMode = browserConfig.performance?.lowRamMode !== false;
        const chromeV8Limit = isLowRamMode ? 256 : 512;

        if (process.platform === 'linux') {
            browserOptions.args.push(
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                `--js-flags=--max-old-space-size=${chromeV8Limit}`
            );
        } else {
            browserOptions.args.push(
                '--disable-dev-shm-usage',
                `--js-flags=--max-old-space-size=${chromeV8Limit}`
            );
        }

        // Add tab management settings
        browserOptions.args.push(
            '--disable-backgrounding-occluded-windows',
            '--disable-renderer-backgrounding',
            '--disable-background-timer-throttling'
        );

        if (options.headless) {
            browserOptions.args.push('--headless=new');
        }

        if (isMobileDevice) {
            browserOptions.args.push('--touch-events=enabled');
        }

        // Add WebRTC blocking settings
        if (browserConfig.privacy?.webrtc?.block) {
            browserOptions.args.push(
                '--disable-webrtc',
                '--force-webrtc-ip-handling-policy=disable_non_proxied_udp'
            );
        }

        // When hardware acceleration is explicitly disabled in browser-config.json,
        // fall back to SwiftShader software rendering but keep rasterization enabled
        // so WebGL canvas content still composites correctly to screen.
        if (browserConfig.hardware?.acceleration?.enabled === false) {
            browserOptions.args.push(
                '--use-gl=swiftshader',
                '--enable-webgl',
                '--ignore-gpu-blocklist'
            );
        }

        let newProxyUrl = null;

        // ===== PRE-LAUNCH PROXY AND TIMEZONE CHECKS =====
        console.log('\n=== Pre-Launch Checks (Before Browser Launch) ===');

        let timezoneConfigForBrowser = null;

        // Check proxy connectivity BEFORE browser launch if proxy is enabled
        if (browserConfig.proxy?.enabled) {
            console.log('Performing proxy connectivity test...');
            const proxyCheckResult = await testProxyConnectivity(browserConfig.proxy);

            if (!proxyCheckResult.valid) {
                if (browserConfig.proxy.fallback?.useDirectConnection) {
                    console.warn('⚠️ Proxy connectivity test failed, falling back to direct connection');
                    browserConfig.proxy.enabled = false;
                } else {
                    throw new Error(`Proxy connectivity test failed: ${proxyCheckResult.error}`);
                }
            } else if (proxyCheckResult.ip) {
                console.log(`✅ Proxy test passed with IP: ${proxyCheckResult.ip}`);

                // Perform Scamalytics check on the proxy IP (pre-launch)
                if (browserConfig.proxy.scamalytics?.enabled) {
                    const scamalyticsResult = await checkScamalytics(proxyCheckResult.ip);
                    if (!scamalyticsResult) {
                        throw new Error('Proxy failed Scamalytics security check during pre-launch validation');
                    }
                }
            }
        }

        // Detect timezone BEFORE browser launch (no new tabs opened)
        console.log('Detecting timezone before browser launch (no new tabs)...');
        const detectedTzInfo = await detectTimezonePreLaunch(browserConfig.proxy);
        console.log(`✅ Timezone pre-detected: ${detectedTzInfo.timezone} (UTC${detectedTzInfo.offset})\n`);

        // Only save history for permanent profiles
        if (targetUserDataDir && !targetUserDataDir.includes(os.tmpdir())) {
            try {
                const historyPath = path.join(targetUserDataDir, 'history.json');
                let historyObj = {
                    currentIp: detectedTzInfo.ip || 'Direct Connection',
                    currentTimezone: detectedTzInfo.timezone,
                    previousIp: 'Unknown',
                    previousTimezone: 'Unknown',
                    history: []
                };

                if (fs.existsSync(historyPath)) {
                    try {
                        const oldHistoryObj = JSON.parse(fs.readFileSync(historyPath, 'utf8'));
                        historyObj.previousIp = oldHistoryObj.currentIp || 'Unknown';
                        historyObj.previousTimezone = oldHistoryObj.currentTimezone || 'Unknown';
                        historyObj.history = oldHistoryObj.history || [];
                    } catch (e) {
                        console.error('Error reading old history:', e);
                    }
                }

                // Add to history log
                historyObj.history.unshift({
                    ip: detectedTzInfo.ip || 'Direct Connection',
                    timezone: detectedTzInfo.timezone,
                    timestamp: new Date().toISOString()
                });

                // Keep only last 10 entries in the log
                if (historyObj.history.length > 10) {
                    historyObj.history = historyObj.history.slice(0, 10);
                }

                // Write history back
                if (!fs.existsSync(targetUserDataDir)) {
                    fs.mkdirSync(targetUserDataDir, { recursive: true });
                }
                fs.writeFileSync(historyPath, JSON.stringify(historyObj, null, 4));
                console.log('✅ Profile IP and Timezone history updated in history.json');
            } catch (e) {
                console.warn('Failed to update history.json:', e.message);
            }
        }

        // Convert detected timezone to browser timezone config format
        timezoneConfigForBrowser = {
            current: detectedTzInfo.timezone,
            offset: detectedTzInfo.offset,
            offsets: {
                [detectedTzInfo.timezone]: detectedTzInfo.offsetMinutes
            }
        };

        // ===== END PRE-LAUNCH CHECKS =====

        // Handle proxy configuration based on enabled status
        if (browserConfig.proxy?.enabled) {
            console.log('Setting up proxy connection...');
            try {
                if (browserConfig.proxy.username && browserConfig.proxy.password) {
                    const oldProxyUrl = `${browserConfig.proxy.protocol}://${browserConfig.proxy.username}:${browserConfig.proxy.password}@${browserConfig.proxy.host}:${browserConfig.proxy.port}`;
                    console.log('Attempting to anonymize proxy...');
                    newProxyUrl = await proxyChain.anonymizeProxy(oldProxyUrl);
                    console.log('Proxy anonymization successful');
                } else {
                    console.log('Proxy credentials not provided. Using proxy directly.');
                    newProxyUrl = `${browserConfig.proxy.protocol}://${browserConfig.proxy.host}:${browserConfig.proxy.port}`;
                }

                // Add proxy to browser args
                browserOptions.args.push(`--proxy-server=${newProxyUrl}`);
            } catch (proxyError) {
                console.error('Proxy setup failed:', proxyError);

                if (browserConfig.proxy?.fallback?.useDirectConnection) {
                    console.log('Attempting direct connection...');
                } else {
                    throw new Error('Proxy required but setup failed');
                }
            }
        } else {
            console.log('Proxy disabled, using direct connection');
        }

        async function setupPage(_page) {

            if (!timezoneConfigForBrowser) return;

            // Set viewport with explicit dimensions
            // await page.setViewport({
            //     width: browserConfig.display.viewport.width,
            //     height: browserConfig.display.viewport.height,
            //     deviceScaleFactor: browserConfig.display.viewport.deviceScaleFactor,
            //     isMobile: browserConfig.display.viewport.isMobile,
            //     hasTouch: browserConfig.display.viewport.hasTouch,
            //     isLandscape: browserConfig.display.viewport.isLandscape
            // });

            // Inject unified Premium Golden Mouse Cursor & Animations
            if (mouseBase64) {
                try {
                    await _page.evaluateOnNewDocument((base64) => {
                        const injectCursor = () => {
                            if (document.getElementById('golden-mouse')) return;

                            const cursor = document.createElement('div');
                            cursor.id = 'golden-mouse';
                            cursor.style.cssText = `
                                position: fixed !important;
                                width: 32px !important;
                                height: 32px !important;
                                background: url(data:image/png;base64,${base64}) no-repeat center !important;
                                background-size: contain !important;
                                pointer-events: none !important;
                                z-index: 2147483647 !important;
                                left: -100px;
                                top: -100px;
                                filter: drop-shadow(0 0 5px rgba(255, 215, 0, 0.8)) !important;
                                transition: opacity 0.2s !important;
                            `;
                            document.documentElement.appendChild(cursor);

                            // Premium Golden click-ping ripple effect
                            window.addEventListener('mousedown', (e) => {
                                const ping = document.createElement('div');
                                ping.style.cssText = `
                                    position: fixed !important;
                                    left: ${e.clientX - 10}px !important;
                                    top: ${e.clientY - 10}px !important;
                                    width: 20px !important;
                                    height: 20px !important;
                                    border: 2px solid gold !important;
                                    border-radius: 50% !important;
                                    pointer-events: none !important;
                                    z-index: 2147483646 !important;
                                    animation: mouse-ping 0.5s ease-out forwards !important;
                                `;
                                document.body.appendChild(ping);
                                setTimeout(() => ping.remove(), 500);
                            }, true);

                            const style = document.createElement('style');
                            style.innerHTML = `
                                @keyframes mouse-ping {
                                    to { transform: scale(3); opacity: 0; }
                                }
                                * { cursor: none !important; }
                            `;
                            document.head.appendChild(style);

                            window.addEventListener('mousemove', (e) => {
                                cursor.style.left = e.clientX + 'px';
                                cursor.style.top = e.clientY + 'px';
                            }, true);
                        };
                        if (document.readyState === 'loading') {
                            document.addEventListener('DOMContentLoaded', injectCursor);
                        } else {
                            injectCursor();
                        }
                        setInterval(injectCursor, 1000);
                    }, mouseBase64);
                } catch (err) {
                    console.warn('⚠️ Golden mouse page injection warning:', err.message);
                }
            }

            // Apply timezone settings using the timezoneConfig
            await _page.emulateTimezone(timezoneConfigForBrowser.current);

            const overrideDate = browserConfig.privacy?.fingerprint?.overrideDate !== false;
            if (overrideDate) {
                await _page.evaluateOnNewDocument((tzConfig) => {
                    // Timezone Configuration
                    const currentOffset = tzConfig.offsets[tzConfig.current];
                    const tzFormatter = new Intl.DateTimeFormat('en-US', {
                        timeZone: tzConfig.current,
                        hour12: false,
                        year: 'numeric',
                        month: '2-digit',
                        day: '2-digit',
                        hour: '2-digit',
                        minute: '2-digit',
                        second: '2-digit'
                    });

                    // Store original objects
                    const RealDate = Date;

                    // Override Date
                    window.Date = class extends RealDate {
                        constructor(...args) {
                            if (args.length === 0) {
                                super();
                                const tzParts = tzFormatter.format(super.getTime())
                                    .split(/[/:\s]/)
                                    .map(p => parseInt(p, 10));

                                return new RealDate(
                                    tzParts[2], // year
                                    tzParts[0] - 1, // month
                                    tzParts[1], // day
                                    tzParts[3], // hour
                                    tzParts[4], // minute,
                                    tzParts[5] // second
                                );
                            }
                            return new RealDate(...args);
                        }

                        getTimezoneOffset() {
                            return currentOffset * 60;
                        }

                        toString() {
                            return tzFormatter.format(this) +
                                ` (${tzConfig.current.split('/')[1].replace('_', ' ')} Time)`;
                        }
                    };

                    // Preserve Date static methods
                    Object.getOwnPropertyNames(RealDate).forEach(prop => {
                        window.Date[prop] = RealDate[prop];
                    });

                    // Ensure timezone consistency in Intl
                    const originalDateTimeFormat = Intl.DateTimeFormat;
                    Intl.DateTimeFormat = function (locale, options = {}) {
                        options.timeZone = tzConfig.current;
                        return new originalDateTimeFormat(locale, options);
                    };
                    Intl.DateTimeFormat.prototype = originalDateTimeFormat.prototype;

                }, timezoneConfigForBrowser);
            }

            // Add CDP timezone + native hardware overrides (no JS injection needed)
            try {
                const client1 = await _page.target().createCDPSession();

                // Timezone
                await client1.send('Emulation.setTimezoneOverride', {
                    timezoneId: timezoneConfigForBrowser.current
                });

                // navigator.hardwareConcurrency — set at browser engine level, undetectable
                const _cores = generatedFingerprint.fingerprint.navigator.hardwareConcurrency || 8;
                try {
                    await client1.send('Emulation.setHardwareConcurrencyOverride', {
                        hardwareConcurrency: _cores
                    });
                } catch (e) { /* CDP command may not exist in this Chrome version */ }

                // screen dimensions — set at browser engine level via device metrics.
                // IMPORTANT: Use the actual window width/height (1400x900 or 412x915), NOT the
                // fingerprint screen.width (e.g. 1920) which is the *reported* screen resolution.
                // Passing 1920 here overrides window.innerWidth to 1920 while the actual Chrome
                // window is 1400px wide, which causes SportyBet to compute a collapsed container
                // height for the Virtustec iframe (< 400px), triggering the Angular shell freeze.
                const pageUrl = _page.url ? _page.url() : '';
                const isCrossOriginFrame = pageUrl.includes('virtustec.com') || pageUrl.includes('goldenrace.com');
                if (!isCrossOriginFrame) {
                    const _winW = isMobileDevice ? 412 : 1400;
                    const _winH = isMobileDevice ? 915 : 900;
                    const _dpr = generatedFingerprint.fingerprint.screen.devicePixelRatio || 1;
                    try {
                        await client1.send('Emulation.setDeviceMetricsOverride', {
                            width: _winW,
                            height: _winH,
                            deviceScaleFactor: _dpr,
                            mobile: isMobileDevice
                        });
                    } catch (e) { /* CDP command may not exist in this Chrome version */ }
                }

            } catch (e) {
                console.warn('Failed to set CDP Emulation overrides:', e.message);
            }

            // Block WebRTC via JS if enabled
            if (browserConfig.privacy?.webrtc?.block) {
                const webrtcBlockScript = `
                    try {
                        ['RTCPeerConnection', 'webkitRTCPeerConnection', 'mozRTCPeerConnection', 'RTCDataChannel', 'RTCIceCandidate', 'RTCSessionDescription'].forEach(prop => {
                            try { delete window[prop]; } catch(e) {}
                            try { delete globalThis[prop]; } catch(e) {}
                            try { delete Window.prototype[prop]; } catch(e) {}
                        });
                    } catch (e) {}
                `;
                await _page.evaluateOnNewDocument(webrtcBlockScript);
                await _page.evaluate(webrtcBlockScript); // Apply to current page immediately
            }
        }

        const fpProBypassScript = `
            (() => {
                // --- window.chrome injection (always-on, works in headless and headful) ---
                try {
                    if (!window.chrome || !window.chrome.runtime) {
                        const _noop = function() {};
                        const _chr = {
                            app: {
                                isInstalled: false,
                                getIsInstalled: _noop,
                                getDetails: _noop,
                                getInstallState: _noop,
                                runningState: 'cannot_run',
                                InstallState: { DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' },
                                RunningState: { CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running' }
                            },
                            csi: _noop,
                            loadTimes: _noop,
                            runtime: {
                                connect: _noop,
                                sendMessage: _noop,
                                id: undefined,
                                OnInstalledReason: { CHROME_UPDATE: 'chrome_update', INSTALL: 'install', SHARED_MODULE_UPDATE: 'shared_module_update', UPDATE: 'update' },
                                PlatformOs: { ANDROID: 'android', CROS: 'cros', LINUX: 'linux', MAC: 'mac', OPENBSD: 'openbsd', WIN: 'win' },
                                PlatformArch: { ARM: 'arm', ARM64: 'arm64', X86_32: 'x86-32', X86_64: 'x86-64', MIPS: 'mips', MIPS64: 'mips64' }
                            }
                        };
                        try {
                            Object.defineProperty(window, 'chrome', { value: _chr, writable: true, enumerable: true, configurable: true });
                        } catch(e) {
                            window.chrome = _chr;
                        }
                    }
                } catch(e) {}

                // --- WebGL VENDOR/RENDERER spoofing (two-layer: real context patch + fake context fallback) ---
                // Layer 1: If real WebGL exists, patch its prototype methods.
                // Layer 2: If getContext('webgl') returns null (no GPU / VM environment),
                //          intercept getContext() and return a minimal fake context so that
                //          fingerprint tests like Intoli/sannysoft still see a vendor + renderer.
                try {
                    const _sv = ${JSON.stringify(generatedFingerprint.fingerprint.videoCard?.vendor || 'Google Inc. (NVIDIA)')};
                    const _sr = ${JSON.stringify(generatedFingerprint.fingerprint.videoCard?.renderer || 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)')};
                    const _fakeExt = { UNMASKED_VENDOR_WEBGL: 37445, UNMASKED_RENDERER_WEBGL: 37446 };

                    // Layer 1 — patch real WebGL prototype if available
                    function _patchGL(proto) {
                        const _oe = proto.getExtension;
                        proto.getExtension = function(n) {
                            if (n === 'WEBGL_debug_renderer_info') return _fakeExt;
                            return _oe ? _oe.call(this, n) : null;
                        };
                        const _og = proto.getParameter;
                        proto.getParameter = function(p) {
                            if (p === 37445) return _sv;
                            if (p === 37446) return _sr;
                            return _og ? _og.call(this, p) : null;
                        };
                    }
                    try { _patchGL(WebGLRenderingContext.prototype); } catch(e) {}
                    try { if (typeof WebGL2RenderingContext !== 'undefined') _patchGL(WebGL2RenderingContext.prototype); } catch(e) {}


                } catch(e) {}

                // --- performance.memory spoofing via Proxy on __proto__ ---
                // No Object.* calls. Proxy intercepts 'memory' reads transparently.
                try {
                    const _mem = ${generatedFingerprint.fingerprint.navigator.deviceMemory || 8};
                    const _lim = _mem >= 8 ? 4294705152 : (_mem * 536870912);
                    const _memObj = {
                        jsHeapSizeLimit:  _lim,
                        totalJSHeapSize:  Math.floor(_lim * 0.3),
                        usedJSHeapSize:   Math.floor(_lim * 0.2)
                    };
                    performance.__proto__ = new Proxy(performance.__proto__, {
                        get(target, prop, receiver) {
                            if (prop === 'memory') return _memObj;
                            return Reflect.get(target, prop, receiver);
                        },
                        getPrototypeOf(target) { return target; }
                    });
                } catch(e) {}
                // --- IntersectionObserver override for Xvfb / headless environments ---
                // Golden Race desktop-v4 uses checkScroll=true, which means it waits for
                // IntersectionObserver to fire with isIntersecting=true before the Angular
                // game module router mounts. Under Xvfb, the compositor never reports
                // cross-origin iframe content as intersecting, so the game freezes at the
                // Angular shell (141 elements). This override forces callbacks to always
                // fire with isIntersecting=true, unblocking the game module initialization.
                try {
                    if (typeof IntersectionObserver !== 'undefined') {
                        const _OrigIO = window.IntersectionObserver;
                        window.IntersectionObserver = function(callback, options) {
                            const observer = new _OrigIO((entries, obs) => {
                                const patched = entries.map(e => {
                                    try {
                                        const d = {};
                                        for (const k of ['target','boundingClientRect','intersectionRect','rootBounds','time']) {
                                            try { d[k] = { value: e[k], writable: true, configurable: true }; } catch(_) {}
                                        }
                                        d.isIntersecting = { value: true, writable: true, configurable: true };
                                        d.intersectionRatio = { value: 1, writable: true, configurable: true };
                                        return Object.defineProperties(Object.create(IntersectionObserverEntry.prototype), d);
                                    } catch(_) { return e; }
                                });
                                callback(patched, obs);
                            }, options);

                            const _origObserve = observer.observe.bind(observer);
                            observer.observe = function(el) {
                                _origObserve(el);
                                // Also fire immediately with isIntersecting=true so games
                                // that check on observe() don't wait for a real scroll event
                                try {
                                    setTimeout(() => {
                                        try {
                                            const rect = el ? el.getBoundingClientRect() : {};
                                            callback([{
                                                isIntersecting: true,
                                                intersectionRatio: 1,
                                                target: el,
                                                boundingClientRect: rect,
                                                intersectionRect: rect,
                                                rootBounds: null,
                                                time: performance.now()
                                            }], observer);
                                        } catch(_) {}
                                    }, 50);
                                } catch(_) {}
                            };
                            return observer;
                        };
                        window.IntersectionObserver.prototype = _OrigIO.prototype;
                    }
                } catch(e) {}

            })();
        `;
        // ===========================================

        // perfMemoryScript merged into fpProBypassScript
        const perfMemoryScript = '';

        // Fix crashed session bubble before connecting
        await fixCrashedSession(targetUserDataDir, customConfig.profilePath);

        // --- Diagnostic logging: capture executablePath, userDataDir and args ---
        try {
            console.log('[Puppeteer-debug] executablePath:', browserOptions.executablePath);
            console.log('[Puppeteer-debug] resolved browser-config.paths.chrome:', browserConfig.paths?.chrome);
            console.log('[Puppeteer-debug] userDataDir:', browserOptions.userDataDir);
            console.log('[Puppeteer-debug] profilePath option:', customConfig.profilePath);
            console.log('[Puppeteer-debug] args count:', (browserOptions.args || []).length);
            try { console.log('[Puppeteer-debug] args:', JSON.stringify(browserOptions.args, null, 2)); } catch (e) { console.log('[Puppeteer-debug] args: <unserializable>'); }
            if (browserOptions.executablePath) {
                try {
                    console.log('[Puppeteer-debug] executable exists:', fs.existsSync(browserOptions.executablePath));
                } catch (e) { console.warn('[Puppeteer-debug] fs.existsSync check failed:', e && e.message); }
            }
        } catch (e) { console.warn('[Puppeteer-debug] pre-connect logging failed:', e && e.message); }

        let page, browser;
        let connectAttempts = 0;
        const maxConnectAttempts = 3;
        while (connectAttempts < maxConnectAttempts) {
            try {
                connectAttempts++;
                if (useRealBrowser) {
                    ({ page, browser } = await puppeteer.connect(browserOptions));
                    // puppeteer-real-browser patches navigator.webdriver, WebGL fingerprints and
                    // canvas APIs for full stealth, but it does NOT honour connectOption.defaultViewport
                    // on already-open pages. Without an explicit setViewport() call the page retains
                    // whatever Xvfb display dimensions were set at launch (often mismatched).
                    // SportyBet reads window.innerWidth to decide the Virtustec iframe container
                    // height — if that value is wrong the Angular game module freezes at 141 elements.
                    // Calling setViewport() here corrects the layout without breaking stealth.
                    try {
                        const vp = isMobileDevice
                            ? { width: 412, height: 915, isMobile: true, hasTouch: true }
                            : { width: 1400, height: 900 };
                        await page.setViewport(vp);
                    } catch (_) { }
                } else {
                    // Non-stealth fallback (unit tests / CI only)
                    const cleanArgs = (browserOptions.args || []).filter(a =>
                        !a.startsWith('--proxy-server') && !a.startsWith('--proxy-bypass-list')
                    );
                    browser = await puppeteer.launch({
                        executablePath: browserOptions.executablePath || browserConfig.paths.chrome,
                        userDataDir: browserOptions.userDataDir,
                        headless: options.headless ? 'new' : false,
                        args: cleanArgs,
                        defaultViewport: isMobileDevice
                            ? { width: 412, height: 915, isMobile: true, hasTouch: true }
                            : { width: 1400, height: 900 }
                    });
                    const pages = await browser.pages();
                    page = pages.length > 0 ? pages[0] : await browser.newPage();
                }

                // Register automatic process exit cleanup for Chrome
                const killChromeOnProcessExit = () => {
                    try {
                        const pid = browser && browser.process ? browser.process()?.pid : null;
                        if (pid) {
                            if (process.platform === 'win32') {
                                require('child_process').execSync(`taskkill /F /PID ${pid} /T`, { stdio: 'ignore' });
                            } else {
                                require('child_process').execSync(`pkill -9 -P ${pid} || true`, { stdio: 'ignore' });
                                require('child_process').execSync(`kill -9 ${pid} || true`, { stdio: 'ignore' });
                            }
                        }
                        if (targetUserDataDir) {
                            const folderName = path.basename(targetUserDataDir);
                            if (folderName) {
                                if (process.platform === 'win32') {
                                    require('child_process').execSync(`powershell -Command "Get-CimInstance Win32_Process -Filter \\"Name = 'chrome.exe'\\" | Where-Object { $_.CommandLine -like '*${folderName}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"`, { stdio: 'ignore' });
                                } else {
                                    const currentPid = process.pid;
                                    const safeKillFolderCmd = `ps aux | grep -E "(chrome|chromium)" | grep -F "${folderName}" | grep -v -E "electron|nexus-panel|antigravity|vscode|node_modules|${currentPid}" | awk '{print $2}' | xargs -r kill -9 || true`;
                                    require('child_process').execSync(safeKillFolderCmd, { stdio: 'ignore' });
                                }
                            }
                        }
                    } catch (e) { }
                };

                ['SIGINT', 'SIGTERM', 'SIGHUP', 'exit'].forEach(sig => {
                    process.once(sig, killChromeOnProcessExit);
                });
                break; // success!
            } catch (e) {
                console.warn(`[Puppeteer] connect() attempt ${connectAttempts} failed:`, e.message || e);

                // Terminate any launched Chrome process to avoid leaving orphaned zombie processes
                try {
                    if (targetUserDataDir) {
                        const profileFolderName = path.basename(targetUserDataDir);
                        const cmd = process.platform === 'win32'
                            ? `powershell -Command "Get-CimInstance Win32_Process -Filter \\"Name = 'chrome.exe'\\" | Where-Object { $_.CommandLine -like '*${profileFolderName}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"`
                            : `ps aux | grep -E "(chrome|chromium)" | grep -F "${profileFolderName}" | grep -v -E "electron|nexus-panel|antigravity|vscode|node_modules|${process.pid}" | awk '{print $2}' | xargs -r kill -9 || true`;
                        const { execSync } = require('child_process');
                        execSync(cmd);
                        console.log(`[Puppeteer] Cleaned up failed Chrome instance (${profileFolderName}) before retrying.`);
                    }
                } catch (cleanupErr) {
                    console.warn('[Puppeteer] Failed to clean up Chrome instance:', cleanupErr.message);
                }

                if (connectAttempts >= maxConnectAttempts) {
                    throw e; // rethrow after all attempts fail
                }
                const delayMs = 2000;
                console.log(`[Puppeteer] Retrying connect() in ${delayMs}ms...`);
                await new Promise(r => setTimeout(r, delayMs));
            }
        }


        // Unified targetcreated handler to apply timeouts, anti-detect fingerprinters, HTTP headers, timezone config, and visibility overrides to all new tabs/pages
        browser.on('targetcreated', async (target) => {
            try {
                const newPage = await target.page();
                if (newPage && !newPage.isClosed()) {
                    // Set default timeouts
                    await newPage.setDefaultNavigationTimeout(360000);
                    await newPage.setDefaultTimeout(360000);

                    // Inject dynamic fingerprint overrides
                    const fpConfig = browserConfig.privacy?.fingerprint || {};
                    if (fpConfig.overrideWebGL !== false || fpConfig.overrideHardware !== false) {
                        await newPage.evaluateOnNewDocument(fpProBypassScript);
                        await newPage.evaluate(fpProBypassScript).catch(() => { });
                    }
                    if (fpConfig.overrideHardware !== false) {
                        await newPage.evaluateOnNewDocument(perfMemoryScript);
                        await newPage.evaluate(perfMemoryScript).catch(() => { });
                        await newPage.evaluateOnNewDocument(hardwareScript);
                        await newPage.evaluate(hardwareScript).catch(() => { });
                    }
                    if (fpConfig.overrideUserAgentData !== false) {
                        await newPage.evaluateOnNewDocument(uaDataScript);
                        await newPage.evaluate(uaDataScript).catch(() => { });
                    }

                    // Note: setExtraHTTPHeaders removed to prevent CORS preflight & 403 Forbidden errors on cross-origin iframes (e.g. Virtustec)

                    // Run core page setup (timezone, cursor, etc.)
                    await setupPage(newPage);

                    // Inject Date and Timezone overrides
                    const overrideDate = browserConfig.privacy?.fingerprint?.overrideDate !== false;
                    if (overrideDate) {
                        try {
                            const dateOverrideFn = (tzConfig) => {
                                const currentOffset = tzConfig.offsets[tzConfig.current];
                                const tzFormatter = new Intl.DateTimeFormat('en-US', {
                                    timeZone: tzConfig.current,
                                    hour12: false,
                                    year: 'numeric',
                                    month: '2-digit',
                                    day: '2-digit',
                                    hour: '2-digit',
                                    minute: '2-digit',
                                    second: '2-digit'
                                });

                                const RealDate = Date;
                                window.Date = class extends RealDate {
                                    constructor(...args) {
                                        if (args.length === 0) {
                                            super();
                                            const tzParts = tzFormatter.format(super.getTime())
                                                .split(/[/:\s]/)
                                                .map(p => parseInt(p, 10));

                                            return new RealDate(
                                                tzParts[2],
                                                tzParts[0] - 1,
                                                tzParts[1],
                                                tzParts[3],
                                                tzParts[4],
                                                tzParts[5]
                                            );
                                        }
                                        return new RealDate(...args);
                                    }

                                    getTimezoneOffset() {
                                        return currentOffset * 60;
                                    }

                                    toString() {
                                        return tzFormatter.format(this) +
                                            ` (${tzConfig.current.split('/')[1].replace('_', ' ')} Time)`;
                                    }
                                };

                                Object.getOwnPropertyNames(RealDate).forEach(prop => {
                                    window.Date[prop] = RealDate[prop];
                                });

                                const originalDateTimeFormat = Intl.DateTimeFormat;
                                Intl.DateTimeFormat = function (locale, options = {}) {
                                    options.timeZone = tzConfig.current;
                                    return new originalDateTimeFormat(locale, options);
                                };
                                Intl.DateTimeFormat.prototype = originalDateTimeFormat.prototype;
                            };

                            await newPage.evaluateOnNewDocument(dateOverrideFn, timezoneConfigForBrowser);
                            await newPage.evaluate(dateOverrideFn, timezoneConfigForBrowser).catch(() => { });
                        } catch (error) {
                            if (!error.message.includes('Target closed') && !error.message.includes('Protocol error')) {
                                console.warn('Skipping timezone evaluateOnNewDocument due to closed target');
                            }
                        }
                    }

                    // Keep page active via CDP without breaking JS visibility listeners or iframe unload events
                    try {
                        const newClient = await newPage.target().createCDPSession();
                        await newClient.send('Page.setWebLifecycleState', { state: 'active' });
                        await newClient.send('Emulation.setFocusEmulationEnabled', { enabled: true });
                    } catch (e) { }

                    // Handle page errors
                    newPage.on('error', (err) => console.warn('Page error:', err));
                }
            } catch (error) {
                if (!error.message.includes('Target closed') && !error.message.includes('Protocol error')) {
                    console.error('Error in unified targetcreated handler:', error);
                }
            }
        });

        // Add error handlers for unexpected closures
        browser.on('disconnected', () => {
            console.error('\n=== Browser Disconnected ===');
            console.error('Browser instance was disconnected unexpectedly');
            // Cleanup and notify any active operations
            if (global.onBrowserDisconnect) {
                global.onBrowserDisconnect();
            }
        });

        page.on('error', (err) => {
            console.error('\n=== Page Error ===');
            console.error('Page crashed:', err);
        });

        page.on('close', () => {
            console.log('\n=== Page Closed ===');
            console.log('Page was closed, cleaning up...');
        });

        // Add try-catch for each critical operation
        try {
            // Iterate over all currently open pages to ensure we catch the true main tab
            const allPages = await browser.pages();

            for (const p of allPages) {
                if (p.url().includes('extension')) continue;

                const fpConfig = browserConfig.privacy?.fingerprint || {};

                // fpProBypassScript handles: SharedArrayBuffer + WebGL spoofing + maxTouchPoints
                if (fpConfig.overrideWebGL !== false || fpConfig.overrideHardware !== false) {
                    await p.evaluateOnNewDocument(fpProBypassScript);
                }
                if (fpConfig.overrideHardware !== false) {
                    await p.evaluateOnNewDocument(perfMemoryScript);
                    await p.evaluateOnNewDocument(hardwareScript);
                }
                if (fpConfig.overrideUserAgentData !== false) {
                    await p.evaluateOnNewDocument(uaDataScript);
                }

                // Execute scripts immediately on the current page to cover the time before the first navigation
                if (fpConfig.overrideWebGL !== false || fpConfig.overrideHardware !== false) {
                    await p.evaluate(fpProBypassScript).catch(() => { });
                }
                if (fpConfig.overrideHardware !== false) {
                    await p.evaluate(perfMemoryScript).catch(() => { });
                    await p.evaluate(hardwareScript).catch(() => { });
                }
                // Note: setExtraHTTPHeaders removed to prevent CORS preflight & 403 Forbidden errors on cross-origin iframes
            }


        } catch (err) {
            console.error('Fingerprint injection failed:', err);
            // Continue anyway as this is not critical
        }

        // Setup initial pages with pre-detected timezone (no new tabs opened)
        const allPagesForSetup = await browser.pages();
        for (const p of allPagesForSetup) {
            if (p.url().includes('extension')) continue;
            await setupPage(p);

            // Add CDP commands for focus maintenance without breaking document.visibilityState or events
            try {
                const cdpClient = await p.target().createCDPSession();
                await cdpClient.send('Page.setWebLifecycleState', { state: 'active' });
                await cdpClient.send('Emulation.setFocusEmulationEnabled', { enabled: true });
            } catch (e) { }
        }

        // Enhanced target handling
        // browser.on('targetcreated', async (target) => {
        //     try {
        //         if (target.type() === 'page') {
        //             const newPage = await target.page();
        //             if (newPage) {
        //                 // Set default timeout
        //                 await newPage.setDefaultNavigationTimeout(360000);
        //                 await newPage.setDefaultTimeout(360000);

        //                 // Handle page errors
        //                 newPage.on('error', (err) => {
        //                     console.warn('Page error:', err);
        //                 });

        //                 // Keep page alive
        //                 await newPage.evaluateOnNewDocument(() => {
        //                     window.addEventListener('unload', (e) => {
        //                         e.preventDefault();
        //                         e.stopPropagation();
        //                         return false;
        //                     });
        //                 });

        //                 // Existing page setup code...
        //                 await setupPage(newPage);
        //             }
        //         }
        //     } catch (error) {
        //         if (!error.message.includes('Target closed')) {
        //             console.error('Error handling new target:', error);
        //         }
        //     }
        // });

        // Add tab crash handling
        // browser.on('targetdestroyed', async (target) => {
        //     try {
        //         const allPages = await browser.pages();
        //         if (allPages.length === 0) {
        //             console.error('\n=== All Pages Closed ===');
        //             console.error('No pages remaining, initiating cleanup...');
        //             if (global.onBrowserDisconnect) {
        //                 global.onBrowserDisconnect();
        //             }
        //         }
        //     } catch (err) {
        //         // Browser might already be closed
        //         console.error('Error checking remaining pages:', err);
        //     }
        // });

        browser.on('disconnected', () => {
            console.log('Browser has been disconnected');
        });



        console.log('Reloading all non-extension tabs to guarantee anti-detect hooks apply perfectly...');
        const finalPages = await browser.pages();
        for (const p of finalPages) {
            if (p.url().includes('extension')) continue;
            try {
                await p.reload({ waitUntil: 'domcontentloaded' });
            } catch (e) {
                console.warn('Could not reload a page:', e.message);
            }
        }

        // ── Inject anti-detect scripts into cross-origin (OOPIF) child frames ──────
        // The targetcreated handler above MISSES cross-origin iframes because
        // target.page() returns null for Out-of-Process IFrame (OOPIF) targets.
        // framenavigated fires for ALL frames (main + child, in-process + OOPIF)
        // and gives a direct frame reference we can evaluate into — the only
        // reliable way to reach the Virtustec/GoldenRace iframe context.
        page.on('framenavigated', async (frame) => {
            if (frame === page.mainFrame()) return; // skip main frame, already handled
            const frameUrl = frame.url();
            if (!frameUrl || frameUrl === 'about:blank') return;

            const isGameFrame = frameUrl.includes('virtustec.com') || frameUrl.includes('goldenrace');

            if (isGameFrame) {
                // For Virtustec/GoldenRace frames: ONLY send the scroll handshake.
                // Do NOT inject prototype-spoofing scripts — they break zone.js and Angular's
                // instanceof Date checks, freezing the game module router at 141 elements.
                try {
                    await frame.evaluate(() => {
                        window.postMessage({ scroll: { top: 0, height: 900 } }, '*');
                    }).catch(() => { });
                } catch (_) { }
                return;
            }

            // For non-game cross-origin child frames: inject full anti-detect suite
            try {
                const fpConfig = browserConfig.privacy?.fingerprint || {};
                if (fpConfig.overrideWebGL !== false || fpConfig.overrideHardware !== false) {
                    await frame.evaluate(fpProBypassScript).catch(() => { });
                }
                if (fpConfig.overrideHardware !== false) {
                    if (hardwareScript) await frame.evaluate(hardwareScript).catch(() => { });
                }
                if (fpConfig.overrideUserAgentData !== false) {
                    if (uaDataScript) await frame.evaluate(uaDataScript).catch(() => { });
                }
            } catch (_) { }
        });

        console.log('Successfully connected to browser instance');
        if (page && typeof detectedTzInfo !== 'undefined') {
            page.timezoneOffsetMinutes = detectedTzInfo.offsetMinutes;
        }
        return page;
    } catch (error) {
        console.error('Browser connection error:', error);
        throw error;
    }
};
//---------------------------------------------------//
// let openai = null;
// try {
//     const { openaiClient } = require('./search-query-generation');
//     const browserConfig = require('./browser-config.json');
//     openai = openaiClient;
//     console.log('✅ OpenAI client imported from search-query-generation');
// } catch (error) {
//     console.error('❌ Failed to import OpenAI client:', error);
// }

module.exports = {
    customConfig,
    //generateSearchQuery,
    connect,
    deepSeekConfig,
    featureFlags: browserConfig.features,
    //   openai: openai, // Export the imported openaiClient as openai
    openAiConfig: {
        apiKey: process.env.OPENAI_API_KEY || '',
        model: 'gpt-3.5-turbo',
        temperature: 0.1,
        maxTokens: 5
    }
};