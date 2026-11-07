const puppeteer = require('puppeteer-real-browser');
const config = require('./config');

async function openBlankTab() {
    let browser;
    try {
        const page = await config.connect();
        browser = page.browser();
        await page.setViewport(config.customConfig.viewport);


        //  await new Promise(resolve => setTimeout(resolve, stayDuration));
        // Navigation will be automatically blocked if not initialized
        await page.goto('about:blank');



    } catch (error) {
        console.error('An error occurred:', error);
    }
}

module.exports = { openBlankTab };
