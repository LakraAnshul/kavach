/**
 * CONCURRENCY — the single-use bound must hold when two agents race.
 *
 * Why this test exists. Validating a mandate and burning it are not adjacent in
 * time: between them sits a full Razorpay round-trip (235 ms in this project's
 * own server log). If the bound is only *checked* before that call and only
 * *claimed* after it, a second request that arrives inside the window reads a
 * mandate that is still active, clears every bound, and creates a second order.
 * One single-use mandate, two real orders.
 *
 * So the gate has to check and claim in one indivisible step. These tests drive the
 * mandate engine directly, which makes them a fast and precise test of that step.
 *
 * SCOPE, stated plainly: driving the engine directly means these tests cannot see
 * src/server.js. The double-spend this project actually had lived in the route — it
 * checked the bound, called the gateway, and only then burned the mandate — and
 * nothing here would notice if the route went back to doing that, because nothing
 * here forces the route to use the atomic gate at all. tests/test_transaction_race.js
 * covers that: it goes over real HTTP through POST /api/transactions. Both matter.
 * This file localises a failure to the engine; that one proves the money path is safe.
 *
 * Non-destructive by design: it creates its own mandates under unique agent ids
 * and never deletes a data file, so it can be run against a live demo.
 */
require("./_isolate"); // first: fixes the data directory before src/config resolves it
const assert = require("assert");
const engine = require("../src/mandates/engine");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const GATEWAY_MS = 40; // stands in for the real ~235 ms order-creation call

let failures = 0;
async function check(name, fn) {
  try {
    await fn();
    console.log(`PASS  ${name}`);
  } catch (e) {
    failures++;
    console.error(`FAIL  ${name}: ${e.message}`);
  }
}

function mandate(agent_id, { max_spend_paise = 100000, single_use = true, categories = ["electronics"] } = {}) {
  return engine.createMandate({
    agent_id,
    max_spend_paise,
    category_allowlist: categories,
    expiry_timestamp: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    single_use,
  });
}

/**
 * One transaction attempt against the engine, in the same order the route uses:
 * gate the mandate, wait out a gateway call, then settle the mandate on the outcome.
 * This is a stand-in for the route, not a check on it — see the scope note at the
 * top of the file, and test_transaction_race.js for the route itself.
 */
async function attempt({ mandate_id, agent_id, amount_paise, category = "electronics", gateway = "ok" }) {
  const gate = await engine.reserveMandateForTransaction({ mandate_id, agent_id, amount_paise, category });
  if (!gate.allowed) return { approved: false, reason_code: gate.reason_code };

  await sleep(GATEWAY_MS); // the window a racing request would slip into

  if (gateway === "fail") {
    await engine.releaseMandate(mandate_id, { reason: "gateway rejected the order" });
    return { approved: false, reason_code: "gateway_error" };
  }
  await engine.consumeMandate(mandate_id, { transaction_id: "tx_" + agent_id, amount_paise });
  return { approved: true };
}

async function run() {
  await check("two concurrent attempts on one single-use mandate -> exactly one approved", async () => {
    const m = await mandate("conc-two");
    const results = await Promise.all([
      attempt({ mandate_id: m.mandate_id, agent_id: "conc-two", amount_paise: 100000 }),
      attempt({ mandate_id: m.mandate_id, agent_id: "conc-two", amount_paise: 100000 }),
    ]);
    const approved = results.filter((r) => r.approved);
    assert.equal(
      approved.length,
      1,
      `${approved.length} of 2 concurrent attempts were approved against one single-use mandate; ` +
        `that authorises ${approved.length * 100000} paise against a 100000 paise bound. ` +
        `Results: ${JSON.stringify(results)}`
    );
    const refused = results.find((r) => !r.approved);
    assert.ok(refused.reason_code, "the refused attempt must carry a reason code");
  });

  await check("ten concurrent attempts on one single-use mandate -> exactly one approved", async () => {
    const m = await mandate("conc-ten");
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        attempt({ mandate_id: m.mandate_id, agent_id: "conc-ten", amount_paise: 100000 })
      )
    );
    const approved = results.filter((r) => r.approved);
    assert.equal(
      approved.length,
      1,
      `${approved.length} of 10 concurrent attempts cleared one single-use mandate. ` +
        `Reasons: ${JSON.stringify(results.map((r) => r.reason_code || "approved"))}`
    );
  });

  await check("a claimed-but-unfinished mandate is refused, not silently allowed", async () => {
    const m = await mandate("conc-inflight");
    // Claim it and hold, exactly as a request waiting on the gateway would.
    const first = await engine.reserveMandateForTransaction({
      mandate_id: m.mandate_id, agent_id: "conc-inflight", amount_paise: 100000, category: "electronics",
    });
    assert.equal(first.allowed, true, "the first claim must succeed");

    const second = await engine.reserveMandateForTransaction({
      mandate_id: m.mandate_id, agent_id: "conc-inflight", amount_paise: 100000, category: "electronics",
    });
    assert.equal(second.allowed, false, "a second claim on an in-flight single-use mandate must be refused");
    assert.ok(
      second.explanation && second.explanation.length > 0,
      "the refusal must explain itself in words, like every other refusal on this rail"
    );
  });

  await check("a failed gateway call releases the claim; the mandate is not bricked", async () => {
    const m = await mandate("conc-release");
    const failed = await attempt({ mandate_id: m.mandate_id, agent_id: "conc-release", amount_paise: 100000, gateway: "fail" });
    assert.equal(failed.approved, false);

    // The order never happened, so the spending power must still be there.
    const retry = await attempt({ mandate_id: m.mandate_id, agent_id: "conc-release", amount_paise: 100000 });
    assert.equal(
      retry.approved,
      true,
      `a gateway failure left the mandate unusable (${retry.reason_code}); a refused order must not consume spending power`
    );
  });

  await check("claiming still enforces every bound it enforced before", async () => {
    const m = await mandate("conc-bounds", { max_spend_paise: 50000, categories: ["electronics"] });
    const over = await engine.reserveMandateForTransaction({
      mandate_id: m.mandate_id, agent_id: "conc-bounds", amount_paise: 50001, category: "electronics",
    });
    assert.equal(over.allowed, false);
    assert.equal(over.reason_code, "mandate_exceeded");

    const wrongCat = await engine.reserveMandateForTransaction({
      mandate_id: m.mandate_id, agent_id: "conc-bounds", amount_paise: 100, category: "gambling",
    });
    assert.equal(wrongCat.allowed, false);
    assert.equal(wrongCat.reason_code, "category_not_allowed");

    const wrongOwner = await engine.reserveMandateForTransaction({
      mandate_id: m.mandate_id, agent_id: "conc-someone-else", amount_paise: 100, category: "electronics",
    });
    assert.equal(wrongOwner.allowed, false);

    // A refused claim must not have consumed anything.
    const good = await engine.reserveMandateForTransaction({
      mandate_id: m.mandate_id, agent_id: "conc-bounds", amount_paise: 50000, category: "electronics",
    });
    assert.equal(good.allowed, true, "refused claims must leave the mandate untouched");
  });

  await check("a reusable mandate still allows repeat spending within its per-transaction cap", async () => {
    const m = await mandate("conc-reusable", { single_use: false });
    const results = await Promise.all([
      attempt({ mandate_id: m.mandate_id, agent_id: "conc-reusable", amount_paise: 100000 }),
      attempt({ mandate_id: m.mandate_id, agent_id: "conc-reusable", amount_paise: 100000 }),
    ]);
    assert.equal(
      results.filter((r) => r.approved).length,
      2,
      `a reusable mandate must not be serialized like a single-use one: ${JSON.stringify(results)}`
    );
  });

  console.log(failures === 0 ? "\nALL CONCURRENCY TESTS PASSED" : `\n${failures} TEST(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

run();
