const { launchBrowser, isLoggedIn, BASE_URL } = require('./scraper');

/**
 * Run this ONCE to log in manually via Google.
 * It opens a visible browser — you log in with your Google account.
 * After login, cookies are saved to .browser-session/ and reused automatically.
 * 
 * Usage: node login.js
 */
async function main() {
  console.log('🔓 Opening browser for manual Google login...');
  console.log('   Log in with your Google account, then the script will detect it.\n');

  // Launch VISIBLE browser (headless: false) so you can log in
  const context = await launchBrowser(false);
  const page = await context.newPage();

  await page.goto(`${BASE_URL}/sales`, { waitUntil: 'networkidle', timeout: 60000 });

  // Wait for user to complete Google login
  console.log('⏳ Waiting for you to complete Google login...');
  console.log('   (The browser will close automatically once login is detected)\n');

  // Poll until we get past the Google login (land on /start/route or /sales)
  let loggedIn = false;
  for (let i = 0; i < 120; i++) {
    await new Promise(r => setTimeout(r, 1000));
    const url = page.url();
    if (url.includes('agent.goldadam.app') && !url.includes('/login') && !url.includes('accounts.google.com')) {
      loggedIn = true;
      break;
    }
  }

  if (!loggedIn) {
    console.log('❌ Login timed out. Please try again: node login.js');
    await context.close();
    return;
  }

  console.log('✅ Google login successful!');

  // Handle route selection page if present
  const currentUrl = page.url();
  if (currentUrl.includes('/start/route')) {
    console.log('📍 Route selection page detected. Selecting route S26...');
    try {
      await page.click('button:has-text("S26: Västra Götaland")');
      await page.click('button:has-text("Continue")');
      await page.waitForURL('**/bookings**', { timeout: 15000 }).catch(() => {});
      console.log('✅ Route selected! Now on:', page.url());
    } catch (e) {
      console.log('⚠️  Could not auto-select route. Current page:', page.url());
      console.log('   You may need to select a route manually next time.');
    }
  }

  console.log('✅ Session saved to .browser-session/');
  console.log('   You can now run: npm start');

  await context.close();
}

main().catch(console.error);
