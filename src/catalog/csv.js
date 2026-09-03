/**
 * CSV → rows. The only place papaparse is touched, and the only place CSV-specific
 * concerns live. Everything downstream sees plain objects and cannot tell which upload
 * format produced them.
 *
 * GUARDRAIL: dynamicTyping stays OFF. papaparse's type inference turns "349900" into
 * the number 349900 — which looks harmless — and "349.90" into the float 349.9, which
 * puts a non-integer on the money path. Worse, it turns "0" into 0 and would let a
 * truthiness check read a stock of zero as "no value supplied". Every cell leaves this
 * module as the string it arrived as, and src/catalog/validate.js is the single place
 * that decides what a string is allowed to become.
 */
const Papa = require("papaparse");
const { REQUIRED_PRODUCT_FIELDS } = require("./validate");

// EDGE CASE: a CSV exported from Excel begins with a UTF-8 BOM, which would make the
// first header "﻿id" and match nothing — so the file would be refused for having
// no id column while looking perfectly correct in a spreadsheet.
function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * EDGE CASE: headers are matched by NAME, case-insensitively, never by position. A CSV
 * with its columns in a different order than the documented one maps correctly, and a
 * CSV whose columns happen to be in the right order but misnamed is refused rather than
 * silently mapped by position — position-based mapping is how a stock column ends up
 * being read as a price.
 */
function normalizeHeader(header) {
  return String(header || "")
    .replace(/^﻿/, "")
    .trim()
    .toLowerCase();
}

function parseCsvCatalog(text) {
  if (typeof text !== "string" || text.trim().length === 0) {
    return { ok: false, reason_code: "csv_empty", message: "the uploaded CSV file is empty" };
  }

  let parsed;
  try {
    parsed = Papa.parse(stripBom(text), {
      header: true,
      // Off, deliberately. See the note at the top of this file.
      dynamicTyping: false,
      // "greedy" also drops rows that contain only delimiters, so a trailing newline or a
      // stray ",,,,,,," line does not become a product with every field missing.
      skipEmptyLines: "greedy",
      transformHeader: normalizeHeader,
    });
  } catch (err) {
    // papaparse is forgiving by design and rarely throws, but a throw here must still be
    // a 400 about the file rather than a 500 about the server.
    return { ok: false, reason_code: "csv_unparseable", message: `CSV could not be parsed: ${err.message}` };
  }

  // An unbalanced quote makes every field after it garbage — papaparse reports it and
  // then does its best, which is exactly the case where "its best" must not be trusted.
  // Field-count mismatches are deliberately NOT fatal here: they surface as missing
  // required fields per product, which tells the merchant which row to fix.
  const quoteErrors = (parsed.errors || []).filter((e) => e && e.type === "Quotes");
  if (quoteErrors.length > 0) {
    const first = quoteErrors[0];
    return {
      ok: false,
      reason_code: "csv_unparseable",
      message: `CSV is malformed: ${first.message}${Number.isInteger(first.row) ? ` (row ${first.row + 1})` : ""}`,
      detail: { errors: quoteErrors.slice(0, 5) },
    };
  }

  const fields = parsed.meta && Array.isArray(parsed.meta.fields) ? parsed.meta.fields : [];

  // EDGE CASE: the same column supplied twice. papaparse collapses duplicates into one
  // key and the last one silently wins — an unacceptable way to decide a price, so an
  // ambiguous header is refused instead.
  const duplicateHeaders = fields.filter((f, i) => REQUIRED_PRODUCT_FIELDS.includes(f) && fields.indexOf(f) !== i);
  if (duplicateHeaders.length > 0) {
    return {
      ok: false,
      reason_code: "csv_duplicate_columns",
      message: `CSV header repeats the column(s) ${[...new Set(duplicateHeaders)].join(", ")}; each field may appear once so there is no ambiguity about which value counts`,
      detail: { headers: fields },
    };
  }

  // The real "this file is not a catalog" test. A .csv that is actually a text file, a
  // renamed image, or a different schema entirely lands here rather than producing rows
  // of nulls, and gets told what a header row is supposed to contain.
  const missingHeaders = REQUIRED_PRODUCT_FIELDS.filter((f) => !fields.includes(f));
  if (missingHeaders.length === REQUIRED_PRODUCT_FIELDS.length) {
    return {
      ok: false,
      reason_code: "csv_no_header_row",
      message: `CSV has no recognizable header row: expected columns ${REQUIRED_PRODUCT_FIELDS.join(", ")} (case-insensitive, any order)`,
      detail: { headers_found: fields.slice(0, 20) },
    };
  }
  if (missingHeaders.length > 0) {
    return {
      ok: false,
      reason_code: "csv_missing_columns",
      message: `CSV header is missing required column(s): ${missingHeaders.join(", ")}`,
      detail: { headers_found: fields, missing_columns: missingHeaders },
    };
  }

  // EDGE CASE: extra/unknown columns are dropped here rather than failing the upload. A
  // merchant's real export carries warehouse codes and internal notes; refusing the file
  // over a column the rail does not need would make ingestion useless in practice.
  const rows = (parsed.data || []).map((row) => {
    const picked = {};
    for (const field of REQUIRED_PRODUCT_FIELDS) {
      if (row[field] !== undefined) picked[field] = row[field];
    }
    return picked;
  });

  const ignored_columns = fields.filter((f) => !REQUIRED_PRODUCT_FIELDS.includes(f));
  return { ok: true, rows, ignored_columns };
}

module.exports = { parseCsvCatalog };
