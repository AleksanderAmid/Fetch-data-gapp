const { launchBrowser, isLoggedIn, BASE_URL } = require('./scraper');
const fs = require('fs');
const path = require('path');

/**
 * Fetch all CRM customer data from /crm page by calling the getCustomers RPC.
 * Decodes the SvelteKit devalue format in-browser and paginates through all results.
 */
async function main() {
  console.log('🧪 CRM Data Fetcher — Extracting all customer data...\n');

  const context = await launchBrowser(true);
  const page = await context.newPage();

  const loggedIn = await isLoggedIn(page);
  if (!loggedIn) {
    console.error('❌ Not logged in! Run "npm run login" first.');
    await context.close();
    return;
  }
  console.log('✅ Session valid.\n');

  // Navigate to /crm first to establish the session context
  console.log('🌐 Navigating to /crm...');
  await page.goto(`${BASE_URL}/crm`, { waitUntil: 'networkidle', timeout: 30000 });
  console.log(`📍 Landed on: ${page.url()}\n`);

  // Wait for initial data to load
  await page.waitForTimeout(3000);

  // Extract ALL customers by paginating through the getCustomers RPC endpoint
  // We decode the devalue response inside the browser context
  const allCustomers = await page.evaluate(async (baseUrl) => {
    const customers = [];
    let currentPage = 1;
    let hasMore = true;
    let totalCount = 0;

    while (hasMore) {
      // Build payload: [{"page":N,"search":-1,"myCustomers":-1},0]
      const payload = JSON.stringify([{ page: currentPage, search: -1, myCustomers: -1 }, 0]);
      const encodedPayload = btoa(payload);
      const url = `${baseUrl}/_app/remote/l2h6vx/getCustomers?payload=${encodedPayload}`;

      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status} on page ${currentPage}`);
      const json = await res.json();

      // The result is a devalue-encoded string — parse it
      const parsed = JSON.parse(json.result);

      // parsed[0] = {customers: idx, totalCount: idx, hasMore: idx}
      const header = parsed[0];
      totalCount = parsed[header.totalCount];
      const hasMoreVal = parsed[header.hasMore];

      // parsed[header.customers] = array of indices pointing to customer template objects
      const customerIndices = parsed[header.customers];

      if (!customerIndices || customerIndices.length === 0) break;

      for (const idx of customerIndices) {
        const template = parsed[idx];
        const customer = {};
        for (const [key, valIdx] of Object.entries(template)) {
          customer[key] = parsed[valIdx];
        }
        delete customer.search_vector;
        customers.push(customer);
      }

      // Stop when we've fetched all customers
      if (customers.length >= totalCount) {
        hasMore = false;
      } else {
        currentPage++;
      }

      if (currentPage > 200) break; // safety
    }

    return { customers: customers.slice(0, totalCount), totalCount };
  }, BASE_URL);

  console.log(`📊 Fetched ${allCustomers.customers.length} customers (total in CRM: ${allCustomers.totalCount})\n`);

  // Preview first 5
  for (const c of allCustomers.customers.slice(0, 5)) {
    console.log(`  ${c.first_name} ${c.surname} | ${c.email} | ${c.mobile_number} | ${c.total_sales} ${c.currency}`);
  }
  if (allCustomers.customers.length > 5) {
    console.log(`  ... and ${allCustomers.customers.length - 5} more`);
  }

  // Save
  const outPath = path.join(__dirname, 'CRM_DATA.json');
  fs.writeFileSync(outPath, JSON.stringify(allCustomers, null, 2), 'utf-8');
  console.log(`\n💾 Saved to CRM_DATA.json (${allCustomers.customers.length} customers)`);

  await context.close();
  console.log('✅ Done!');
}

main().catch(console.error);
