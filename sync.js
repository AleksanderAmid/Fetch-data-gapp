// Gold Adam → Supabase sync module
// Fetches today's sales from Gold Adam via the authenticated browser session,
// matches routes to organizations, and inserts new sales + items into Supabase.

const { supabase } = require('./supabase');
const { fetchSales, getTodayDate } = require('./scraper');

/**
 * Parse route number from an org name like "#26 Västra Götaland" → "26"
 */
function parseRouteNumber(orgName) {
  const match = orgName.match(/#(\d+)/);
  return match ? match[1] : null;
}

/**
 * Parse route number from Gold Adam agent_route like "26" or "S26: Västra Götaland" → "26"
 */
function parseAgentRoute(agentRoute) {
  if (!agentRoute) return null;
  const str = String(agentRoute);
  // Try pure number first
  if (/^\d+$/.test(str)) return str;
  // Try pattern like "S26: ..."
  const match = str.match(/S?(\d+)/i);
  return match ? match[1] : null;
}

/**
 * Run a full sync cycle.
 * @param {import('playwright').Page} page - The authenticated Playwright page
 * @returns {Object} Sync result with counts
 */
async function runSync(page) {
  console.log('🔄 Starting Gold Adam sync...');

  // 1. Check config
  const { data: config, error: configErr } = await supabase
    .from('goldadam_sync_config')
    .select('*')
    .limit(1)
    .maybeSingle();

  if (configErr || !config) {
    console.log('⚠️  No sync config found or error:', configErr?.message);
    return { status: 'error', error: 'No sync config found' };
  }

  if (!config.enabled) {
    console.log('⏸️  Sync is disabled in config.');
    return { status: 'skipped', error: 'Sync disabled' };
  }

  // 2. Create log entry
  const { data: logEntry, error: logErr } = await supabase
    .from('goldadam_sync_log')
    .insert({ status: 'running' })
    .select('id')
    .single();

  if (logErr) {
    console.error('❌ Failed to create sync log:', logErr.message);
    return { status: 'error', error: logErr.message };
  }

  const logId = logEntry.id;
  let salesFetched = 0;
  let salesInserted = 0;
  let salesSkipped = 0;

  try {
    // 3. Fetch all organizations and build route-number → org_id map
    const { data: orgs, error: orgsErr } = await supabase
      .from('organizations')
      .select('id, name');

    if (orgsErr) throw new Error(`Failed to fetch orgs: ${orgsErr.message}`);

    const routeToOrg = new Map();
    for (const org of orgs || []) {
      const routeNum = parseRouteNumber(org.name);
      if (routeNum) {
        routeToOrg.set(routeNum, org.id);
      }
    }

    console.log(`📋 Orgs mapped: ${routeToOrg.size} orgs with route numbers`);

    // 4. Fetch today's sales from Gold Adam (all pages)
    const today = getTodayDate();
    let allPackages = [];
    let currentPage = 1;
    const pageSize = 50;

    while (true) {
      const raw = await fetchSales(page, {
        page: currentPage,
        pageSize,
        startDate: today,
        endDate: today,
        sortBy: 'created_at',
        sortDir: 'desc',
      });

      const packages = raw.packages || [];
      allPackages = allPackages.concat(packages);

      if (packages.length < pageSize || allPackages.length >= (raw.totalCount || 0)) {
        break;
      }
      currentPage++;
    }

    salesFetched = allPackages.length;
    console.log(`📦 Fetched ${salesFetched} packages from Gold Adam`);

    if (salesFetched === 0) {
      await supabase
        .from('goldadam_sync_log')
        .update({
          finished_at: new Date().toISOString(),
          status: 'success',
          sales_fetched: 0,
          sales_inserted: 0,
          sales_skipped: 0,
        })
        .eq('id', logId);

      return { status: 'success', salesFetched: 0, salesInserted: 0, salesSkipped: 0 };
    }

    // 5. Get existing package numbers to detect duplicates
    const pkgNumbers = allPackages.map(p => p.package_number);
    const { data: existingSales } = await supabase
      .from('sales')
      .select('package_number')
      .in('package_number', pkgNumbers);

    const existingPkgSet = new Set((existingSales || []).map(s => s.package_number));

    // 6. Insert each new sale
    for (const pkg of allPackages) {
      if (existingPkgSet.has(pkg.package_number)) {
        salesSkipped++;
        continue;
      }

      // Match route
      const routeNum = parseAgentRoute(pkg.agent_route);
      const orgId = routeNum ? routeToOrg.get(routeNum) : null;

      if (!orgId) {
        console.warn(`⚠️  No org match for route "${pkg.agent_route}" (parsed: ${routeNum})`);
        salesSkipped++;
        continue;
      }

      // Build customer name
      const firstName = pkg.customer?.first_name || '';
      const surname = pkg.customer?.surname || '';
      const customerName = `${firstName} ${surname}`.trim() || 'Unknown';

      // Calculate amount from items if profit_amount not available
      let amount = pkg.profit_amount ?? 0;
      if (!amount && pkg.items?.length) {
        amount = pkg.items.reduce((sum, item) => sum + (item.price || 0), 0);
      }

      // Insert sale
      const { data: sale, error: insertErr } = await supabase
        .from('sales')
        .insert({
          org_id: orgId,
          user_id: config.default_user_id,
          date: pkg.created_at || new Date().toISOString(),
          package_number: pkg.package_number,
          customer_name: customerName,
          gold_pure: pkg.pure_gold_grams ?? null,
          silver_pure: pkg.silver_weight_grams ?? null,
          amount,
          currency_code: 'SEK',
          margin_percent: pkg.profit_margin_percent ?? null,
          source: 'auto_fetch',
        })
        .select('id')
        .single();

      if (insertErr) {
        // Duplicate constraint or other error — skip
        console.warn(`⚠️  Failed to insert ${pkg.package_number}: ${insertErr.message}`);
        salesSkipped++;
        continue;
      }

      // Insert items
      if (pkg.items?.length && sale?.id) {
        const items = pkg.items.map(item => ({
          sale_id: sale.id,
          material: item.material || 'unknown',
          purity: item.purity || null,
          purity_percent: item.purity_percent ?? null,
          weight_grams: item.weight_grams ?? null,
          price: item.price ?? null,
          profit: item.profit ?? null,
          price_per_gram: item.price_per_gram ?? null,
          profit_per_gram: item.profit_per_gram ?? null,
          profit_margin_percent: item.profit_margin_percent ?? null,
          price_adjustment: item.price_adjustment ?? 0,
          stone_deductions: item.stone_deductions ?? 0,
          photo_url: item.photo_url || null,
        }));

        const { error: itemsErr } = await supabase
          .from('sale_items')
          .insert(items);

        if (itemsErr) {
          console.warn(`⚠️  Failed to insert items for ${pkg.package_number}: ${itemsErr.message}`);
        }
      }

      salesInserted++;
    }

    // 7. Update log entry
    await supabase
      .from('goldadam_sync_log')
      .update({
        finished_at: new Date().toISOString(),
        status: 'success',
        sales_fetched: salesFetched,
        sales_inserted: salesInserted,
        sales_skipped: salesSkipped,
      })
      .eq('id', logId);

    console.log(`✅ Sync complete: ${salesInserted} inserted, ${salesSkipped} skipped out of ${salesFetched} fetched`);

    return { status: 'success', salesFetched, salesInserted, salesSkipped };
  } catch (err) {
    console.error('❌ Sync error:', err.message);

    // Update log with error
    await supabase
      .from('goldadam_sync_log')
      .update({
        finished_at: new Date().toISOString(),
        status: 'error',
        sales_fetched: salesFetched,
        sales_inserted: salesInserted,
        sales_skipped: salesSkipped,
        error_message: err.message,
      })
      .eq('id', logId);

    return { status: 'error', error: err.message, salesFetched, salesInserted, salesSkipped };
  }
}

module.exports = { runSync };
