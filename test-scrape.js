const { launchBrowser, isLoggedIn, fetchSales } = require('./scraper');

/**
 * Quick test: fetches sales and prints them.
 * Usage: node test-scrape.js
 */
async function main() {
  console.log('🧪 Testing scraper...\n');

  const context = await launchBrowser(true);
  const page = await context.newPage();

  const loggedIn = await isLoggedIn(page);
  if (!loggedIn) {
    console.error('❌ Not logged in! Run "npm run login" first.');
    await context.close();
    return;
  }

  console.log('✅ Session valid. Fetching sales...\n');

  const data = await fetchSales(page);
  console.log(`📊 Got ${data.totalCount} sales:\n`);

  for (const pkg of data.packages) {
    console.log(`  ${pkg.package_number} | ${pkg.customer.first_name} ${pkg.customer.surname} | ${pkg.total_price} ${pkg.currency} | ${pkg.pure_gold_grams}g gold`);
  }

  await context.close();
  console.log('\n✅ Done!');
}

main().catch(console.error);
