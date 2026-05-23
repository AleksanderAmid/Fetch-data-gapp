// Auth relay module — allows remote login via screenshot relay
// Used by the admin panel to log into Gold Adam without SSH/VNC

const { chromium } = require('playwright');
const path = require('path');

const USER_DATA_DIR = path.join(__dirname, '.browser-session');
const BASE_URL = 'https://agent.goldadam.app';

let loginContext = null;
let loginPage = null;
let loginTimeout = null;

/**
 * Start a visible-mode login session (headless but we take screenshots).
 * Returns true if session started, false if one is already active.
 */
async function startLoginSession() {
  if (loginContext) {
    return { success: false, error: 'Login session already active' };
  }

  try {
    // Launch a NEW persistent context for login (headless — we relay via screenshots)
    loginContext = await chromium.launchPersistentContext(USER_DATA_DIR, {
      headless: true,
      viewport: { width: 1280, height: 800 },
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    });

    loginPage = await loginContext.newPage();
    await loginPage.goto(`${BASE_URL}/sales`, { waitUntil: 'networkidle', timeout: 30000 });

    // Auto-cleanup after 3 minutes
    loginTimeout = setTimeout(() => {
      cleanupLoginSession();
    }, 3 * 60 * 1000);

    return { success: true };
  } catch (err) {
    await cleanupLoginSession();
    return { success: false, error: err.message };
  }
}

/**
 * Take a screenshot of the current login page.
 * Returns base64-encoded PNG.
 */
async function getScreenshot() {
  if (!loginPage) return { success: false, error: 'No login session active' };

  try {
    const buffer = await loginPage.screenshot({ type: 'png' });
    return { success: true, screenshot: buffer.toString('base64') };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * Click at the given viewport coordinates.
 */
async function clickAt(x, y) {
  if (!loginPage) return { success: false, error: 'No login session active' };

  try {
    await loginPage.mouse.click(x, y);
    // Wait a bit for any navigation/interaction to settle
    await loginPage.waitForTimeout(500);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * Type text into the currently focused element.
 */
async function typeText(text) {
  if (!loginPage) return { success: false, error: 'No login session active' };

  try {
    await loginPage.keyboard.type(text, { delay: 50 });
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * Press a keyboard key (e.g., 'Enter', 'Tab', 'Backspace').
 */
async function pressKey(key) {
  if (!loginPage) return { success: false, error: 'No login session active' };

  try {
    await loginPage.keyboard.press(key);
    await loginPage.waitForTimeout(500);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * Check if the login session has successfully authenticated.
 */
async function checkLoginStatus() {
  if (!loginPage) return { loggedIn: false, active: false };

  try {
    const url = loginPage.url();
    const loggedIn = url.includes('/sales') && !url.includes('/login') && !url.includes('accounts.google.com');

    // Also handle route selection page
    if (url.includes('/start/route')) {
      try {
        await loginPage.click('button:has-text("S26: Västra Götaland")');
        await loginPage.click('button:has-text("Continue")');
        await loginPage.waitForTimeout(2000);
        const newUrl = loginPage.url();
        return {
          loggedIn: newUrl.includes('/sales'),
          active: true,
          url: newUrl,
        };
      } catch {
        return { loggedIn: false, active: true, url };
      }
    }

    return { loggedIn, active: true, url };
  } catch (err) {
    return { loggedIn: false, active: true, error: err.message };
  }
}

/**
 * Finish the login session — close the login browser.
 * The persistent context directory will retain the cookies for the main browser to use.
 */
async function finishLoginSession() {
  if (!loginPage) return { success: false, error: 'No login session active' };

  try {
    // Check if we're actually logged in
    const status = await checkLoginStatus();
    await cleanupLoginSession();

    return {
      success: true,
      loggedIn: status.loggedIn,
      message: status.loggedIn
        ? 'Session saved — scraper will use the new session on next restart.'
        : 'Session saved but login not detected — you may need to try again.',
    };
  } catch (err) {
    await cleanupLoginSession();
    return { success: false, error: err.message };
  }
}

/**
 * Cleanup login session resources.
 */
async function cleanupLoginSession() {
  if (loginTimeout) {
    clearTimeout(loginTimeout);
    loginTimeout = null;
  }
  if (loginContext) {
    try { await loginContext.close(); } catch { /* ignore */ }
    loginContext = null;
    loginPage = null;
  }
}

module.exports = {
  startLoginSession,
  getScreenshot,
  clickAt,
  typeText,
  pressKey,
  checkLoginStatus,
  finishLoginSession,
  cleanupLoginSession,
};
