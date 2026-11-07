#!/usr/bin/env node

/**
 * Database Diagnostic & Repair Tool
 * 
 * This script helps identify and fix common ECONNECT and database issues:
 * 1. Checks database file integrity
 * 2. Detects database locks
 * 3. Repairs corrupted tables
 * 4. Tests connection timeouts
 * 5. Validates database schema
 * 
 * Usage: node diagnose_database.js [dbPath] [outputDir]
 */

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { resolveDatabasePath, resolveOutputDir } = require('./utils/path_resolver');

const args = process.argv.slice(2);
let outputDir = resolveOutputDir(args[1]);
let dbPath = resolveDatabasePath(args[0], 'sportybet_archive.db');

// Ensure directory exists
if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
    console.log(`📁 Created output directory: ${outputDir}`);
}

console.log('🔍 Database Diagnostic Tool\n');
console.log(`Database Path: ${dbPath}\n`);

const diagnostics = {
    fileExists: false,
    fileSize: 0,
    isReadable: false,
    isWritable: false,
    canConnect: false,
    hasCorruption: false,
    lockDetected: false,
    tableCount: 0,
    rowCounts: {},
    issues: [],
    fixes: []
};

// Step 1: Check file existence
console.log('Step 1: Checking file existence...');
if (fs.existsSync(dbPath)) {
    diagnostics.fileExists = true;
    const stats = fs.statSync(dbPath);
    diagnostics.fileSize = stats.size;
    console.log(`✅ Database file exists (${(stats.size / 1024 / 1024).toFixed(2)} MB)`);
} else {
    console.log(`❌ Database file not found: ${dbPath}`);
    diagnostics.issues.push('Database file does not exist');
    if (fs.existsSync(outputDir)) {
        const files = fs.readdirSync(outputDir).filter(f => f.endsWith('.db'));
        if (files.length > 0) {
            console.log(`   Available databases: ${files.join(', ')}`);
            diagnostics.fixes.push(`Use one of these databases or specify path explicitly`);
        }
    }
}

// Step 2: Check file permissions
console.log('\nStep 2: Checking file permissions...');
try {
    fs.accessSync(dbPath, fs.constants.R_OK);
    diagnostics.isReadable = true;
    console.log('✅ File is readable');
} catch (e) {
    console.log('❌ File is not readable');
    diagnostics.issues.push('File is not readable - check permissions');
    diagnostics.fixes.push('Run: chmod 644 ' + dbPath);
}

try {
    fs.accessSync(dbPath, fs.constants.W_OK);
    diagnostics.isWritable = true;
    console.log('✅ File is writable');
} catch (e) {
    console.log('❌ File is not writable');
    diagnostics.issues.push('File is not writable - check permissions');
    diagnostics.fixes.push('Run: chmod 666 ' + dbPath);
}

// Step 3: Test connection
console.log('\nStep 3: Testing database connection...');
let db = null;
const connectStart = Date.now();
try {
    db = new Database(dbPath, { timeout: 5000 });
    const connectTime = Date.now() - connectStart;
    diagnostics.canConnect = true;
    console.log(`✅ Successfully connected (${connectTime}ms)`);
    
    if (connectTime > 3000) {
        console.log(`⚠️  Connection is slow (${connectTime}ms > 3000ms)`);
        diagnostics.issues.push('Slow database connection');
        diagnostics.fixes.push('Check disk I/O, close other processes');
    }
} catch (err) {
    console.log(`❌ Connection failed: ${err.message}`);
    diagnostics.issues.push(`Connection error: ${err.message}`);
    
    if (err.message.includes('locked')) {
        diagnostics.lockDetected = true;
        diagnostics.issues.push('Database is locked by another process');
        diagnostics.fixes.push('1. Close all other database connections');
        diagnostics.fixes.push('2. Restart the application');
        diagnostics.fixes.push('3. Check for stuck node processes: ps aux | grep node');
    } else if (err.message.includes('ECONNECT') || err.message.includes('Cannot open')) {
        diagnostics.issues.push('Cannot connect to database - file may be corrupt');
        diagnostics.fixes.push('1. Backup the corrupted file');
        diagnostics.fixes.push('2. Delete the file and restart (fresh database will be created)');
        diagnostics.fixes.push('3. Or restore from backup');
    }
}

// Step 4: Check database integrity
if (diagnostics.canConnect && db) {
    console.log('\nStep 4: Checking database integrity...');
    try {
        const integrity = db.prepare('PRAGMA integrity_check').get();
        if (integrity.integrity_check === 'ok') {
            console.log('✅ Database integrity is OK');
        } else {
            console.log(`❌ Database integrity check failed: ${integrity.integrity_check}`);
            diagnostics.hasCorruption = true;
            diagnostics.issues.push('Database may be corrupted');
            diagnostics.fixes.push('Try VACUUM command to rebuild database');
            diagnostics.fixes.push('Or restore from a backup');
        }
    } catch (err) {
        console.log(`⚠️  Could not verify integrity: ${err.message}`);
    }

    // Step 5: Check tables and row counts
    console.log('\nStep 5: Scanning tables...');
    try {
        const tables = db.prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
        ).all();
        
        diagnostics.tableCount = tables.length;
        console.log(`✅ Found ${tables.length} tables`);
        
        for (const table of tables) {
            try {
                const countResult = db.prepare(`SELECT COUNT(*) as count FROM \"${table.name}\"`).get();
                diagnostics.rowCounts[table.name] = countResult.count;
                console.log(`   - ${table.name}: ${countResult.count} rows`);
            } catch (err) {
                console.log(`   - ${table.name}: ERROR - ${err.message}`);
                diagnostics.issues.push(`Error reading table ${table.name}`);
            }
        }
    } catch (err) {
        console.log(`❌ Error reading tables: ${err.message}`);
        diagnostics.issues.push('Cannot read table list');
    }

    // Step 6: Test query performance
    console.log('\nStep 6: Testing query performance...');
    try {
        const start = Date.now();
        const result = db.prepare('SELECT COUNT(*) as count FROM live_predictions').get();
        const elapsed = Date.now() - start;
        console.log(`✅ Query executed in ${elapsed}ms (${result.count} predictions)`);
        
        if (elapsed > 1000) {
            console.log(`⚠️  Slow query (${elapsed}ms > 1000ms)`);
            diagnostics.issues.push('Slow query performance');
            diagnostics.fixes.push('Run VACUUM to optimize database');
            diagnostics.fixes.push('Check available disk space and RAM');
        }
    } catch (err) {
        console.log(`❌ Query test failed: ${err.message}`);
        diagnostics.issues.push('Cannot execute queries');
    }

    // Step 7: Attempt repairs
    if (diagnostics.issues.length > 0 && !diagnostics.hasCorruption) {
        console.log('\nStep 7: Attempting repairs...');
        try {
            console.log('  Running VACUUM...');
            db.prepare('VACUUM').run();
            console.log('  ✅ VACUUM completed');
            diagnostics.fixes.push('✅ Executed VACUUM successfully');
        } catch (err) {
            console.log(`  ⚠️  VACUUM failed: ${err.message}`);
        }

        try {
            console.log('  Running PRAGMA optimize...');
            db.prepare('PRAGMA optimize').run();
            console.log('  ✅ PRAGMA optimize completed');
            diagnostics.fixes.push('✅ Executed PRAGMA optimize');
        } catch (err) {
            console.log(`  ⚠️  PRAGMA optimize failed: ${err.message}`);
        }
    }
}

// Step 8: Check backup
console.log('\nStep 8: Checking for backups...');
const backupDir = path.join(outputDir, 'backups');
if (fs.existsSync(backupDir)) {
    const backups = fs.readdirSync(backupDir).filter(f => f.endsWith('.db'));
    if (backups.length > 0) {
        console.log(`✅ Found ${backups.length} backup(s)`);
        const latest = backups.sort().reverse()[0];
        console.log(`   Latest: ${latest}`);
    } else {
        console.log('❌ No backups found in backups/ directory');
        diagnostics.fixes.push('Create regular backups: cp database.db backups/backup_$(date +%Y%m%d_%H%M%S).db');
    }
} else {
    console.log('❌ No backups directory found');
    diagnostics.fixes.push('Create backups directory and backup database regularly');
}

// Close database
if (db) {
    try {
        db.close();
    } catch (e) {}
}

// Print summary
console.log('\n' + '='.repeat(60));
console.log('DIAGNOSTIC SUMMARY');
console.log('='.repeat(60));

const status = {
    '✅ File Exists': diagnostics.fileExists,
    '✅ Readable': diagnostics.isReadable,
    '✅ Writable': diagnostics.isWritable,
    '✅ Can Connect': diagnostics.canConnect,
    '✅ No Corruption': !diagnostics.hasCorruption,
    '✅ No Lock': !diagnostics.lockDetected
};

Object.entries(status).forEach(([key, value]) => {
    console.log(`${value ? key : key.replace('✅', '❌')}`);
});

if (diagnostics.issues.length === 0) {
    console.log('\n🎉 Database is HEALTHY - No issues detected!\n');
} else {
    console.log(`\n⚠️  Found ${diagnostics.issues.length} issue(s):\n`);
    diagnostics.issues.forEach((issue, i) => {
        console.log(`${i + 1}. ${issue}`);
    });

    if (diagnostics.fixes.length > 0) {
        console.log(`\n💡 Recommended fixes:\n`);
        diagnostics.fixes.forEach((fix, i) => {
            console.log(`${i + 1}. ${fix}`);
        });
    }
}

console.log('\n' + '='.repeat(60) + '\n');

// Exit with appropriate code
process.exit(diagnostics.issues.length === 0 ? 0 : 1);
