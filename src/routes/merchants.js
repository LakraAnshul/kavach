/**
 * Merchant catalog ingestion.
 *
 *   POST /api/merchants/:merchant_id/catalog    ingest a catalog as a new version
 *   GET  /api/merchants                         which merchants have catalogs
 *   GET  /api/merchants/:merchant_id/catalog    read one version back
 *
 * The shape of this file follows the order the work has to happen in, and that order is
 * the actual guarantee: identify the merchant, decide what was uploaded, parse it,
 * validate ALL of it, and only then write. Nothing touches the filesystem until the
 * whole upload has been accepted, so a rejected upload cannot leave a merchant with half
 * a catalog — and every refusal is recorded before the response goes back.
 */
const express = require("express");
const path = require("path");
const multer = require("multer");
const logger = require("../logger");
const audit = require("../audit/log");
const store = require("../catalog/store");
const { validateCatalog, REQUIRED_PRODUCT_FIELDS, MAX_PRODUCTS } = require("../catalog/validate");
const { parseCsvCatalog } = require("../catalog/csv");

const MOUNT_PATH = "/api/merchants";

// 2 MB, and it is enforced in three places for three different callers: multer's
// fileSize for a multipart upload, body-parser's limit for a raw JSON body, and the
// product count in validate.js for a small file describing an enormous catalog.
const UPLOAD_LIMIT_BYTES = 2 * 1024 * 1024;

/**
 * GUARDRAIL: the extension allowlist is the authority on file type, not the declared
 * MIME type. A browser sends "application/vnd.ms-excel" for a .csv on Windows and curl
 * sends "application/octet-stream" for almost everything, so a MIME allowlist would
 * refuse the two most likely ways anyone actually uploads a catalog. The declared type
 * is still checked against the denylist below, and the bytes themselves are sniffed —
 * three cheap checks that disagree in different ways rather than one that can be lied to.
 */
const ALLOWED_EXTENSIONS = [".json", ".csv"];

// Types that are never a catalog no matter what the file is called. Deliberately narrow:
// octet-stream is absent because that is what curl sends for a perfectly good CSV.
const REFUSED_MIME_PREFIXES = ["image/", "audio/", "video/", "font/"];
const REFUSED_MIME_TYPES = [
  "application/pdf",
  "application/zip",
  "application/gzip",
  "application/x-tar",
  "application/x-msdownload",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
];

const upload = multer({
  // In memory, never to disk. A rejected upload should not leave a temp file behind, and
  // the 2 MB ceiling makes buffering bounded.
  storage: multer.memoryStorage(),
  limits: { fileSize: UPLOAD_LIMIT_BYTES, files: 1, fields: 20, parts: 30 },
});

/** Long strings from a caller end up in the audit trail; they do not get to be unbounded. */
function clip(value, max = 120) {
  const s = typeof value === "string" ? value : String(value === undefined || value === null ? "" : value);
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/**
 * The merchant id as it appeared in the URL, for logging ONLY.
 *
 * The body parsers are mounted at the app level (see the note in server.js about why
 * they run ahead of express.json), and at that point Express has not matched a route, so
 * req.params does not exist yet. A parser-level refusal still has to name the merchant it
 * refused. This value is never sanitized-and-used as a path — it is only ever written to
 * the trail, clipped.
 */
function merchantIdFromUrl(req) {
  const match = /^\/api\/merchants\/([^/?#]+)\/catalog/.exec(req.originalUrl || req.url || "");
  if (!match) return null;
  let raw = match[1];
  try {
    raw = decodeURIComponent(raw);
  } catch {
    // A malformed percent-escape is itself the reason the upload is being refused.
  }
  return clip(raw);
}

/**
 * Record an ingestion outcome and wait for it to reach disk.
 *
 * Additive: a new `action` value on the existing record shape. merchant_id, version and
 * product_count travel in `meta`, so nothing about the trail's schema changes — an older
 * reader sees an entry it does not have a special case for and falls through to the
 * generic rendering, rather than seeing a record with fields it cannot interpret.
 */
function recordIngestion({ merchant_id, result, reason_code, reason, meta = {} }) {
  audit.append({
    action: "catalog_ingested",
    result,
    reason_code,
    reason,
    meta: { merchant_id: merchant_id || null, ...meta },
  });
  // The response does not go back before the record is durable, for the same reason
  // every other decision on this rail waits: a decision nobody can look up later is not
  // auditable. See audit.flush.
  return audit.flush();
}

function ingestionError(res, status, code, message, detail = {}) {
  return res.status(status).json({
    error: {
      code,
      message,
      ...detail,
      // Stated on every refusal, because it is the fact the merchant actually needs: the
      // upload changed nothing, so whatever was live before still is.
      note: "No catalog version was written; the previously ingested catalog is unchanged.",
    },
  });
}

/**
 * Body parsers for the ingestion path.
 *
 * MOUNTED AHEAD OF THE GLOBAL express.json() IN server.js, and the ordering is load
 * bearing — the same trap the webhook raw parser documents, arrived at from the other
 * direction. The global parser has a 1 MB limit, so mounted first it would reject a
 * 1.5 MB catalog with "request body exceeds the 1mb limit" before this route ever ran,
 * and the 2 MB limit this endpoint advertises would be a fiction.
 *
 * The trailing arity-4 function is an error handler for this stack only: multer reports
 * an oversized file by calling next(err), so without it a 3 MB upload would reach the
 * app-level boundary as an error with no status and be reported as a 500 — the server
 * blaming itself for a limit it enforced correctly.
 */
const uploadParsers = [
  // Multer passes non-multipart requests straight through, so this is inert for a JSON
  // body and for every GET on this path.
  upload.any(),
  express.json({ limit: UPLOAD_LIMIT_BYTES }),
  function uploadParserErrors(err, req, res, next) {
    const merchant_id = merchantIdFromUrl(req);
    const tooLarge = (err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE") || err.type === "entity.too.large";

    if (tooLarge) {
      const reason = `upload exceeds the ${UPLOAD_LIMIT_BYTES / (1024 * 1024)}MB limit`;
      logger.warn("catalog_upload_too_large", { merchant_id, limit_bytes: UPLOAD_LIMIT_BYTES });
      return recordIngestion({ merchant_id, result: "fail", reason_code: "upload_too_large", reason, meta: { limit_bytes: UPLOAD_LIMIT_BYTES } })
        .then(() =>
          res.status(413).json({
            error: {
              code: "upload_too_large",
              message: `Catalog upload exceeds the ${UPLOAD_LIMIT_BYTES / (1024 * 1024)}MB limit. Split the catalog or reduce it to at most ${MAX_PRODUCTS} products.`,
              limit_bytes: UPLOAD_LIMIT_BYTES,
              note: "No catalog version was written; the previously ingested catalog is unchanged.",
            },
          })
        )
        .catch(next);
    }

    if (err instanceof multer.MulterError) {
      const message =
        err.code === "LIMIT_FILE_COUNT" || err.code === "LIMIT_UNEXPECTED_FILE"
          ? "Upload exactly one file per request. A catalog is replaced as a whole, so two files in one request would be ambiguous about which one is the catalog."
          : `Upload was rejected by the multipart parser: ${err.message}`;
      return recordIngestion({ merchant_id, result: "fail", reason_code: "upload_rejected", reason: clip(err.message), meta: { multer_code: err.code } })
        .then(() => ingestionError(res, 400, "upload_rejected", message, { multer_code: err.code }))
        .catch(next);
    }

    if (err && err.type === "entity.parse.failed") {
      // A JSON body that is not JSON. Refused as bad input with the parser's own
      // account of where it went wrong, never as a server fault, and never by crashing.
      return recordIngestion({ merchant_id, result: "fail", reason_code: "malformed_json", reason: clip(err.message) })
        .then(() =>
          ingestionError(res, 400, "malformed_json", "Request body is not valid JSON. Send an array of products, or upload a .json/.csv file as multipart form data.", {
            parse_error: clip(err.message),
          })
        )
        .catch(next);
    }

    return next(err);
  },
];

const router = express.Router();

/**
 * §7 — which merchants exist. Read-only, and it degrades rather than failing: an
 * unreadable merchant directory is skipped inside the store and the rest still list.
 */
router.get("/", (_req, res) => {
  try {
    const merchants = store.listMerchants();
    res.json({ count: merchants.length, merchants });
  } catch (err) {
    logger.error("merchant_list_failed", { reason: err.message });
    res.status(500).json({ error: { code: "internal", message: "failed to list merchants" } });
  }
});

// Status for a store-level refusal. An unknown merchant is a 404 because the caller
// named something that does not exist; a bad merchant_id or version is a 400 because the
// request itself is malformed. Collapsing both into one code would tell a caller with a
// typo in the id to go looking for a missing merchant.
const STORE_REASON_STATUS = {
  invalid_merchant_id: 400,
  invalid_version: 400,
  merchant_not_found: 404,
  version_not_found: 404,
  catalog_unreadable: 500,
};

/**
 * Read a catalog version back. `?version=N` returns that version, which is what makes
 * "v1 is still retrievable after v2 lands" checkable from outside the process rather
 * than only true on disk.
 */
router.get("/:merchant_id/catalog", (req, res) => {
  try {
    const result = store.readCatalog(req.params.merchant_id, { version: req.query.version });
    if (!result.ok) {
      const status = STORE_REASON_STATUS[result.reason_code] || 400;
      return res.status(status).json({ error: { code: result.reason_code, message: result.reason } });
    }
    const meta = store.readMeta(result.merchant_id);
    res.json({
      merchant_id: result.merchant_id,
      version: result.version,
      is_current: result.is_current,
      current_version: meta ? meta.current_version : result.version,
      versions: meta ? meta.versions : [result.version],
      product_count: result.products.length,
      products: result.products,
    });
  } catch (err) {
    logger.error("catalog_read_failed", { reason: err.message });
    res.status(500).json({ error: { code: "internal", message: "failed to read catalog" } });
  }
});

/**
 * §1–§5 — ingest a catalog.
 *
 * Accepts either a JSON body (an array of products) or a multipart upload of one .json
 * or .csv file. Both funnel into the same validator, and a re-upload always creates a
 * new version rather than merging into or overwriting the old one.
 */
router.post("/:merchant_id/catalog", async (req, res) => {
  const rawMerchantId = req.params.merchant_id;
  try {
    // GUARDRAIL: the merchant id is validated before anything else, because it is the
    // one field that becomes a path segment. Nothing below this line can be reached with
    // an id that has not been through the allowlist.
    const safe = store.sanitizeMerchantId(rawMerchantId);
    if (!safe.ok) {
      logger.warn("catalog_ingest_rejected", { merchant_id: clip(rawMerchantId), reason_code: "invalid_merchant_id", reason: safe.reason });
      await recordIngestion({
        merchant_id: clip(rawMerchantId),
        result: "fail",
        reason_code: "invalid_merchant_id",
        reason: safe.reason,
        meta: { security_event: true, submitted_merchant_id: clip(rawMerchantId) },
      });
      return ingestionError(res, 400, "invalid_merchant_id", `Rejected merchant_id: ${safe.reason}`, { received: clip(rawMerchantId) });
    }
    const merchant_id = safe.merchant_id;

    const fail = (status, reason_code, message, detail = {}, meta = {}) =>
      recordIngestion({ merchant_id, result: "fail", reason_code, reason: clip(message, 300), meta }).then(() =>
        ingestionError(res, status, reason_code, message, detail)
      );

    // ---- decide what was actually uploaded ----
    const files = Array.isArray(req.files) ? req.files : [];
    let rawProducts;
    let format;
    let ignored_columns = [];

    if (files.length > 0) {
      const file = files[0];
      const filename = typeof file.originalname === "string" ? file.originalname : "";
      const ext = path.extname(filename).toLowerCase();
      const declaredType = String(file.mimetype || "").toLowerCase();

      // GUARDRAIL: file type is decided BEFORE any attempt to parse the bytes.
      if (!ALLOWED_EXTENSIONS.includes(ext)) {
        return fail(
          400,
          "unsupported_file_type",
          `Only ${ALLOWED_EXTENSIONS.join(" and ")} files can be ingested; "${clip(filename, 80)}" has extension "${ext || "(none)"}".`,
          { filename: clip(filename, 80), extension: ext || null, allowed_extensions: ALLOWED_EXTENSIONS },
          { filename: clip(filename, 80), extension: ext || null, declared_mime: declaredType || null }
        );
      }
      if (REFUSED_MIME_PREFIXES.some((p) => declaredType.startsWith(p)) || REFUSED_MIME_TYPES.includes(declaredType)) {
        return fail(
          400,
          "unsupported_file_type",
          `File "${clip(filename, 80)}" is declared as "${declaredType}", which is not a catalog. Upload a JSON array or a CSV with a header row.`,
          { filename: clip(filename, 80), declared_mime: declaredType },
          { filename: clip(filename, 80), declared_mime: declaredType }
        );
      }

      const buffer = Buffer.isBuffer(file.buffer) ? file.buffer : Buffer.alloc(0);
      if (buffer.length === 0) {
        return fail(400, "empty_upload", `File "${clip(filename, 80)}" is empty.`, { filename: clip(filename, 80) }, { filename: clip(filename, 80) });
      }
      // EDGE CASE: a renamed binary — evil.png saved as catalog.csv — passes the
      // extension check by construction. NUL bytes are not legal in a UTF-8 text file, so
      // this catches it before a parser is handed the bytes. It also catches a UTF-16
      // spreadsheet export, which is why the message names both possibilities instead of
      // accusing the merchant of uploading an image.
      if (buffer.subarray(0, 8192).includes(0)) {
        return fail(
          400,
          "unsupported_file_type",
          `File "${clip(filename, 80)}" contains NUL bytes, so it is not UTF-8 text. If this is a spreadsheet export, re-save it as UTF-8 CSV.`,
          { filename: clip(filename, 80) },
          { filename: clip(filename, 80), declared_mime: declaredType || null }
        );
      }

      const text = buffer.toString("utf8");
      if (ext === ".csv") {
        format = "csv";
        const parsed = parseCsvCatalog(text);
        if (!parsed.ok) {
          return fail(
            400,
            parsed.reason_code,
            parsed.message,
            { filename: clip(filename, 80), ...(parsed.detail || {}), expected_columns: REQUIRED_PRODUCT_FIELDS },
            { filename: clip(filename, 80), format: "csv" }
          );
        }
        rawProducts = parsed.rows;
        ignored_columns = parsed.ignored_columns;
      } else {
        format = "json_file";
        try {
          rawProducts = JSON.parse(text);
        } catch (err) {
          return fail(
            400,
            "malformed_json",
            `File "${clip(filename, 80)}" is not valid JSON: ${clip(err.message, 160)}`,
            { filename: clip(filename, 80) },
            { filename: clip(filename, 80), format: "json_file" }
          );
        }
      }
    } else {
      format = "json_body";
      const body = req.body;
      // A bare array is the documented shape. {products:[...]} and {catalog:[...]} are
      // accepted too — they are what people send, and refusing them would be pedantry
      // rather than a safety property.
      if (Array.isArray(body)) rawProducts = body;
      else if (body && Array.isArray(body.products)) rawProducts = body.products;
      else if (body && Array.isArray(body.catalog)) rawProducts = body.catalog;
      else {
        return fail(
          400,
          "no_catalog_supplied",
          "No catalog found in the request. Send a JSON array of products as the body, or upload one .json or .csv file as multipart form data.",
          { required_fields: REQUIRED_PRODUCT_FIELDS, max_products: MAX_PRODUCTS }
        );
      }
    }

    // ---- validate everything, before touching the filesystem ----
    const validated = validateCatalog(rawProducts);
    if (!validated.ok) {
      logger.warn("catalog_ingest_rejected", {
        merchant_id,
        format,
        reason_code: validated.reason_code,
        problem_count: (validated.problems || []).length + (validated.problems_omitted || 0),
      });
      return fail(
        400,
        validated.reason_code,
        validated.reason_code === "duplicate_product_ids"
          ? `Catalog rejected: duplicate product ids (${(validated.duplicate_ids || []).join(", ")}). Ids must be unique within a catalog.`
          : "Catalog rejected: one or more products failed validation. Nothing was ingested — fix the listed problems and upload again.",
        {
          reason_code: validated.reason_code,
          problems: validated.problems,
          problems_omitted: validated.problems_omitted || 0,
          duplicate_ids: validated.duplicate_ids || [],
          required_fields: REQUIRED_PRODUCT_FIELDS,
          max_products: MAX_PRODUCTS,
        },
        {
          format,
          problem_count: (validated.problems || []).length + (validated.problems_omitted || 0),
          duplicate_ids: validated.duplicate_ids || [],
        }
      );
    }

    // ---- accepted: write a new version ----
    let written;
    try {
      written = await store.writeCatalogVersion(merchant_id, validated.products, { source: format });
    } catch (err) {
      logger.error("catalog_write_failed", { merchant_id, reason: err.message });
      await recordIngestion({
        merchant_id,
        result: "fail",
        reason_code: "catalog_write_failed",
        reason: clip(err.message, 300),
        meta: { format, product_count: validated.products.length },
      });
      // The catalog was valid; persisting it failed. Saying which one it was matters,
      // because "your catalog is invalid" would send the merchant to fix a correct file.
      return res.status(500).json({
        error: {
          code: "catalog_not_saved",
          message: `Catalog passed validation but could not be written: ${err.message}`,
          note: "No new version was created; the previously ingested catalog is unchanged.",
        },
      });
    }

    await recordIngestion({
      merchant_id,
      result: "pass",
      reason_code: "catalog_accepted",
      reason: `catalog ingested: ${written.product_count} products stored as version ${written.version} from ${format}`,
      meta: {
        version: written.version,
        previous_version: written.previous_version,
        product_count: written.product_count,
        format,
        ignored_columns,
      },
    });

    logger.info("catalog_ingested", {
      merchant_id,
      version: written.version,
      product_count: written.product_count,
      format,
      ignored_columns,
    });

    res.status(201).json({
      merchant_id,
      version: written.version,
      previous_version: written.previous_version,
      product_count: written.product_count,
      format,
      // Named so a merchant whose export carried extra columns can see they were dropped
      // rather than wondering whether they were silently used.
      ignored_columns,
      stored_as: `merchants/${merchant_id}/catalog_v${written.version}.json`,
      replaced:
        written.previous_version === null
          ? "this is the first catalog for this merchant"
          : `version ${written.previous_version} is retained and still readable; passports signed against it remain verifiable`,
      next_step: `POST /api/passport/generate with {"merchant_id":"${merchant_id}"} to sign this catalog version`,
    });
  } catch (err) {
    // GUARDRAIL: a bad upload never crashes the server. The 500 path still records that
    // an ingestion attempt failed, so an attempt that broke the handler is not invisible.
    logger.error("catalog_ingest_handler_error", { merchant_id: clip(rawMerchantId), reason: err.message, stack: (err.stack || "").split("\n")[1] });
    try {
      await recordIngestion({
        merchant_id: clip(rawMerchantId),
        result: "fail",
        reason_code: "ingestion_handler_error",
        reason: clip(err.message, 300),
      });
    } catch (auditErr) {
      logger.error("catalog_ingest_audit_failed", { reason: auditErr.message });
    }
    if (!res.headersSent) {
      res.status(500).json({
        error: {
          code: "internal",
          message: "unexpected server error; the upload was not ingested",
          note: "No catalog version was written; the previously ingested catalog is unchanged.",
        },
      });
    }
  }
});

module.exports = { router, uploadParsers, MOUNT_PATH, UPLOAD_LIMIT_BYTES };
