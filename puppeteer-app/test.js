
const puppeteer = require('puppeteer-real-browser');


const { openBlankTab } = require('./blank');

(async () => {
  try {
    // Test blank tab
    try {
      await openBlankTab();
      console.log('Blank tab activity completed');
    } catch (blankError) {
      console.error('Error during blank tab activity:', blankError);
    }

    console.log('All activities completed successfully');
  } catch (error) {
    console.error('An error occurred during execution:', error);
  }
})();

