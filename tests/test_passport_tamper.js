require("./_isolate"); // first: fixes the data directory before src/config resolves it
const assert = require("assert");
const crypto = require("crypto");
const { generatePassport, verifyPassport, canonicalize, SIGNATURE_ALGORITHM } = require("../src/passport/generator");
const { config } = require("../src/config");

function deepClone(o) {
  return JSON.parse(JSON.stringify(o));
}

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

  const gen = generatePassport();
  await check("generation succeeds for valid catalog", async () => {
    assert.equal(gen.ok, true, JSON.stringify(gen.errors || {}));
  });

  const manifest = gen.manifest;
  await check("untampered passport verifies", async () => {
    assert.equal(verifyPassport(manifest).valid, true);
  });

  await check("stock=0 item marked unavailable but passport still generated", async () => {
    const cable = manifest.payload.catalog.find((c) => c.stock === 0);
    assert.ok(cable, "expected the zero-stock sku in catalog");
    assert.equal(cable.available, false);
  });

  // Tamper with EVERY field one at a time; each must break verification.
  const tampers = [
    ["product name", (m) => (m.payload.catalog[0].name = "Hacked Keyboard")],
    ["price_paise", (m) => (m.payload.catalog[0].price_paise = 1)],
    ["stock", (m) => (m.payload.catalog[0].stock = 9999)],
    ["category", (m) => (m.payload.catalog[0].category = "contraband")],
    ["return_policy", (m) => (m.payload.catalog[2].return_policy = "no returns ever")],
    ["refund_terms", (m) => (m.payload.catalog[2].refund_terms = "no refunds")],
    ["available flag", (m) => (m.payload.catalog[1].available = true)],
    ["generated_at", (m) => (m.generated_at = "2001-01-01T00:00:00.000Z")],
    ["passport_version", (m) => (m.passport_version = "9.9")],
    ["signature itself", (m) => (m.signature = m.signature.slice(0, -4) + "beef")],
  ];

  for (const [label, mutate] of tampers) {
    await check(`tampering ${label} breaks verification`, async () => {
      const tampered = deepClone(manifest);
      mutate(tampered);
      const r = verifyPassport(tampered);
      assert.equal(r.valid, false, `tampered (${label}) passport verified as VALID — bug`);
      assert.equal(r.reason_code, "signature_mismatch");
    });
  }

  // ---- signature_algorithm is inside the signed set ----
  // It used to sit in the manifest but outside the signature, so the manifest's own
  // account of how it was signed could be rewritten while still verifying as valid.

  await check("signature actually covers signature_algorithm", async () => {
    // Proof by construction rather than by trusting the guard below: a signature over
    // the old field set (version + timestamp + payload only) must differ from the real
    // one. If they matched, the field would not be part of what was signed.
    const legacy = crypto
      .createHmac("sha256", config.passportSigningKey)
      .update(canonicalize({ passport_version: manifest.passport_version, generated_at: manifest.generated_at, payload: manifest.payload }))
      .digest("hex");
    assert.notEqual(legacy, manifest.signature, "signature_algorithm is not covered by the signature");
  });

  await check("rewriting signature_algorithm is refused", async () => {
    const tampered = deepClone(manifest);
    tampered.signature_algorithm = "HMAC-MD5-whatever";
    const r = verifyPassport(tampered);
    assert.equal(r.valid, false, "a rewritten algorithm verified as VALID — bug");
    assert.equal(r.reason_code, "unsupported_signature_algorithm");
  });

  await check("stripping signature_algorithm is refused", async () => {
    const tampered = deepClone(manifest);
    delete tampered.signature_algorithm;
    const r = verifyPassport(tampered);
    assert.equal(r.valid, false);
    assert.equal(r.reason_code, "unsupported_signature_algorithm");
  });

  await check("a passport signed under the old scheme is refused, but not called tampered", async () => {
    const old = deepClone(manifest);
    old.signature = crypto
      .createHmac("sha256", config.passportSigningKey)
      .update(canonicalize({ passport_version: old.passport_version, generated_at: old.generated_at, payload: old.payload }))
      .digest("hex");
    const r = verifyPassport(old);
    assert.equal(r.valid, false, "an old-scheme signature must not verify");
    assert.equal(r.reason_code, "signature_scheme_outdated");
  });

  // ---- verification never throws ----
  // timingSafeEqual throws RangeError on unequal buffer lengths. The guard used to
  // compare STRING lengths (UTF-16 code units) before building UTF-8 buffers, so a
  // signature with any multi-byte character passed the guard and then threw — turning
  // a passport that should be refused into a 500.
  await check("a multi-byte signature of equal character length is refused, not thrown", async () => {
    const tampered = deepClone(manifest);
    const sameCharCount = "0".repeat(String(manifest.signature).length - 1) + "é";
    assert.equal(sameCharCount.length, String(manifest.signature).length, "test setup: character lengths must match");
    assert.notEqual(Buffer.byteLength(sameCharCount, "utf8"), Buffer.byteLength(manifest.signature, "utf8"), "test setup: byte lengths must differ");
    tampered.signature = sameCharCount;
    const r = verifyPassport(tampered);
    assert.equal(r.valid, false);
    assert.equal(r.reason_code, "signature_mismatch");
  });

  for (const [label, sig] of [["a number", 12345], ["an object", { a: 1 }], ["an array", ["x"]], ["a short string", "ab"]]) {
    await check(`${label} as the signature is refused, not thrown`, async () => {
      const tampered = deepClone(manifest);
      tampered.signature = sig;
      const r = verifyPassport(tampered);
      assert.equal(r.valid, false);
    });
  }

  for (const [label, bad] of [["null", null], ["a string", "not-a-manifest"], ["a number", 7], ["undefined", undefined]]) {
    await check(`${label} as the whole manifest is refused, not thrown`, async () => {
      const r = verifyPassport(bad);
      assert.equal(r.valid, false);
    });
  }

  // ---- an unset signing key must refuse, never sign with nothing ----
  // crypto.createHmac accepts an empty key and returns a perfectly well-formed digest,
  // so without this guard a deployment that forgot PASSPORT_SIGNING_KEY would issue
  // passports anyone who noticed could forge.
  await check("an unset signing key refuses to sign or verify", async () => {
    const saved = config.passportSigningKey;
    try {
      config.passportSigningKey = "";
      const g = generatePassport();
      assert.equal(g.ok, false, "a passport was signed with an empty key — bug");
      assert.equal(g.errors[0].reason_code, "signing_key_missing");
      const r = verifyPassport(manifest);
      assert.equal(r.valid, false);
      assert.equal(r.reason_code, "signing_key_missing");
    } finally {
      config.passportSigningKey = saved;
    }
  });

  await check("verification still works after the key is restored", async () => {
    assert.equal(verifyPassport(manifest).valid, true);
    assert.equal(manifest.signature_algorithm, SIGNATURE_ALGORITHM);
  });

  console.log(failures === 0 ? "\nALL PASSPORT TAMPER TESTS PASSED" : `\n${failures} TEST(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

run();
