const { api, paise } = require("./client");

/**
 * AGENT B — overspend attempt. Reuses Agent A's client code; only the
 * requested amount differs. Must be blocked BEFORE any Razorpay call and
 * receive a clean, human-readable explanation.
 */
async function main() {
  console.log("=== AGENT B (overspend / blocked) ===");

  const mandateRes = await api("POST", "/api/mandates", {
    agent_id: "agent-b-buyer",
    max_spend_paise: 100000,
    category_allowlist: ["electronics"],
    expiry_timestamp: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    single_use: false,
  });
  if (!mandateRes.ok) {
    console.error("[B] mandate creation failed:", JSON.stringify(mandateRes.body));
    process.exitCode = 1;
    return;
  }
  const mandate = mandateRes.body;
  console.log(`[B] mandate issued: ${mandate.mandate_id} (max ${paise(mandate.max_spend_paise)})`);

  // Attempt to spend Rs 3499.00 against a Rs 1000.00 bound
  const tx = await api("POST", "/api/transactions", {
    agent_id: "agent-b-buyer",
    mandate_id: mandate.mandate_id,
    amount_paise: 349900,
    category: "electronics",
  });

  if (tx.status === 403 && tx.body.decision === "rejected") {
    console.log(`[B] BLOCKED (HTTP 403) reason_code=${tx.body.reason_code}`);
    console.log(`[B] explanation: ${tx.body.explanation}`);
    console.log(`[B] server note: ${tx.body.note}`);
    return;
  }

  console.error(`[B] EXPECTED TO BE BLOCKED but got HTTP ${tx.status}:`, JSON.stringify(tx.body, null, 2));
  process.exitCode = 1;
}

main().catch((e) => {
  console.error("[B] client crashed:", e.message);
  process.exitCode = 1;
});
