/**
 * Google Drive Background Synchronization Daemon
 * 
 * Runs continuously in the background independently of the Electron dashboard window.
 * Synchronizes all database folder contents and scoped configuration files to Google Drive.
 * Automatically exits if sync is disabled from the dashboard.
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const PID_FILE = path.join(PROJECT_ROOT, 'google_sync_daemon.pid');
const LOG_FILE = path.join(PROJECT_ROOT, 'google_sync_daemon.log');
const CONFIG_PATH = path.join(PROJECT_ROOT, 'browser-config.json');

const INTERVAL_MS_MAP = {
  '1h': 60 * 60 * 1000,
  '6h': 6 * 60 * 60 * 1000,
  '12h': 12 * 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000
};

function log(message, level = 'INFO') {
  const timestamp = new Date().toISOString();
  const logLine = `[${timestamp}] [${level}] ${message}\n`;
  try {
    process.stdout.write(logLine);
    fs.appendFileSync(LOG_FILE, logLine);
  } catch (_) {}
}

/**
 * Check if a process with given PID is currently running
 */
function isPidAlive(pid) {
  if (!pid || isNaN(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM'; // Running under another user
  }
}

/**
 * Get current daemon status
 */
function getDaemonStatus() {
  if (!fs.existsSync(PID_FILE)) {
    return { running: false, pid: null };
  }
  try {
    const pid = parseInt(fs.readFileSync(PID_FILE, 'utf8').trim(), 10);
    if (isPidAlive(pid)) {
      return { running: true, pid };
    }
    // Stale PID file
    try { fs.unlinkSync(PID_FILE); } catch (_) {}
    return { running: false, pid: null };
  } catch (_) {
    return { running: false, pid: null };
  }
}

/**
 * Perform a full sync pass of the database folder and configured scope
 */
function performSyncPass() {
  try {
    const { syncDatabasesToGoogleDrive } = require('./google_sync_helper.js');
    log('Triggering scheduled Google Drive synchronization...', 'INFO');
    const result = syncDatabasesToGoogleDrive(PROJECT_ROOT);
    if (result && result.success) {
      log(`Sync succeeded: ${result.count || 0} files backed up to ${result.destination}`, 'SUCCESS');
      return true;
    } else if (result && result.skipped) {
      log(`Sync skipped: ${result.reason}`, 'INFO');
      return false;
    } else {
      log(`Sync failed: ${result?.error || result?.reason || 'Unknown error'}`, 'WARN');
      return false;
    }
  } catch (err) {
    log(`Sync error: ${err.message}`, 'ERROR');
    return false;
  }
}

/**
 * Main daemon loop
 */
function startDaemonLoop() {
  // Check if another instance is already running
  if (fs.existsSync(PID_FILE)) {
    try {
      const existingPid = parseInt(fs.readFileSync(PID_FILE, 'utf8').trim(), 10);
      if (existingPid !== process.pid && isPidAlive(existingPid)) {
        log(`Daemon already running with PID ${existingPid}. Exiting duplicate instance.`, 'WARN');
        process.exit(0);
      }
    } catch (_) {}
  }

  // Write PID
  fs.writeFileSync(PID_FILE, String(process.pid), 'utf8');
  log(`Google Drive background sync daemon started [PID: ${process.pid}]`, 'INFO');

  const cleanup = () => {
    log('Daemon shutting down. Cleaning up PID file.', 'INFO');
    try {
      if (fs.existsSync(PID_FILE)) {
        const recordedPid = parseInt(fs.readFileSync(PID_FILE, 'utf8').trim(), 10);
        if (recordedPid === process.pid) {
          fs.unlinkSync(PID_FILE);
        }
      }
    } catch (_) {}
    process.exit(0);
  };

  process.on('SIGTERM', cleanup);
  process.on('SIGINT', cleanup);
  process.on('exit', () => {
    try {
      if (fs.existsSync(PID_FILE)) {
        const recordedPid = parseInt(fs.readFileSync(PID_FILE, 'utf8').trim(), 10);
        if (recordedPid === process.pid) {
          fs.unlinkSync(PID_FILE);
        }
      }
    } catch (_) {}
  });

  // Run initial sync check after a 45s warm-up delay
  setTimeout(() => {
    performSyncPass();
  }, 45000);

  // Periodic poll loop (every 60 seconds) to check schedule and configuration
  const pollInterval = setInterval(() => {
    try {
      if (!fs.existsSync(CONFIG_PATH)) return;
      const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
      const settings = config.googleDriveSync;

      // If user disabled sync or set to manual, stop daemon gracefully
      if (!settings || !settings.enabled || settings.interval === 'manually') {
        log('Google Drive sync disabled by user in dashboard settings. Background daemon shutting down.', 'INFO');
        clearInterval(pollInterval);
        cleanup();
        return;
      }

      const intervalMs = INTERVAL_MS_MAP[settings.interval] || (6 * 60 * 60 * 1000);
      const lastSyncMs = settings.lastSync ? new Date(settings.lastSync).getTime() : 0;
      const now = Date.now();

      // Check if it's time to sync
      if (now - lastSyncMs >= intervalMs) {
        log(`Interval threshold reached for interval "${settings.interval}" (${now - lastSyncMs}ms >= ${intervalMs}ms). Syncing...`, 'INFO');
        performSyncPass();
      }
    } catch (err) {
      log(`Error in daemon loop tick: ${err.message}`, 'ERROR');
    }
  }, 60 * 1000); // Check every minute
}

/**
 * Start daemon in detached background process
 */
function startDaemonProcess(projectRoot = PROJECT_ROOT) {
  const status = getDaemonStatus();
  if (status.running) {
    return { success: true, message: `Daemon already running (PID: ${status.pid})`, pid: status.pid };
  }

  const scriptPath = path.join(projectRoot, 'utils', 'google_sync_daemon.js');
  const outLog = fs.openSync(LOG_FILE, 'a');
  const errLog = fs.openSync(LOG_FILE, 'a');

  const child = spawn(process.execPath, [scriptPath, '--daemon'], {
    cwd: projectRoot,
    detached: true,
    stdio: ['ignore', outLog, errLog]
  });

  child.unref();

  return { success: true, message: `Background daemon spawned (PID: ${child.pid})`, pid: child.pid };
}

/**
 * Stop running daemon process
 */
function stopDaemonProcess() {
  const status = getDaemonStatus();
  if (!status.running || !status.pid) {
    if (fs.existsSync(PID_FILE)) {
      try { fs.unlinkSync(PID_FILE); } catch (_) {}
    }
    return { success: true, message: 'Daemon is not running' };
  }

  try {
    process.kill(status.pid, 'SIGTERM');
    log(`Sent SIGTERM to daemon PID ${status.pid}`, 'INFO');
  } catch (e) {
    try { process.kill(status.pid, 'SIGKILL'); } catch (_) {}
  }

  try {
    if (fs.existsSync(PID_FILE)) {
      fs.unlinkSync(PID_FILE);
    }
  } catch (_) {}

  return { success: true, message: `Stopped daemon PID ${status.pid}` };
}

// CLI handler if executed directly
if (require.main === module) {
  const args = process.argv.slice(2);
  const cmd = args[0] || '--start';

  if (cmd === '--daemon') {
    startDaemonLoop();
  } else if (cmd === '--start') {
    const res = startDaemonProcess();
    console.log(res.message);
  } else if (cmd === '--stop') {
    const res = stopDaemonProcess();
    console.log(res.message);
  } else if (cmd === '--status') {
    const st = getDaemonStatus();
    console.log(st.running ? `✅ Daemon is RUNNING (PID: ${st.pid})` : '❌ Daemon is STOPPED');
  } else if (cmd === '--run-once') {
    performSyncPass();
  } else {
    console.log('Usage: node google_sync_daemon.js [--start | --stop | --status | --run-once | --daemon]');
  }
}

module.exports = {
  startDaemonProcess,
  stopDaemonProcess,
  getDaemonStatus,
  performSyncPass
};
