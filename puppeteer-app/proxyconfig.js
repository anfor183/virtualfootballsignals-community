const OpenAI = require('openai');
const os = require('os');
const browserConfig = require('./browser-config.json');
const fetch = require('node-fetch');
const { testProxyConnectivity, checkScamalytics } = require('./utils/pre-launch-proxy-check');
const { detectTimezonePreLaunch } = require('./utils/ip-utils');
const fs = require('fs');
const path = require('path');

// Dynamically resolve Chrome and UserDataDir paths to avoid hardcoded machine-specific paths
(function resolveDynamicPaths() {
    if (browserConfig && browserConfig.paths) {
        // 1. Resolve Chrome executable path
        const isWindows = process.platform === 'win32';
        const targetName = isWindows ? 'chrome.exe' : 'chrome';
        let chromeExists = false;
        
        if (browserConfig.paths.chrome) {
            try {
                chromeExists = fs.existsSync(browserConfig.paths.chrome);
            } catch (e) {}
        }
        
        if (!chromeExists) {
            console.log(`[Bot ProxyConfig] 🔍 Chrome path in config does not exist: "${browserConfig.paths.chrome}". Searching locally...`);
            const localChromeDir = path.join(__dirname, 'chrome');
            if (fs.existsSync(localChromeDir)) {
                // BFS to find chrome.exe or chrome
                const queue = [localChromeDir];
                let foundPath = null;
                while (queue.length > 0) {
                    const currentDir = queue.shift();
                    let files = [];
                    try {
                        files = fs.readdirSync(currentDir, { withFileTypes: true });
                    } catch (e) {}
                    for (const file of files) {
                        const fullPath = path.join(currentDir, file.name);
                        if (file.isDirectory()) {
                            queue.push(fullPath);
                        } else if (file.isFile() && file.name.toLowerCase() === targetName) {
                            foundPath = fullPath;
                            break;
                        }
                    }
                    if (foundPath) break;
                }
                
                if (foundPath) {
                    console.log(`[Bot ProxyConfig] ✅ Dynamically found Chrome executable: ${foundPath}`);
                    browserConfig.paths.chrome = foundPath;
                } else {
                    console.warn(`[Bot ProxyConfig] ❌ Could not find Chrome executable inside local "chrome/" directory.`);
                }
            } else {
                console.warn(`[Bot ProxyConfig] ❌ Local "chrome/" directory does not exist at: ${localChromeDir}`);
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
            console.warn(`[Bot ProxyConfig] ⚠️ UserDataDir drive does not exist for: "${userDataPath}". Falling back to: "${defaultUserDir}"`);
            browserConfig.paths.userDataDir = defaultUserDir;
        }
    }
})();

const {
    generateSearchQuery,
    generateYTQuery,
    generateSundayYTQuery,
    generateLIQuery
} = require('./search-query-generation');
const { getTimezoneFromIP } = require('./utils/ip-utils');


const args = process.argv.slice(2);
const userDataDirArg = args.find(arg => arg.startsWith('--user-data-dir='))?.split('=')[1];
let deviceArg = args.find(arg => arg.startsWith('--device='))?.split('=')[1] || 'random';

if (deviceArg === 'random') {
    const devices = ['desktop', 'mac', 'linux', 'mobile'];
    deviceArg = devices[Math.floor(Math.random() * devices.length)];
    console.log(`🎲 Random device selected: ${deviceArg}`);
}

let isMobileDevice = deviceArg === 'mobile';

let browserArg = args.find(arg => arg.startsWith('--browser='))?.split('=')[1] || 'random';

if (browserArg === 'random') {
    const browsers = ['chrome', 'firefox', 'safari', 'edge'];
    // Weighted random selection: Chrome (60%), Firefox (15%), Safari (15%), Edge (10%)
    const roll = Math.random();
    if (roll < 0.60) browserArg = 'chrome';
    else if (roll < 0.75) browserArg = 'firefox';
    else if (roll < 0.90) browserArg = 'safari';
    else browserArg = 'edge';
    console.log(`🎲 Random browser selected: ${browserArg}`);
}

//-----------------------------------------------//
const customConfig = {
    executablePath: browserConfig.paths.chrome,
    chromePath: browserConfig.paths.chrome,
    userDataDir: userDataDirArg || browserConfig.paths.userDataDir,
    profilePath: browserConfig.paths.profilePath,
    cursorPath: browserConfig.paths.cursorPath,
    args: [
        '--disable-features=IsolateOrigins,site-per-process,Notifications,GeolocationAPI',
        '--enable-features=NetworkService',
        '--start-maximized',
        '--enable-automation=false',
        '--disable-blink-features=AutomationControlled',
        '--no-sandbox',
        '--disable-notifications',
        '--js-flags=--expose-gc',
        '--disable-dev-shm-usage',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--memory-pressure-off',
        `--disable-gpu=${!browserConfig.hardware.acceleration.enabled}`,
        `--disable-gpu-compositing=${!browserConfig.hardware.acceleration.enabled}`,
        `--enable-gpu-rasterization=${browserConfig.hardware.acceleration.enabled}`,
        `--enable-zero-copy=${browserConfig.hardware.acceleration.enabled}`,
        `--canvas-msaa-sample-count=${browserConfig.hardware.acceleration.enabled ? 4 : 0}`,
        '--enable-gpu-memory-buffer-video-frames',
        `--use-gl=${browserConfig.hardware.acceleration.canvas}`,
        '--enable-data-saver',
        '--force-enable-data-saver'
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
// Add this function near the top with other imports/constants
async function getIPBasedTimezone(page) {
    try {
        // Get IP and location data using the browser's context
        const ipData = await page.evaluate(async () => {
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
            } catch (e) { }

            try {
                const response = await fetch('https://lumtest.com/myip.json');
                const data = await response.json();
                if (data && data.geo && data.geo.tz) {
                    return {
                        timezone: data.geo.tz,
                        offsetMinutes: getOffset(data.geo.tz)
                    };
                }
            } catch (e) { }

            try {
                const response = await fetch('http://ip-api.com/json');
                const data = await response.json();
                if (data && data.timezone) {
                    return {
                        timezone: data.timezone,
                        offsetMinutes: getOffset(data.timezone)
                    };
                }
            } catch (e) { }

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
            } catch (err) { }
            return null;
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
//-----------------------------------------------//
const connect = async function () {
    const puppeteer = require('puppeteer-real-browser');
    const proxyChain = require('proxy-chain');
    console.log('Attempting to connect to browser instance...');

    // --- Profile-Specific Proxy Loading ---
    const fs = require('fs');
    const path = require('path');
    if (customConfig.userDataDir) {
        const profileProxyPath = path.join(customConfig.userDataDir, 'proxy.json');
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

    const { FingerprintGenerator } = require('fingerprint-generator');
    const { FingerprintInjector } = require('fingerprint-injector');

    // Initialize BrowserHeadersGenerator
    let browserHeadersGenerator;
    let randomBrowserHeaders = {};
    try {
        const BrowserHeadersGenerator = require('browser-headers-generator').default || require('browser-headers-generator');
        browserHeadersGenerator = new BrowserHeadersGenerator();
        await browserHeadersGenerator.initialize();
        randomBrowserHeaders = await browserHeadersGenerator.getRandomizedHeaders();
    } catch (err) {
        console.warn('Failed to initialize browser headers generator', err);
    }

    let targetOS = 'windows';
    if (deviceArg === 'mac') targetOS = 'macos';
    else if (deviceArg === 'linux') targetOS = 'linux';
    else if (deviceArg === 'mobile') targetOS = 'android';

    if (browserArg === 'safari') {
        targetOS = 'macos';
    }

    const fingerprintGenerator = new FingerprintGenerator({
        browsers: [{ name: browserArg, minVersion: 100 }],
        devices: isMobileDevice ? ['mobile'] : ['desktop'],
        operatingSystems: [targetOS],
    });

    const generatedFingerprint = fingerprintGenerator.getFingerprint({
        locales: ['en-US', 'en'],
    });

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
        uaData.mobile = uaData.mobile !== undefined ? uaData.mobile : false;

        let platform = 'Windows';
        if (ua.includes('Mac OS X')) platform = 'macOS';
        else if (ua.includes('Linux')) platform = 'Linux';
        else if (ua.includes('Android')) platform = 'Android';
        else if (ua.includes('iPhone') || ua.includes('iPad')) platform = 'iOS';

        uaData.platform = uaData.platform || platform;

        uaData.wow64 = uaData.wow64 !== undefined ? uaData.wow64 : false;
        uaData.formFactors = uaData.formFactors || ['Desktop'];
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

    console.log('--- Generated WebGL Info ---');
    console.log(generatedFingerprint.fingerprint.videoCard);
    console.log('----------------------------');

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

    try {
        const browserOptions = {
            headless: false,
            userAgent: generatedFingerprint.fingerprint.navigator.userAgent,
            executablePath: customConfig.executablePath,
            userDataDir: customConfig.userDataDir,
            customConfig: customConfig,
            turnstile: false,
            connectOption: {
                defaultViewport: null,
                protocolTimeout: 180000,
                timeout: 180000
            },
            disableXvfb: false,
            ignoreAllFlags: true,
            args: [
                '--disable-features=Notifications,GeolocationAPI',
                '--disable-geolocation',
                '--deny-permission-prompts',
                `--user-agent=${generatedFingerprint.fingerprint.navigator.userAgent}`
            ]
        };

        // Add tab management settings
        browserOptions.args.push(
            '--disable-backgrounding-occluded-windows',
            '--disable-renderer-backgrounding',
            '--disable-background-timer-throttling'
        );

        // Add WebRTC blocking settings
        if (browserConfig.privacy?.webrtc?.block) {
            browserOptions.args.push(
                '--disable-webrtc',
                '--force-webrtc-ip-handling-policy=disable_non_proxied_udp'
            );
        }

        let newProxyUrl = null;

        // ===== PRE-LAUNCH PROXY AND TIMEZONE CHECKS =====
        console.log('\n=== Pre-Launch Checks (Before Browser Launch) ===');

        let timezoneConfigForBrowser = null;

        // Check proxy connectivity BEFORE browser launch if proxy is enabled
        if (browserConfig.proxy.enabled) {
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

        const os = require('os');
        const fs = require('fs');
        const path = require('path');

        // Only save history for permanent profiles
        if (customConfig.userDataDir && !customConfig.userDataDir.includes(os.tmpdir())) {
            try {
                const historyPath = path.join(customConfig.userDataDir, 'history.json');
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
                if (!fs.existsSync(customConfig.userDataDir)) {
                    fs.mkdirSync(customConfig.userDataDir, { recursive: true });
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
        if (browserConfig.proxy.enabled) {
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

                if (browserConfig.proxy.fallback.useDirectConnection) {
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

            // Apply timezone settings using the timezoneConfig
            await _page.emulateTimezone(timezoneConfigForBrowser.current);
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

            // Add CDP timezone override
            try {
                const client1 = await _page.target().createCDPSession();
                await client1.send('Emulation.setTimezoneOverride', {
                    timezoneId: timezoneConfigForBrowser.current
                });
            } catch (e) {
                console.warn('Failed to set Timezone Override:', e.message);
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
        const perfMemoryScript = `
            (() => {
                try {
                    if (performance && performance.memory) {
                        const mem = ${generatedFingerprint.fingerprint.navigator.deviceMemory || 8};
                        const limit = mem >= 8 ? 4294705152 : (mem * 536870912);
                        const memObj = {
                            jsHeapSizeLimit: limit,
                            totalJSHeapSize: Math.floor(limit * 0.3),
                            usedJSHeapSize: Math.floor(limit * 0.2)
                        };
                        Object.defineProperty(performance, 'memory', {
                            get: () => memObj,
                            enumerable: true,
                            configurable: true
                        });
                    }
                } catch(e) {}
            })();
        `;

        const { page, browser } = await puppeteer.connect(browserOptions);

        // Unified targetcreated handler to apply timeouts, anti-detect fingerprinters, HTTP headers, timezone config, and visibility overrides to all new tabs/pages
        browser.on('targetcreated', async (target) => {
            try {
                const newPage = await target.page();
                if (newPage && !newPage.isClosed()) {
                    // Set default timeouts
                    await newPage.setDefaultNavigationTimeout(360000);
                    await newPage.setDefaultTimeout(360000);

                    // Inject dynamic fingerprint overrides
                    const injectionScript = fingerprintInjector.getInjectableScript(generatedFingerprint);
                    await newPage.evaluateOnNewDocument(perfMemoryScript);
                    await newPage.evaluate(perfMemoryScript).catch(() => {});
                    await newPage.evaluateOnNewDocument(injectionScript);
                    await newPage.evaluate(injectionScript).catch(() => {});
                    await newPage.evaluateOnNewDocument(uaDataScript);
                    await newPage.evaluate(uaDataScript).catch(() => {});

                    // Copy all Client Hints and HTTP headers from main page configuration to the new tab
                    if (Object.keys(randomBrowserHeaders).length > 0) {
                        const stringHeaders = Object.fromEntries(Object.entries(randomBrowserHeaders).map(([k, v]) => [k, String(v)]));
                        await newPage.setExtraHTTPHeaders(stringHeaders);
                    }

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
                            await newPage.evaluate(dateOverrideFn, timezoneConfigForBrowser).catch(() => {});
                        } catch (error) {
                            if (!error.message.includes('Target closed') && !error.message.includes('Protocol error')) {
                                console.warn('Skipping timezone evaluateOnNewDocument due to closed target');
                            }
                        }
                    }

                    // Visibility overrides
                    const visibilityOverrideFn1 = () => {
                        Object.defineProperty(document, 'hidden', { value: false, writable: false });
                        Object.defineProperty(document, 'visibilityState', { value: 'visible', writable: false });
                        Object.defineProperty(document, 'webkitVisibilityState', { value: 'visible', writable: false });
                        document.dispatchEvent(new Event('visibilitychange'));

                        window.onblur = null;
                        window.onfocus = null;

                        const originalHasFocus = Document.prototype.hasFocus;
                        Document.prototype.hasFocus = function () { return true; };
                    };
                    await newPage.evaluateOnNewDocument(visibilityOverrideFn1);
                    await newPage.evaluate(visibilityOverrideFn1).catch(() => {});

                    const visibilityOverrideFn2 = () => {
                        const originalRequestAnimationFrame = window.requestAnimationFrame;
                        window.requestAnimationFrame = (callback) => {
                            return originalRequestAnimationFrame(callback);
                        };

                        document.addEventListener('visibilitychange', (e) => {
                            e.stopImmediatePropagation();
                        }, true);
                    };
                    await newPage.evaluateOnNewDocument(visibilityOverrideFn2);
                    await newPage.evaluate(visibilityOverrideFn2).catch(() => {});

                    // CDP focus/lifecycle state
                    try {
                        const newClient = await newPage.target().createCDPSession();
                        await newClient.send('Page.setWebLifecycleState', { state: 'active' });
                        await newClient.send('Emulation.setFocusEmulationEnabled', { enabled: true });
                    } catch (e) {}

                    // Handle page errors
                    newPage.on('error', (err) => console.warn('Page error:', err));

                    // Keep page alive
                    const unloadFn = () => {
                        window.addEventListener('unload', (e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            return false;
                        });
                    };
                    await newPage.evaluateOnNewDocument(unloadFn);
                    await newPage.evaluate(unloadFn).catch(() => {});
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
            const injectionScript = fingerprintInjector.getInjectableScript(generatedFingerprint);

            for (const p of allPages) {
                if (p.url().includes('extension')) continue;

                // Inject dynamic fingerprint immediately after page creation
                await p.evaluateOnNewDocument(perfMemoryScript);
                await p.evaluateOnNewDocument(injectionScript);
                await p.evaluateOnNewDocument(uaDataScript);

                // Execute scripts immediately on the current page to cover the time before the first navigation
                await p.evaluate(perfMemoryScript).catch(() => { });
                await p.evaluate(injectionScript).catch(() => { });
                await p.evaluate(uaDataScript).catch(() => { });

                // Ensure HTTP headers are set for all existing pages
                if (Object.keys(randomBrowserHeaders).length > 0) {
                    const stringHeaders = Object.fromEntries(Object.entries(randomBrowserHeaders).map(([k, v]) => [k, String(v)]));
                    await p.setExtraHTTPHeaders(stringHeaders);
                }
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

            // Override page visibility state
            await p.evaluateOnNewDocument(() => {
                Object.defineProperty(document, 'hidden', { value: false, writable: false });
                Object.defineProperty(document, 'visibilityState', { value: 'visible', writable: false });
                Object.defineProperty(document, 'webkitVisibilityState', { value: 'visible', writable: false });
                document.dispatchEvent(new Event('visibilitychange'));

                // Override blur/focus events
                window.onblur = null;
                window.onfocus = null;

                // Override native focus detection
                const originalHasFocus = Document.prototype.hasFocus;
                Document.prototype.hasFocus = function () { return true; };
            });

            await p.evaluateOnNewDocument(() => {
                // Additional visibility protections
                const originalRequestAnimationFrame = window.requestAnimationFrame;
                window.requestAnimationFrame = (callback) => {
                    return originalRequestAnimationFrame(callback);
                };

                // Override page visibility API
                document.addEventListener('visibilitychange', (e) => {
                    e.stopImmediatePropagation();
                }, true);
            });

            // Add CDP commands for focus maintenance
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

        // Handle new pages with timezone config


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

        console.log('Successfully connected to browser instance');
        return page;
    } catch (error) {
        console.error('Browser connection error:', error);
        throw error;
    }
};
//---------------------------------------------------//
let openai = null;
try {
    const { openaiClient } = require('./search-query-generation');
    const browserConfig = require('./browser-config.json');
    openai = openaiClient;
    console.log('✅ OpenAI client imported from search-query-generation');
} catch (error) {
    console.error('❌ Failed to import OpenAI client:', error);
}

module.exports = {
    customConfig,
    generateSearchQuery,
    generateYTQuery,
    generateLIQuery,
    generateSundayYTQuery,
    connect,
    deepSeekConfig,
    featureFlags: browserConfig.features,
    openai: openai, // Export the imported openaiClient as openai
    openAiConfig: {
        apiKey: process.env.OPENAI_API_KEY || '',
        model: 'gpt-3.5-turbo',
        temperature: 0.1,
        maxTokens: 5
    }
};