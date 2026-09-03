/**
 * Throwaway smoke harness for src/catalog/csv.js and src/catalog/store.js.
 * Not part of the suite; deleted once both modules are verified.
 */
process.env.KAVACH_DATA_DIR = require("path").join(__dirname, ".tmp-data", "smoke-catalog");
const fs = require("fs");
const path = require("path");
fs.rmSync(process.env.KAVACH_DATA_DIR, { recursive: true, force: true });

const { parseCsvCatalog } = require("../src/catalog/csv");
const { validateCatalog } = require("../src/catalog/validate");
const store = require("../src/catalog/store");

let fails = 0;
function t(name, fn) {
  try {
    fn();
    console.log(`  ok   ${name}`);
  } catch (e) {
    fails++;
    console.log(`  FAIL ${name}: ${e.message}`);
  }
}
const assert = require("assert");

const HEAD = "id,name,price_paise,stock,category,return_policy,refund_terms,available";
const ROW1 = "sku-a,Widget A,1000,5,electronics,7-day,full refund,true";
const ROW2 = "sku-b,Widget B,2500,0,home,10-day,partial,false";

console.log("\n--- csv.js ---");

t("plain csv parses into rows", () => {
  const r = parseCsvCatalog(`${HEAD}\n${ROW1}\n${ROW2}\n`);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.rows.length, 2);
  assert.equal(r.rows[0].id, "sku-a");
  assert.equal(r.rows[0].price_paise, "1000", "cells must stay strings (dynamicTyping off)");
  assert.equal(typeof r.rows[0].price_paise, "string");
  assert.equal(r.rows[1].available, "false");
});

t("shuffled column order maps by name", () => {
  const r = parseCsvCatalog(
    "available,refund_terms,return_policy,category,stock,price_paise,name,id\n" +
      "true,full refund,7-day,electronics,5,1000,Widget A,sku-a\n"
  );
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.rows[0].id, "sku-a");
  assert.equal(r.rows[0].price_paise, "1000");
  assert.equal(r.rows[0].available, "true");
});

t("uppercase and padded headers normalize", () => {
  const r = parseCsvCatalog(" ID , NAME , Price_Paise , STOCK , Category , Return_Policy , Refund_Terms , AVAILABLE \n" + ROW1 + "\n");
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.rows[0].id, "sku-a");
  assert.equal(r.rows[0].stock, "5");
});

t("unknown extra columns are dropped and reported", () => {
  const r = parseCsvCatalog(`${HEAD},warehouse,internal_note\n${ROW1},WH-7,ignore me\n`);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.ignored_columns, ["warehouse", "internal_note"]);
  assert.equal(r.rows[0].warehouse, undefined, "unknown column must not reach the product");
  assert.deepEqual(Object.keys(r.rows[0]).sort(), HEAD.split(",").sort());
});

t("BOM-prefixed csv (Excel export) still finds the id column", () => {
  const r = parseCsvCatalog(`\uFEFF${HEAD}\n${ROW1}\n`);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.rows[0].id, "sku-a");
});

t("CRLF line endings parse", () => {
  const r = parseCsvCatalog(`${HEAD}\r\n${ROW1}\r\n${ROW2}\r\n`);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.rows.length, 2);
  assert.equal(r.rows[1].available, "false", "CR must not survive into the value");
});

t("trailing blank and comma-only lines are skipped", () => {
  const r = parseCsvCatalog(`${HEAD}\n${ROW1}\n\n,,,,,,,\n\n`);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.rows.length, 1, `expected 1 row, got ${JSON.stringify(r.rows)}`);
});

t("quoted commas inside a field are preserved", () => {
  const r = parseCsvCatalog(`${HEAD}\nsku-c,"Widget, Large",1000,5,electronics,"7-day, unused",full refund,true\n`);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.rows[0].name, "Widget, Large");
  assert.equal(r.rows[0].return_policy, "7-day, unused");
});

t("empty file -> csv_empty", () => {
  const r = parseCsvCatalog("   \n  ");
  assert.equal(r.ok, false);
  assert.equal(r.reason_code, "csv_empty");
});

t("missing one required column -> csv_missing_columns naming it", () => {
  const r = parseCsvCatalog("id,name,price_paise,stock,category,return_policy,refund_terms\nsku-a,A,1000,5,electronics,7d,full\n");
  assert.equal(r.ok, false);
  assert.equal(r.reason_code, "csv_missing_columns");
  assert.ok(/available/.test(r.message), r.message);
});

t("not-a-catalog text -> csv_no_header_row", () => {
  const r = parseCsvCatalog("this is just prose\nand another line\n");
  assert.equal(r.ok, false);
  assert.equal(r.reason_code, "csv_no_header_row", JSON.stringify(r));
});

t("duplicated required column -> csv_duplicate_columns", () => {
  const r = parseCsvCatalog(`${HEAD},price_paise\n${ROW1},99\n`);
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.equal(r.reason_code, "csv_duplicate_columns");
  assert.ok(/price_paise/.test(r.message));
});

t("unclosed quote -> csv_unparseable", () => {
  const r = parseCsvCatalog(`${HEAD}\nsku-a,"Widget A,1000,5,electronics,7d,full,true\n`);
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.equal(r.reason_code, "csv_unparseable", JSON.stringify(r));
});

t("csv -> validate integration: strings become integers and booleans", () => {
  const parsed = parseCsvCatalog(`${HEAD}\n${ROW1}\n${ROW2}\n`);
  assert.equal(parsed.ok, true);
  const v = validateCatalog(parsed.rows);
  assert.equal(v.ok, true, JSON.stringify(v));
  assert.strictEqual(v.products[0].price_paise, 1000);
  assert.strictEqual(v.products[0].stock, 5);
  assert.strictEqual(v.products[0].available, true);
  assert.strictEqual(v.products[1].stock, 0);
  assert.strictEqual(v.products[1].available, false);
  assert.ok(Number.isInteger(v.products[0].price_paise), "no float on the money path");
});

t("csv -> validate integration: a decimal price is refused, not rounded", () => {
  const parsed = parseCsvCatalog(`${HEAD}\nsku-a,Widget A,349.9,5,electronics,7d,full,true\n`);
  const v = validateCatalog(parsed.rows);
  assert.equal(v.ok, false);
  assert.equal(v.problems[0].field, "price_paise");
});

console.log("\n--- store.js ---");

t("path traversal merchant ids are refused", () => {
  for (const bad of ["../../etc", "..", ".", "a/b", "a\\b", "C:\\evil", "%2e%2e", "", "   ", "-lead", "_lead", "x".repeat(65), null, 42, "a b"]) {
    const r = store.sanitizeMerchantId(bad);
    assert.equal(r.ok, false, `merchant_id ${JSON.stringify(bad)} was accepted`);
    assert.ok(r.reason, "a refusal must say why");
  }
});

t("legitimate merchant ids are accepted and trimmed", () => {
  for (const good of ["kavach-demo-merchant-001", "merchant_b", "A1", "x".repeat(64)]) {
    const r = store.sanitizeMerchantId(good);
    assert.equal(r.ok, true, `${good} was refused: ${r.reason}`);
    assert.equal(r.merchant_id, good);
  }
  assert.equal(store.sanitizeMerchantId("  merchant-b  ").merchant_id, "merchant-b");
});

t("resolveMerchantDir throws on unsafe input and stays inside the root", () => {
  assert.throws(() => store.resolveMerchantDir("../../etc"), /unsafe merchant_id/);
  const dir = store.resolveMerchantDir("merchant-b");
  assert.ok(dir.startsWith(path.resolve(store.MERCHANTS_DIR) + path.sep), dir);
});

t("demo merchant seeds itself on first read", () => {
  const cat = store.readCatalog(store.DEMO_MERCHANT_ID);
  assert.equal(cat.ok, true, JSON.stringify(cat));
  assert.equal(cat.version, 1);
  assert.equal(cat.products.length, 3);
  assert.equal(cat.products[0].id, "sku-mech-keyboard");
  assert.equal(cat.products[0].price_paise, 349900);
  assert.equal(cat.products[1].stock, 0);
  assert.equal(cat.products[1].available, false);
  assert.ok(fs.existsSync(path.join(store.MERCHANTS_DIR, store.DEMO_MERCHANT_ID, "catalog_v1.json")));
});

t("seeding is idempotent", () => {
  store.ensureSeeded(store.DEMO_MERCHANT_ID);
  store.ensureSeeded(store.DEMO_MERCHANT_ID);
  assert.deepEqual(store.listVersions(store.DEMO_MERCHANT_ID), [1]);
});

t("unknown merchant reports merchant_not_found, not a crash", () => {
  const r = store.readCatalog("merchant-does-not-exist");
  assert.equal(r.ok, false);
  assert.equal(r.reason_code, "merchant_not_found");
});

t("invalid merchant id on a read reports invalid_merchant_id", () => {
  const r = store.readCatalog("../../etc");
  assert.equal(r.ok, false);
  assert.equal(r.reason_code, "invalid_merchant_id");
});

(async () => {
  console.log("\n--- store.js (writes) ---");

  const A = [
    { id: "sku-a", name: "A", price_paise: 1000, stock: 5, category: "electronics", return_policy: "7d", refund_terms: "full", available: true },
  ];
  const A2 = [
    { id: "sku-a", name: "A", price_paise: 1500, stock: 5, category: "electronics", return_policy: "7d", refund_terms: "full", available: true },
    { id: "sku-a2", name: "A2", price_paise: 700, stock: 1, category: "home", return_policy: "7d", refund_terms: "full", available: true },
  ];
  const B = [
    { id: "sku-a", name: "B's own sku-a", price_paise: 99999, stock: 2, category: "home", return_policy: "30d", refund_terms: "none", available: true },
  ];

  const w1 = await store.writeCatalogVersion("merchant-a", A);
  t("first write is v1", () => {
    assert.equal(w1.version, 1);
    assert.equal(w1.previous_version, null);
    assert.equal(w1.product_count, 1);
  });

  const w2 = await store.writeCatalogVersion("merchant-a", A2);
  t("re-upload creates v2 and moves the pointer", () => {
    assert.equal(w2.version, 2);
    assert.equal(w2.previous_version, 1);
    const meta = store.readMeta("merchant-a");
    assert.equal(meta.current_version, 2);
    assert.deepEqual(meta.versions, [1, 2]);
    assert.equal(meta.product_count, 2);
  });

  t("v1 is still retrievable after v2 lands", () => {
    const v1 = store.readCatalog("merchant-a", { version: 1 });
    assert.equal(v1.ok, true, JSON.stringify(v1));
    assert.equal(v1.products.length, 1);
    assert.equal(v1.products[0].price_paise, 1000);
    assert.equal(v1.is_current, false);
    const cur = store.readCatalog("merchant-a");
    assert.equal(cur.version, 2);
    assert.equal(cur.products[0].price_paise, 1500);
    assert.equal(cur.is_current, true);
  });

  t("created_at survives a re-upload, updated_at moves", () => {
    const meta = store.readMeta("merchant-a");
    assert.ok(meta.created_at, "created_at must be recorded");
    assert.ok(meta.updated_at, "updated_at must be recorded");
    assert.ok(meta.updated_at >= meta.created_at);
  });

  t("a version that does not exist is refused by name", () => {
    const r = store.readCatalog("merchant-a", { version: 9 });
    assert.equal(r.ok, false);
    assert.equal(r.reason_code, "version_not_found");
    assert.ok(/1, 2/.test(r.reason), r.reason);
  });

  t("a nonsense version is refused as invalid, not treated as current", () => {
    for (const bad of [0, -1, 1.5, "abc", "1.5"]) {
      const r = store.readCatalog("merchant-a", { version: bad });
      assert.equal(r.ok, false, `version ${JSON.stringify(bad)} was accepted`);
      assert.equal(r.reason_code, "invalid_version");
    }
    // a numeric string is a legitimate query param
    assert.equal(store.readCatalog("merchant-a", { version: "1" }).ok, true);
  });

  await store.writeCatalogVersion("merchant-b", B);
  t("two merchants price the same sku id independently", () => {
    const a = store.findProduct("merchant-a", "sku-a");
    const b = store.findProduct("merchant-b", "sku-a");
    assert.equal(a.ok, true);
    assert.equal(b.ok, true);
    assert.equal(a.product.price_paise, 1500);
    assert.equal(b.product.price_paise, 99999);
    assert.notEqual(a.product.price_paise, b.product.price_paise);
  });

  t("findProduct against an old version prices from that version", () => {
    const old = store.findProduct("merchant-a", "sku-a", { version: 1 });
    assert.equal(old.product.price_paise, 1000);
  });

  t("missing product reports product_not_found with the merchant and version", () => {
    const r = store.findProduct("merchant-a", "sku-nope");
    assert.equal(r.ok, false);
    assert.equal(r.reason_code, "product_not_found");
    assert.ok(/merchant-a/.test(r.reason) && /version 2/.test(r.reason), r.reason);
  });

  t("concurrent writes for one merchant never collide on a version number", async () => {});
  const conc = await Promise.all([
    store.writeCatalogVersion("merchant-c", A),
    store.writeCatalogVersion("merchant-c", A2),
    store.writeCatalogVersion("merchant-c", A),
    store.writeCatalogVersion("merchant-c", A2),
  ]);
  t("...four simultaneous uploads produced v1..v4", () => {
    const versions = conc.map((c) => c.version).sort((a, b) => a - b);
    assert.deepEqual(versions, [1, 2, 3, 4], `got ${JSON.stringify(versions)}`);
    assert.deepEqual(store.listVersions("merchant-c"), [1, 2, 3, 4]);
    assert.equal(store.readMeta("merchant-c").current_version, 4);
  });

  t("listMerchants reports every merchant with counts and versions", () => {
    const list = store.listMerchants();
    const ids = list.map((m) => m.merchant_id);
    assert.deepEqual(ids, [store.DEMO_MERCHANT_ID, "merchant-a", "merchant-b", "merchant-c"].sort((a, b) => a.localeCompare(b)));
    const a = list.find((m) => m.merchant_id === "merchant-a");
    assert.equal(a.current_version, 2);
    assert.equal(a.product_count, 2);
    assert.ok(a.last_updated, "last_updated must be present");
    const demo = list.find((m) => m.merchant_id === store.DEMO_MERCHANT_ID);
    assert.equal(demo.product_count, 3);
    assert.equal(demo.current_version, 1);
  });

  t("a corrupt meta.json falls back to the highest version on disk", () => {
    fs.writeFileSync(path.join(store.MERCHANTS_DIR, "merchant-a", "meta.json"), "{ not json");
    const meta = store.readMeta("merchant-a");
    assert.ok(meta, "a corrupt pointer must not erase the merchant");
    assert.equal(meta.current_version, 2, "should recover the highest version present");
    const cat = store.readCatalog("merchant-a");
    assert.equal(cat.ok, true);
    assert.equal(cat.products[0].price_paise, 1500);
    // and a write after recovery must not clobber v2
    return store.writeCatalogVersion("merchant-a", A).then((w) => {
      assert.equal(w.version, 3, "a write after pointer recovery must create a new version");
      assert.deepEqual(store.listVersions("merchant-a"), [1, 2, 3]);
    });
  });

  t("a pointer at a deleted version falls back instead of failing every lookup", () => {
    fs.writeFileSync(
      path.join(store.MERCHANTS_DIR, "merchant-b", "meta.json"),
      JSON.stringify({ merchant_id: "merchant-b", current_version: 47, product_count: 1 })
    );
    const meta = store.readMeta("merchant-b");
    assert.equal(meta.current_version, 1);
    assert.equal(store.findProduct("merchant-b", "sku-a").ok, true);
  });

  t("no file was written outside the merchants directory by any of the above", () => {
    const dataDir = process.env.KAVACH_DATA_DIR;
    const stray = fs.readdirSync(dataDir).filter((n) => n !== "merchants");
    assert.deepEqual(stray, [], `unexpected entries in the data dir: ${stray.join(", ")}`);
    const dirs = fs.readdirSync(store.MERCHANTS_DIR).sort();
    assert.deepEqual(dirs, [store.DEMO_MERCHANT_ID, "merchant-a", "merchant-b", "merchant-c"].sort());
  });

  t("no .tmp files were left behind", () => {
    const leftovers = [];
    for (const d of fs.readdirSync(store.MERCHANTS_DIR)) {
      for (const f of fs.readdirSync(path.join(store.MERCHANTS_DIR, d))) {
        if (f.endsWith(".tmp")) leftovers.push(`${d}/${f}`);
      }
    }
    assert.deepEqual(leftovers, [], `atomic-write temp files were not renamed away: ${leftovers.join(", ")}`);
  });

  console.log(fails === 0 ? "\nSMOKE OK" : `\n${fails} SMOKE FAILURE(S)`);
  process.exitCode = fails === 0 ? 0 : 1;
})();
