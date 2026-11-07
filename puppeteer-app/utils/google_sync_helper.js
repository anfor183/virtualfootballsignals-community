const fs = require('fs');
const path = require('path');
const os = require('os');
const { checkpointDatabase } = require('./db_safe.js');

function resolveDrivePath(configuredPath) {
  if (!configuredPath) return configuredPath;
  const trimmed = configuredPath.trim();
  const altPath = trimmed.replace(/Predictor database live/i, 'Predictor_Database_Live');
  if (altPath !== trimmed && fs.existsSync(altPath)) {
    return altPath;
  }
  return trimmed;
}

/**
 * Scan a directory for all files, skipping only OS metadata and temp lock files.
 */
function scanDirAllFiles(dirPath, baseDir = dirPath, collected = []) {
  if (!fs.existsSync(dirPath)) return collected;
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      const lower = entry.name.toLowerCase();
      // Skip system lock, temp cache files, SHM shared memory, and quarantine/corrupt files
      if (
        lower === '.ds_store' ||
        lower === 'thumbs.db' ||
        lower.endsWith('.tmp') ||
        lower.endsWith('.crswap') ||
        lower === 'lock' ||
        lower.endsWith('-shm') ||
        lower.includes('corrupt') ||
        lower.includes('damaged_bak')
      ) {
        continue;
      }
      if (entry.isDirectory()) {
        scanDirAllFiles(fullPath, baseDir, collected);
      } else if (entry.isFile()) {
        try {
          const stat = fs.statSync(fullPath);
          const relativeName = path.relative(baseDir, fullPath).replace(/\\/g, '/');
          collected.push({
            name: relativeName,
            filename: entry.name,
            path: fullPath,
            size: stat.size,
            mtimeMs: stat.mtimeMs,
            dir: dirPath
          });
        } catch (_) {}
      }
    }
  } catch (_) {}
  return collected;
}

/**
 * Discover all files inside the user's configured database folder and project database directories.
 */
function findDatabaseFiles(appRoot) {
  const searchDirs = new Set();
  const root = appRoot || path.resolve(__dirname, '..');

  // 1. Primary: Check user-configured output directory in bot_settings.json
  const botSettingsPath = path.join(root, 'bot_settings.json');
  let userConfiguredDbDir = null;
  if (fs.existsSync(botSettingsPath)) {
    try {
      const bs = JSON.parse(fs.readFileSync(botSettingsPath, 'utf8'));
      if (bs.outputDir && typeof bs.outputDir === 'string' && bs.outputDir.trim()) {
        userConfiguredDbDir = path.resolve(bs.outputDir.trim());
        searchDirs.add(userConfiguredDbDir);
      }
      if (bs.outputDirectory && typeof bs.outputDirectory === 'string' && bs.outputDirectory.trim()) {
        userConfiguredDbDir = path.resolve(bs.outputDirectory.trim());
        searchDirs.add(userConfiguredDbDir);
      }
      if (bs.trainingDbPath && typeof bs.trainingDbPath === 'string' && bs.trainingDbPath.trim()) {
        const tPath = path.resolve(bs.trainingDbPath.trim());
        if (fs.existsSync(tPath)) {
          const stat = fs.statSync(tPath);
          if (stat.isDirectory()) {
            searchDirs.add(tPath);
          } else {
            searchDirs.add(path.dirname(tPath));
          }
        }
      }
    } catch (_) {}
  }

  // 2. Standard project database directories
  searchDirs.add(path.join(root, 'databases'));
  searchDirs.add(path.join(root, 'database'));
  searchDirs.add(path.join(root, '..', 'database'));
  searchDirs.add(path.join(root, 'backups'));
  searchDirs.add(path.join(os.homedir(), 'Desktop', 'Virtual_Football_Archives'));
  searchDirs.add(path.join(os.homedir(), 'Virtual_Football_Archives'));

  const fileMap = new Map();

  for (const sDir of searchDirs) {
    if (fs.existsSync(sDir)) {
      try {
        const stat = fs.statSync(sDir);
        if (!stat.isDirectory()) continue;

        const files = scanDirAllFiles(sDir, sDir);
        for (const fileObj of files) {
          const existing = fileMap.get(fileObj.filename);
          if (!existing || fileObj.mtimeMs > existing.mtimeMs) {
            fileMap.set(fileObj.filename, fileObj);
          }
        }
      } catch (_) {}
    }
  }

  return {
    dbFiles: Array.from(fileMap.values()),
    searchedDirs: Array.from(searchDirs)
  };
}

/**
 * Triggers live database sync to the user's configured Google Drive folder.
 * Backs up ALL files in the configured database folder.
 */
function syncDatabasesToGoogleDrive(customAppRoot) {
  try {
    const root = customAppRoot || path.resolve(__dirname, '..');
    const configPath = path.join(root, 'browser-config.json');
    if (!fs.existsSync(configPath)) return { success: false, reason: 'browser-config.json not found' };

    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const gSync = config.googleDriveSync;

    if (!gSync || !gSync.enabled) {
      return { success: false, skipped: true, reason: 'Google Drive sync is disabled' };
    }

    if (gSync.syncScope && gSync.syncScope.databases === false) {
      return { success: false, skipped: true, reason: 'Database sync option is disabled in syncScope' };
    }

    if (gSync.mode === 'local' && gSync.localPath && gSync.localPath.trim()) {
      const targetDir = path.resolve(resolveDrivePath(gSync.localPath));
      if (!fs.existsSync(targetDir)) {
        fs.mkdirSync(targetDir, { recursive: true });
      }

      // Checkpoint active WAL databases before copying
      const mainDbs = [
        path.join(root, 'databases', 'sportybet_archive.db'),
        path.join(root, 'databases', 'virtual_football_archive.db')
      ];
      for (const mdb of mainDbs) {
        if (fs.existsSync(mdb)) {
          try { checkpointDatabase(mdb); } catch (_) {}
        }
      }

      const { dbFiles, searchedDirs } = findDatabaseFiles(root);
      if (dbFiles.length === 0) {
        return { success: false, reason: `No database files found in directories: ${searchedDirs.join(', ')}` };
      }

      let copied = 0;
      for (const dbFile of dbFiles) {
        if (dbFile.filename.endsWith('-shm') || dbFile.filename.includes('corrupt') || dbFile.filename.includes('damaged_bak')) {
          continue;
        }
        const destPath = path.join(targetDir, dbFile.filename);
        const destParent = path.dirname(destPath);
        if (!fs.existsSync(destParent)) {
          fs.mkdirSync(destParent, { recursive: true });
        }
        try {
          fs.copyFileSync(dbFile.path, destPath);
          copied++;
        } catch (err) {
          console.warn(`[Google Drive Live Sync] Failed to copy ${dbFile.filename}: ${err.message}`);
        }
      }

      // Update lastSync timestamp in browser-config.json
      try {
        config.googleDriveSync.lastSync = new Date().toISOString();
        fs.writeFileSync(configPath, JSON.stringify(config, null, 4), 'utf8');
      } catch (e) {}

      console.log(`[Google Drive Live Sync] ✅ Successfully synced ${copied} files from database folder to ${targetDir}`);
      return { success: true, count: copied, destination: targetDir };
    }

    return { success: false, skipped: true, reason: 'Non-local mode or empty localPath' };
  } catch (error) {
    console.error(`[Google Drive Live Sync] Error: ${error.message}`);
    return { success: false, error: error.message };
  }
}

/**
 * Background daemon lifecycle controls
 */
function startGoogleSyncDaemon(customAppRoot) {
  const { startDaemonProcess } = require('./google_sync_daemon.js');
  return startDaemonProcess(customAppRoot || path.resolve(__dirname, '..'));
}

function stopGoogleSyncDaemon() {
  const { stopDaemonProcess } = require('./google_sync_daemon.js');
  return stopDaemonProcess();
}

function getGoogleSyncDaemonStatus() {
  const { getDaemonStatus } = require('./google_sync_daemon.js');
  return getDaemonStatus();
}

module.exports = {
  findDatabaseFiles,
  syncDatabasesToGoogleDrive,
  startGoogleSyncDaemon,
  stopGoogleSyncDaemon,
  getGoogleSyncDaemonStatus
};
