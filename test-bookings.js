const { launchBrowser, BASE_URL } = require('./scraper');
const fs = require('fs');
const path = require('path');

/**
 * Phase 2 Discovery: Call the CORRECT endpoints found via network interception.
 *
 * Discovered endpoints:
 *   getRoutes          (hash: 14iizf7)  payload: [{"_ts":1}, <timestamp>]
 *   getScheduledStops  (hash: snipem)   payload: [{"routeId":1,"date":2}, "<routeId>", "<date>"]
 *   getBookingsToday   (hash: 1ewssmb)  payload: [{"routeId":1,"dateParam":2,"_ts":3}, "<routeId>", "<date>", <ts>]
 */

function devalueDecode(parsed) {
  const header = parsed[0];
  if (Array.isArray(header)) {
    const items = [];
    for (const idx of header) {
      const template = parsed[idx];
      if (template && typeof template === 'object' && !Array.isArray(template)) {
        const item = {};
        for (const [key, valIdx] of Object.entries(template)) {
          item[key] = parsed[valIdx];
        }
        items.push(item);
      }
    }
    return items;
  } else if (typeof header === 'object' && header !== null) {
    const result = {};
    for (const [key, valIdx] of Object.entries(header)) {
      const val = parsed[valIdx];
      if (Array.isArray(val)) {
        const items = [];
        for (const subIdx of val) {
          const template = parsed[subIdx];
          if (template && typeof template === 'object' && !Array.isArray(template)) {
            const item = {};
            for (const [k, vi] of Object.entries(template)) {
              item[k] = parsed[vi];
            }
            items.push(item);
          } else {
            items.push(parsed[subIdx]);
          }
        }
        result[key] = items;
      } else {
        result[key] = val;
      }
    }
    return result;
  }
  return parsed;
}

async function main() {
  console.log('🔍 Bookings API Discovery — Phase 2\n');

  const context = await launchBrowser(false);
  const page = await context.newPage();

  // Login check
  await page.goto(`${BASE_URL}/sales`, { waitUntil: 'networkidle', timeout: 30000 });
  let url = page.url();

  if (url.includes('/login') || url.includes('accounts.google.com')) {
    console.log('⏳ Session expired. Waiting for Google login...');
    for (let i = 0; i < 120; i++) {
      await new Promise(r => setTimeout(r, 1000));
      url = page.url();
      if (url.includes('agent.goldadam.app') && !url.includes('/login') && !url.includes('accounts.google.com')) break;
    }
    if (url.includes('/login') || url.includes('accounts.google.com')) {
      console.error('❌ Login timed out!');
      await context.close();
      return;
    }
    console.log('✅ Logged in!');
  }

  if (url.includes('/start/route')) {
    try {
      await page.click('button:has-text("S26")');
      await page.click('button:has-text("Continue")');
      await page.waitForTimeout(3000);
    } catch (e) {}
  }

  console.log('✅ Session valid.\n');
  await page.goto(`${BASE_URL}/bookings`, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(2000);

  // ── Step 1: Fetch all routes ───────────────────────────────
  console.log('═══ STEP 1: Fetch All Routes ═══');

  const routesResult = await page.evaluate(async (baseUrl) => {
    const payload = btoa(JSON.stringify([{ _ts: 1 }, Date.now()]));
    const url = `${baseUrl}/_app/remote/14iizf7/getRoutes?payload=${payload}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    if (json.type === 'error') throw new Error(JSON.stringify(json));
    return JSON.parse(json.result);
  }, BASE_URL);

  const routes = devalueDecode(routesResult);
  console.log(`Routes found: ${routes.length}`);
  if (routes.length > 0) {
    console.log('First route:', JSON.stringify(routes[0]));
    console.log('Fields:', Object.keys(routes[0]));
  }

  // ── Step 2: Fetch scheduled stops ──────────────────────────
  console.log('\n═══ STEP 2: Fetch Scheduled Stops ═══');

  const testRouteId = routes.length > 0
    ? (routes.find(r => r.name && r.name.includes('S26'))?.id || routes[0].id)
    : '50ac807a-0071-4f16-b4ef-81397cb13e86';
  const testRouteName = routes.find(r => r.id === testRouteId)?.name || 'unknown';

  const today = new Date();
  const dateStr = today.getFullYear() + '-' +
    String(today.getMonth() + 1).padStart(2, '0') + '-' +
    String(today.getDate()).padStart(2, '0');

  console.log(`Route: ${testRouteName} (${testRouteId})`);
  console.log(`Date: ${dateStr}\n`);

  const stopsRaw = await page.evaluate(async (args) => {
    const { baseUrl, routeId, date } = args;
    const payload = btoa(JSON.stringify([
      { routeId: 1, date: 2 },
      routeId,
      date
    ]));
    const url = `${baseUrl}/_app/remote/snipem/getScheduledStops?payload=${payload}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
    const json = await res.json();
    if (json.type === 'error') throw new Error(JSON.stringify(json));
    return JSON.parse(json.result);
  }, { baseUrl: BASE_URL, routeId: testRouteId, date: dateStr });

  console.log('Stops raw length:', stopsRaw.length);
  console.log('Stops raw header:', JSON.stringify(stopsRaw[0]));
  console.log('Stops raw sample (first 20):', JSON.stringify(stopsRaw.slice(0, 20), null, 2));

  const stops = devalueDecode(stopsRaw);
  console.log(`\nDecoded stops: ${Array.isArray(stops) ? stops.length : 'object'}`);
  if (Array.isArray(stops) && stops.length > 0) {
    console.log('\nFirst stop (full):', JSON.stringify(stops[0], null, 2));
    console.log('All stop fields:', Object.keys(stops[0]));
    console.log('\nAll stops summary:');
    stops.forEach((s, i) => console.log(`  ${i + 1}. ${s.name || s.stop_name || JSON.stringify(s)}`));
  } else if (typeof stops === 'object') {
    console.log('Decoded result:', JSON.stringify(stops, null, 2));
  }

  // ── Step 3: Fetch bookings today ──────────────────────────
  console.log('\n═══ STEP 3: Fetch Bookings Today ═══');

  const bookingsRaw = await page.evaluate(async (args) => {
    const { baseUrl, routeId, date } = args;
    const payload = btoa(JSON.stringify([
      { routeId: 1, dateParam: 2, _ts: 3 },
      routeId,
      date,
      Date.now()
    ]));
    const url = `${baseUrl}/_app/remote/1ewssmb/getBookingsToday?payload=${payload}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
    const json = await res.json();
    if (json.type === 'error') throw new Error(JSON.stringify(json));
    return JSON.parse(json.result);
  }, { baseUrl: BASE_URL, routeId: testRouteId, date: dateStr });

  console.log('Bookings raw length:', bookingsRaw.length);
  console.log('Bookings raw header:', JSON.stringify(bookingsRaw[0]));
  console.log('Bookings raw sample (first 20):', JSON.stringify(bookingsRaw.slice(0, 20), null, 2));

  const bookings = devalueDecode(bookingsRaw);
  console.log(`\nDecoded bookings: ${Array.isArray(bookings) ? bookings.length : 'object'}`);
  if (Array.isArray(bookings) && bookings.length > 0) {
    console.log('\nFirst booking (full):', JSON.stringify(bookings[0], null, 2));
    console.log('All booking fields:', Object.keys(bookings[0]));
  } else if (typeof bookings === 'object') {
    console.log('Decoded result:', JSON.stringify(bookings, null, 2));
  }

  // ── Save findings ─────────────────────────────────────────
  const findings = {
    routes,
    stopsRaw: stopsRaw.slice(0, 30),
    stops: Array.isArray(stops) ? stops : stops,
    bookingsRaw: bookingsRaw.slice(0, 30),
    bookings: Array.isArray(bookings) ? bookings : bookings,
    dateUsed: dateStr,
    routeUsed: { id: testRouteId, name: testRouteName }
  };

  fs.writeFileSync(
    path.join(__dirname, '_bookings_discovery.json'),
    JSON.stringify(findings, null, 2),
    'utf-8'
  );
  console.log('\n💾 Saved findings to _bookings_discovery.json');

  await context.close();
  console.log('✅ Discovery complete!');
}

main().catch(console.error);
