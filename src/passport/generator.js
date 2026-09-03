const crypto = require("crypto");
const { config } = require("../config");
const logger = require("../logger");
const store = require("../catalog/store");

const PASSPORT_VERSION = "1.0";
const REQUIRED_FIELDS = ["name", "price_paise", "stock", "category", "return_policy", "refund_terms"];

/**
 * The catalog is no longer a constant in this file. It is read from the merchant's
 * ingested, versioned catalog under data/merchants/<merchant_id>/, so a passport is
 * signed over data a merchant actually supplied rather than over data compiled into the
 * binary.
 *
 * The demo merchant's old hardcoded catalog moved to src/catalog/store.js as seed data
 * and is written to disk on first read, so kavach-demo-merchant-001 signs the same three
 * SKUs it always did — by the same code path every other merchant uses. There is no
 * "demo mode" branch below, which is the point: if the generalized path breaks, the demo
 * breaks too and the suite says so, instead of the demo passing on a special case.
 */
const DEFAULT_MERCHANT_ID = store.DEMO_MERCHANT_ID;

function canonicalize(obj) {
  if (obj === null || typeof obj !== "object") return JSON.stringify(obj);
  if (Array.isArray(obj)) return "[" + obj.map(canonicalize).join(",") + "]";
  const keys = Object.keys(obj).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalize(obj[k])).join(",") + "}";
}

function validateCatalogEntry(entry) {
  const missing = REQUIRED_FIELDS.filter((f) => entry[f] === undefined || entry[f] === null);
  if (missing.length > 0) {
    return { ok: false, reason_code: "missing_required_fields", detail: { missing_fields: missing } };
  }
  if (!Number.isInteger(entry.price_paise) || entry.price_paise <= 0) {
    // EDGE CASE: price zero or negative -> invalid catalog entry
    return {
      ok: false,
      reason_code: "invalid_price",
      detail: { field: "price_paise", value: entry.price_paise, rule: "must be a positive integer in paise" },
    };
  }
  if (!Number.isInteger(entry.stock) || entry.stock < 0) {
    return {
      ok: false,
      reason_code: "invalid_stock",
      detail: { field: "stock", value: entry.stock, rule: "must be a non-negative integer" },
    };
  }
  return { ok: true };
}

const SIGNATURE_ALGORITHM = "HMAC-SHA256-canonical-json";

/**
 * GUARDRAIL: an empty signing key would still produce a valid-looking HMAC, and
 * anyone who guessed the key was unset could forge a passport that verifies. Refuse
 * to sign at all instead.
 */
function signPayload(payload) {
  const key = config.passportSigningKey;
  if (typeof key !== "string" || key.length === 0) {
    throw new Error("PASSPORT_SIGNING_KEY is not set, so no passport can be signed or verified");
  }
  const hmac = crypto.createHmac("sha256", key);
  hmac.update(canonicalize(payload));
  return hmac.digest("hex");
}

// Compare as BYTES, in constant time. timingSafeEqual throws RangeError on unequal
// buffer lengths, and a string's length counts UTF-16 code units while the buffer it
// becomes counts UTF-8 bytes — so a signature holding any multi-byte character could
// pass a string-length guard and then throw, turning a passport that should be
// refused into a 500.
function constantTimeEqual(a, b) {
  const bufA = Buffer.from(String(a), "utf8");
  const bufB = Buffer.from(String(b), "utf8");
  return bufA.length === bufB.length && crypto.timingSafeEqual(bufA, bufB);
}

// The exact field set covered by the signature. signature_algorithm is inside it:
// left outside, the algorithm name could be rewritten freely and the manifest would
// still verify as valid, which makes the manifest's own account of how it was signed
// untrustworthy.
function signedView({ passport_version, generated_at, payload, signature_algorithm }) {
  return { passport_version, generated_at, payload, signature_algorithm };
}

/**
 * Generate a signed passport for one merchant.
 *
 * `generatePassport()` with no arguments signs the demo merchant's current catalog,
 * which is what the existing suite and the dashboard call.
 *
 * `version` signs a specific historical catalog version instead of the current one.
 * That exists because a passport names the version it was signed over: given an old
 * passport, the same version can be re-signed and compared, so "this passport is
 * genuine" and "this is what it promised" are both answerable later — not just the
 * first one.
 */
function generatePassport({ merchant_id = DEFAULT_MERCHANT_ID, version } = {}) {
  // The catalog is loaded before anything is signed, and a load failure is a refusal
  // with a reason rather than an exception. An unknown merchant is a normal thing for a
  // caller to ask about; it is not a fault.
  const loaded = store.readCatalog(merchant_id, { version });
  if (!loaded.ok) {
    logger.error("passport_generation_rejected", {
      merchant_id,
      requested_version: version ?? null,
      reason_code: loaded.reason_code,
      reason: loaded.reason,
    });
    return { ok: false, errors: [{ reason_code: loaded.reason_code, reason: loaded.reason }] };
  }

  const catalog = loaded.products;

  // EDGE CASE: a catalog file that exists but holds nothing. Ingestion refuses an empty
  // upload, so reaching this means the file was emptied by hand — and an empty passport
  // would sign and verify perfectly while promising nothing at all.
  if (catalog.length === 0) {
    const reason = `catalog version ${loaded.version} for "${loaded.merchant_id}" contains no products, so there is nothing to attest`;
    logger.error("passport_generation_rejected", { merchant_id: loaded.merchant_id, reason_code: "catalog_empty", reason });
    return { ok: false, errors: [{ reason_code: "catalog_empty", reason }] };
  }

  const rejected = [];
  for (const entry of catalog) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      rejected.push({ sku: null, reason_code: "malformed_catalog_entry", rule: "each catalog entry must be an object" });
      continue;
    }
    // Checked here as well as at ingestion, because this reads a FILE. Ingestion
    // validates what arrives over HTTP; nothing stops a catalog file from being edited
    // afterwards, and the signature would faithfully attest whatever it found. The
    // signing step is the last place to refuse.
    if (typeof entry.id !== "string" || entry.id.trim().length === 0) {
      rejected.push({ sku: null, reason_code: "missing_sku_id", rule: "each catalog entry must carry a non-empty id" });
      continue;
    }
    const v = validateCatalogEntry(entry);
    if (!v.ok) {
      // EDGE CASE: bad catalog entry -> reject generation entirely, list problems
      logger.error("passport_generation_rejected", {
        merchant_id: loaded.merchant_id,
        sku: entry.id,
        reason_code: v.reason_code,
        ...v.detail,
      });
      rejected.push({ sku: entry.id, reason_code: v.reason_code, ...v.detail });
    }
  }

  // Two entries sharing an id would make every price lookup by item_id ambiguous, and
  // the passport would attest both prices at once.
  const seen = new Set();
  for (const entry of catalog) {
    const id = entry && typeof entry.id === "string" ? entry.id : null;
    if (id === null) continue;
    if (seen.has(id)) rejected.push({ sku: id, reason_code: "duplicate_sku_ids", rule: "catalog ids must be unique" });
    seen.add(id);
  }

  if (rejected.length > 0) {
    return { ok: false, errors: rejected };
  }

  const payload = {
    merchant_id: loaded.merchant_id,
    // Which version of the merchant's catalog this passport attests. Inside the payload,
    // so it is covered by the signature: a passport that could be re-pointed at a
    // different version after signing would attest nothing in particular.
    catalog_version: loaded.version,
    catalog: catalog.map((e) => ({
      ...e,
      // A merchant's own "not for sale" is honoured, and stock still has the final say.
      // EDGE CASE: stock = 0 still listed, but marked unavailable
      available: (e.available === undefined ? true : e.available === true) && e.stock > 0,
    })),
  };
  const generated_at = new Date().toISOString();
  const manifest = {
    passport_version: PASSPORT_VERSION,
    generated_at,
    payload,
    signature_algorithm: SIGNATURE_ALGORITHM,
    signature: null,
  };
  try {
    manifest.signature = signPayload(signedView(manifest));
  } catch (err) {
    logger.error("passport_signing_failed", { reason: err.message, decision: "no unsigned passport is issued" });
    return { ok: false, errors: [{ reason_code: "signing_key_missing", reason: err.message }] };
  }
  logger.info("passport_generated", {
    merchant_id: payload.merchant_id,
    catalog_version: payload.catalog_version,
    skus: payload.catalog.map((c) => c.id),
    unavailable_skus: payload.catalog.filter((c) => !c.available).map((c) => c.id),
  });
  return { ok: true, manifest, merchant_id: payload.merchant_id, catalog_version: payload.catalog_version };
}

/**
 * GUARDRAIL: verification returns a verdict on every path and never throws. A throw
 * here reaches the dashboard as a bare 500, which reads as "the server is broken"
 * rather than "this passport does not verify" — the opposite of the signal a trust
 * rail exists to give.
 *
 * Note what verification does NOT do: it never reads the catalog on disk. The manifest
 * carries everything the signature covers, so a passport signed over version 1 still
 * verifies after version 2 is ingested. Checking against the current catalog instead
 * would make every re-upload retroactively invalidate history, which is the opposite of
 * an audit trail.
 */
function verifyPassport(manifest) {
  if (!manifest || typeof manifest !== "object") {
    return { valid: false, reason_code: "malformed_manifest", reason: "passport is not an object" };
  }
  const { passport_version, generated_at, payload, signature, signature_algorithm } = manifest;
  if (!payload || !signature || !generated_at || !passport_version) {
    return { valid: false, reason_code: "missing_manifest_fields", reason: "passport is missing version, timestamp, payload or signature" };
  }
  if (signature_algorithm !== SIGNATURE_ALGORITHM) {
    // Either the field was rewritten or the passport was signed under another scheme.
    // Neither is verifiable here, and both are refusals rather than errors.
    return {
      valid: false,
      reason_code: "unsupported_signature_algorithm",
      reason: `passport declares signature_algorithm "${signature_algorithm}", but this rail only verifies "${SIGNATURE_ALGORITHM}"`,
    };
  }

  let expected;
  try {
    expected = signPayload(signedView(manifest));
  } catch (err) {
    return { valid: false, reason_code: "signing_key_missing", reason: err.message };
  }

  // Compared as bytes and in constant time; see constantTimeEqual.
  if (constantTimeEqual(expected, signature)) {
    return { valid: true, reason_code: "signature_valid", reason: "signature matches the canonical form of every signed field" };
  }

  // Distinguish a passport signed before signature_algorithm was brought inside the
  // signed set from one that was actually altered. Both are refused — an old-scheme
  // signature proves nothing about the algorithm field — but calling a stale file
  // tampered would be an accusation the evidence does not support.
  let legacy = null;
  try {
    legacy = signPayload({ passport_version, generated_at, payload });
  } catch {
    legacy = null;
  }
  if (legacy !== null && constantTimeEqual(legacy, signature)) {
    return {
      valid: false,
      reason_code: "signature_scheme_outdated",
      reason:
        "signature matches an earlier scheme that did not cover signature_algorithm, so the algorithm field cannot be trusted; regenerate the passport",
    };
  }

  return {
    valid: false,
    reason_code: "signature_mismatch",
    reason: "signature does not match the signed fields; the passport was altered after signing",
  };
}

// CATALOG is deliberately NOT exported any more. It used to be, and the transaction
// route priced items off it — which meant every merchant was priced from one shared
// in-memory constant no matter whose catalog they had uploaded. Pricing now goes through
// src/catalog/store.js findProduct(merchant_id, ...). Leaving the export in place would
// leave that regression one autocomplete away.
module.exports = {
  generatePassport,
  verifyPassport,
  validateCatalogEntry,
  canonicalize,
  SIGNATURE_ALGORITHM,
  DEFAULT_MERCHANT_ID,
};
