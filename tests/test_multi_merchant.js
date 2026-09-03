/**
 * MULTI-MERCHANT PRICING AND PASSPORTS.
 *
 * This is the suite for §9. Pricing used to read a hardcoded array compiled into the
 * process, which meant every merchant on the rail was charged from one shared price list:
 * two merchants selling the same sku id at different prices would both have been billed
 * the first one's price, and an ingested catalog moved the passport but never the money.
 *
 * So the central case here is deliberately adversarial about exactly that. Two merchants
 * ingest a catalog containing THE SAME product id at different prices and in different
 * categories, and then the same transaction request is sent twice, differing only in
 * merchant_id. If anything shared sits between them, the two requests price identically
 * and this suite goes red.
 *
 * The prices are asserted from refusals rather than approvals wherever possible. A
 * mandate cap below both prices makes the rail state the amount it computed and refuse
 * before any gateway call, so the assertions are exact, offline, and cost nothing.
 *
 * Boots its own server on PORT 3014. Non-destructive: writes only inside its own
 * tests/.tmp-data/ directory.
 */
const { dataDir } = require("./_isolate"); // first: fixes the data directory before src/config resolves it
const assert = require("assert");
const path = require("path");
const { spawn } = require("child_process");

require("dotenv").config();

const PORT = process.env.KAVACH_MULTI_TEST_PORT || "3014";
const BASE = `http://localhost:${PORT}`;
const DEMO = "kavach-demo-merchant-001";
const SHARED_SKU = "sku-shared-id";

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

async function post(route, body) {
  const res = await fetch(`${BASE}${route}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function get(route) {
  const res = await fetch(`${BASE}${route}`);
  return { status: res.status, body: await res.json().catch(() => null) };
}

function product(id, over = {}) {
  return {
    id,
    name: `Product ${id}`,
    price_paise: 100000,
    stock: 10,
    category: "electronics",
    return_policy: "7-day return, unused",
    refund_terms: "Full refund within 5 business days",
    available: true,
    ...over,
  };
}

async function ingest(merchant_id, products) {
  const r = await post(`/api/merchants/${merchant_id}/catalog`, products);
  assert.equal(r.status, 201, `ingest for ${merchant_id} failed: HTTP ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
}

/** A mandate with a cap chosen by the caller, so a price can be proven by refusal. */
async function mandate(agent_id, max_spend_paise, categories = ["electronics"], single_use = false) {
  const r = await post("/api/mandates", {
    agent_id,
    max_spend_paise,
    category_allowlist: categories,
    expiry_timestamp: new Date(Date.now() + 3600_000).toISOString(),
    single_use,
  });
  assert.equal(r.status, 201, `mandate creation failed: HTTP ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
}

/**
 * The amount the rail computed for a request, taken from an over-cap refusal.
 *
 * The refusal happens after pricing and before the gateway, and it reports the amount it
 * refused — which makes it a precise, offline probe of the pricing source. Reading the
 * price back from the catalog would prove nothing about which catalog the money path used.
 */
async function pricedAmount(req) {
  const r = await post("/api/transactions", req);
  assert.equal(r.status, 403, `expected an over-cap refusal that states the amount, got HTTP ${r.status} ${JSON.stringify(r.body)}`);
  assert.equal(r.body.reason_code, "mandate_exceeded", `expected mandate_exceeded, got ${r.body.reason_code}`);
  assert.ok(Number.isInteger(r.body.amount_paise), `the refusal did not state an integer amount: ${JSON.stringify(r.body)}`);
  return { amount_paise: r.body.amount_paise, category: r.body.category };
}

async function auditEntries() {
  const r = await get("/api/audit");
  return (r.body && r.body.entries) || [];
}

async function waitForServer(child, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`server exited early with code ${child.exitCode}`);
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) return res.json();
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`server did not become healthy on ${BASE} within ${timeoutMs}ms`);
}

async function run() {
  const child = spawn(process.execPath, [path.join(__dirname, "..", "src", "server.js")], {
    env: { ...process.env, PORT },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (c) => (stderr += c.toString()));
  child.on("error", (e) => {
    console.error(`FAIL  could not spawn server: ${e.message}`);
    process.exit(1);
  });

  try {
    await waitForServer(child);
  } catch (e) {
    console.error(`FAIL  ${e.message}`);
    if (stderr) console.error(stderr.split("\n").slice(0, 6).join("\n"));
    child.kill();
    process.exitCode = 1;
    return;
  }

  // Two merchants. Same product id, different price, different category, different stock
  // posture — every field that pricing reads differs, so a shared source cannot hide.
  await check("two merchants ingest catalogs that share a product id", async () => {
    const alpha = await ingest("merchant-alpha", [
      product(SHARED_SKU, { price_paise: 1500, category: "electronics", name: "Alpha Widget" }),
      product("sku-alpha-only", { price_paise: 250000, category: "electronics" }),
    ]);
    const beta = await ingest("merchant-beta", [
      product(SHARED_SKU, { price_paise: 999900, category: "home", name: "Beta Widget" }),
      product("sku-beta-only", { price_paise: 700, category: "home" }),
    ]);
    assert.equal(alpha.version, 1);
    assert.equal(beta.version, 1);
  });

  await check("the same item_id prices differently for each merchant (§9)", async () => {
    // One cap, below both prices, so both requests are priced and then refused. The only
    // difference between the two requests is merchant_id.
    const m = await mandate("agent-pricing", 1000, ["electronics", "home"]);
    const base = { agent_id: "agent-pricing", mandate_id: m.mandate_id, item_id: SHARED_SKU };

    const alpha = await pricedAmount({ ...base, merchant_id: "merchant-alpha" });
    const beta = await pricedAmount({ ...base, merchant_id: "merchant-beta" });

    assert.strictEqual(alpha.amount_paise, 1500, "merchant-alpha was not priced from its own catalog");
    assert.strictEqual(beta.amount_paise, 999900, "merchant-beta was not priced from its own catalog");
    assert.notStrictEqual(
      alpha.amount_paise,
      beta.amount_paise,
      "both merchants priced identically for the same item_id — pricing is still reading one shared source"
    );
  });

  await check("category is read from each merchant's own catalog too", async () => {
    // Not just the price: the category decides which mandates can pay at all. Alpha files
    // the shared sku under electronics, beta under home.
    const m = await mandate("agent-category", 1000, ["electronics", "home"]);
    const base = { agent_id: "agent-category", mandate_id: m.mandate_id, item_id: SHARED_SKU };
    const alpha = await pricedAmount({ ...base, merchant_id: "merchant-alpha" });
    const beta = await pricedAmount({ ...base, merchant_id: "merchant-beta" });
    assert.equal(alpha.category, "electronics");
    assert.equal(beta.category, "home");
  });

  await check("a mandate scoped to one category cannot pay for the other merchant's listing", async () => {
    // The consequence of the previous case, on the money path: an electronics-only mandate
    // is refused for beta's listing on category grounds, not on price.
    const m = await mandate("agent-scoped", 10_000_000, ["electronics"]);
    const r = await post("/api/transactions", {
      agent_id: "agent-scoped",
      mandate_id: m.mandate_id,
      merchant_id: "merchant-beta",
      item_id: SHARED_SKU,
    });
    assert.equal(r.status, 403, `HTTP ${r.status} ${JSON.stringify(r.body)}`);
    assert.equal(r.body.reason_code, "category_not_allowed", `got ${r.body.reason_code}`);
    assert.equal(r.body.category, "home", "the refusal must name the category the merchant's own catalog gave");
  });

  await check("quantity multiplies the merchant's own price, in integer paise", async () => {
    const m = await mandate("agent-qty", 1000, ["electronics"]);
    const r = await pricedAmount({
      agent_id: "agent-qty",
      mandate_id: m.mandate_id,
      merchant_id: "merchant-alpha",
      item_id: SHARED_SKU,
      quantity: 3,
    });
    assert.strictEqual(r.amount_paise, 4500, "3 × 1500 paise");
    assert.ok(Number.isInteger(r.amount_paise), "the amount must stay an integer");
  });

  await check("an unknown merchant is refused by name rather than priced from something else", async () => {
    const m = await mandate("agent-unknown", 10_000_000);
    const r = await post("/api/transactions", {
      agent_id: "agent-unknown",
      mandate_id: m.mandate_id,
      merchant_id: "merchant-who",
      item_id: SHARED_SKU,
    });
    assert.equal(r.status, 400, `HTTP ${r.status} ${JSON.stringify(r.body)}`);
    assert.equal(r.body.error.reason_code, "merchant_not_found");
    assert.equal(r.body.error.merchant_id, "merchant-who");
  });

  await check("a sku that exists for one merchant is unknown for the other", async () => {
    const m = await mandate("agent-crossover", 10_000_000);
    const r = await post("/api/transactions", {
      agent_id: "agent-crossover",
      mandate_id: m.mandate_id,
      merchant_id: "merchant-beta",
      item_id: "sku-alpha-only",
    });
    assert.equal(r.status, 400, `merchant-beta was able to sell merchant-alpha's sku: HTTP ${r.status} ${JSON.stringify(r.body)}`);
    assert.equal(r.body.error.reason_code, "product_not_found");
  });

  // ---------- versions on the money path ----------

  await check("pricing follows the current version after a re-upload", async () => {
    const v2 = await ingest("merchant-alpha", [
      product(SHARED_SKU, { price_paise: 5000, category: "electronics", name: "Alpha Widget mk2" }),
      product("sku-alpha-only", { price_paise: 250000, category: "electronics" }),
    ]);
    assert.equal(v2.version, 2);
    const m = await mandate("agent-v2", 1000, ["electronics"]);
    const priced = await pricedAmount({
      agent_id: "agent-v2",
      mandate_id: m.mandate_id,
      merchant_id: "merchant-alpha",
      item_id: SHARED_SKU,
    });
    assert.strictEqual(priced.amount_paise, 5000, "a re-upload did not move the price the money path uses");
  });

  await check("catalog_version prices against the version an older passport attests", async () => {
    const m = await mandate("agent-v1", 1000, ["electronics"]);
    const priced = await pricedAmount({
      agent_id: "agent-v1",
      mandate_id: m.mandate_id,
      merchant_id: "merchant-alpha",
      item_id: SHARED_SKU,
      catalog_version: 1,
    });
    assert.strictEqual(priced.amount_paise, 1500, "an agent holding the v1 passport was charged v2's price");
  });

  await check("an unknown catalog_version is refused rather than falling back to current", async () => {
    const m = await mandate("agent-badversion", 10_000_000);
    for (const catalog_version of [9, 0, -1, "abc"]) {
      const r = await post("/api/transactions", {
        agent_id: "agent-badversion",
        mandate_id: m.mandate_id,
        merchant_id: "merchant-alpha",
        item_id: SHARED_SKU,
        catalog_version,
      });
      assert.equal(r.status, 400, `catalog_version ${JSON.stringify(catalog_version)} was not refused: HTTP ${r.status} ${JSON.stringify(r.body)}`);
      assert.ok(
        ["version_not_found", "invalid_version"].includes(r.body.error.reason_code),
        `unexpected reason_code ${r.body.error.reason_code} for catalog_version ${JSON.stringify(catalog_version)}`
      );
    }
  });

  // ---------- availability, per merchant ----------

  await check("stock 0 is refused as out of stock, in stock but withdrawn is refused as not for sale", async () => {
    await ingest("merchant-availability", [
      product("sku-out-of-stock", { price_paise: 500, stock: 0, available: true }),
      product("sku-withdrawn", { price_paise: 500, stock: 25, available: false }),
      product("sku-fine", { price_paise: 500, stock: 25, available: true }),
    ]);
    const m = await mandate("agent-avail", 10_000_000);

    const outOfStock = await post("/api/transactions", {
      agent_id: "agent-avail", mandate_id: m.mandate_id, merchant_id: "merchant-availability", item_id: "sku-out-of-stock",
    });
    assert.equal(outOfStock.status, 409, `HTTP ${outOfStock.status} ${JSON.stringify(outOfStock.body)}`);
    assert.equal(outOfStock.body.reason_code, "item_unavailable");

    const withdrawn = await post("/api/transactions", {
      agent_id: "agent-avail", mandate_id: m.mandate_id, merchant_id: "merchant-availability", item_id: "sku-withdrawn",
    });
    assert.equal(withdrawn.status, 409, `HTTP ${withdrawn.status} ${JSON.stringify(withdrawn.body)}`);
    assert.equal(
      withdrawn.body.reason_code,
      "item_not_for_sale",
      "an in-stock item the merchant withdrew must not be reported as out of stock — that misstates the merchant's own decision"
    );
  });

  await check("the two availability refusals are distinguishable in the trail", async () => {
    const entries = await auditEntries();
    const unavailable = entries.filter((e) => e.reason_code === "item_unavailable").pop();
    const notForSale = entries.filter((e) => e.reason_code === "item_not_for_sale").pop();
    assert.ok(unavailable, "no item_unavailable entry was recorded");
    assert.ok(notForSale, "no item_not_for_sale entry was recorded");
    assert.ok(/out of stock/.test(unavailable.human_reason), unavailable.human_reason);
    assert.ok(/not for sale/.test(notForSale.human_reason), notForSale.human_reason);
    for (const e of [unavailable, notForSale]) {
      assert.equal(e.meta.merchant_id, "merchant-availability", "the refusal must record which merchant's catalog it read");
      assert.ok(Number.isInteger(e.meta.catalog_version), "the refusal must record which catalog version it read");
    }
  });

  // ---------- passports, per merchant ----------

  await check("each merchant gets its own signed passport and one does not clobber another", async () => {
    const alpha = await post("/api/passport/generate", { merchant_id: "merchant-alpha" });
    assert.equal(alpha.status, 200, `HTTP ${alpha.status} ${JSON.stringify(alpha.body)}`);
    const beta = await post("/api/passport/generate", { merchant_id: "merchant-beta" });
    assert.equal(beta.status, 200, `HTTP ${beta.status} ${JSON.stringify(beta.body)}`);

    // Generating beta's passport second must not have overwritten alpha's.
    const alphaRead = await get("/api/passport?merchant_id=merchant-alpha");
    assert.equal(alphaRead.body.exists, true);
    assert.equal(alphaRead.body.manifest.payload.merchant_id, "merchant-alpha");
    assert.equal(alphaRead.body.manifest.payload.catalog_version, 2);
    assert.equal(alphaRead.body.signature_status.valid, true, JSON.stringify(alphaRead.body.signature_status));

    const betaRead = await get("/api/passport?merchant_id=merchant-beta");
    assert.equal(betaRead.body.manifest.payload.merchant_id, "merchant-beta");
    assert.equal(betaRead.body.signature_status.valid, true, JSON.stringify(betaRead.body.signature_status));

    // Each passport attests its own prices, not the other's.
    const alphaShared = alphaRead.body.manifest.payload.catalog.find((c) => c.id === SHARED_SKU);
    const betaShared = betaRead.body.manifest.payload.catalog.find((c) => c.id === SHARED_SKU);
    assert.strictEqual(alphaShared.price_paise, 5000);
    assert.strictEqual(betaShared.price_paise, 999900);
  });

  await check("the passport price and the transaction price agree, per merchant", async () => {
    // The property that was broken before §9: the passport said one thing and the money
    // path used another. Both sides are read here and compared.
    for (const merchant_id of ["merchant-alpha", "merchant-beta"]) {
      const view = await get(`/api/passport?merchant_id=${merchant_id}`);
      const attested = view.body.manifest.payload.catalog.find((c) => c.id === SHARED_SKU);
      const m = await mandate(`agent-agree-${merchant_id}`, 1, ["electronics", "home"]);
      const priced = await pricedAmount({
        agent_id: `agent-agree-${merchant_id}`,
        mandate_id: m.mandate_id,
        merchant_id,
        item_id: SHARED_SKU,
      });
      assert.strictEqual(
        priced.amount_paise,
        attested.price_paise,
        `${merchant_id}: the passport attests ${attested.price_paise}p but the rail priced ${priced.amount_paise}p`
      );
    }
  });

  await check("a passport cannot be generated for a merchant that has never ingested one", async () => {
    const r = await post("/api/passport/generate", { merchant_id: "merchant-nonexistent" });
    assert.equal(r.status, 404, `HTTP ${r.status} ${JSON.stringify(r.body)}`);
    assert.equal(r.body.error.code, "merchant_not_found");
    assert.ok(/POST \/api\/merchants/.test(r.body.error.hint || ""), "the refusal should say how to fix it");
  });

  await check("a path-breaking merchant_id is refused on the passport and pricing paths too", async () => {
    const gen = await post("/api/passport/generate", { merchant_id: "../../etc" });
    assert.equal(gen.status, 400, `passport generate: HTTP ${gen.status} ${JSON.stringify(gen.body)}`);
    assert.equal(gen.body.error.code, "invalid_merchant_id");

    const view = await get(`/api/passport?merchant_id=${encodeURIComponent("../../etc")}`);
    assert.equal(view.status, 400, `passport read: HTTP ${view.status} ${JSON.stringify(view.body)}`);

    const m = await mandate("agent-traversal", 10_000_000);
    const tx = await post("/api/transactions", {
      agent_id: "agent-traversal", mandate_id: m.mandate_id, merchant_id: "../../etc", item_id: SHARED_SKU,
    });
    assert.equal(tx.status, 400, `transaction: HTTP ${tx.status} ${JSON.stringify(tx.body)}`);
    assert.equal(tx.body.error.reason_code, "invalid_merchant_id");
  });

  // ---------- the original single-merchant demo, unchanged ----------

  await check("the demo merchant still signs the same three SKUs with no merchant_id supplied", async () => {
    // Exactly what the dashboard button and the agent scripts send: an empty body.
    const r = await post("/api/passport/generate", {});
    assert.equal(r.status, 200, `HTTP ${r.status} ${JSON.stringify(r.body)}`);
    assert.equal(r.body.payload.merchant_id, DEMO, "an empty body must still sign the demo merchant");
    assert.equal(r.body.payload.catalog.length, 3);
    assert.deepEqual(
      r.body.payload.catalog.map((c) => c.id),
      ["sku-mech-keyboard", "sku-usbc-cable", "sku-desk-lamp"],
      "the demo catalog's SKUs or their order changed"
    );
    const keyboard = r.body.payload.catalog.find((c) => c.id === "sku-mech-keyboard");
    assert.strictEqual(keyboard.price_paise, 349900);
    assert.strictEqual(keyboard.available, true);
    const cable = r.body.payload.catalog.find((c) => c.id === "sku-usbc-cable");
    assert.strictEqual(cable.available, false, "the stock-0 cable must still be signed as unavailable");

    // And the legacy no-query read still returns the most recently generated passport,
    // which is what the dashboard has always read.
    const legacy = await get("/api/passport");
    assert.equal(legacy.body.exists, true);
    assert.equal(legacy.body.manifest.payload.merchant_id, DEMO);
    assert.equal(legacy.body.signature_status.valid, true, JSON.stringify(legacy.body.signature_status));
  });

  await check("the demo merchant prices from its own catalog with no merchant_id supplied", async () => {
    const m = await mandate("agent-demo", 1000, ["electronics"]);
    const priced = await pricedAmount({
      agent_id: "agent-demo",
      mandate_id: m.mandate_id,
      item_id: "sku-mech-keyboard",
    });
    assert.strictEqual(priced.amount_paise, 349900, "the demo price changed");
    assert.equal(priced.category, "electronics");
  });

  await check("the demo cable is still refused as out of stock, exactly as before", async () => {
    const m = await mandate("agent-demo-cable", 10_000_000, ["accessories"]);
    const r = await post("/api/transactions", {
      agent_id: "agent-demo-cable", mandate_id: m.mandate_id, item_id: "sku-usbc-cable",
    });
    assert.equal(r.status, 409, `HTTP ${r.status} ${JSON.stringify(r.body)}`);
    assert.equal(r.body.reason_code, "item_unavailable", "the demo's stock-0 cable must keep reporting item_unavailable");
  });

  await check("an approved transaction records which merchant and version it was priced from", async () => {
    // The one case that reaches the gateway. Razorpay's own minimum is 100 paise, and the
    // gateway can be unconfigured or unreachable on a given machine, so both outcomes are
    // accepted — but the amount and the pricing source are asserted either way, because
    // both are recorded before the gateway is called.
    const m = await mandate("agent-approved", 10_000_000, ["electronics"]);
    const r = await post("/api/transactions", {
      agent_id: "agent-approved",
      mandate_id: m.mandate_id,
      merchant_id: "merchant-alpha",
      item_id: "sku-alpha-only",
    });

    if (r.body && r.body.decision === "approved") {
      assert.strictEqual(r.body.amount_paise, 250000);
      assert.equal(
        r.body.priced_from,
        "catalog:merchant-alpha@v2:sku-alpha-only x1",
        `priced_from must name the merchant and version: ${r.body.priced_from}`
      );
    } else {
      assert.equal(r.status, 500, `expected approval or a gateway refusal, got HTTP ${r.status} ${JSON.stringify(r.body)}`);
      assert.equal(r.body.error.code, "gateway_error", JSON.stringify(r.body));
      assert.equal(r.body.mandate_consumed, false, "a refused order must not consume the mandate");
      console.log("      (gateway unavailable; the price was verified from the audit trail instead)");
    }

    const entries = await auditEntries();
    const priced = entries.filter((e) => e.agent_id === "agent-approved" && e.amount_paise === 250000);
    assert.ok(priced.length > 0, "no entry recorded the amount this transaction was priced at");
  });

  await check("both merchants and the demo merchant appear in the listing with their own versions", async () => {
    const r = await get("/api/merchants");
    assert.equal(r.status, 200);
    const byId = Object.fromEntries(r.body.merchants.map((m) => [m.merchant_id, m]));
    assert.ok(byId[DEMO], "the demo merchant is missing from the listing");
    assert.equal(byId[DEMO].product_count, 3);
    assert.equal(byId["merchant-alpha"].current_version, 2, "alpha should be on v2 after its re-upload");
    assert.deepEqual(byId["merchant-alpha"].versions, [1, 2]);
    assert.equal(byId["merchant-beta"].current_version, 1, "beta must not have been advanced by alpha's re-upload");
    assert.equal(byId["merchant-beta"].product_count, 2);
  });

  await check("the audit trail attributes every priced decision to a specific merchant and version", async () => {
    const entries = await auditEntries();
    const priced = entries.filter((e) => e.meta && e.meta.merchant_id && e.meta.catalog_version !== undefined);
    assert.ok(priced.length > 0, "no decision recorded the catalog it was priced from");

    const merchants = new Set(priced.map((e) => e.meta.merchant_id));
    assert.ok(merchants.size >= 2, `decisions were only attributed to ${[...merchants].join(", ")}; multi-merchant pricing should show more than one`);

    // The record shape is the existing one throughout; nothing was restructured.
    for (const e of entries) {
      for (const key of ["ts", "action", "result", "reason_code", "reason", "amount_paise", "meta"]) {
        assert.ok(key in e, `an audit entry is missing the existing field "${key}": ${JSON.stringify(e)}`);
      }
    }
  });

  await check("the server survived every merchant, version and traversal case above", async () => {
    const r = await get("/api/health");
    assert.equal(r.status, 200);
    assert.equal(child.exitCode, null, "the server process died during this suite");
    assert.ok(String(dataDir).includes(".tmp-data"), `this suite must not write to the live data directory (got ${dataDir})`);
  });

  child.kill();
  console.log(failures === 0 ? "\nALL MULTI-MERCHANT TESTS PASSED" : `\n${failures} TEST(S) FAILED`);
  // exitCode, not process.exit(); see the note in test_webhook.js.
  process.exitCode = failures === 0 ? 0 : 1;
}

run().catch((e) => {
  console.error("multi-merchant harness crashed:", e.message);
  process.exit(1);
});
