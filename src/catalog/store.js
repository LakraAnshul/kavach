/**
 * Per-merchant catalog store: sanitized paths, versioned files, and the demo merchant's
 * migration into that structure.
 *
 * Layout under KAVACH_DATA_DIR:
 *
 *   merchants/<merchant_id>/catalog_v1.json      the ingested catalog, one file per version
 *   merchants/<merchant_id>/catalog_v2.json      a re-upload never overwrites v1
 *   merchants/<merchant_id>/meta.json            {current_version, ...} — the pointer
 *   merchants/<merchant_id>/passport.json        most recent signed manifest (written by the route)
 *
 * Versions are kept rather than replaced because a passport is only as good as the data
 * it was signed over. If a re-upload overwrote catalog.json, every passport signed
 * against the old catalog would still verify — the signature covers the manifest, not
 * the file — but nobody could show WHAT was signed any more. Keeping the version the
 * manifest names makes an old passport auditable instead of merely valid.
 */
const fs = require("fs");
const path = require("path");
const { config } = require("../config");
const logger = require("../logger");

const MERCHANTS_DIR = path.join(config.dataDir, "merchants");

/**
 * GUARDRAIL: merchant_id becomes a directory name, so it is the one piece of caller
 * input on this rail that reaches the filesystem as a path segment. It is validated
 * against an allowlist — alphanumerics, hyphen, underscore, first character
 * alphanumeric — rather than by stripping bad characters out. Stripping is how
 * "..%2f.." becomes ".." after one pass of the wrong cleaner; an allowlist has no such
 * failure mode, because anything not explicitly permitted is refused outright.
 *
 * The 64-character cap is not cosmetic: this repository lives under a long OneDrive
 * path, and an unbounded segment plus a filename is how a write starts failing at
 * Windows' path limit instead of at a validation boundary.
 */
const MERCHANT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

const DEMO_MERCHANT_ID = "kavach-demo-merchant-001";

/**
 * The demo merchant's catalog, migrated out of src/passport/generator.js where it was a
 * hardcoded constant. It is seed data now, written to disk once and read from disk
 * afterwards, so the demo merchant travels the exact same code path as a merchant who
 * uploaded a CSV five seconds ago. Values are unchanged from the constant it replaces —
 * `available` matches what the generator used to derive (stock > 0) — so the migrated
 * demo passport carries the same catalog it always did.
 */
const DEMO_CATALOG = [
  {
    id: "sku-mech-keyboard",
    name: "Mechanical Keyboard K1",
    price_paise: 349900,
    stock: 12,
    category: "electronics",
    return_policy: "7-day return, unused, original packaging",
    refund_terms: "Full refund to source within 5 business days of pickup",
    available: true,
  },
  {
    id: "sku-usbc-cable",
    name: "USB-C Cable 2m Braided",
    price_paise: 49900,
    stock: 0,
    category: "accessories",
    return_policy: "15-day replacement only",
    refund_terms: "Refund issued only if replacement stock unavailable",
    available: false,
  },
  {
    id: "sku-desk-lamp",
    name: "LED Desk Lamp Pro",
    price_paise: 189500,
    stock: 30,
    category: "home",
    return_policy: "10-day return, restocking fee 5%",
    refund_terms: "Refund minus restocking fee within 7 business days",
    available: true,
  },
];

function sanitizeMerchantId(raw) {
  if (typeof raw !== "string") {
    return { ok: false, reason: "merchant_id must be a string" };
  }
  const id = raw.trim();
  if (id.length === 0) {
    return { ok: false, reason: "merchant_id must not be empty" };
  }
  // Named explicitly rather than left to the pattern below. The pattern already refuses
  // all of these, but a caller who is told "contains a path separator" understands the
  // refusal, and a future edit that loosens the pattern still trips this check.
  for (const forbidden of ["..", "/", "\\", ":", "\0", "%"]) {
    if (id.includes(forbidden)) {
      return {
        ok: false,
        reason: `merchant_id must not contain "${forbidden === "\0" ? "\\0" : forbidden}"; it is used as a directory name`,
      };
    }
  }
  if (!MERCHANT_ID_PATTERN.test(id)) {
    return {
      ok: false,
      reason:
        "merchant_id may contain only letters, digits, hyphens and underscores, must start with a letter or digit, and must be at most 64 characters",
    };
  }
  return { ok: true, merchant_id: id };
}

/**
 * Resolve a merchant's directory and prove it stays inside the merchants root.
 *
 * The containment check is deliberately redundant with sanitizeMerchantId. That is the
 * point: the guarantee "no write ever leaves data/merchants/" is then a property of the
 * path itself, verified immediately before use, rather than a property of a regex
 * somewhere else in the file. Only one of the two has to hold for the rail to be safe.
 */
function resolveMerchantDir(merchant_id) {
  const safe = sanitizeMerchantId(merchant_id);
  if (!safe.ok) throw new Error(`unsafe merchant_id rejected before any filesystem access: ${safe.reason}`);
  const root = path.resolve(MERCHANTS_DIR);
  const dir = path.resolve(root, safe.merchant_id);
  if (dir !== path.join(root, safe.merchant_id) || !dir.startsWith(root + path.sep)) {
    throw new Error("resolved merchant path escaped the merchants directory; refusing");
  }
  return dir;
}

function catalogFileName(version) {
  return `catalog_v${version}.json`;
}

function metaPath(merchant_id) {
  return path.join(resolveMerchantDir(merchant_id), "meta.json");
}

function catalogPath(merchant_id, version) {
  return path.join(resolveMerchantDir(merchant_id), catalogFileName(version));
}

function passportPath(merchant_id) {
  return path.join(resolveMerchantDir(merchant_id), "passport.json");
}

function readJson(filePath) {
  const raw = fs.readFileSync(filePath, "utf8");
  return JSON.parse(raw);
}

/**
 * Write via a temp file and a rename, so a reader never sees a half-written catalog.
 * Same reasoning as the mandate store's writes; a torn catalog file would be a signed
 * passport's source of truth going missing mid-read.
 */
function writeJsonAtomic(filePath, value) {
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, filePath);
}

/** Version numbers actually present on disk, ascending. */
function listVersions(merchant_id) {
  let entries;
  try {
    entries = fs.readdirSync(resolveMerchantDir(merchant_id));
  } catch {
    return [];
  }
  return entries
    .map((name) => /^catalog_v(\d+)\.json$/.exec(name))
    .filter(Boolean)
    .map((m) => parseInt(m[1], 10))
    .filter((n) => Number.isSafeInteger(n) && n > 0)
    .sort((a, b) => a - b);
}

/**
 * The demo merchant is seeded on first read rather than by a migration script that
 * somebody has to remember to run.
 *
 * This is what keeps every existing suite green: each one points KAVACH_DATA_DIR at its
 * own empty directory, so a demo catalog committed to data/merchants/ would not exist
 * for them. Seeding on read means an isolated test directory, a fresh clone, and the
 * live demo all get the same catalog the hardcoded constant used to provide.
 *
 * Idempotent, and never throws into a read path: a seed that cannot be written is
 * logged and the read proceeds to report "no catalog", which is the truth.
 */
function ensureSeeded(merchant_id) {
  if (merchant_id !== DEMO_MERCHANT_ID) return;
  try {
    const dir = resolveMerchantDir(DEMO_MERCHANT_ID);
    if (fs.existsSync(path.join(dir, "meta.json"))) return;
    if (listVersions(DEMO_MERCHANT_ID).length > 0) return;
    fs.mkdirSync(dir, { recursive: true });
    const now = new Date().toISOString();
    writeJsonAtomic(path.join(dir, catalogFileName(1)), DEMO_CATALOG);
    writeJsonAtomic(path.join(dir, "meta.json"), {
      merchant_id: DEMO_MERCHANT_ID,
      current_version: 1,
      product_count: DEMO_CATALOG.length,
      created_at: now,
      updated_at: now,
      source: "seed:migrated_from_hardcoded_catalog",
    });
    logger.info("demo_merchant_seeded", {
      merchant_id: DEMO_MERCHANT_ID,
      version: 1,
      product_count: DEMO_CATALOG.length,
      dir,
    });
  } catch (err) {
    logger.error("demo_merchant_seed_failed", { reason: err.message, decision: "read continues; catalog will report as absent" });
  }
}

/**
 * The version pointer.
 *
 * EDGE CASE: meta.json missing or corrupt while catalog files exist. Reporting "no
 * catalog" there would hide a merchant's entire history behind one unreadable pointer
 * file, and rewriting it blindly could point at the wrong version. So the highest
 * version present on disk is used as the fallback, and the recovery is logged rather
 * than performed silently.
 */
function readMeta(merchant_id) {
  const safe = sanitizeMerchantId(merchant_id);
  if (!safe.ok) return null;
  ensureSeeded(safe.merchant_id);

  const versions = listVersions(safe.merchant_id);
  let meta = null;
  try {
    meta = readJson(metaPath(safe.merchant_id));
  } catch (err) {
    if (err.code !== "ENOENT") {
      logger.error("merchant_meta_unreadable", {
        merchant_id: safe.merchant_id,
        reason: err.message,
        decision: versions.length > 0 ? "falling back to the highest catalog version on disk" : "treated as no catalog",
      });
    }
  }

  const pointer = meta && Number.isSafeInteger(meta.current_version) ? meta.current_version : null;
  // A pointer at a version whose file is gone is worse than no pointer: it would make
  // every price lookup fail while claiming a catalog exists.
  const current_version = pointer !== null && versions.includes(pointer) ? pointer : versions.length > 0 ? versions[versions.length - 1] : null;
  if (current_version === null) return null;
  if (pointer !== current_version) {
    logger.warn("merchant_meta_pointer_recovered", {
      merchant_id: safe.merchant_id,
      recorded_pointer: pointer,
      using_version: current_version,
      versions_on_disk: versions,
    });
  }

  return {
    merchant_id: safe.merchant_id,
    current_version,
    versions,
    product_count: Number.isSafeInteger(meta && meta.product_count) ? meta.product_count : null,
    created_at: (meta && meta.created_at) || null,
    updated_at: (meta && meta.updated_at) || null,
    source: (meta && meta.source) || null,
  };
}

/**
 * Read one merchant's catalog. Defaults to the current version; an explicit version is
 * honoured so an old passport can be checked against the data it was actually signed
 * over.
 */
function readCatalog(merchant_id, { version } = {}) {
  const safe = sanitizeMerchantId(merchant_id);
  if (!safe.ok) return { ok: false, reason_code: "invalid_merchant_id", reason: safe.reason };

  const meta = readMeta(safe.merchant_id);
  if (!meta) {
    return {
      ok: false,
      reason_code: "merchant_not_found",
      reason: `no catalog has been ingested for merchant "${safe.merchant_id}"`,
    };
  }

  let wanted = meta.current_version;
  if (version !== undefined && version !== null) {
    const asInt = typeof version === "string" ? (/^\d+$/.test(version.trim()) ? parseInt(version.trim(), 10) : NaN) : version;
    if (!Number.isSafeInteger(asInt) || asInt <= 0) {
      return { ok: false, reason_code: "invalid_version", reason: `version must be a positive integer, received ${JSON.stringify(version)}` };
    }
    if (!meta.versions.includes(asInt)) {
      return {
        ok: false,
        reason_code: "version_not_found",
        reason: `merchant "${safe.merchant_id}" has no catalog version ${asInt}; versions on record: ${meta.versions.join(", ")}`,
      };
    }
    wanted = asInt;
  }

  let products;
  try {
    products = readJson(catalogPath(safe.merchant_id, wanted));
  } catch (err) {
    logger.error("merchant_catalog_unreadable", { merchant_id: safe.merchant_id, version: wanted, reason: err.message });
    return {
      ok: false,
      reason_code: "catalog_unreadable",
      reason: `catalog version ${wanted} for "${safe.merchant_id}" could not be read: ${err.message}`,
    };
  }
  if (!Array.isArray(products)) {
    return {
      ok: false,
      reason_code: "catalog_unreadable",
      reason: `catalog version ${wanted} for "${safe.merchant_id}" is not a JSON array`,
    };
  }

  return { ok: true, merchant_id: safe.merchant_id, version: wanted, products, is_current: wanted === meta.current_version };
}

/**
 * Writes are serialized through one chain, for the same reason the mandate store
 * serializes its own: the next version number is derived from what is on disk, so two
 * uploads for the same merchant arriving together could both read "current is 1" and
 * both decide to write v2 — one of them silently losing. The chain makes
 * read-then-write indivisible.
 */
let writeChain = Promise.resolve();

/**
 * Persist a validated catalog as a NEW version.
 *
 * GUARDRAIL: this function does not validate. It must only ever be handed products that
 * src/catalog/validate.js has already accepted — the route enforces that, and keeping
 * validation out of here means there is no path where "write" can also mean "decide
 * whether it was any good".
 *
 * Write order matters: the version file lands first, the pointer second. A crash
 * between the two leaves the previous version still current and the new file orphaned,
 * which is recoverable and harms nothing. The reverse order would point at a file that
 * does not exist yet.
 */
function writeCatalogVersion(merchant_id, products, { source = "upload" } = {}) {
  const safe = sanitizeMerchantId(merchant_id);
  if (!safe.ok) return Promise.reject(new Error(safe.reason));

  const step = writeChain.then(() => {
    const dir = resolveMerchantDir(safe.merchant_id);
    fs.mkdirSync(dir, { recursive: true });

    const existing = listVersions(safe.merchant_id);
    const recorded = readMeta(safe.merchant_id);
    // max of both, so a stale or recovered pointer can never cause an existing version
    // file to be overwritten.
    const highest = Math.max(existing.length > 0 ? existing[existing.length - 1] : 0, recorded ? recorded.current_version : 0);
    const version = highest + 1;
    const now = new Date().toISOString();

    writeJsonAtomic(catalogPath(safe.merchant_id, version), products);
    writeJsonAtomic(metaPath(safe.merchant_id), {
      merchant_id: safe.merchant_id,
      current_version: version,
      product_count: products.length,
      created_at: (recorded && recorded.created_at) || now,
      updated_at: now,
      source,
    });

    logger.info("catalog_version_written", {
      merchant_id: safe.merchant_id,
      version,
      product_count: products.length,
      replaced_version: highest || null,
      source,
    });

    return { merchant_id: safe.merchant_id, version, product_count: products.length, previous_version: highest || null };
  });

  // The chain itself must never carry a rejection forward, or one failed upload would
  // stall every later one for the life of the process.
  writeChain = step.then(
    () => {},
    () => {}
  );
  return step;
}

/**
 * Every merchant with a catalog, for the dashboard's "which merchants exist" view.
 * Read-only and never throws: a single unreadable directory is skipped and logged
 * rather than failing the whole listing.
 */
function listMerchants() {
  ensureSeeded(DEMO_MERCHANT_ID);
  let names;
  try {
    names = fs.readdirSync(MERCHANTS_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch (err) {
    if (err.code !== "ENOENT") logger.error("merchants_dir_unreadable", { reason: err.message });
    return [];
  }

  const merchants = [];
  for (const name of names) {
    // A directory whose name is not a legal merchant_id cannot have been created through
    // ingestion. Listing it would advertise something no route can address.
    if (!sanitizeMerchantId(name).ok) continue;
    let meta;
    try {
      meta = readMeta(name);
    } catch (err) {
      logger.error("merchant_meta_listing_failed", { merchant_id: name, reason: err.message });
      continue;
    }
    if (!meta) continue;
    // product_count is read back from the catalog when the pointer had to be recovered,
    // so the number shown always matches the file that would actually price a purchase.
    let product_count = meta.product_count;
    if (product_count === null) {
      const cat = readCatalog(name);
      product_count = cat.ok ? cat.products.length : null;
    }
    merchants.push({
      merchant_id: meta.merchant_id,
      product_count,
      current_version: meta.current_version,
      versions: meta.versions,
      last_updated: meta.updated_at,
      created_at: meta.created_at,
      source: meta.source,
    });
  }
  return merchants.sort((a, b) => a.merchant_id.localeCompare(b.merchant_id));
}

/**
 * Look one product up in a merchant's stored catalog. This is the pricing lookup: the
 * transaction path uses it instead of an in-memory constant, so Merchant A and Merchant
 * B price from their own ingested data and nothing shared sits between them.
 */
function findProduct(merchant_id, product_id, { version } = {}) {
  const catalog = readCatalog(merchant_id, { version });
  if (!catalog.ok) return catalog;
  const product = catalog.products.find((p) => p && p.id === product_id);
  if (!product) {
    return {
      ok: false,
      reason_code: "product_not_found",
      reason: `product "${product_id}" is not in merchant "${catalog.merchant_id}" catalog version ${catalog.version}`,
      merchant_id: catalog.merchant_id,
      version: catalog.version,
    };
  }
  return { ok: true, merchant_id: catalog.merchant_id, version: catalog.version, product };
}

module.exports = {
  sanitizeMerchantId,
  resolveMerchantDir,
  readMeta,
  readCatalog,
  writeCatalogVersion,
  listMerchants,
  listVersions,
  findProduct,
  passportPath,
  catalogPath,
  metaPath,
  ensureSeeded,
  MERCHANTS_DIR,
  DEMO_MERCHANT_ID,
  DEMO_CATALOG,
};
