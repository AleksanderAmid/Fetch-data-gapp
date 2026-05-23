const express = require('express');
const cron = require('node-cron');
const { launchBrowser, isLoggedIn, fetchSales, fetchSubagents, getTodayDate } = require('./scraper');
const { runSync } = require('./sync');
const {
  startLoginSession,
  getScreenshot,
  clickAt,
  typeText,
  pressKey,
  checkLoginStatus,
  finishLoginSession,
} = require('./auth-relay');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

let browserContext = null;
let page = null;
let syncRunning = false;

// Parse JSON bodies
app.use(express.json());

// API key middleware for sync/auth endpoints
const SYNC_API_KEY = process.env.SYNC_API_KEY || '';

function requireApiKey(req, res, next) {
  if (!SYNC_API_KEY) return next(); // No key configured = open access (dev mode)
  const provided = req.headers['x-sync-api-key'];
  if (provided !== SYNC_API_KEY) {
    return res.status(401).json({ error: 'Invalid API key' });
  }
  next();
}

/**
 * Initialize the browser with the saved session.
 */
async function initBrowser() {
  if (browserContext) return;

  console.log('🚀 Launching headless browser...');
  browserContext = await launchBrowser(true);
  page = await browserContext.newPage();

  // Check if session is still valid
  const loggedIn = await isLoggedIn(page);
  if (!loggedIn) {
    console.error('⚠️  Not logged in! Use the admin panel login relay or run "npm run login" to authenticate.');
    console.log('   Server will continue running — auth relay endpoints are available.');
    await browserContext.close();
    browserContext = null;
    page = null;
    return;
  }

  console.log('✅ Authenticated session loaded.');
}

/**
 * Middleware to ensure browser is ready.
 */
async function ensureBrowser(req, res, next) {
  try {
    if (!browserContext || !page) {
      await initBrowser();
    }
    next();
  } catch (err) {
    res.status(503).json({ error: 'Browser not ready', details: err.message });
  }
}

// ─── API Routes ──────────────────────────────────────────

/**
 * GET /api/sales
 * Query params: page, pageSize, sortBy, sortDir, startDate, endDate, search
 * Defaults to today's date if startDate/endDate not provided.
 */
app.get('/api/sales', ensureBrowser, async (req, res) => {
  try {
    const today = getTodayDate();
    const raw = await fetchSales(page, {
      page: req.query.page,
      pageSize: req.query.pageSize,
      sortBy: req.query.sortBy,
      sortDir: req.query.sortDir,
      startDate: req.query.startDate || today,
      endDate: req.query.endDate || today,
      search: req.query.search,
    });

    // Return only the fields we need
    const sales = (raw.packages || []).map(pkg => ({
      package_number: pkg.package_number,
      first_name: pkg.customer?.first_name || null,
      surname: pkg.customer?.surname || null,
      created_at: pkg.created_at,
      pure_gold_grams: pkg.pure_gold_grams,
      silver_weight_grams: pkg.silver_weight_grams,
      agent_route: pkg.agent_route,
      profit_margin_percent: pkg.profit_margin_percent,
      profit_amount: pkg.profit_amount ?? null,
      items: (pkg.items || []).map(item => ({
        material: item.material,
        purity: item.purity,
        purity_percent: item.purity_percent,
        weight_grams: item.weight_grams,
        price: item.price,
        profit: item.profit,
        price_per_gram: item.price_per_gram,
        profit_per_gram: item.profit_per_gram,
        profit_margin_percent: item.profit_margin_percent,
        price_adjustment: item.price_adjustment,
        stone_deductions: item.stone_deductions,
        photo_url: item.photo_url,
      })),
    }));

    res.json({
      sales,
      totalCount: raw.totalCount,
      page: raw.page,
      pageSize: raw.pageSize,
    });
  } catch (err) {
    console.error('Error fetching sales:', err.message);

    // Session might have expired — try re-login check
    const loggedIn = await isLoggedIn(page);
    if (!loggedIn) {
      res.status(401).json({ error: 'Session expired. Run "npm run login" to re-authenticate.' });
    } else {
      res.status(500).json({ error: 'Failed to fetch sales', details: err.message });
    }
  }
});

/**
 * GET /api/sales/subagents
 */
app.get('/api/sales/subagents', ensureBrowser, async (req, res) => {
  try {
    const data = await fetchSubagents(page);
    res.json(data);
  } catch (err) {
    console.error('Error fetching subagents:', err.message);
    res.status(500).json({ error: 'Failed to fetch subagents', details: err.message });
  }
});

/**
 * GET /api/health
 */
app.get('/api/health', async (req, res) => {
  const loggedIn = browserContext && page ? await isLoggedIn(page) : false;
  res.json({
    status: loggedIn ? 'ok' : 'not_authenticated',
    message: loggedIn ? 'Browser session active' : 'Run "npm run login" to authenticate',
  });
});

// ─── Sync endpoints ─────────────────────────────────────

/**
 * POST /api/sync/trigger — manually trigger a sync cycle
 */
app.post('/api/sync/trigger', requireApiKey, async (req, res) => {
  if (syncRunning) {
    return res.status(409).json({ error: 'Sync already in progress' });
  }
  if (!browserContext || !page) {
    return res.status(503).json({ error: 'Browser not ready' });
  }

  try {
    syncRunning = true;
    const result = await runSync(page);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    syncRunning = false;
  }
});

/**
 * GET /api/sync/status — get latest sync info
 */
app.get('/api/sync/status', requireApiKey, async (req, res) => {
  const { supabase } = require('./supabase');
  const { data, error } = await supabase
    .from('goldadam_sync_log')
    .select('*')
    .order('started_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) return res.status(500).json({ error: error.message });
  res.json({ lastSync: data, syncRunning });
});

// ─── Auth relay endpoints ────────────────────────────────

/**
 * POST /api/auth/start-login — start a remote login session
 */
app.post('/api/auth/start-login', requireApiKey, async (req, res) => {
  // Close the existing main browser so the login context can use .browser-session/
  if (browserContext) {
    await browserContext.close();
    browserContext = null;
    page = null;
  }

  const result = await startLoginSession();
  res.json(result);
});

/**
 * GET /api/auth/screenshot — get a screenshot of the login page
 */
app.get('/api/auth/screenshot', requireApiKey, async (req, res) => {
  const result = await getScreenshot();
  res.json(result);
});

/**
 * POST /api/auth/click — click at viewport coordinates
 */
app.post('/api/auth/click', requireApiKey, async (req, res) => {
  const { x, y } = req.body;
  if (typeof x !== 'number' || typeof y !== 'number') {
    return res.status(400).json({ error: 'x and y are required numbers' });
  }
  const result = await clickAt(x, y);
  res.json(result);
});

/**
 * POST /api/auth/type — type text into focused element
 */
app.post('/api/auth/type', requireApiKey, async (req, res) => {
  const { text } = req.body;
  if (typeof text !== 'string') {
    return res.status(400).json({ error: 'text is required' });
  }
  const result = await typeText(text);
  res.json(result);
});

/**
 * POST /api/auth/keypress — press a key
 */
app.post('/api/auth/keypress', requireApiKey, async (req, res) => {
  const { key } = req.body;
  if (typeof key !== 'string') {
    return res.status(400).json({ error: 'key is required' });
  }
  const result = await pressKey(key);
  res.json(result);
});

/**
 * GET /api/auth/status — check if login was successful
 */
app.get('/api/auth/status', requireApiKey, async (req, res) => {
  const result = await checkLoginStatus();
  res.json(result);
});

/**
 * POST /api/auth/finish — save session and close login browser
 */
app.post('/api/auth/finish', requireApiKey, async (req, res) => {
  const result = await finishLoginSession();

  // Re-initialize the main browser with the new session
  if (result.loggedIn) {
    try {
      await initBrowser();
      result.browserRestarted = true;
    } catch (err) {
      result.browserRestarted = false;
      result.browserError = err.message;
    }
  }

  res.json(result);
});

// ─── Graceful shutdown ──────────────────────────────────

async function cleanup() {
  if (browserContext) {
    console.log('🛑 Closing browser...');
    await browserContext.close();
  }
  process.exit(0);
}

process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);

// ─── Cron: sync every 5 minutes ────────────────────────

cron.schedule('*/5 * * * *', async () => {
  if (syncRunning) {
    console.log('⏳ Sync already running, skipping cron tick');
    return;
  }
  if (!browserContext || !page) {
    console.log('⏳ Browser not ready, skipping sync');
    return;
  }

  try {
    syncRunning = true;
    await runSync(page);
  } catch (err) {
    console.error('❌ Cron sync error:', err.message);
  } finally {
    syncRunning = false;
  }
});

// ─── Start ──────────────────────────────────────────────

app.listen(PORT, async () => {
  console.log(`\n📡 Gold Adam Sales API running on http://localhost:${PORT}`);
  console.log(`   GET  /api/sales           — Fetch sales data`);
  console.log(`   GET  /api/sales/subagents  — Fetch subagent data`);
  console.log(`   GET  /api/health           — Check session status`);
  console.log(`   POST /api/sync/trigger     — Trigger manual sync`);
  console.log(`   GET  /api/sync/status      — Last sync info`);
  console.log(`   POST /api/auth/start-login — Start login relay`);
  console.log(`   ⏰   Cron: sync every 5 minutes\n`);
  await initBrowser();
});
