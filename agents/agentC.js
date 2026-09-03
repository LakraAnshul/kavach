const { api, paise } = require("./client");

const SECOND_MERCHANT_ID = "artisan-coffee-roasters";

/**
 * AGENT C — category violation attempt against a second merchant.
 * Scoped to an "equipment" allowlist with ample funds (Rs 2000.00), then attempts
 * to purchase an item categorized as "beverages" (Artisan Espresso Roast @ Rs 1450.00)
 * from artisan-coffee-roasters.
 *
 * Demonstrates:
 * 1. Multi-merchant support: runs against a different merchant than Agent A and Agent B.
 * 2. Scoped bounding: mandate creation succeeds legitimately (valid equipment scope).
 * 3. Pre-gateway policy enforcement: blocked with HTTP 403 reason_code=category_not_allowed.
 */
async function main() {
  console.log("=== AGENT C (category mismatch / blocked) ===");
  const health = await api("GET", "/api/health");
  console.log(`[C] backend health: ${health.body?.ok ? "up" : "down"}`);

  // 1. Ensure the second merchant's catalog is available and has a signed passport
  let passport = await api("GET", `/api/passport?merchant_id=${SECOND_MERCHANT_ID}`);
  if (!passport.ok || !passport.body?.exists) {
    // Ingest the merchant's multi-category catalog via the public ingestion API if needed
    const ingestRes = await api("POST", `/api/merchants/${SECOND_MERCHANT_ID}/catalog`, [
      {
        id: "sku-espresso-beans",
        name: "Artisan Espresso Roast 1kg",
        price_paise: 145000,
        stock: 20,
        category: "beverages",
        return_policy: "7-day return unopened",
        refund_terms: "Full refund on return",
        available: true,
      },
      {
        id: "sku-pourover-kit",
        name: "V60 Ceramic Coffee Dripper",
        price_paise: 85000,
        stock: 10,
        category: "equipment",
        return_policy: "14-day return",
        refund_terms: "Full refund",
        available: true,
      },
    ]);
    if (!ingestRes.ok) {
      console.error("[C] could not ingest second merchant catalog:", JSON.stringify(ingestRes.body));
      process.exitCode = 1;
      return;
    }
    const genRes = await api("POST", "/api/passport/generate", { merchant_id: SECOND_MERCHANT_ID });
    if (!genRes.ok) {
      console.error("[C] could not generate second merchant passport:", JSON.stringify(genRes.body));
      process.exitCode = 1;
      return;
    }
    passport = await api("GET", `/api/passport?merchant_id=${SECOND_MERCHANT_ID}`);
  }

  const manifest = passport.body.manifest;
  const targetItem = manifest.payload.catalog.find((c) => c.id === "sku-espresso-beans");
  if (!targetItem) {
    console.error("[C] target item sku-espresso-beans not found in merchant catalog");
    process.exitCode = 1;
    return;
  }
  console.log(`[C] merchant "${SECOND_MERCHANT_ID}" passport verified (sig ${manifest.signature.slice(0, 12)}...).`);
  console.log(`[C] Target SKU: "${targetItem.name}" [category: ${targetItem.category}] @ ${paise(targetItem.price_paise)}`);

  // 2. Obtain a valid scoped mandate allowing ONLY "equipment" with plenty of budget (Rs 2000.00)
  const mandateRes = await api("POST", "/api/mandates", {
    agent_id: "agent-c-buyer",
    max_spend_paise: 200000,
    category_allowlist: ["equipment"],
    expiry_timestamp: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    single_use: false,
  });

  if (!mandateRes.ok) {
    console.error("[C] mandate creation failed:", JSON.stringify(mandateRes.body));
    process.exitCode = 1;
    return;
  }

  const mandate = mandateRes.body;
  console.log(`[C] mandate issued: ${mandate.mandate_id} (max ${paise(mandate.max_spend_paise)}, allowed categories: [${mandate.category_allowlist.join(", ")}])`);

  // 3. Attempt to purchase sku-espresso-beans (category: "beverages") using an "equipment"-only mandate
  console.log(`[C] attempting purchase of category "${targetItem.category}" against allowlist [${mandate.category_allowlist.join(", ")}]...`);
  const tx = await api("POST", "/api/transactions", {
    agent_id: "agent-c-buyer",
    mandate_id: mandate.mandate_id,
    merchant_id: SECOND_MERCHANT_ID,
    item_id: targetItem.id,
    quantity: 1,
  });

  if (tx.status === 403 && tx.body.decision === "rejected" && tx.body.reason_code === "category_not_allowed") {
    console.log(`[C] BLOCKED (HTTP 403) reason_code=${tx.body.reason_code}`);
    console.log(`[C] explanation: ${tx.body.explanation}`);
    console.log(`[C] server note: ${tx.body.note}`);
    return;
  }

  console.error(`[C] EXPECTED TO BE BLOCKED with category_not_allowed but got HTTP ${tx.status}:`, JSON.stringify(tx.body, null, 2));
  process.exitCode = 1;
}

main().catch((e) => {
  console.error("[C] client crashed:", e.message);
  process.exitCode = 1;
});
