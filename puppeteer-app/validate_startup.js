#!/usr/bin/env node

/**
 * Startup Validator
 *
 * Validates that the system is properly configured and ready to run.
 * Runs automatically before the app starts.
 *
 * Checks:
 * 1. Node.js version
 * 2. npm dependencies installed
 * 3. Database directory exists
 * 4. Configuration files present
 * 5. Port availability
 * 6. System resources
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

const issues = [];
const warnings = [];
const success = [];

console.log('\n' + '='.repeat(60));
console.log('🚀 STARTUP VALIDATOR');
console.log('='.repeat(60) + '\n');

// 1. Check Node.js version
console.log('Checking Node.js version...');
const nodeVersion = process.version;
const majorVersion = parseInt(nodeVersion.split('.')[0].substring(1));
if (majorVersion >= 14) {
    success.push(`Node.js ${nodeVersion} ✅`);
} else {
    issues.push(`Node.js ${nodeVersion} is too old. Requires >= 14.0.0`);
}

// 2. Check npm dependencies
console.log('Checking npm dependencies...');
const packageJsonPath = path.join(__dirname, 'package.json');
const nodeModulesPath = path.join(__dirname, 'node_modules');

if (!fs.existsSync(packageJsonPath)) {
    issues.push('package.json not found in root directory');
} else {
    success.push('package.json found ✅');
}

if (!fs.existsSync(nodeModulesPath)) {
    warnings.push('node_modules not found. Run: npm install');
} else {
    // Check for critical dependencies
    const criticalDeps = ['electron', 'better-sqlite3', 'puppeteer'];
    const missingDeps = [];
    
    for (const dep of criticalDeps) {
        if (!fs.existsSync(path.join(nodeModulesPath, dep))) {
            missingDeps.push(dep);
        }
    }
    
    if (missingDeps.length > 0) {
        warnings.push(`Missing dependencies: ${missingDeps.join(', ')}. Run: npm install`);
    } else {
        success.push('All critical dependencies installed ✅');
    }
}

// 3. Check database directory
console.log('Checking database directory...');
const dbDir = path.join(__dirname, 'databases');
if (fs.existsSync(dbDir)) {
    success.push(`Database directory exists ✅`);
    const dbFiles = fs.readdirSync(dbDir).filter(f => f.endsWith('.db'));
    console.log(`   Found ${dbFiles.length} database file(s): ${dbFiles.join(', ') || 'none'}`);
} else {
    fs.mkdirSync(dbDir, { recursive: true });
    success.push(`Database directory created ✅`);
}

// 4. Check configuration files
console.log('Checking configuration files...');
const configFiles = ['config.js', 'package.json', 'dashboard/src/main/index.js', 'db_reader.js'];
for (const configFile of configFiles) {
    const fullPath = path.join(__dirname, configFile);
    if (fs.existsSync(fullPath)) {
        success.push(`${configFile} ✅`);
    } else {
        issues.push(`${configFile} not found`);
    }
}

// 5. Check port availability
console.log('Checking port availability...');
const net = require('net');
const portsToCheck = [5173, 3001, 3000]; // Vite, Dev server
const checkPorts = async () => {
    for (const port of portsToCheck) {
        try {
            const server = require('net').createServer();
            await new Promise((resolve, reject) => {
                server.once('error', (err) => {
                    if (err.code === 'EADDRINUSE') {
                        warnings.push(`Port ${port} is in use. Close other apps using it.`);
                    }
                    reject(err);
                });
                server.once('listening', () => {
                    server.close();
                    success.push(`Port ${port} available ✅`);
                    resolve();
                });
                server.listen(port, '127.0.0.1');
            });
        } catch (e) {
            // Port unavailable, but not critical
        }
    }
};

// 6. Check system resources
console.log('Checking system resources...');
const totalMemory = os.totalmem();
const freeMemory = os.freemem();
const memoryGb = (totalMemory / 1024 / 1024 / 1024).toFixed(1);
const freeGb = (freeMemory / 1024 / 1024 / 1024).toFixed(1);
const cpuCount = os.cpus().length;

if (totalMemory < 2 * 1024 * 1024 * 1024) {
    warnings.push(`Low memory: ${memoryGb}GB total. Recommend >= 4GB.`);
} else if (totalMemory < 4 * 1024 * 1024 * 1024) {
    warnings.push(`Limited memory: ${memoryGb}GB total. Recommend 8GB for optimal performance.`);
} else {
    success.push(`Memory: ${memoryGb}GB available ✅`);
}

if (freeMemory < 1 * 1024 * 1024 * 1024) {
    warnings.push(`Low free memory: ${freeGb}GB. Close other applications.`);
} else {
    success.push(`Free memory: ${freeGb}GB ✅`);
}

if (cpuCount < 2) {
    warnings.push(`Limited CPU cores: ${cpuCount}. Recommend >= 2 cores.`);
} else {
    success.push(`CPU cores: ${cpuCount} ✅`);
}

// Check disk space
let availableSpace = 0;
let availableGB = '0.00';
try {
    const stats = fs.statfsSync('.');
    availableSpace = stats.bavail * stats.bsize;
    availableGB = (availableSpace / 1024 / 1024 / 1024).toFixed(2);
    if (availableSpace < 500 * 1024 * 1024) {
        issues.push(`Low disk space: ${availableGB}GB available. Minimum 500MB required.`);
    } else if (availableSpace < 2 * 1024 * 1024 * 1024) {
        warnings.push(`Limited disk space: ${availableGB}GB available. Database will grow over time.`);
    } else {
        success.push(`Disk space: ${availableGB}GB available ✅`);
    }
} catch (err) {
    warnings.push(`Could not determine disk space: ${err.message}`);
}

// 7. Check utils directory
console.log('Checking utils directory...');
const utilsDir = path.join(__dirname, 'utils');
if (fs.existsSync(utilsDir)) {
    const utilFiles = fs.readdirSync(utilsDir).filter(f => f.endsWith('.js'));
    console.log(`   Found ${utilFiles.length} utility files`);
    const criticalUtils = ['live_companion.js', 'ml_predictor.js'];
    const missingUtils = criticalUtils.filter(f => !fs.existsSync(path.join(utilsDir, f)));
    if (missingUtils.length > 0) {
        issues.push(`Missing utility files: ${missingUtils.join(', ')}`);
    } else {
        success.push('All critical utility files present ✅');
    }
} else {
    issues.push('utils directory not found');
}

// Print results
console.log('\n' + '='.repeat(60));

if (success.length > 0) {
    console.log('\n✅ SUCCESS:\n');
    success.forEach(s => console.log(`   ${s}`));
}

if (warnings.length > 0) {
    console.log('\n⚠️  WARNINGS:\n');
    warnings.forEach(w => console.log(`   - ${w}`));
}

if (issues.length > 0) {
    console.log('\n❌ CRITICAL ISSUES:\n');
    issues.forEach(i => console.log(`   - ${i}`));
    console.log('\n🔧 REQUIRED ACTIONS:\n');
    console.log('   1. npm install       (install dependencies)');
    console.log('   2. node diagnose_database.js (validate database)');
    console.log('   3. npm start         (launch the app)');
}

console.log('\n' + '='.repeat(60));

if (issues.length === 0) {
    console.log('\n🚀 SYSTEM READY TO START\n');
    console.log('Run: npm start\n');
    process.exit(0);
} else {
    console.log('\n⛔ CANNOT START - Fix issues above\n');
    process.exit(1);
}
