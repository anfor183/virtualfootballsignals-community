const fetch = require('node-fetch');

const TIMEZONE_SERVICES = [
    {
        name: 'ipapi.co',
        url: (ip) => `https://ipapi.co/${ip}/timezone`,
        parse: async (response) => await response.text()
    },
    {
        name: 'worldtimeapi',
        url: (ip) => `http://worldtimeapi.org/api/ip/${ip}`,
        parse: async (response) => {
            const data = await response.json();
            return data.timezone;
        }
    },
    {
        name: 'timezonedb',
        url: (ip) => `http://api.timezonedb.com/v2.1/get-time-zone?key=YOUR_API_KEY&format=json&by=position&lat=${ip.lat}&lng=${ip.lon}`,
        parse: async (response) => {
            const data = await response.json();
            return data.zoneName;
        }
    }
];

const getTimezoneFromIP = async (ip) => {
    if (!ip) {
        console.log('No IP provided, using local system timezone');
        return Intl.DateTimeFormat().resolvedOptions().timeZone;
    }

    console.log(`Attempting to detect timezone for IP: ${ip}`);

    for (const service of TIMEZONE_SERVICES) {
        try {
            console.log(`Trying timezone service: ${service.name}`);
            const response = await fetch(service.url(ip));
            
            if (!response.ok) {
                console.log(`${service.name} returned status ${response.status}, trying next...`);
                continue;
            }

            const timezone = await service.parse(response);
            
            if (timezone) {
                console.log(`Successfully detected timezone ${timezone} using ${service.name}`);
                return timezone;
            }
            
            console.log(`${service.name} returned no timezone, trying next...`);
        } catch (error) {
            console.log(`Service ${service.name} detection failed, trying next...`, error.message);
            continue;
        }
    }

    console.log('All timezone detection services failed, using system default');
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
};

/**
 * Detect timezone BEFORE browser launch using Node.js HTTP requests
 * Queries IP services directly to get the proxy's IP and timezone
 * @returns {Promise<{timezone: string, offset: string, offsetMinutes: number}>}
 */
const detectTimezonePreLaunch = async (proxyConfig = null) => {
    console.log('Detecting timezone before browser launch...');
    
    try {
        // Try multiple IP detection services to get current IP (through proxy if enabled)
        let detectedIP = null;
        
        const ipServices = [
            'https://api.ipify.org?format=json',
            'https://lumtest.com/myip.json',
            'http://ip-api.com/json'
        ];

        // Require axios locally just for this function if needed
        const axios = require('axios');
        let axiosConfig = { timeout: 10000 };
        
        if (proxyConfig && proxyConfig.enabled) {
            axiosConfig.proxy = {
                protocol: proxyConfig.protocol || 'http',
                host: proxyConfig.host,
                port: parseInt(proxyConfig.port),
            };
            if (proxyConfig.username && proxyConfig.password) {
                axiosConfig.proxy.auth = {
                    username: proxyConfig.username,
                    password: proxyConfig.password
                };
            }
        }

        for (const service of ipServices) {
            try {
                console.log(`Querying IP from ${service}...`);
                const response = await axios.get(service, axiosConfig);
                const data = response.data;
                
                if (data.ip) {
                    detectedIP = data.ip;
                    console.log(`✅ Detected IP: ${detectedIP}`);
                    break;
                } else if (data.query) {
                    detectedIP = data.query;
                    console.log(`✅ Detected IP: ${detectedIP}`);
                    break;
                }
            } catch (error) {
                console.log(`Failed to get IP from ${service}:`, error.message);
                continue;
            }
        }

        if (!detectedIP) {
            console.warn('Could not detect IP, falling back to system timezone');
            const systemTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
            return {
                timezone: systemTz,
                offset: new Date().toLocaleString('en-US', { 
                    timeZone: systemTz, 
                    timeZoneName: 'short' 
                }).split(' ').pop(),
                offsetMinutes: -(new Date().getTimezoneOffset())
            };
        }

        // Now get timezone for the detected IP
        const timezone = await getTimezoneFromIP(detectedIP);
        
        // Calculate offset
        const getOffset = (tz) => {
            try {
                const d = new Date();
                const tzDate = new Date(d.toLocaleString('en-US', { timeZone: tz }));
                const utcDate = new Date(d.toLocaleString('en-US', { timeZone: 'UTC' }));
                return Math.round((tzDate.getTime() - utcDate.getTime()) / 60000);
            } catch (e) { 
                return -(new Date().getTimezoneOffset());
            }
        };

        const offset = getOffset(timezone);
        const offsetStr = new Date().toLocaleString('en-US', { 
            timeZone: timezone, 
            timeZoneName: 'short' 
        }).split(' ').pop();

        console.log(`✅ Pre-launch timezone detection: ${timezone} (UTC${offsetStr})`);
        
        return {
            timezone,
            offset: offsetStr,
            offsetMinutes: offset,
            ip: detectedIP
        };
    } catch (error) {
        console.error('Pre-launch timezone detection error:', error);
        console.log('Falling back to system timezone');
        
        const systemTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
        return {
            timezone: systemTz,
            offset: new Date().toLocaleString('en-US', { 
                timeZone: systemTz, 
                timeZoneName: 'short' 
            }).split(' ').pop(),
            offsetMinutes: -(new Date().getTimezoneOffset()),
            ip: 'Direct Connection'
        };
    }
};

module.exports = {
    getTimezoneFromIP,
    detectTimezonePreLaunch
};
