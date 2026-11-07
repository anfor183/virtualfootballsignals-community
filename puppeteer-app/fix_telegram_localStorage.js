/**
 * Fix corrupted Telegram localStorage keys in Electron's LevelDB.
 * Run this with Node.js BEFORE starting the dashboard app.
 *
 * The app's localStorage is stored in LevelDB — we can't edit it directly,
 * but we can inject corrected values by opening the app and running code in devtools.
 *
 * This script instead writes a small HTML injector file that the user can
 * open in the Electron devtools console to fix the keys.
 */

const fixes = {
  'autoPostToTelegram': 'true',
  'telegramPickFilter': 'ai_all',
};

console.log('\n🔧 Telegram localStorage Fix Tool');
console.log('='.repeat(50));
console.log('The following keys may be corrupted in your Electron app.\n');
console.log('INSTRUCTIONS:');
console.log('1. Start the Dashboard app (npm run dev)');
console.log('2. Open DevTools (Ctrl+Shift+I in the Electron window)');
console.log('3. Click the Console tab');
console.log('4. Paste and run the following code:\n');
console.log('─'.repeat(50));

const script = Object.entries(fixes)
  .map(([k, v]) => `localStorage.setItem('${k}', '${v}'); console.log('✅ Set ${k} =', '${v}');`)
  .join('\n');

console.log(script);
console.log('\n// Then verify with:');
console.log("console.log('autoPostToTelegram:', localStorage.getItem('autoPostToTelegram'));");
console.log("console.log('telegramBotToken:', localStorage.getItem('telegramBotToken') ? '[SET]' : '[MISSING]');");
console.log("console.log('telegramChatId:', localStorage.getItem('telegramChatId'));");
console.log('─'.repeat(50));
console.log('\n✅ After running the above in DevTools, reload the app.');
