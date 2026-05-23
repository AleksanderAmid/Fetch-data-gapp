const { launchBrowser, BASE_URL } = require('./scraper');
const fs = require('fs');
const path = require('path');

/**
 * Scrape all route booking schedules from Gold Adam.
 *
 * Endpoints (discovered via network interception):
 *   getRoutes          (14iizf7)  → all routes
 *   getScheduledStops  (snipem)   → stops per route+date
 *
 * Devalue format: parsed[0] = array of template indices,
 *   parsed[templateIdx] = {field: valueIdx, ...} where nested objects
 *   also use index references that must be recursively resolved.
 */

// ── Devalue decoder ──────────────────────────────────────────────
// Resolves the SvelteKit devalue serialization format recursively.
// parsed[0] is the root (array of stop indices or a header object).
// Each object template maps field names → indices into the parsed array.
// Primitives (strings, numbers, booleans, null) are leaf values.
function devalueResolve(parsed, idx, cache) {
  if (idx === undefined || idx === null) return idx;
  if (cache.has(idx)) return cache.get(idx);

  const val = parsed[idx];

  // Primitives — return as-is
  if (val === null || val === undefined) return val;
  if (typeof val !== 'object') return val;

  if (Array.isArray(val)) {
    const arr = [];
    cache.set(idx, arr); // cache before recursion to handle cycles
    for (const subIdx of val) {
      arr.push(devalueResolve(parsed, subIdx, cache));
    }
    return arr;
  }

  // Object template: keys → value indices
  const obj = {};
  cache.set(idx, obj);
  for (const [key, subIdx] of Object.entries(val)) {
    obj[key] = devalueResolve(parsed, subIdx, cache);
  }
  return obj;
}

function devalueDecode(parsed) {
  if (!parsed || !Array.isArray(parsed) || parsed.length === 0) return [];
  return devalueResolve(parsed, 0, new Map());
}

// ── Date helpers ─────────────────────────────────────────────────
function fmtDate(d) {
  return d.getFullYear() + '-' +
    String(d.getMonth() + 1).padStart(2, '0') + '-' +
    String(d.getDate()).padStart(2, '0');
}

function getMonday(d) {
  const date = new Date(d);
  const day = date.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  date.setDate(date.getDate() + diff);
  return date;
}

function getDayName(dateStr) {
  return new Date(dateStr + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long' });
}

function getWeekDates(monday) {
  const dates = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(monday);
    d.setDate(d.getDate() + i);
    dates.push(fmtDate(d));
  }
  return dates;
}

// ── Formatting a stop from decoded data ──────────────────────────
function formatStop(s, idx) {
  return {
    order: idx + 1,
    name: s.location?.title || s.displayLabel || 'Unknown',
    address: s.location?.address || null,
    postcode: s.location?.postcode || null,
    city: s.location?.city || null,
    latitude: s.location?.latitude || null,
    longitude: s.location?.longitude || null,
    startTime: s.startTime || null,
    endTime: s.endTime || null,
    status: s.status || null,
    displayLabel: s.displayLabel || null,
    travelToNext: s.travelToNext ? {
      durationMinutes: Math.round((s.travelToNext.durationSeconds || 0) / 60),
      distanceKm: Math.round((s.travelToNext.distanceMeters || 0) / 100) / 10,
      estimated: s.travelToNext.estimated || false
    } : null
  };
}

// ── Main ─────────────────────────────────────────────────────────
async function main() {
  console.log('🚀 Gold Adam — Route Bookings Scraper\n');

  const context = await launchBrowser(false);
  const page = await context.newPage();

  // ── Login ──────────────────────────────────────────────────
  await page.goto(`${BASE_URL}/sales`, { waitUntil: 'networkidle', timeout: 30000 });
  let url = page.url();

  if (url.includes('/login') || url.includes('accounts.google.com')) {
    console.log('⏳ Session expired. Please log in via the browser window...');
    for (let i = 0; i < 180; i++) {
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

  console.log('✅ Session active.\n');
  await page.goto(`${BASE_URL}/bookings`, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(1000);

  // ── Fetch all routes ───────────────────────────────────────
  console.log('📋 Fetching routes...');
  const routesRaw = await page.evaluate(async (baseUrl) => {
    const payload = btoa(JSON.stringify([{ _ts: 1 }, Date.now()]));
    const res = await fetch(`${baseUrl}/_app/remote/14iizf7/getRoutes?payload=${payload}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    if (json.type === 'error') throw new Error(JSON.stringify(json));
    return JSON.parse(json.result);
  }, BASE_URL);

  const routes = devalueDecode(routesRaw);
  const activeRoutes = Array.isArray(routes) ? routes.filter(r => r.status === 'active') : [];
  console.log(`   ${routes.length} total, ${activeRoutes.length} active\n`);

  if (activeRoutes.length === 0) {
    console.error('❌ No active routes found!');
    await context.close();
    return;
  }

  // ── Date ranges ────────────────────────────────────────────
  const today = new Date();
  const monday1 = getMonday(today);
  const week1 = getWeekDates(monday1);
  const monday2 = new Date(monday1);
  monday2.setDate(monday2.getDate() + 7);
  const week2 = getWeekDates(monday2);

  console.log(`📅 Week 1: ${week1[0]} → ${week1[6]}`);
  console.log(`📅 Week 2: ${week2[0]} → ${week2[6]}\n`);

  // ── Helper: fetch stops for a route+date ───────────────────
  async function getStops(routeId, date) {
    try {
      const raw = await page.evaluate(async (args) => {
        const payload = btoa(JSON.stringify([
          { routeId: 1, date: 2 },
          args.routeId,
          args.date
        ]));
        const res = await fetch(
          `${args.baseUrl}/_app/remote/snipem/getScheduledStops?payload=${payload}`
        );
        if (!res.ok) return null;
        const json = await res.json();
        if (json.type === 'error') return null;
        return JSON.parse(json.result);
      }, { baseUrl: BASE_URL, routeId, date });

      if (!raw) return [];
      const decoded = devalueDecode(raw);
      return Array.isArray(decoded) ? decoded : [];
    } catch (e) {
      return [];
    }
  }

  // ── Scrape all routes ──────────────────────────────────────
  const results = [];
  let done = 0;

  for (const route of activeRoutes) {
    const routeResult = {
      route_code: route.route_code,
      route_name: route.name,
      route_id: route.id,
      area: route.area,
      schedule_type: 'weekly',
      schedule: []
    };

    // Fetch week 1 (7 days)
    for (const date of week1) {
      const stops = await getStops(route.id, date);
      routeResult.schedule.push({
        date,
        day_of_week: getDayName(date),
        total_stops: stops.length,
        stops: stops.map(formatStop)
      });
    }

    // Smart 2-week detection: fetch next Monday and compare first stop
    const week2MondayStops = await getStops(route.id, week2[0]);
    const week1MonFirst = routeResult.schedule[0]?.stops?.[0]?.name;
    const week2MonFirst = week2MondayStops[0]?.location?.title || week2MondayStops[0]?.displayLabel;
    const week1MonCount = routeResult.schedule[0]?.total_stops || 0;

    let needsWeek2 = false;
    if (week2MondayStops.length > 0) {
      if (week2MonFirst && week1MonFirst && week2MonFirst !== week1MonFirst) needsWeek2 = true;
      if (week2MondayStops.length !== week1MonCount) needsWeek2 = true;
    }

    if (needsWeek2) {
      routeResult.schedule_type = 'biweekly';
      // Already have Monday of week 2
      routeResult.schedule.push({
        date: week2[0],
        day_of_week: getDayName(week2[0]),
        total_stops: week2MondayStops.length,
        stops: week2MondayStops.map(formatStop)
      });
      // Fetch Tue-Sun of week 2
      for (let i = 1; i < 7; i++) {
        const stops = await getStops(route.id, week2[i]);
        routeResult.schedule.push({
          date: week2[i],
          day_of_week: getDayName(week2[i]),
          total_stops: stops.length,
          stops: stops.map(formatStop)
        });
      }
    }

    done++;
    const totalStops = routeResult.schedule.reduce((s, d) => s + d.total_stops, 0);
    const weeks = routeResult.schedule_type === 'biweekly' ? '2wk' : '1wk';
    console.log(`  ✅ [${done}/${activeRoutes.length}] ${route.name} — ${totalStops} stops (${weeks})`);

    results.push(routeResult);
  }

  // ── Summary ────────────────────────────────────────────────
  const totalStopsAll = results.reduce((s, r) => s + r.schedule.reduce((s2, d) => s2 + d.total_stops, 0), 0);
  const biweekly = results.filter(r => r.schedule_type === 'biweekly').length;

  console.log(`\n═══ SUMMARY ═══`);
  console.log(`Routes scraped: ${results.length}`);
  console.log(`Total scheduled stops: ${totalStopsAll}`);
  console.log(`Biweekly routes: ${biweekly}`);

  // ── Save ───────────────────────────────────────────────────
  const output = {
    scraped_at: new Date().toISOString(),
    total_routes: results.length,
    total_stops: totalStopsAll,
    biweekly_routes: biweekly,
    week1: { start: week1[0], end: week1[6] },
    week2: { start: week2[0], end: week2[6] },
    routes: results
  };

  const outPath = path.join(__dirname, 'BOOKINGS_DATA.json');
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2), 'utf-8');
  console.log(`\n💾 Saved to ${outPath}`);

  await context.close();
  console.log('✅ Done!');
}

main().catch(console.error);
