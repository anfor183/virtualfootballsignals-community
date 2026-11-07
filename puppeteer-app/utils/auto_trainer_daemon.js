/**
 * auto_trainer_daemon.js
 * =======================
 * Dedicated background worker that periodically checks database matches
 * and retrains AI models automatically whenever new match outcomes settle.
 */

const path = require('path');
const fs = require('fs');
const { triggerAutoTrainingIfDue } = require('./auto_trainer');

const DB_PATH = process.argv[2] || path.join(__dirname, '../databases/sportybet_archive.db');
const CHECK_INTERVAL_MS = 5 * 60 * 1000; // Check every 5 minutes

console.log(`[AutoTrainer Daemon] 🚀 Started monitoring ${DB_PATH} for continuous AI model training...`);

async function runCheck() {
    try {
        if (fs.existsSync(DB_PATH)) {
            triggerAutoTrainingIfDue(DB_PATH, { minNewMatches: 20, intervalMinutes: 60 });
        }
    } catch (e) {
        console.error('[AutoTrainer Daemon] Error during check:', e.message);
    }
}

// Stagger initial check on boot (20s delay) to avoid simultaneous cold-start contention with scrapers
setTimeout(() => {
    runCheck();
    // Recurring timer loop
    setInterval(runCheck, CHECK_INTERVAL_MS);
}, 20000);
