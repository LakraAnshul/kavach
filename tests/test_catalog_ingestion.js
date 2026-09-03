/**
 * CATALOG INGESTION, OVER REAL HTTP.
 *
 * This suite exists because ingestion is where untrusted data enters the rail. Everything
 * downstream — the signed passport, the price an agent is charged, the audit trail — is
 * only as trustworthy as the moment a merchant's file was accepted or refused. So these
 * cases go over the wire against POST /api/merchants/:merchant_id/catalog and assert on
 * what the merchant is actually told, plus what did and did not appear on disk.
 *
 * Two properties get asserted repeatedly and deliberately:
 *
 *   1. A refusal writes NOTHING. Not a directory, not a version file, not a pointer. A
 *      validator that rejects an upload after writing half of it is worse than no
 *      validator, because the merchant is told "rejected" while the rail serves the
 *      partial catalog.
 *   2. merchant_id never escapes data/merchants/. It is the one caller-supplied string
 *      that becomes a filesystem path, so the traversal cases check the filesystem
 *      itself rather than trusting the HTTP status.
 *
 * Boots its own server on PORT 3013 so it never disturbs a demo on 3000.
 * Non-destructive: writes only inside its own tests/.tmp-data/ directory.
 */
const { dataDir } = require("./_isolate"); // first: fixes the data directory before src/config resolves it
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

require("dotenv").config();

const PORT = process.env.KAVACH_INGEST_TEST_PORT || "3013";
const BASE = `http://localhost:${PORT}`;
const MERCHANTS_DIR = path.join(dataDir, "merchants");
const DEMO = "kavach-demo-merchant-001";
const LIMIT_BYTES = 2 * 1024 * 1024;
const MAX_PRODUCTS = 500;

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
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function get(route) {
  const res = await fetch(`${BASE}${route}`);
  return { status: res.status, body: await res.json().catch(() => null) };
}

/** Multipart upload, the way a browser form or `curl -F` would send it. */
async function upload(route, filename, contents, type = "text/csv") {
  const form = new FormData();
  const blob = contents instanceof Uint8Array ? new Blob([contents], { type }) : new Blob([String(contents)], { type });
  form.append("file", blob, filename);
  // Content-Type is deliberately not set: fetch has to generate the multipart boundary.
  const res = await fetch(`${BASE}${route}`, { method: "POST", body: form });
  return { status: res.status, body: await res.json().catch(() => null) };
}

function product(id, over = {}) {
  return {
    id,
    name: `Product ${id}`,
    price_paise: 100000,
    stock: 5,
    category: "electronics",
    return_policy: "7-day return, unused",
    refund_terms: "Full refund within 5 business days",
    available: true,
    ...over,
  };
}

const CSV_HEADER = "id,name,price_paise,stock,category,return_policy,refund_terms,available";
function csvCell(v) {
  const s = String(v ?? "");
  if (s.includes(",") || s.includes('"') || s.includes("\n")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}
function csvRow(p) {
  return [p.id, p.name, p.price_paise, p.stock, p.category, p.return_policy, p.refund_terms, p.available].map(csvCell).join(",");
}
function csvOf(products) {
  return [CSV_HEADER, ...products.map(csvRow)].join("\n") + "\n";
}

function merchantDirs() {
  try {
    return fs.readdirSync(MERCHANTS_DIR).sort();
  } catch {
    return [];
  }
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

  // ---------- happy paths ----------

  await check("a valid JSON array is ingested as version 1", async () => {
    const r = await post("/api/merchants/merchant-json/catalog", [product("sku-1"), product("sku-2"), product("sku-3", { stock: 0, available: false })]);
    assert.equal(r.status, 201, `HTTP ${r.status} ${JSON.stringify(r.body)}`);
    assert.equal(r.body.merchant_id, "merchant-json");
    assert.equal(r.body.version, 1);
    assert.equal(r.body.previous_version, null);
    assert.equal(r.body.product_count, 3);
    assert.ok(fs.existsSync(path.join(MERCHANTS_DIR, "merchant-json", "catalog_v1.json")), "catalog_v1.json was not written");
  });

  await check("{products:[...]} and {catalog:[...]} envelopes are accepted too", async () => {
    const a = await post("/api/merchants/merchant-envelope-a/catalog", { products: [product("sku-1")] });
    assert.equal(a.status, 201, `products envelope: HTTP ${a.status} ${JSON.stringify(a.body)}`);
    const b = await post("/api/merchants/merchant-envelope-b/catalog", { catalog: [product("sku-1")] });
    assert.equal(b.status, 201, `catalog envelope: HTTP ${b.status} ${JSON.stringify(b.body)}`);
  });

  await check("an ingested catalog signs into a passport that verifies", async () => {
    const gen = await post("/api/passport/generate", { merchant_id: "merchant-json" });
    assert.equal(gen.status, 200, `HTTP ${gen.status} ${JSON.stringify(gen.body)}`);
    assert.equal(gen.body.payload.merchant_id, "merchant-json");
    assert.equal(gen.body.payload.catalog_version, 1, "the passport must name the catalog version it was signed over");
    assert.equal(gen.body.payload.catalog.length, 3);

    const view = await get("/api/passport?merchant_id=merchant-json");
    assert.equal(view.status, 200);
    assert.equal(view.body.exists, true);
    assert.equal(view.body.signature_status.valid, true, `signature did not verify: ${JSON.stringify(view.body.signature_status)}`);
  });

  await check("a stock-0 product is signed as unavailable rather than dropped", async () => {
    const view = await get("/api/passport?merchant_id=merchant-json");
    const zero = view.body.manifest.payload.catalog.find((c) => c.id === "sku-3");
    assert.ok(zero, "the stock-0 product must still appear in the passport");
    assert.equal(zero.available, false);
  });

  await check("a CSV upload for a different merchant produces integer paise, never floats", async () => {
    const csv = csvOf([
      product("sku-cable", { price_paise: 49900, stock: 0, available: false }),
      product("sku-lamp", { price_paise: 189500, stock: 30 }),
    ]);
    const r = await upload("/api/merchants/merchant-csv/catalog", "catalog.csv", csv);
    assert.equal(r.status, 201, `HTTP ${r.status} ${JSON.stringify(r.body)}`);
    assert.equal(r.body.format, "csv");
    assert.equal(r.body.product_count, 2);

    const read = await get("/api/merchants/merchant-csv/catalog");
    assert.equal(read.status, 200);
    for (const p of read.body.products) {
      assert.ok(Number.isInteger(p.price_paise), `price_paise ${p.price_paise} arrived as ${typeof p.price_paise}, not an integer`);
      assert.ok(Number.isInteger(p.stock), `stock ${p.stock} is not an integer`);
      assert.equal(typeof p.available, "boolean", `available arrived as ${typeof p.available}`);
    }
    const cable = read.body.products.find((p) => p.id === "sku-cable");
    assert.strictEqual(cable.price_paise, 49900);
    assert.strictEqual(cable.available, false, '"false" from a CSV cell must become the boolean false');
  });

  await check("a CSV with shuffled, padded and uppercase headers maps by name", async () => {
    const csv =
      " AVAILABLE , Refund_Terms ,RETURN_POLICY, category ,STOCK, Price_Paise ,Name, ID \n" +
      "true,full refund,7-day,electronics,4,777,Shuffled Widget,sku-shuffled\n";
    const r = await upload("/api/merchants/merchant-shuffled/catalog", "export.csv", csv);
    assert.equal(r.status, 201, `HTTP ${r.status} ${JSON.stringify(r.body)}`);
    const read = await get("/api/merchants/merchant-shuffled/catalog");
    assert.equal(read.body.products[0].id, "sku-shuffled");
    assert.strictEqual(read.body.products[0].price_paise, 777);
    assert.strictEqual(read.body.products[0].stock, 4);
  });

  await check("unknown CSV columns are dropped and named in the response", async () => {
    const csv = `${CSV_HEADER},warehouse,internal_cost\n${csvRow(product("sku-x"))},WH-7,42\n`;
    const r = await upload("/api/merchants/merchant-extracols/catalog", "catalog.csv", csv);
    assert.equal(r.status, 201, `HTTP ${r.status} ${JSON.stringify(r.body)}`);
    assert.deepEqual(r.body.ignored_columns, ["warehouse", "internal_cost"]);
    const read = await get("/api/merchants/merchant-extracols/catalog");
    assert.equal(read.body.products[0].warehouse, undefined, "an unknown column must not reach the stored catalog");
  });

  await check("a .json file upload is ingested like a JSON body", async () => {
    const r = await upload("/api/merchants/merchant-jsonfile/catalog", "catalog.json", JSON.stringify([product("sku-1")]), "application/json");
    assert.equal(r.status, 201, `HTTP ${r.status} ${JSON.stringify(r.body)}`);
    assert.equal(r.body.format, "json_file");
  });

  // ---------- validation: every refusal must write nothing ----------

  await check("a missing required field is refused, naming the product and field, with nothing written", async () => {
    const broken = product("sku-broken");
    delete broken.return_policy;
    const r = await post("/api/merchants/merchant-missing/catalog", [product("sku-ok"), broken]);
    assert.equal(r.status, 400, `HTTP ${r.status} ${JSON.stringify(r.body)}`);
    assert.equal(r.body.error.reason_code, "product_fields_invalid");
    const named = r.body.error.problems.find((p) => p.field === "return_policy");
    assert.ok(named, `the refusal must name the missing field: ${JSON.stringify(r.body.error.problems)}`);
    assert.equal(named.product_id, "sku-broken", "the refusal must name which product was wrong");

    // NO PARTIAL WRITE: not the valid product, not a directory, not a pointer.
    assert.ok(!fs.existsSync(path.join(MERCHANTS_DIR, "merchant-missing")), "a refused upload created a merchant directory");
    const read = await get("/api/merchants/merchant-missing/catalog");
    assert.equal(read.status, 404, "a refused upload left a readable catalog behind");
    const list = await get("/api/merchants");
    assert.ok(!list.body.merchants.some((m) => m.merchant_id === "merchant-missing"), "a refused upload registered a merchant");
  });

  await check("duplicate product ids are refused and the duplicate is named", async () => {
    const r = await post("/api/merchants/merchant-dupes/catalog", [product("sku-1"), product("sku-2"), product("sku-1", { price_paise: 999 })]);
    assert.equal(r.status, 400, `HTTP ${r.status} ${JSON.stringify(r.body)}`);
    assert.equal(r.body.error.reason_code, "duplicate_product_ids");
    assert.deepEqual(r.body.error.duplicate_ids, ["sku-1"]);
    assert.ok(/sku-1/.test(r.body.error.message), `the message must name the duplicate id: ${r.body.error.message}`);
    assert.ok(!fs.existsSync(path.join(MERCHANTS_DIR, "merchant-dupes")), "a refused upload created a merchant directory");
  });

  await check("prices that are not positive whole paise are all refused", async () => {
    const cases = [
      ["negative", -100],
      ["zero", 0],
      ["decimal", 349.9],
      ["decimal as a string", "349.9"],
      ["not a number", "cheap"],
      ["exponent notation", "3e5"],
      ["thousands separator", "1,000"],
    ];
    for (const [label, price_paise] of cases) {
      const r = await post("/api/merchants/merchant-badprice/catalog", [product("sku-1", { price_paise })]);
      assert.equal(r.status, 400, `${label} price ${JSON.stringify(price_paise)} was accepted: HTTP ${r.status} ${JSON.stringify(r.body)}`);
      const named = (r.body.error.problems || []).find((p) => p.field === "price_paise");
      assert.ok(named, `${label}: the refusal must name price_paise — got ${JSON.stringify(r.body.error.problems)}`);
    }
    assert.ok(!fs.existsSync(path.join(MERCHANTS_DIR, "merchant-badprice")), "a refused upload created a merchant directory");
  });

  await check("stock must be a whole number of units, zero or above", async () => {
    for (const stock of [-1, 1.5, "many", ""]) {
      const r = await post("/api/merchants/merchant-badstock/catalog", [product("sku-1", { stock })]);
      assert.equal(r.status, 400, `stock ${JSON.stringify(stock)} was accepted`);
    }
    const ok = await post("/api/merchants/merchant-zerostock/catalog", [product("sku-1", { stock: 0, available: false })]);
    assert.equal(ok.status, 201, "stock 0 is valid input and must be ingested, not refused");
  });

  await check("a non-boolean available value is refused rather than coerced", async () => {
    const r = await post("/api/merchants/merchant-badbool/catalog", [product("sku-1", { available: "maybe" })]);
    assert.equal(r.status, 400, `HTTP ${r.status} ${JSON.stringify(r.body)}`);
    const named = (r.body.error.problems || []).find((p) => p.field === "available");
    assert.ok(named, "the refusal must name the available field");
  });

  await check("an empty category is refused", async () => {
    const r = await post("/api/merchants/merchant-nocat/catalog", [product("sku-1", { category: "   " })]);
    assert.equal(r.status, 400);
    assert.ok((r.body.error.problems || []).some((p) => p.field === "category"));
  });

  await check("zero products is refused", async () => {
    const r = await post("/api/merchants/merchant-empty/catalog", []);
    assert.equal(r.status, 400, `HTTP ${r.status} ${JSON.stringify(r.body)}`);
    assert.equal(r.body.error.reason_code, "catalog_empty");
    assert.ok(!fs.existsSync(path.join(MERCHANTS_DIR, "merchant-empty")));
  });

  await check("no catalog at all is refused with the required fields named", async () => {
    const r = await post("/api/merchants/merchant-nobody/catalog", {});
    assert.equal(r.status, 400, `HTTP ${r.status} ${JSON.stringify(r.body)}`);
    assert.equal(r.body.error.code, "no_catalog_supplied");
    assert.ok(Array.isArray(r.body.error.required_fields), "the refusal should say what a product needs");
  });

  await check(`${MAX_PRODUCTS + 1} products is refused with the limit stated`, async () => {
    const many = Array.from({ length: MAX_PRODUCTS + 1 }, (_, i) => product(`sku-${i}`));
    const r = await post("/api/merchants/merchant-toobig/catalog", many);
    assert.equal(r.status, 400, `HTTP ${r.status} ${JSON.stringify(r.body && r.body.error && r.body.error.code)}`);
    assert.equal(r.body.error.reason_code, "catalog_too_large");
    assert.ok(new RegExp(String(MAX_PRODUCTS)).test(JSON.stringify(r.body.error)), "the refusal must state the limit");
    assert.ok(!fs.existsSync(path.join(MERCHANTS_DIR, "merchant-toobig")));
  });

  await check(`exactly ${MAX_PRODUCTS} products is accepted (the limit is a ceiling, not a fence)`, async () => {
    const many = Array.from({ length: MAX_PRODUCTS }, (_, i) => product(`sku-${i}`));
    const r = await post("/api/merchants/merchant-atlimit/catalog", many);
    assert.equal(r.status, 201, `HTTP ${r.status} ${JSON.stringify(r.body)}`);
    assert.equal(r.body.product_count, MAX_PRODUCTS);
  });

  // ---------- malformed input must not crash anything ----------

  await check("a malformed JSON body is a 400 parse error, not a crash", async () => {
    const r = await post("/api/merchants/merchant-badjson/catalog", '[{"id":"sku-1", "name": ');
    assert.equal(r.status, 400, `HTTP ${r.status} ${JSON.stringify(r.body)}`);
    assert.equal(r.body.error.code, "malformed_json");
    const health = await get("/api/health");
    assert.equal(health.status, 200, "the server must survive a malformed body");
  });

  await check("a corrupt CSV is refused with a parse reason", async () => {
    const r = await upload("/api/merchants/merchant-badcsv/catalog", "catalog.csv", `${CSV_HEADER}\nsku-1,"Unclosed quote,100,1,home,7d,full,true\n`);
    assert.equal(r.status, 400, `HTTP ${r.status} ${JSON.stringify(r.body)}`);
    assert.equal(r.body.error.code, "csv_unparseable");
  });

  await check("a CSV missing a required column names the column", async () => {
    const r = await upload("/api/merchants/merchant-csvcols/catalog", "catalog.csv", "id,name,price_paise,stock,category,return_policy,refund_terms\nsku-1,A,100,1,home,7d,full\n");
    assert.equal(r.status, 400, `HTTP ${r.status} ${JSON.stringify(r.body)}`);
    assert.equal(r.body.error.code, "csv_missing_columns");
    assert.ok(/available/.test(r.body.error.message), r.body.error.message);
  });

  await check("prose in a .csv file is refused as having no header row", async () => {
    const r = await upload("/api/merchants/merchant-prose/catalog", "notes.csv", "this is not a catalog\njust some notes I had\n");
    assert.equal(r.status, 400, `HTTP ${r.status} ${JSON.stringify(r.body)}`);
    assert.equal(r.body.error.code, "csv_no_header_row");
  });

  await check("an empty CSV file is refused", async () => {
    const r = await upload("/api/merchants/merchant-emptyfile/catalog", "catalog.csv", "   \n  ");
    assert.equal(r.status, 400, `HTTP ${r.status} ${JSON.stringify(r.body)}`);
    assert.ok(["csv_empty", "empty_upload"].includes(r.body.error.code), r.body.error.code);
  });

  // ---------- file type ----------

  await check("a .txt upload is refused before any parse is attempted", async () => {
    const r = await upload("/api/merchants/merchant-txt/catalog", "catalog.txt", csvOf([product("sku-1")]), "text/plain");
    assert.equal(r.status, 400, `HTTP ${r.status} ${JSON.stringify(r.body)}`);
    assert.equal(r.body.error.code, "unsupported_file_type");
    assert.deepEqual(r.body.error.allowed_extensions, [".json", ".csv"]);
    assert.ok(!fs.existsSync(path.join(MERCHANTS_DIR, "merchant-txt")));
  });

  await check("a .png upload is refused", async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 73, 72, 68, 82]);
    const r = await upload("/api/merchants/merchant-png/catalog", "logo.png", png, "image/png");
    assert.equal(r.status, 400, `HTTP ${r.status} ${JSON.stringify(r.body)}`);
    assert.equal(r.body.error.code, "unsupported_file_type");
  });

  await check("a binary renamed to .csv is refused on its bytes, not its name", async () => {
    // The extension allowlist cannot catch this by construction, which is exactly why
    // there is a second check on the content.
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0]);
    const r = await upload("/api/merchants/merchant-fakecsv/catalog", "catalog.csv", png, "text/csv");
    assert.equal(r.status, 400, `HTTP ${r.status} ${JSON.stringify(r.body)}`);
    assert.equal(r.body.error.code, "unsupported_file_type");
    assert.ok(/NUL/.test(r.body.error.message), `the refusal should say why: ${r.body.error.message}`);
  });

  await check("a .csv declared as image/png is refused on its declared type", async () => {
    const r = await upload("/api/merchants/merchant-liedmime/catalog", "catalog.csv", csvOf([product("sku-1")]), "image/png");
    assert.equal(r.status, 400, `HTTP ${r.status} ${JSON.stringify(r.body)}`);
    assert.equal(r.body.error.code, "unsupported_file_type");
  });

  await check("a CSV declared as application/octet-stream is accepted (this is what curl sends)", async () => {
    const r = await upload("/api/merchants/merchant-octet/catalog", "catalog.csv", csvOf([product("sku-1")]), "application/octet-stream");
    assert.equal(r.status, 201, `HTTP ${r.status} ${JSON.stringify(r.body)} — refusing octet-stream would break curl -F`);
  });

  // ---------- size limits ----------

  await check("an upload over 2MB is refused with 413, as a file and as a JSON body", async () => {
    const oversized = "x".repeat(LIMIT_BYTES + 1024);
    const asFile = await upload("/api/merchants/merchant-huge/catalog", "catalog.csv", `${CSV_HEADER}\n${oversized}\n`);
    assert.equal(asFile.status, 413, `multipart: HTTP ${asFile.status} ${JSON.stringify(asFile.body)}`);
    assert.equal(asFile.body.error.code, "upload_too_large");
    assert.equal(asFile.body.error.limit_bytes, LIMIT_BYTES);

    const asBody = await post("/api/merchants/merchant-huge/catalog", JSON.stringify([product("sku-1", { name: oversized })]));
    assert.equal(asBody.status, 413, `json body: HTTP ${asBody.status} ${JSON.stringify(asBody.body)}`);
    assert.ok(!fs.existsSync(path.join(MERCHANTS_DIR, "merchant-huge")));
  });

  await check("a catalog between 1MB and 2MB is accepted (the mount order is load bearing)", async () => {
    // The global express.json limit is 1MB. If the ingestion parser were mounted after it
    // rather than before, this would come back 413 and the endpoint's documented 2MB
    // limit would be fiction. Sized to sit clearly between the two.
    const padding = "p".repeat(3000);
    const products = Array.from({ length: 400 }, (_, i) => product(`sku-${i}`, { return_policy: `7-day return ${padding}` }));
    const bytes = Buffer.byteLength(JSON.stringify(products));
    assert.ok(bytes > 1024 * 1024 && bytes < LIMIT_BYTES, `fixture must sit between 1MB and 2MB, got ${bytes} bytes`);
    const r = await post("/api/merchants/merchant-bigok/catalog", products);
    assert.equal(r.status, 201, `HTTP ${r.status} ${JSON.stringify(r.body && r.body.error)} for a ${bytes}-byte catalog`);
    assert.equal(r.body.product_count, 400);
  });

  // ---------- merchant_id is a path segment: the security guardrail ----------

  await check("path traversal in merchant_id is refused and writes nothing outside the merchants directory", async () => {
    const before = merchantDirs();
    // Percent-encoded so the separators survive URL normalisation and actually reach the
    // route. A bare "../../etc" is collapsed by the URL parser before it is ever sent,
    // which would make this test pass without exercising the guard at all.
    const attacks = [
      "..%2F..%2Fetc",
      "%2E%2E%2F%2E%2E%2Fetc",
      "%2E%2E",
      "a%2Fb",
      "a%5Cb",
      "C%3A%5Cevil",
      "%00null",
      "merchant%20b",
      "-leading-hyphen",
      "x".repeat(65),
    ];
    for (const attack of attacks) {
      const r = await post(`/api/merchants/${attack}/catalog`, [product("sku-1")]);
      assert.ok(
        r.status === 400 || r.status === 404,
        `merchant_id "${attack}" was not refused: HTTP ${r.status} ${JSON.stringify(r.body)}`
      );
      if (r.status === 400 && r.body && r.body.error) {
        assert.ok(r.body.error.message, "a refusal must say why");
      }
    }

    // The status codes above are secondary. This is the assertion that matters: the
    // filesystem is unchanged, and nothing appeared next to or above the merchants root.
    assert.deepEqual(merchantDirs(), before, "a traversal attempt changed what is inside data/merchants/");
    // A .tmp sibling is a rename-in-flight from an atomic write, not evidence of traversal.
    const KNOWN = ["merchants", "audit.jsonl", "mandates.json", "passport.json"];
    for (const entry of fs.readdirSync(dataDir).sort()) {
      assert.ok(
        KNOWN.includes(entry) || (entry.endsWith(".tmp") && KNOWN.includes(entry.slice(0, -4))),
        `unexpected entry "${entry}" in the data directory after traversal attempts`
      );
    }
    assert.ok(!fs.existsSync(path.join(dataDir, "..", "etc")), "a traversal attempt wrote above the data directory");
    for (const dir of merchantDirs()) {
      assert.ok(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(dir), `merchant directory "${dir}" is not a legal merchant_id`);
    }
  });

  await check("a traversal attempt is recorded as a refused ingestion rather than passing silently", async () => {
    const { body } = await get("/api/audit");
    const entry = body.entries.filter((e) => e.action === "catalog_ingested" && e.reason_code === "invalid_merchant_id").pop();
    assert.ok(entry, "no catalog_ingested/invalid_merchant_id entry reached the trail");
    assert.equal(entry.result, "fail");
    assert.ok(entry.human_reason, "the entry must carry a plain-language reason");
    assert.ok(/Rejected/.test(entry.human_reason), entry.human_reason);
  });

  // ---------- versioning ----------

  await check("a re-upload creates v2, keeps v1 readable, and moves the pointer", async () => {
    const first = await post("/api/merchants/merchant-versioned/catalog", [product("sku-1", { price_paise: 1000 })]);
    assert.equal(first.status, 201);
    assert.equal(first.body.version, 1);

    const second = await post("/api/merchants/merchant-versioned/catalog", [
      product("sku-1", { price_paise: 1500 }),
      product("sku-2", { price_paise: 700 }),
    ]);
    assert.equal(second.status, 201, `HTTP ${second.status} ${JSON.stringify(second.body)}`);
    assert.equal(second.body.version, 2, "a re-upload must create a new version, never overwrite");
    assert.equal(second.body.previous_version, 1);
    assert.ok(/retained/.test(second.body.replaced), second.body.replaced);

    const v1 = await get("/api/merchants/merchant-versioned/catalog?version=1");
    assert.equal(v1.status, 200, "v1 must stay retrievable after v2 lands");
    assert.equal(v1.body.products.length, 1);
    assert.strictEqual(v1.body.products[0].price_paise, 1000, "v1 must still hold the price it was uploaded with");
    assert.equal(v1.body.is_current, false);

    const current = await get("/api/merchants/merchant-versioned/catalog");
    assert.equal(current.body.version, 2);
    assert.equal(current.body.current_version, 2);
    assert.strictEqual(current.body.products[0].price_paise, 1500);
    assert.deepEqual(current.body.versions, [1, 2]);

    assert.ok(fs.existsSync(path.join(MERCHANTS_DIR, "merchant-versioned", "catalog_v1.json")), "v1 file was deleted by a re-upload");
    assert.ok(fs.existsSync(path.join(MERCHANTS_DIR, "merchant-versioned", "catalog_v2.json")));
  });

  await check("a re-upload replaces rather than merges", async () => {
    const current = await get("/api/merchants/merchant-versioned/catalog");
    const ids = current.body.products.map((p) => p.id).sort();
    assert.deepEqual(ids, ["sku-1", "sku-2"], "v2's contents must be exactly what was uploaded, with nothing carried over from v1");
  });

  await check("a passport signed over v1 still verifies after v2 is ingested", async () => {
    const signedOverV1 = await post("/api/passport/generate", { merchant_id: "merchant-versioned", version: 1 });
    assert.equal(signedOverV1.status, 200, `HTTP ${signedOverV1.status} ${JSON.stringify(signedOverV1.body)}`);
    assert.equal(signedOverV1.body.payload.catalog_version, 1);
    assert.strictEqual(signedOverV1.body.payload.catalog[0].price_paise, 1000);

    // Re-signing the current version must not retroactively invalidate the old manifest:
    // verification reads the manifest, never the catalog on disk. Checked in-process
    // because there is no verify-an-arbitrary-manifest endpoint — GET /api/passport only
    // verifies the stored file, which by now holds the v2 passport.
    const resigned = await post("/api/passport/generate", { merchant_id: "merchant-versioned" });
    assert.equal(resigned.body.payload.catalog_version, 2, "a bare generate must sign the CURRENT version");

    const { verifyPassport } = require("../src/passport/generator");
    const verdict = verifyPassport(signedOverV1.body);
    assert.equal(verdict.valid, true, `the v1 passport stopped verifying after v2 landed: ${verdict.reason}`);

    // And the old manifest still carries v1's price, not v2's.
    assert.strictEqual(signedOverV1.body.payload.catalog[0].price_paise, 1000);
  });

  await check("a rejected re-upload leaves the current version exactly where it was", async () => {
    const before = await get("/api/merchants/merchant-versioned/catalog");
    const r = await post("/api/merchants/merchant-versioned/catalog", [product("sku-1", { price_paise: -5 })]);
    assert.equal(r.status, 400);
    const after = await get("/api/merchants/merchant-versioned/catalog");
    assert.equal(after.body.version, before.body.version, "a refused upload moved the current version pointer");
    assert.deepEqual(after.body.products, before.body.products, "a refused upload changed the live catalog");
    assert.ok(!fs.existsSync(path.join(MERCHANTS_DIR, "merchant-versioned", "catalog_v3.json")), "a refused upload wrote a version file");
  });

  await check("an unknown version is refused by name, listing what exists", async () => {
    const r = await get("/api/merchants/merchant-versioned/catalog?version=9");
    assert.equal(r.status, 404, `HTTP ${r.status} ${JSON.stringify(r.body)}`);
    assert.equal(r.body.error.code, "version_not_found");
    assert.ok(/1, 2/.test(r.body.error.message), r.body.error.message);
  });

  await check("a nonsense version is refused as invalid rather than treated as current", async () => {
    for (const version of ["0", "-1", "1.5", "abc", "99999999999999999999"]) {
      const r = await get(`/api/merchants/merchant-versioned/catalog?version=${encodeURIComponent(version)}`);
      assert.ok(r.status === 400 || r.status === 404, `version "${version}" returned HTTP ${r.status}`);
      assert.notEqual(r.status, 200, `version "${version}" was silently treated as the current version`);
    }
  });

  // ---------- listing, audit, and the demo merchant ----------

  await check("GET /api/merchants reports product count, current version and last-updated", async () => {
    const r = await get("/api/merchants");
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.body.merchants));
    assert.equal(r.body.count, r.body.merchants.length);

    const versioned = r.body.merchants.find((m) => m.merchant_id === "merchant-versioned");
    assert.ok(versioned, "an ingested merchant must be listed");
    assert.equal(versioned.current_version, 2);
    assert.equal(versioned.product_count, 2);
    assert.deepEqual(versioned.versions, [1, 2]);
    assert.ok(versioned.last_updated, "last_updated must be reported");
    assert.ok(Number.isFinite(Date.parse(versioned.last_updated)), `last_updated is not a timestamp: ${versioned.last_updated}`);

    // Merchants whose uploads were all refused must not be listed at all.
    for (const refused of ["merchant-missing", "merchant-dupes", "merchant-toobig", "merchant-badprice"]) {
      assert.ok(!r.body.merchants.some((m) => m.merchant_id === refused), `${refused} was listed despite never having a catalog accepted`);
    }
  });

  await check("the migrated demo merchant is present with its original three SKUs", async () => {
    const r = await get(`/api/merchants/${DEMO}/catalog`);
    assert.equal(r.status, 200, `HTTP ${r.status} ${JSON.stringify(r.body)}`);
    assert.equal(r.body.products.length, 3);
    const keyboard = r.body.products.find((p) => p.id === "sku-mech-keyboard");
    assert.ok(keyboard, "the demo catalog must still contain sku-mech-keyboard");
    assert.strictEqual(keyboard.price_paise, 349900, "the migrated demo price must be unchanged");
    const cable = r.body.products.find((p) => p.id === "sku-usbc-cable");
    assert.strictEqual(cable.stock, 0);
    assert.strictEqual(cable.available, false);
  });

  await check("every ingestion outcome reached the append-only trail before the response returned", async () => {
    const { body } = await get("/api/audit");
    const ingestions = body.entries.filter((e) => e.action === "catalog_ingested");
    assert.ok(ingestions.length > 0, "no catalog_ingested entries were recorded");

    const accepted = ingestions.filter((e) => e.result === "pass");
    const refused = ingestions.filter((e) => e.result === "fail");
    assert.ok(accepted.length > 0, "no accepted ingestion was recorded");
    assert.ok(refused.length > 0, "no refused ingestion was recorded");

    const one = accepted.find((e) => e.meta && e.meta.merchant_id === "merchant-versioned" && e.meta.version === 2);
    assert.ok(one, `the v2 ingestion is not in the trail: ${JSON.stringify(accepted.map((e) => e.meta))}`);
    assert.equal(one.meta.product_count, 2);
    assert.equal(one.meta.previous_version, 1);
    assert.ok(/version 2/.test(one.human_reason), one.human_reason);
    assert.ok(/Version 1 is kept/.test(one.human_reason), one.human_reason);

    for (const entry of refused) {
      assert.ok(entry.human_reason, `a refusal reached the trail with no plain-language reason: ${JSON.stringify(entry)}`);
      assert.ok(/Nothing was written/.test(entry.human_reason), `a refusal must state that nothing was written: ${entry.human_reason}`);
    }

    // The core record shape is unchanged; the new fields ride in meta.
    for (const key of ["ts", "agent_id", "mandate_id", "action", "result", "reason_code", "reason", "amount_paise", "meta"]) {
      assert.ok(key in ingestions[0], `catalog_ingested entries must keep the existing record shape; "${key}" is missing`);
    }
  });

  await check("the server is still healthy after every malformed, oversized and hostile upload above", async () => {
    const r = await get("/api/health");
    assert.equal(r.status, 200);
    assert.equal(child.exitCode, null, "the server process died during this suite");
  });

  child.kill();
  console.log(failures === 0 ? "\nALL CATALOG INGESTION TESTS PASSED" : `\n${failures} TEST(S) FAILED`);
  // exitCode, not process.exit(); see the note in test_webhook.js. This suite kills a
  // spawned server the same way and carried the same latent abort.
  process.exitCode = failures === 0 ? 0 : 1;
}

run().catch((e) => {
  console.error("catalog ingestion harness crashed:", e.message);
  process.exit(1);
});
