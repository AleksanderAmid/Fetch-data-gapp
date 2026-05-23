const { chromium } = require('playwright');
const path = require('path');

const USER_DATA_DIR = path.join(__dirname, '.browser-session');
const BASE_URL = 'https://agent.goldadam.app';

/**
 * Launches a browser with persistent session (reuses cookies from previous logins).
 * This looks like a real user — no suspicious activity.
 */
async function launchBrowser(headless = true) {
  const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
    headless,
    viewport: { width: 1280, height: 800 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  });
  return context;
}

/**
 * Check if we're logged in. Navigates to /sales — if redirected to route selection,
 * auto-selects route S26 and continues. Returns false only if sent to login/Google.
 */
async function isLoggedIn(page) {
  await page.goto(`${BASE_URL}/sales`, { waitUntil: 'networkidle', timeout: 30000 });
  let url = page.url();

  // If we hit the route selection page, pick S26 and go straight to /sales
  if (url.includes('/start/route')) {
    try {
      await page.click('button:has-text("S26: Västra Götaland")');
      await page.click('button:has-text("Continue")');
      await page.waitForTimeout(2000);
      await page.goto(`${BASE_URL}/sales`, { waitUntil: 'networkidle', timeout: 30000 });
      url = page.url();
    } catch {
      return false;
    }
  }

  return url.includes('/sales') && !url.includes('/login') && !url.includes('accounts.google.com');
}

/**
 * Returns today's date as YYYY-MM-DD.
 */
function getTodayDate() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

/**
 * Fetches sales data by making the same API call the frontend makes,
 * but from within the authenticated browser session.
 * Defaults to today's date if no date range is provided.
 */
async function fetchSales(page, options = {}) {
  const today = getTodayDate();
  const {
    page: pageNum = 1,
    pageSize = 50,
    sortBy = 'created_at',
    sortDir = 'desc',
    startDate = today,
    endDate = today,
    search,
  } = options;

  // Build query string
  const params = new URLSearchParams({
    page: String(pageNum),
    pageSize: String(pageSize),
    sortBy,
    sortDir,
    startDate,
    endDate,
  });
  if (search) params.set('search', search);

  const apiUrl = `${BASE_URL}/api/sales?${params.toString()}`;

  // Use page.evaluate to make fetch from the authenticated browser context
  const data = await page.evaluate(async (url) => {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    return res.json();
  }, apiUrl);

  return data;
}

/**
 * Fetches subagents data
 */
async function fetchSubagents(page) {
  const data = await page.evaluate(async (url) => {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    return res.json();
  }, `${BASE_URL}/api/sales/subagents`);
  return data;
}

module.exports = { launchBrowser, isLoggedIn, fetchSales, fetchSubagents, getTodayDate, BASE_URL };
