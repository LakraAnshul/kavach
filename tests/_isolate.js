/**
 * Test isolation. MUST be required before anything from src/.
 *
 * src/config.js resolves dataDir once, at module load, so the environment has to be
 * set before the first require of anything that reaches it. In CommonJS that means
 * this file goes at the very top of a suite's require list.
 *
 * Why bother. The suites used to write into data/ — the same mandate store and the
 * same append-only audit trail the demo reads. `npm test` left test mandates in the
 * dashboard's Mandates tab and dozens of `agent-test` and `conc-*` decisions in the
 * trail. Worse, because the suites end with process.exit(), how many of those entries
 * actually landed varied from run to run, so the demo's evidence was polluted *and*
 * nondeterministic. Pointing each suite at its own directory fixes both, and makes
 * "non-destructive, safe to run against a live demo" true rather than nearly true.
 */
const fs = require("fs");
const path = require("path");

// One directory PER SUITE, not one shared by all of them. run_all.js runs the suites
// sequentially, and two of them spawn a server subprocess that can still be releasing
// its handle on audit.jsonl when the next suite starts. A shared directory would put
// the next suite's wipe against that open handle, which on Windows is an EBUSY throw
// rather than a delete. Separate directories remove the contention outright.
const suite = path.basename(process.argv[1] || "suite", ".js") || "suite";
const DEFAULT_DIR = path.join(__dirname, ".tmp-data", suite);

if (!process.env.KAVACH_DATA_DIR) process.env.KAVACH_DATA_DIR = DEFAULT_DIR;
const dataDir = process.env.KAVACH_DATA_DIR;

// Start from empty so a suite's assertions never depend on a previous run — but only
// ever for the directory this file chose itself. A KAVACH_DATA_DIR supplied from
// outside is left alone: a recursive delete pointed at a real data directory by a
// stray environment variable is not a risk worth taking for a tidier fixture.
//
// A server subprocess a suite spawns never reaches this file — it requires src/, not
// tests/ — and inherits the resolved directory through the environment. Even if it did
// reach it, its own argv[1] would make DEFAULT_DIR a different path, so the equality
// check below is false and no wipe happens under a running parent either way.
if (path.resolve(dataDir) === path.resolve(DEFAULT_DIR)) {
  try {
    fs.rmSync(dataDir, { recursive: true, force: true });
  } catch (err) {
    // A leftover lock is not worth failing a suite over. Stale entries can only add
    // rows the assertions ignore — every suite asserts on ids it generates itself.
    console.log(`[isolate] could not clear ${dataDir} (${err.code || err.message}); reusing it`);
  }
}
fs.mkdirSync(dataDir, { recursive: true });

module.exports = { dataDir };
