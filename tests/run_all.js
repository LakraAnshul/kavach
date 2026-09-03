/**
 * Runs every suite in one go and reports a single verdict.
 *
 * Sequential, not parallel: the mandate suites share one JSON store and the webhook
 * suite boots a server that writes the same audit log. Running them concurrently
 * would let one suite's writes land in the middle of another's, and a red result
 * would tell you nothing about which bound actually broke.
 */
const path = require("path");
const { spawn } = require("child_process");

const SUITES = [
  ["passport signature", "test_passport_tamper.js"],
  ["mandate bounds", "test_mandates.js"],
  ["concurrency (engine)", "test_concurrency.js"],
  ["transaction race (http)", "test_transaction_race.js"],
  ["webhook signature", "test_webhook.js"],
  ["catalog ingestion (http)", "test_catalog_ingestion.js"],
  ["multi-merchant pricing (http)", "test_multi_merchant.js"],
  ["mandate revocation (lifecycle)", "test_mandate_revocation.js"],
];

function runSuite(file) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(__dirname, file)], { stdio: "inherit" });
    child.on("error", (err) => {
      console.error(`could not start ${file}: ${err.message}`);
      resolve(1);
    });
    child.on("close", (code) => resolve(code === 0 ? 0 : code || 1));
  });
}

(async () => {
  const failed = [];
  for (const [label, file] of SUITES) {
    console.log(`\n=== ${label} (${file}) ===`);
    const code = await runSuite(file);
    if (code !== 0) failed.push(label);
  }

  console.log("\n========================================");
  if (failed.length === 0) {
    console.log(`ALL ${SUITES.length} SUITES PASSED`);
    process.exit(0);
  }
  console.log(`${failed.length} of ${SUITES.length} SUITES FAILED: ${failed.join(", ")}`);
  process.exit(1);
})();
