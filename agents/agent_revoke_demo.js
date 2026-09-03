const { api, paise } = require("./client");

/**
 * AGENT REVOCATION DEMO HELPER
 *
 * Demonstrates killing an active mandate mid-flow in ~30 seconds:
 * 1. Obtains a multi-use mandate (single_use: false) with ample limit (Rs 10,000.00).
 * 2. Executes a transaction successfully -> APPROVED (HTTP 200).
 * 3. Explicitly revokes the mandate via POST /api/mandates/:id/revoke -> REVOKED (HTTP 200).
 * 4. Attempts an identical transaction against the revoked mandate -> BLOCKED (HTTP 403 mandate_revoked).
 */
async function main() {
  console.log("=============================================================");
  console.log("=== KAVACH TRUST RAIL — MANDATE REVOCATION LIVE DEMO ===");
  console.log("=============================================================\n");

  const health = await api("GET", "/api/health");
  console.log(`[1/4] Backend health: ${health.body?.ok ? "UP" : "DOWN"}`);

  // Ensure passport is generated for default demo merchant
  const passport = await api("POST", "/api/passport/generate", {});
  const keyboard = passport.body?.payload?.catalog?.find((c) => c.id === "sku-mech-keyboard");
  if (!keyboard) {
    console.error("Failed to load demo catalog product");
    process.exitCode = 1;
    return;
  }

  // 1. Issue a multi-use mandate with plenty of spend limit
  console.log("\n[2/4] Issuing multi-use mandate for agent-revoke-demo...");
  const mandateRes = await api("POST", "/api/mandates", {
    agent_id: "agent-revoke-demo",
    max_spend_paise: 1000000, // Rs 10,000.00
    category_allowlist: ["electronics"],
    expiry_timestamp: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
    single_use: false, // Reusable so it survives the first purchase
  });

  if (!mandateRes.ok) {
    console.error("Mandate issuance failed:", JSON.stringify(mandateRes.body));
    process.exitCode = 1;
    return;
  }
  const mandate = mandateRes.body;
  console.log(`  -> Mandate ISSUED: ${mandate.mandate_id} (Limit: ${paise(mandate.max_spend_paise)}, Status: ${mandate.status})`);

  // 2. Transact successfully while active
  console.log(`\n[3/4] BEFORE REVOCATION: Attempting purchase of "${keyboard.name}"...`);
  const txBefore = await api("POST", "/api/transactions", {
    agent_id: "agent-revoke-demo",
    mandate_id: mandate.mandate_id,
    item_id: keyboard.id,
    quantity: 1,
  });

  if (txBefore.status === 200 && txBefore.body.decision === "approved") {
    console.log(`  -> RESULT: APPROVED (HTTP 200) | Order ID: ${txBefore.body.order?.id}`);
    console.log(`  -> Explanation: ${txBefore.body.explanation}`);
  } else {
    console.error("Unexpected failure before revocation:", JSON.stringify(txBefore.body));
    process.exitCode = 1;
    return;
  }

  // 3. Kill the mandate mid-flow via API
  console.log(`\n[!] OPERATOR ACTION: Revoking mandate ${mandate.mandate_id} via POST /api/mandates/:id/revoke...`);
  const revokeRes = await api("POST", `/api/mandates/${mandate.mandate_id}/revoke`);
  if (revokeRes.status === 200 && revokeRes.body.status === "revoked") {
    console.log(`  -> Mandate REVOKED successfully at ${revokeRes.body.revoked_at}`);
  } else {
    console.error("Revocation request failed:", JSON.stringify(revokeRes.body));
    process.exitCode = 1;
    return;
  }

  // 4. Transact again with identical payload -> Blocked before gateway
  console.log(`\n[4/4] AFTER REVOCATION: Attempting identical purchase against same mandate...`);
  const txAfter = await api("POST", "/api/transactions", {
    agent_id: "agent-revoke-demo",
    mandate_id: mandate.mandate_id,
    item_id: keyboard.id,
    quantity: 1,
  });

  if (txAfter.status === 403 && txAfter.body.decision === "rejected" && txAfter.body.reason_code === "mandate_revoked") {
    console.log(`  -> RESULT: BLOCKED (HTTP 403) | reason_code=${txAfter.body.reason_code}`);
    console.log(`  -> Explanation: ${txAfter.body.explanation}`);
    console.log(`  -> Pre-Gateway Note: ${txAfter.body.note}`);
    console.log("\n=============================================================");
    console.log("SUCCESS: Active mandate was revoked mid-flow and blocked pre-gateway!");
    console.log("=============================================================");
    return;
  }

  console.error("Expected blocked transaction with mandate_revoked but got:", txAfter.status, txAfter.body);
  process.exitCode = 1;
}

main().catch((err) => {
  console.error("Revocation demo script error:", err.message);
  process.exitCode = 1;
});
