const config = require('./config');
const fs = require('fs');
const path = require('path');
const os = require('os');

/**
 * Automatically scans and deletes orphaned temporary profile directories (bot-temp-*)
 * left behind by crashed or forcibly closed bot processes from the OS temp folder.
 */
function cleanOrphanedTempProfiles() {
    try {
        console.log('🧹 Scanning OS temp directory for orphaned bot profiles...');
        const tempDir = os.tmpdir();
        const files = fs.readdirSync(tempDir);
        let count = 0;
        
        for (const file of files) {
            if (file.startsWith('bot-temp-')) {
                const fullPath = path.join(tempDir, file);
                try {
                    // Recursive deletion. Locked/active profile folders will fail to delete and be skipped.
                    fs.rmSync(fullPath, { recursive: true, force: true });
                    count++;
                } catch (err) {
                    // Silently ignore folders currently locked/used by active bot processes
                }
            }
        }
        
        if (count > 0) {
            console.log(`✅ Successfully cleaned up ${count} orphaned temporary profile folders from OS temp.`);
        } else {
            console.log('✅ No orphaned temporary profile folders found in OS temp.');
        }
    } catch (err) {
        console.warn('⚠️ Failed to clean OS temporary profile folders:', err.message);
    }
}

/**
 * Recursively scans a base directory to discover all valid Chrome profile folders.
 * Checks for signature files/folders like 'Preferences' or 'Network' or 'Web Data'.
 */
function findProfileDirs(baseDir) {
    const profileDirs = [];
    try {
        if (!fs.existsSync(baseDir)) return [];
        
        function scan(dir) {
            const isProfile = fs.existsSync(path.join(dir, 'Preferences')) || 
                              fs.existsSync(path.join(dir, 'Default', 'Preferences')) ||
                              fs.existsSync(path.join(dir, 'Network')) ||
                              fs.existsSync(path.join(dir, 'Default', 'Network')) ||
                              fs.existsSync(path.join(dir, 'Web Data'));
                              
            if (isProfile) {
                profileDirs.push(dir);
                return; // Direct hit, do not look deeper in this branch
            }
            
            const children = fs.readdirSync(dir);
            for (const child of children) {
                const childPath = path.join(dir, child);
                try {
                    const stat = fs.statSync(childPath);
                    if (stat.isDirectory()) {
                        scan(childPath);
                    }
                } catch (e) {}
            }
        }
        
        scan(baseDir);
    } catch (err) {
        console.warn('⚠️ Error scanning directory:', err.message);
    }
    return profileDirs;
}

/**
 * Physically scans and deletes persistent HTTP/GPU cache directories and temporal history 
 * databases from a discovered user profile folder on disk after Chrome has exited.
 * Re-creates empty cache directories to ensure structural stability for the next launch.
 */
function clearPhysicalDiskCache(profileDir) {
    try {
        console.log(`\n💾 Wiping persistent Chrome disk cache & history databases at: ${profileDir}`);
        if (!profileDir || !fs.existsSync(profileDir)) {
            return;
        }

        const subfolders = ['', 'Default'];
        let clearedBytes = 0;
        let foldersCleared = 0;
        let filesCleared = 0;

        function getDirSize(dirPath) {
            let size = 0;
            try {
                if (!fs.existsSync(dirPath)) return 0;
                const files = fs.readdirSync(dirPath);
                for (const file of files) {
                    const fullPath = path.join(dirPath, file);
                    const stat = fs.statSync(fullPath);
                    if (stat.isDirectory()) {
                        size += getDirSize(fullPath);
                    } else {
                        size += stat.size;
                    }
                }
            } catch (e) {}
            return size;
        }

        for (const sub of subfolders) {
            // 1. Clean cache subdirectories
            const cacheDirs = [
                path.join(profileDir, sub, 'Cache'),
                path.join(profileDir, sub, 'Code Cache'),
                path.join(profileDir, sub, 'GPUCache'),
                path.join(profileDir, sub, 'Service Worker', 'CacheStorage'),
                path.join(profileDir, sub, 'Service Worker', 'ScriptCache'),
                path.join(profileDir, sub, 'ShaderCache'),
                path.join(profileDir, sub, 'GrShaderCache'),
                path.join(profileDir, sub, 'Crashpad'),
                path.join(profileDir, sub, 'OptimizationGuidePredictionModels'),
                path.join(profileDir, sub, 'hyphen-data'),
                path.join(profileDir, sub, 'blob_storage')
            ];

            for (const dir of cacheDirs) {
                if (fs.existsSync(dir)) {
                    const size = getDirSize(dir);
                    try {
                        fs.rmSync(dir, { recursive: true, force: true });
                        // Recreate empty folder for structural stability
                        try { fs.mkdirSync(dir, { recursive: true }); } catch (mkErr) {}
                        clearedBytes += size;
                        foldersCleared++;
                        console.log(`   ✅ Cleared persistent folder: ${path.relative(profileDir, dir)} (${(size / (1024 * 1024)).toFixed(2)} MB)`);
                    } catch (err) {
                        console.warn(`   ⚠️ Could not fully clear ${path.basename(dir)}: ${err.message}`);
                    }
                }
            }        }

        if (foldersCleared > 0) {
            console.log(`✅ Successfully wiped profile cache databases (${(clearedBytes / (1024 * 1024)).toFixed(2)} MB freed).`);
        } else {
            console.log('✅ Profile directories were already clean.');
        }
    } catch (error) {
        console.warn('⚠️ Error during profile cleaning:', error.message);
    }
}

async function runSmartClear() {
    let browser;
    try {
        console.log('🧹 Starting Smart Clear (Preserving All Website Cookies & Login Sessions)...');
        const page = await config.connect({ headless: true });
        browser = page.browser();
        
        const client = await page.target().createCDPSession();
        
        // 1. Clear browser cache (The main consumer of RAM/Memory)
        await client.send('Network.clearBrowserCache');
        console.log('✅ Browser cache cleared (RAM optimized)');

        // 2. Clear heavy temporal/transient storage types that consume disk/memory but don't hold cookie sessions
        // We explicitly omit 'cookies', 'local_storage', 'interest_groups', and 'shared_storage' to preserve all login sessions and ad-serving tracking cohorts.
        await client.send('Storage.clearDataForOrigin', {
            origin: '*',
            storageTypes: 'appcache,file_systems,indexeddb,shader_cache,websql,service_workers,cache_storage'
        }).catch(() => {});
        
        console.log('✅ All heavy background storage and temporal processes cleared.');

        // 3. Clear Download History (exactly matching the ticked setting in Chrome settings)
        console.log('🧹 Clearing browser download history...');
        try {
            const downloadsPage = await browser.newPage();
            await downloadsPage.goto('chrome://downloads', { waitUntil: 'networkidle2' });
            await downloadsPage.evaluate(() => {
                if (typeof chrome !== 'undefined' && chrome.send) {
                    chrome.send('clearAll');
                }
            });
            await downloadsPage.close();
            console.log('✅ Download history cleared successfully.');
        } catch (downloadErr) {
            console.warn('⚠️ Could not clear download history UI:', downloadErr.message);
        }
        
        console.log('📊 All website cookies and login sessions were fully PRESERVED.');
        
        console.log('✨ Smart Clear browser cleanup completed.');
        await browser.close();
        
        // Wait 1.5 seconds for Windows filesystem handles to completely close and unlock
        console.log('⏳ Waiting for browser to fully release file locks...');
        await new Promise(r => setTimeout(r, 1500));

        // 4. Discover and physically clear persistent disk caches & databases for ALL profiles
        console.log('\n🔎 Discovering all bot profiles in the application...');
        const allUserDataDirs = [];

        // Add the currently active configuration profile
        if (config.customConfig.userDataDir) {
            allUserDataDirs.push(path.resolve(config.customConfig.userDataDir));
        }

        // Add any profiles discovered in the configured userDataDir or local profiles/ fallback
        let profilesBaseDir = path.resolve(__dirname, 'profiles');
        if (config.customConfig.userDataDir) {
            let driveExists = true;
            if (process.platform === 'win32' && /^[a-zA-Z]:/.test(config.customConfig.userDataDir)) {
                const drive = config.customConfig.userDataDir.substring(0, 3);
                try {
                    driveExists = fs.existsSync(drive);
                } catch (e) {
                    driveExists = false;
                }
            }
            if (driveExists) {
                profilesBaseDir = path.resolve(config.customConfig.userDataDir);
            }
        }

        const discoveredProfiles = findProfileDirs(profilesBaseDir);
        for (const p of discoveredProfiles) {
            const resolvedPath = path.resolve(p);
            if (!allUserDataDirs.includes(resolvedPath)) {
                allUserDataDirs.push(resolvedPath);
            }
        }

        console.log(`📋 Found ${allUserDataDirs.length} user profile directory(s) to clean.`);

        // Wipe each profile physically
        for (const profileDir of allUserDataDirs) {
            clearPhysicalDiskCache(profileDir);
        }

        // 5. Clean up orphaned temporary bot profiles from OS temp folder
        cleanOrphanedTempProfiles();

        console.log('\n✨ Smart Clear completed successfully for ALL profiles.');
        process.exit(0);
    } catch (error) {
        console.error('❌ Smart Clear failed:', error.message);
        if (browser) await browser.close();
        process.exit(1);
    }
}

runSmartClear();

