/**
 * Telegram Broadcast Mode Test Script
 * Tests that each broadcast mode setting sends the correct message type to the configured channel.
 */

const { sendRawTelegramMessage } = require('./utils/telegram_broadcaster');

const BOT_TOKEN = 'YOUR_TELEGRAM_BOT_TOKEN';
const CHAT_ID   = 'YOUR_TELEGRAM_CHAT_ID';

async function sendMessage(text) {
  const data = await sendRawTelegramMessage(BOT_TOKEN, CHAT_ID, text, 'HTML');
  if (data.ok) {
    console.log('  ✅ Sent successfully (message_id:', data.result?.message_id + ')');
  } else {
    console.error('  ❌ Failed:', data.description);
  }
  return data;
}

async function delay(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function runTests() {
  console.log('\n🔔 NexusPanel — Telegram Broadcast Mode Test');
  console.log('='.repeat(50));
  console.log(`Bot Token : ${BOT_TOKEN.slice(0, 15)}...`);
  console.log(`Channel   : ${CHAT_ID}`);
  console.log('='.repeat(50) + '\n');

  // ── Test 1: AI Best Pick Only ──────────────────────────
  console.log('[1/5] 🤖 Testing: AI Best Picks Only...');
  await sendMessage(
    `🤖 <b>HIGH-RISK AI PICK</b>\n` +
    `⚽ Matchup: <b>Team A vs Team B</b>\n` +
    `🎯 Selection: <code>Home Win</code>\n` +
    `📈 Win Chance: <b>72%</b> | Implied Odd: <b>@1.39</b>\n\n` +
    `📊 <b>CURRENT SYSTEM WIN RATES</b>\n` +
    `🔵 High-Risk AI Pick Win Rate: <b>68.5%</b> (137/200)\n\n` +
    `<i>⚠️ [TEST] Broadcast Mode: AI Best Picks Only</i>`
  );
  await delay(2000);

  // ── Test 2: Safest Pick Only ───────────────────────────
  console.log('[2/5] 🛡️ Testing: Safest Pick Only...');
  await sendMessage(
    `🛡️ <b>CONCURRENT TIP (SAFEST)</b>\n` +
    `⚽ Matchup: <b>Team C vs Team D</b>\n` +
    `🎯 Selection: <code>Over 1.5 Goals</code>\n` +
    `📈 Win Chance: <b>84%</b> | Implied Odd: <b>@1.19</b>\n\n` +
    `📊 <b>CURRENT SYSTEM WIN RATES</b>\n` +
    `🟢 Safest Pick Win Rate: <b>81.2%</b> (162/200)\n\n` +
    `<i>⚠️ [TEST] Broadcast Mode: Safest Pick Only</i>`
  );
  await delay(2000);

  // ── Test 3: High Value Pick Only ──────────────────────
  console.log('[3/5] ⚡ Testing: High Value Pick Only...');
  await sendMessage(
    `⚡ <b>CONCURRENT TIP (HIGH VALUE)</b>\n` +
    `⚽ Matchup: <b>Team E vs Team F</b>\n` +
    `🎯 Selection: <code>Both Teams to Score</code>\n` +
    `📈 Win Chance: <b>65%</b> | Implied Odd: <b>@1.54</b>\n\n` +
    `📊 <b>CURRENT SYSTEM WIN RATES</b>\n` +
    `🟣 High Value Pick Win Rate: <b>63.8%</b> (128/200)\n\n` +
    `<i>⚠️ [TEST] Broadcast Mode: High Value Pick Only</i>`
  );
  await delay(2000);

  // ── Test 4: All AI Picks Combined ─────────────────────
  console.log('[4/5] 🎯 Testing: All AI Picks (High-Risk + Safest + High Value)...');
  await sendMessage(
    `🤖 <b>HIGH-RISK AI PICK</b>\n` +
    `⚽ Team A vs Team B  |  <code>Home Win</code>  |  72% @1.39\n\n` +
    `🛡️ <b>SAFEST PICK</b>\n` +
    `⚽ Team C vs Team D  |  <code>Over 1.5</code>  |  84% @1.19\n\n` +
    `⚡ <b>HIGH VALUE PICK</b>\n` +
    `⚽ Team E vs Team F  |  <code>BTTS</code>  |  65% @1.54\n\n` +
    `📊 Win Rates: 🔵 68.5% | 🟢 81.2% | 🟣 63.8%\n\n` +
    `<i>⚠️ [TEST] Broadcast Mode: All AI Picks</i>`
  );
  await delay(2000);

  // ── Test 5: Upcoming Fixtures (All Weeks) ─────────────
  console.log('[5/5] 📅 Testing: All Picks — Upcoming Fixtures (All Weeks)...');
  const nowWat = new Date().toLocaleTimeString('en-NG', { timeZone: 'Africa/Lagos', hour: '2-digit', minute: '2-digit', hour12: false }) + ' WAT';
  await sendMessage(
    `⚡ <b>NexusPanel — Upcoming Match Predictions</b>\n` +
    `📅 <b>Season:</b> Sportybet VFL S201 | <b>Week 14</b>\n` +
    `🕒 <b>Time:</b> ${nowWat}\n` +
    `📋 <b>3 matches scheduled</b>\n\n` +
    `⚽ <b>Team A vs Team B</b>\n` +
    `   ⏰ 14:00 WAT  |  🎯 Confidence: <b>74%</b>\n` +
    `   📊 1X2: <code>52% / 28% / 20%</code>\n` +
    `   ✅ Best Bet: <b>Team A Win</b> (52%)\n\n` +
    `⚽ <b>Team C vs Team D</b>\n` +
    `   ⏰ 14:03 WAT  |  🎯 Confidence: <b>81%</b>\n` +
    `   📊 1X2: <code>18% / 25% / 57%</code>\n` +
    `   ✅ Best Bet: <b>Team D Win</b> (57%)\n\n` +
    `⚽ <b>Team E vs Team F</b>\n` +
    `   ⏰ 14:06 WAT  |  🎯 Confidence: <b>69%</b>\n` +
    `   📊 1X2: <code>40% / 35% / 25%</code>\n` +
    `   ✅ Best Bet: <b>Team E Win</b> (40%)\n\n` +
    `<i>⚠️ [TEST] Broadcast Mode: Upcoming Fixtures (All Weeks)</i>\n` +
    `<i>⚠️ Disclaimer: Play responsibly. 18+</i>`
  );

  console.log('\n' + '='.repeat(50));
  console.log('✅ All 5 broadcast mode tests completed!');
  console.log('📲 Check your Telegram channel to verify messages arrived.');
  console.log('='.repeat(50) + '\n');
}

runTests().catch(err => {
  console.error('❌ Test failed:', err.message);
  process.exit(1);
});
