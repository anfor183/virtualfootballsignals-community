const path = require('path');
const fs = require('fs');

async function run() {
  console.log('[connect_test] Starting test at', new Date().toISOString());
  try {
    const config = require('./config.js');
    const timeoutMs = 30000;

    const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('connect_test: TIMEOUT after ' + timeoutMs + 'ms')), timeoutMs));

    const connectPromise = (async () => {
      console.log('[connect_test] Calling config.connect({ headless: false, provider: "sportybet" })');
      const page = await config.connect({ headless: false, provider: 'sportybet' });
      return page;
    })();

    const page = await Promise.race([connectPromise, timeout]);
    if (page) {
      console.log('[connect_test] connect() returned a page. URL:', await page.url());
      try { await page.close(); } catch (e) {}
      console.log('[connect_test] Success');
    }
  } catch (e) {
    console.error('[connect_test] Error:', e && (e.stack || e.message || e));
    process.exitCode = 2;
  }
}

run();
