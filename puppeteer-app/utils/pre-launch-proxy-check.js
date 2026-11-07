const axios = require('axios');
const fs = require('fs');
const path = require('path');

/**
 * Tests proxy connectivity by making an HTTP request through the proxy
 * @param {Object} proxyConfig - Proxy configuration object
 * @returns {Promise<{valid: boolean, ip?: string, error?: string}>}
 */
async function testProxyConnectivity(proxyConfig) {
    if (!proxyConfig || !proxyConfig.enabled) {
        return { valid: true };
    }

    const { protocol, host, port, username, password } = proxyConfig;
    if (!host || !port) {
        return { valid: false, error: 'Proxy host or port not configured' };
    }

    console.log(`Testing proxy connectivity: ${protocol}://${host}:${port}`);

    // Try a few reliable IP check services (using http instead of https to prevent Axios proxy tunneling issues)
    const testServices = [
        'http://api.ipify.org?format=json',
        'http://api.myip.com'
    ];

    let lastError = null;

    for (const service of testServices) {
        try {
            const axiosConfig = {
                timeout: 10000,
                proxy: {
                    protocol: protocol || 'http',
                    host: host,
                    port: parseInt(port)
                }
            };

            if (username && password) {
                axiosConfig.proxy.auth = {
                    username: username,
                    password: password
                };
            }

            const response = await axios.get(service, axiosConfig);
            const data = response.data;
            const ip = data.ip || data.query || (data.ipString);

            if (ip) {
                return { valid: true, ip };
            }
        } catch (err) {
            console.warn(`Proxy test failed on ${service}: ${err.message}`);
            lastError = err;
        }
    }

    return {
        valid: false,
        error: lastError ? lastError.message : 'All connectivity test services failed'
    };
}

/**
 * Performs a Scamalytics fraud/risk score check on an IP address
 * @param {string} ipAddress - The IP to check
 * @returns {Promise<boolean>} - Returns true if the IP is clean and below risk threshold, false otherwise
 */
async function checkScamalytics(ipAddress) {
    try {
        // Load the latest config directly from the JSON file to ensure we get active UI saves
        const configPath = path.join(__dirname, '../browser-config.json');
        if (!fs.existsSync(configPath)) {
            console.warn('browser-config.json not found, skipping Scamalytics check');
            return true;
        }

        const browserConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));

        if (!browserConfig.proxy?.scamalytics?.enabled) {
            console.log('Scamalytics check skipped - not enabled in config');
            return true;
        }

        const { hostname, username, apiKey, maxRiskScore } = browserConfig.proxy.scamalytics;

        if (!username || !apiKey) {
            console.warn('Scamalytics credentials incomplete - skipping check');
            return true;
        }

        const host = hostname || 'api.scamalytics.com';
        const limit = maxRiskScore !== undefined ? maxRiskScore : 50;

        // Scamalytics standard query format
        const apiUrl = `https://${host}/${username}/?key=${apiKey}&ip=${ipAddress}`;
        console.log(`Checking IP ${ipAddress} on Scamalytics (Threshold: ${limit})...`);

        const response = await axios.get(apiUrl, { timeout: 10000 });
        const data = response.data;

        console.log('Scamalytics pre-launch response status:', data.status);

        if (data.credits) {
            console.log(`Scamalytics Credits: Used: ${data.credits.used}, Remaining: ${data.credits.remaining}`);
        }

        if (data.status !== 'ok') {
            console.error(`Scamalytics API returned error: ${data.error || 'Unknown error'}`);
            return false;
        }

        const riskScore = parseInt(data.score) || 0;
        console.log(`Scamalytics Risk Score for ${ipAddress}: ${riskScore}`);

        if (riskScore > limit) {
            console.error(`❌ Proxy IP risk score too high: ${riskScore} (Max limit: ${limit})`);
            return false;
        }

        console.log(`✅ Proxy IP is clean! Risk Score: ${riskScore}`);
        return true;
    } catch (error) {
        console.error('Error during Scamalytics check:', error.message);
        // Fail-safe: if Scamalytics API is down/rate-limited, let it pass so the bot doesn't crash unnecessarily
        return true;
    }
}

module.exports = {
    testProxyConnectivity,
    checkScamalytics
};
