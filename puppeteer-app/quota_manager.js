
const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.resolve(__dirname, 'browser-config.json');

/**
 * QuotaManager - Handles click limits and tracking
 */
class QuotaManager {
    static getQuota() {
        try {
            const data = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
            return data.clickQuota || {
                daily: 100, weekly: 700, monthly: 3000,
                current: { daily: 0, weekly: 0, monthly: 0, lastReset: {} }
            };
        } catch (e) {
            return { daily: 100, weekly: 700, monthly: 3000, current: { daily: 0, weekly: 0, monthly: 0, lastReset: {} } };
        }
    }

    static checkQuota() {
        const quota = this.getQuota();
        this.verifyResets(quota);

        if (quota.current.daily >= quota.daily) return { exceeded: true, type: 'daily' };
        if (quota.current.weekly >= quota.weekly) return { exceeded: true, type: 'weekly' };
        if (quota.current.monthly >= quota.monthly) return { exceeded: true, type: 'monthly' };
        
        return { exceeded: false };
    }

    static incrementClick() {
        let attempts = 0;
        const maxAttempts = 5;
        
        while (attempts < maxAttempts) {
            try {
                const data = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
                const quota = data.clickQuota;
                
                this.verifyResets(quota);

                quota.current.daily++;
                quota.current.weekly++;
                quota.current.monthly++;

                fs.writeFileSync(CONFIG_PATH, JSON.stringify(data, null, 4));
                console.log(`📊 [QUOTA] Click incremented. Remaining Daily: ${quota.daily - quota.current.daily}`);
                return;
            } catch (e) {
                attempts++;
                if (attempts === maxAttempts) console.error('❌ Failed to update quota after 5 attempts:', e.message);
                const wait = Math.floor(Math.random() * 200) + 50;
                // Synchronous wait for simple locking
                const start = Date.now();
                while(Date.now() - start < wait); 
            }
        }
    }

    static verifyResets(quota) {
        const now = new Date();
        const last = quota.current.lastReset || {};

        // Daily reset (at midnight)
        if (!last.daily || new Date(last.daily).getDate() !== now.getDate()) {
            quota.current.daily = 0;
            quota.current.lastReset.daily = now.toISOString();
        }

        // Weekly reset (on Monday)
        const getWeekNumber = (d) => {
            d = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
            d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
            const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
            return Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
        };
        if (!last.weekly || getWeekNumber(new Date(last.weekly)) !== getWeekNumber(now)) {
            quota.current.weekly = 0;
            quota.current.lastReset.weekly = now.toISOString();
        }

        // Monthly reset (on 1st)
        if (!last.monthly || new Date(last.monthly).getMonth() !== now.getMonth()) {
            quota.current.monthly = 0;
            quota.current.lastReset.monthly = now.toISOString();
        }
    }
}

module.exports = QuotaManager;
