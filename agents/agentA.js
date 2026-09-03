const { api, paise } = require("./client");

/**
 * AGENT A — happy path buyer.
 * Behaves like a real HTTP client: issues mandates + transactions over HTTP
 * to the Kavach backend. Never touches internal functions directly.
 */
async function main() {
  console.log("=== AGENT A (happy path) ===");
  const health = await api("GET", "/api/health");
  console.log(`[A] backend health: ${health.body.ok ? "up" : "down"}`);

  const passport = await api("POST", "/api/passport/generate", {});
  if (!passport.ok) {
    console.error("[A] could not generate merchant passport:", JSON.stringify(passport.body));
    process.exitCode = 1;
    return;
  }
  const keyboard = passport.body.payload.catalog.find((c) => c.id === "sku-mech-keyboard");
  console.log(`[A] merchant passport OK (sig ${passport.body.signature.slice(0, 12)}...). Wants: ${keyboard.name} @ ${paise(keyboard.price_paise)}`);

  // 1. obtain a scoped mandate: max Rs 5000.00, electronics only, 10 min, single-use
  const mandateRes = await api("POST", "/api/mandates", {
    agent_id: "agent-a-buyer",
    max_spend_paise: 500000,
    category_allowlist: ["electronics"],
    expiry_timestamp: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    single_use: true,
  });
  if (!mandateRes.ok) {
    console.error("[A] mandate creation failed:", JSON.stringify(mandateRes.body));
    process.exitCode = 1;
    return;
  }
  const mandate = mandateRes.body;
  console.log(`[A] mandate issued: ${mandate.mandate_id} (max ${paise(mandate.max_spend_paise)}, single_use=${mandate.single_use})`);

  // 2. attempt the purchase; server prices it from the signed passport catalog
  const tx = await api("POST", "/api/transactions", {
    agent_id: "agent-a-buyer",
    mandate_id: mandate.mandate_id,
    item_id: keyboard.id,
    quantity: 1,
  });

  if (tx.status === 200 && tx.body.decision === "approved") {
    console.log(`[A] APPROVED -> order ${tx.body.order.id} created for ${paise(tx.body.amount_paise)} (${tx.body.category})`);
    console.log(`[A] explanation: ${tx.body.explanation}`);
    console.log("[A] payment lifecycle will finalize via webhook / test-mode payment instrument");
  } else {
    console.error(`[A] UNEXPECTED RESULT (HTTP ${tx.status}):`, JSON.stringify(tx.body, null, 2));
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error("[A] client crashed:", e.message);
  process.exitCode = 1;
});
