require("./_isolate"); // must be first to point KAVACH_DATA_DIR to isolated test folder
const assert = require("assert");
const engine = require("../src/mandates/engine");
const audit = require("../src/audit/log");

async function run() {
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

  // 1. Revoke an active mandate -> 200, status "revoked", audit logged
  let m1;
  await check("1. revoke active mandate -> status becomes revoked and audit logged", async () => {
    m1 = await engine.createMandate({
      agent_id: "agent-rev-test",
      max_spend_paise: 200000,
      category_allowlist: ["electronics"],
      expiry_timestamp: future,
      single_use: false,
    });
    assert.equal(m1.status, "active");

    const rev = await engine.revokeMandate(m1.mandate_id);
    assert.equal(rev.ok, true);
    assert.equal(rev.status, 200);
    assert.equal(rev.mandate.status, "revoked");
    assert.ok(rev.mandate.revoked_at);

    const store = engine.loadStore();
    assert.equal(store[m1.mandate_id].status, "revoked");
    assert.ok(store[m1.mandate_id].revoked_at);

    await audit.flush();
    const trail = audit.readAll();
    const revEvent = trail.find((e) => e.mandate_id === m1.mandate_id && e.action === "mandate_revoked");
    assert.ok(revEvent, "audit trail must record mandate_revoked");
    assert.equal(revEvent.result, "ok");
    assert.equal(revEvent.reason_code, "revoked_by_request");
  });

  // 2. Attempt transaction against revoked mandate -> 403 mandate_revoked
  await check("2. attempt transaction against revoked mandate -> mandate_revoked (before any other bound)", async () => {
    // Even with bad category and overspend, revoked must be the primary rejection reason
    const verdict = await engine.reserveMandateForTransaction({
      mandate_id: m1.mandate_id,
      agent_id: "agent-rev-test",
      amount_paise: 99999999, // overspend
      category: "unauthorized_category", // category mismatch
    });
    assert.equal(verdict.allowed, false);
    assert.equal(verdict.reason_code, "mandate_revoked");

    await audit.flush();
    const trail = audit.readAll();
    const blockEvent = trail.find((e) => e.mandate_id === m1.mandate_id && e.action === "mandate_validation");
    assert.ok(blockEvent);
    assert.equal(blockEvent.result, "fail");
    assert.equal(blockEvent.reason_code, "mandate_revoked");
    assert.equal(
      blockEvent.human_reason,
      "Blocked: this mandate was explicitly revoked and can no longer authorize payments."
    );
  });

  // 3. Attempt to revoke an already-revoked mandate -> 409 mandate_already_terminal
  await check("3. attempt to revoke an already-revoked mandate -> 409 mandate_already_terminal", async () => {
    const revAgain = await engine.revokeMandate(m1.mandate_id);
    assert.equal(revAgain.ok, false);
    assert.equal(revAgain.status, 409);
    assert.equal(revAgain.reason_code, "mandate_already_terminal");
  });

  // 4. Attempt to revoke a consumed mandate -> 409 mandate_already_terminal
  await check("4. attempt to revoke a consumed mandate -> 409 mandate_already_terminal", async () => {
    const mConsumed = await engine.createMandate({
      agent_id: "agent-rev-test",
      max_spend_paise: 50000,
      category_allowlist: ["electronics"],
      expiry_timestamp: future,
      single_use: true,
    });
    await engine.consumeMandate(mConsumed.mandate_id, { transaction_id: "tx_rev_test" });

    const rev = await engine.revokeMandate(mConsumed.mandate_id);
    assert.equal(rev.ok, false);
    assert.equal(rev.status, 409);
    assert.equal(rev.reason_code, "mandate_already_terminal");
  });

  // 5. Attempt to revoke an expired mandate -> 409 mandate_already_terminal
  await check("5. attempt to revoke an expired mandate -> 409 mandate_already_terminal", async () => {
    const mExpired = await engine.createMandate({
      agent_id: "agent-rev-test",
      max_spend_paise: 50000,
      category_allowlist: ["electronics"],
      expiry_timestamp: past,
      single_use: false,
    });

    const rev = await engine.revokeMandate(mExpired.mandate_id);
    assert.equal(rev.ok, false);
    assert.equal(rev.status, 409);
    assert.equal(rev.reason_code, "mandate_already_terminal");
  });

  // 6. Attempt to revoke an in-flight claimed mandate -> 409 mandate_in_flight
  await check("6. attempt to revoke an in-flight claimed mandate -> 409 mandate_in_flight", async () => {
    const mClaimed = await engine.createMandate({
      agent_id: "agent-rev-test",
      max_spend_paise: 100000,
      category_allowlist: ["electronics"],
      expiry_timestamp: future,
      single_use: true,
    });

    // Claim the mandate
    const claimedVerdict = await engine.reserveMandateForTransaction({
      mandate_id: mClaimed.mandate_id,
      agent_id: "agent-rev-test",
      amount_paise: 50000,
      category: "electronics",
    });
    assert.equal(claimedVerdict.allowed, true);

    const rev = await engine.revokeMandate(mClaimed.mandate_id);
    assert.equal(rev.ok, false);
    assert.equal(rev.status, 409);
    assert.equal(rev.reason_code, "mandate_in_flight");

    // Release claim to verify state transitions back to active and can then be revoked
    await engine.releaseMandate(mClaimed.mandate_id, { reason: "test release" });
    const revAfterRelease = await engine.revokeMandate(mClaimed.mandate_id);
    assert.equal(revAfterRelease.ok, true);
    assert.equal(revAfterRelease.mandate.status, "revoked");
  });

  // 7. Attempt to revoke a non-existent mandate -> 404 mandate_not_found
  await check("7. attempt to revoke a non-existent mandate -> 404 mandate_not_found", async () => {
    const rev = await engine.revokeMandate("mdt_nonexistent999");
    assert.equal(rev.ok, false);
    assert.equal(rev.status, 404);
    assert.equal(rev.reason_code, "mandate_not_found");
  });

  // 8. Attempt to revoke with malformed mandate_id -> 400 mandate_malformed
  await check("8. attempt to revoke with malformed mandate_id -> 400 mandate_malformed", async () => {
    const revEmpty = await engine.revokeMandate("");
    assert.equal(revEmpty.ok, false);
    assert.equal(revEmpty.status, 400);
    assert.equal(revEmpty.reason_code, "mandate_malformed");

    const revNull = await engine.revokeMandate(null);
    assert.equal(revNull.ok, false);
    assert.equal(revNull.status, 400);
    assert.equal(revNull.reason_code, "mandate_malformed");
  });

  if (failures > 0) {
    console.error(`\n${failures} MANDATE REVOCATION TESTS FAILED`);
    process.exit(1);
  } else {
    console.log("\nALL MANDATE REVOCATION TESTS PASSED");
    process.exit(0);
  }
}

run().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
