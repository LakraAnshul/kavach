/**
 * Catalog validation. Pure functions, no I/O, no filesystem, no Express.
 *
 * One validator serves both ingestion paths. A JSON upload and a CSV upload are
 * normalized into the same shape first and then judged by the same rules, because two
 * validators drift: the CSV path would eventually accept a price the JSON path refused,
 * and the passport would then be signed over a catalog nothing had checked properly.
 *
 * Normalization before validation is what makes "identical rules" possible at all. CSV
 * has no types — every cell arrives as a string — so `price_paise` reaches us as
 * "349900" and `available` as "TRUE". Coercing first and then applying one rule set is
 * the only way the two paths can be held to the same bar. The coercion is deliberately
 * narrow: "349900" becomes 349900, but "349.9" is refused rather than rounded, and
 * "maybe" is refused rather than treated as false.
 */

// The full field set a merchant must supply per product. `available` is required on
// input even though the passport re-derives it against stock, because a merchant
// stating "this is not for sale" is information the catalog cannot reconstruct from
// stock alone.
const REQUIRED_PRODUCT_FIELDS = [
  "id",
  "name",
  "price_paise",
  "stock",
  "category",
  "return_policy",
  "refund_terms",
  "available",
];

const STRING_FIELDS = ["id", "name", "category", "return_policy", "refund_terms"];

// Demo-scale, stated as a number rather than left implicit. Ingestion holds the whole
// catalog in memory, signs it as one canonical string and writes it as one file, so a
// bulk feed is a different design rather than a bigger number here.
const MAX_PRODUCTS = 500;

// A response that listed 4000 problems would be unreadable and would dwarf the request
// that caused it. Report a usable prefix and say plainly how many were left out —
// silently truncating would read as "these are all the problems", which is worse.
const MAX_REPORTED_PROBLEMS = 50;

/**
 * Integer coercion that refuses anything that is not exactly a whole number.
 *
 * GUARDRAIL: all money on this rail is integer paise. parseInt("349.9") returns 349 and
 * Number("349.9") returns 349.9 — the first silently discards the merchant's stated
 * price, the second introduces a float into the money path. Both are refusals here.
 * The regex is the check; parseInt only runs on input that already matched it.
 */
function toInteger(value) {
  if (typeof value === "number") {
    return Number.isInteger(value) ? { ok: true, value } : { ok: false };
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    // Anchored, digits only, optional sign. "349.9", "3e5", "1,000", "" and " " all fail.
    if (!/^[+-]?\d+$/.test(trimmed)) return { ok: false };
    const n = Number(trimmed);
    // A 20-digit string parses to a number that is no longer distinguishable from its
    // neighbours, which is the same reason the mandate engine insists on safe integers.
    return Number.isSafeInteger(n) ? { ok: true, value: n } : { ok: false };
  }
  return { ok: false };
}

/**
 * EDGE CASE: `available` arrives from CSV as a string — "true", "TRUE", "1", "0" — and
 * from JSON as a real boolean. Both become a real boolean here.
 *
 * Note what is NOT done: there is no truthiness fallback. `Boolean("false")` is true,
 * so a permissive coercion would mark every out-of-sale product as available and the
 * signed passport would advertise stock the merchant said not to sell. An unrecognised
 * value is a validation failure, not a guess.
 */
function toBoolean(value) {
  if (typeof value === "boolean") return { ok: true, value };
  if (typeof value === "number") {
    if (value === 1) return { ok: true, value: true };
    if (value === 0) return { ok: true, value: false };
    return { ok: false };
  }
  if (typeof value === "string") {
    const v = value.trim().toLowerCase();
    if (["true", "1", "yes", "y"].includes(v)) return { ok: true, value: true };
    if (["false", "0", "no", "n"].includes(v)) return { ok: true, value: false };
    return { ok: false };
  }
  return { ok: false };
}

function isMissing(value) {
  return value === undefined || value === null || (typeof value === "string" && value.trim().length === 0);
}

function problem(index, product_id, field, rule, received) {
  return { index, product_id, field, rule, received };
}

/**
 * Validate and normalize one product. Returns the normalized product on success, or
 * every problem found with it — all of them, not just the first, so a merchant fixing
 * a CSV sees the whole list in one round trip.
 */
function validateProduct(raw, index) {
  const problems = [];
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, problems: [problem(index, null, null, "product must be a JSON object", typeof raw)] };
  }

  // Reported alongside every other problem for this product so the message can say
  // WHICH product was wrong, even when the broken field is the id itself.
  const label = typeof raw.id === "string" && raw.id.trim().length > 0 ? raw.id.trim() : null;

  const missing = REQUIRED_PRODUCT_FIELDS.filter((f) => isMissing(raw[f]));
  for (const field of missing) {
    problems.push(problem(index, label, field, "required field is missing or empty", raw[field] ?? null));
  }

  const product = {};

  for (const field of STRING_FIELDS) {
    if (missing.includes(field)) continue;
    if (typeof raw[field] !== "string" && typeof raw[field] !== "number") {
      problems.push(problem(index, label, field, "must be a non-empty string", typeof raw[field]));
      continue;
    }
    const text = String(raw[field]).trim();
    if (text.length === 0) {
      problems.push(problem(index, label, field, "must be a non-empty string", raw[field]));
      continue;
    }
    product[field] = text;
  }

  if (!missing.includes("price_paise")) {
    const price = toInteger(raw.price_paise);
    if (!price.ok || price.value <= 0) {
      problems.push(
        problem(
          index,
          label,
          "price_paise",
          "must be a positive whole number of paise (no decimals, no zero, no negatives)",
          raw.price_paise
        )
      );
    } else {
      product.price_paise = price.value;
    }
  }

  if (!missing.includes("stock")) {
    const stock = toInteger(raw.stock);
    if (!stock.ok || stock.value < 0) {
      problems.push(problem(index, label, "stock", "must be a whole number of units, zero or above", raw.stock));
    } else {
      // EDGE CASE: stock 0 is valid input. It is listed and marked unavailable rather
      // than dropped, which is the behaviour the passport suite pins.
      product.stock = stock.value;
    }
  }

  if (!missing.includes("available")) {
    const available = toBoolean(raw.available);
    if (!available.ok) {
      problems.push(
        problem(index, label, "available", 'must be a boolean or one of "true"/"false"/"1"/"0"/"yes"/"no"', raw.available)
      );
    } else {
      product.available = available.value;
    }
  }

  if (problems.length > 0) return { ok: false, problems };
  // Rebuilt field by field from the normalized values above, so an unknown extra column
  // in a CSV — or an extra key in a JSON upload — never reaches the signed catalog.
  //
  // Emitted in REQUIRED_PRODUCT_FIELDS order rather than in the order the checks above
  // happened to run. Key order does not affect the signature (canonicalize sorts keys),
  // but the stored catalog is a file a human reads and diffs, and a stable field order
  // is what makes it readable.
  const ordered = {};
  for (const field of REQUIRED_PRODUCT_FIELDS) ordered[field] = product[field];
  return { ok: true, product: ordered };
}

/**
 * Validate a whole catalog.
 *
 * GUARDRAIL: all-or-nothing. The caller gets either a fully normalized catalog or a
 * list of problems and no catalog at all. There is no partial result to accidentally
 * write, which is what keeps "no partial ingestion" true at the file layer rather than
 * relying on the route to remember it.
 */
function validateCatalog(rawProducts) {
  if (!Array.isArray(rawProducts)) {
    return {
      ok: false,
      reason_code: "catalog_not_an_array",
      problems: [problem(null, null, null, "catalog must be an array of product objects", typeof rawProducts)],
    };
  }

  // EDGE CASE: zero products. An empty catalog would sign and verify perfectly while
  // promising nothing, so it is refused rather than accepted as a trivially valid one.
  if (rawProducts.length === 0) {
    return {
      ok: false,
      reason_code: "catalog_empty",
      problems: [problem(null, null, null, "catalog must contain at least 1 product", 0)],
    };
  }

  // EDGE CASE: oversized catalog. Checked before per-product work so a 50,000-row file
  // is refused on its shape instead of generating a problem list nobody can read.
  if (rawProducts.length > MAX_PRODUCTS) {
    return {
      ok: false,
      reason_code: "catalog_too_large",
      problems: [
        problem(
          null,
          null,
          null,
          `catalog holds ${rawProducts.length} products, above the ${MAX_PRODUCTS}-product limit; this is a demo-scale rail, not a bulk ingestion pipeline`,
          rawProducts.length
        ),
      ],
    };
  }

  const problems = [];
  const products = [];
  for (let i = 0; i < rawProducts.length; i++) {
    const result = validateProduct(rawProducts[i], i);
    if (result.ok) products.push(result.product);
    else problems.push(...result.problems);
  }

  // EDGE CASE: duplicate ids inside one upload. Checked on the normalized ids, and
  // reported by id rather than by position, because "sku-1 appears twice" is what the
  // merchant can act on. Two products sharing an id would make pricing by item_id
  // ambiguous, and a rail that priced ambiguously is worse than one that refused.
  const seen = new Map();
  const duplicated = new Set();
  for (const p of products) {
    if (seen.has(p.id)) duplicated.add(p.id);
    else seen.set(p.id, true);
  }
  if (duplicated.size > 0) {
    for (const id of duplicated) {
      const positions = products.map((p, i) => (p.id === id ? i : -1)).filter((i) => i >= 0);
      problems.push(problem(null, id, "id", `product id appears ${positions.length} times; ids must be unique within a catalog`, positions));
    }
  }

  if (problems.length > 0) {
    const reported = problems.slice(0, MAX_REPORTED_PROBLEMS);
    return {
      ok: false,
      reason_code: duplicated.size > 0 && problems.length === duplicated.size ? "duplicate_product_ids" : "product_fields_invalid",
      problems: reported,
      // Stated, never silent: the caller is told a list was shortened and by how much.
      problems_omitted: problems.length - reported.length,
      duplicate_ids: [...duplicated],
    };
  }

  return { ok: true, products };
}

module.exports = {
  validateCatalog,
  validateProduct,
  toInteger,
  toBoolean,
  REQUIRED_PRODUCT_FIELDS,
  MAX_PRODUCTS,
};
