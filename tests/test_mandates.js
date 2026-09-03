require("./_isolate"); // first: fixes the data directory before src/config resolves it
const assert = require("assert");
const engine = require("../src/mandates/engine");

async function run() {
  // No store reset. Every case below creates its own mandate with a fresh random id
  // and asserts only against that one, so pre-existing entries cannot affect the
  // outcome. Deleting the store would only strand the demo's audit trail, which
  // still references the mandates it recorded decisions about.
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

  const now = Date.now();
  const future = new Date(now + 60 * 60 * 1000).toISOString();
  const past = new Date(now - 60 * 60 * 1000).toISOString();

  const mOk = await engine.createMandate({
    agent_id: "agent-test",
    max_spend_paise: 500000,
    category_allowlist: ["electronics"],
    expiry_timestamp: future,
    single_use: false,
  });
  const mSingle = await engine.createMandate({
    agent_id: "agent-test",
    max_spend_paise: 500000,
    category_allowlist: ["electronics"],
    expiry_timestamp: future,
    single_use: true,
  });
  const mExpired = await engine.createMandate({
    agent_id: "agent-test",
    max_spend_paise: 500000,
    category_allowlist: ["electronics"],
    expiry_timestamp: past,
    single_use: false,
  });
  const mMultiCat = await engine.createMandate({
    agent_id: "agent-test",
    max_spend_paise: 500000,
    category_allowlist: ["electronics", "home"],
    expiry_timestamp: future,
    single_use: false,
  });

  await check("1. expired mandate -> mandate_expired", async () => {
    const r = await engine.validateMandateForTransaction({
      mandate_id: mExpired.mandate_id, agent_id: "agent-test", amount_paise: 10000, category: "electronics",
    });
    assert.equal(r.allowed, false);
    assert.equal(r.reason_code, "mandate_expired");
  });

  await check("2. overspend -> mandate_exceeded", async () => {
    const r = await engine.validateMandateForTransaction({
      mandate_id: mOk.mandate_id, agent_id: "agent-test", amount_paise: 500001, category: "electronics",
    });
    assert.equal(r.allowed, false);
    assert.equal(r.reason_code, "mandate_exceeded");
  });

  await check("3. category outside allowlist -> category_not_allowed", async () => {
    const r = await engine.validateMandateForTransaction({
      mandate_id: mOk.mandate_id, agent_id: "agent-test", amount_paise: 10000, category: "gambling",
    });
    assert.equal(r.allowed, false);
    assert.equal(r.reason_code, "category_not_allowed");
  });

  await check("4. single-use reuse -> mandate_already_consumed", async () => {
    const first = await engine.validateMandateForTransaction({
      mandate_id: mSingle.mandate_id, agent_id: "agent-test", amount_paise: 10000, category: "electronics",
    });
    assert.equal(first.allowed, true, `expected first pass, got ${first.reason_code}`);
    await engine.consumeMandate(mSingle.mandate_id, { transaction_id: "tx_test_1" });
    const second = await engine.validateMandateForTransaction({
      mandate_id: mSingle.mandate_id, agent_id: "agent-test", amount_paise: 10000, category: "electronics",
    });
    assert.equal(second.allowed, false);
    assert.equal(second.reason_code, "mandate_already_consumed");
  });

  await check("5. malformed request/mandate -> mandate_malformed (never reaches Razorpay)", async () => {
    const badAmount = await engine.validateMandateForTransaction({
      mandate_id: mOk.mandate_id, agent_id: "agent-test", amount_paise: 10.5, category: "electronics",
    });
    assert.equal(badAmount.allowed, false);
    assert.equal(badAmount.reason_code, "mandate_malformed");

    const noCategory = await engine.validateMandateForTransaction({
      mandate_id: mOk.mandate_id, agent_id: "agent-test", amount_paise: 100, category: "",
    });
    assert.equal(noCategory.reason_code, "mandate_malformed");

    const unknownId = await engine.validateMandateForTransaction({
      mandate_id: "mdt_doesnotexist", agent_id: "agent-test", amount_paise: 100, category: "electronics",
    });
    assert.equal(unknownId.reason_code, "mandate_not_found");

    const wrongOwner = await engine.validateMandateForTransaction({
      mandate_id: mOk.mandate_id, agent_id: "agent-rogue", amount_paise: 100, category: "electronics",
    });
    assert.equal(wrongOwner.reason_code, "mandate_not_found");
  });

  await check("6. happy path within bounds -> allowed", async () => {
    const r = await engine.validateMandateForTransaction({
      mandate_id: mMultiCat.mandate_id, agent_id: "agent-test", amount_paise: 349900, category: "home",
    });
    assert.equal(r.allowed, true);
  });

  console.log(failures === 0 ? "\nALL MANDATE TESTS PASSED" : `\n${failures} TEST(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

run();
