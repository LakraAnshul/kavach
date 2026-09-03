const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { config } = require("./config");
const logger = require("./logger");
const rzp = require("./razorpay/client");
const passportMod = require("./passport/generator");
const mandates = require("./mandates/engine");
const audit = require("./audit/log");
const store = require("./catalog/store");
const merchantRoutes = require("./routes/merchants");

const app = express();
const PASSPORT_FILE = path.join(config.dataDir, "passport.json");

// GUARDRAIL: the webhook signature is an HMAC over the exact bytes Razorpay sent,
// so those bytes have to reach the handler intact. This raw parser is mounted AHEAD
// of the JSON parser deliberately. Mounted after it — or route-level, as it was —
// body-parser has already drained the stream and set req._body, and express.raw()
// then silently does nothing: the handler receives a parsed object, the HMAC call
// throws on it, and a forged webhook and a genuine one fail identically as a 500.
// Razorpay sends Content-Type: application/json, so that ordering broke every real
// webhook and the security event this rail promises never fired.
app.use("/api/webhooks/razorpay", express.raw({ type: "*/*", limit: "1mb" }));

// Same ordering trap as the webhook parser above, reached from the other side. Catalog
// ingestion accepts up to 2MB (multipart file or JSON body); the global parser below
// allows 1MB. Mounted after it, a 1.5MB catalog would be refused as "request entity too
// large" by the 1MB parser before this route ran, and the limit this endpoint documents
// would be a lie. See src/routes/merchants.js for what the array contains and why it
// ends with an error handler.
app.use(merchantRoutes.MOUNT_PATH, merchantRoutes.uploadParsers);

// GUARDRAIL: parse (and reject bad) JSON on every other route before handlers run
app.use(express.json({ limit: "1mb" }));

if (!config.keysConfigured) {
  logger.warn("startup_keys_missing", {
    reason: "RAZORPAY_KEY_ID/SECRET are placeholders in .env; order creation will return clean errors until real test keys are set",
  });
}

// ---------- helpers ----------
function badRequest(res, message, detail = {}) {
  return res.status(400).json({ error: { code: "bad_input", message, ...detail } });
}
function forbidden(res, reason_code, explanation, extra = {}) {
  // Human-readable explanation is part of the contract (graceful failure bar).
  return res.status(403).json({ decision: "rejected", reason_code, explanation, ...extra });
}
// Same rejection shape, but for a bound that is contested rather than exceeded: the
// request conflicts with state that is still settling, so retrying can legitimately
// succeed. 403 would tell the agent to give up on something that may yet be allowed.
function conflict(res, reason_code, explanation, extra = {}) {
  return res.status(409).json({ decision: "rejected", reason_code, explanation, ...extra });
}
function isNonEmptyString(v) {
  return typeof v === "string" && v.trim().length > 0;
}

// ---------- passport ----------
/**
 * A generation request that names a merchant who does not exist is a different failure
 * from a catalog that fails validation, and it gets a different status. Reporting
 * "catalog_invalid" for an unknown merchant_id would send whoever is debugging it to
 * inspect a catalog that was never uploaded.
 */
const PASSPORT_LOOKUP_STATUS = {
  invalid_merchant_id: 400,
  invalid_version: 400,
  merchant_not_found: 404,
  version_not_found: 404,
};

app.post("/api/passport/generate", (req, res) => {
  const b = req.body || {};
  // Defaults to the demo merchant, so the existing dashboard button and the agent
  // scripts keep working with an empty body exactly as before.
  const merchant_id = isNonEmptyString(b.merchant_id) ? b.merchant_id.trim() : undefined;
  const version = b.version !== undefined ? b.version : req.query.version;

  const result = passportMod.generatePassport({ merchant_id, version });
  if (!result.ok) {
    // A missing signing key is a server misconfiguration, not a bad catalog. Reporting
    // it as "catalog_invalid" would send whoever is debugging it to the wrong file.
    const problems = result.errors || [];
    if (problems.some((p) => p.reason_code === "signing_key_missing")) {
      return res.status(500).json({
        error: {
          code: "signing_key_missing",
          message: "PASSPORT_SIGNING_KEY is not configured, so no passport can be signed. An unsigned passport is worse than none, so none was issued.",
          problems,
        },
      });
    }
    const lookupFailure = problems.find((p) => PASSPORT_LOOKUP_STATUS[p.reason_code]);
    if (lookupFailure) {
      return res.status(PASSPORT_LOOKUP_STATUS[lookupFailure.reason_code]).json({
        error: {
          code: lookupFailure.reason_code,
          message: lookupFailure.reason,
          hint: "Ingest a catalog first: POST /api/merchants/<merchant_id>/catalog",
        },
      });
    }
    // EDGE CASE: invalid catalog -> reject generation with listed problems
    return res.status(422).json({
      error: {
        code: "catalog_invalid",
        message: "passport generation rejected: catalog failed validation",
        problems,
      },
    });
  }
  try {
    // Written twice, on purpose. The per-merchant copy is that merchant's passport and
    // survives another merchant generating theirs; PASSPORT_FILE is "the most recently
    // generated passport", which is what GET /api/passport and the dashboard have always
    // read. Keeping it means multi-merchant support did not change the meaning of any
    // existing file or response.
    fs.writeFileSync(store.passportPath(result.merchant_id), JSON.stringify(result.manifest, null, 2));
    fs.writeFileSync(PASSPORT_FILE, JSON.stringify(result.manifest, null, 2));
  } catch (err) {
    // The manifest is valid and signed; only persisting it failed. Say which one it
    // was, rather than letting it surface as a bare "unexpected server error".
    logger.error("passport_persist_failed", { merchant_id: result.merchant_id, reason: err.message });
    return res.status(500).json({
      error: { code: "passport_not_saved", message: `passport was generated and signed but could not be written to disk: ${err.message}` },
    });
  }
  res.json(result.manifest);
});

app.get("/api/passport", (req, res) => {
  try {
    // ?merchant_id=x reads that merchant's own passport; with no query this returns the
    // most recently generated one, byte for byte what it returned before merchants existed.
    let file = PASSPORT_FILE;
    if (isNonEmptyString(req.query.merchant_id)) {
      const safe = store.sanitizeMerchantId(req.query.merchant_id);
      if (!safe.ok) return badRequest(res, `rejected merchant_id: ${safe.reason}`);
      file = store.passportPath(safe.merchant_id);
    }
    let manifest = null;
    try {
      manifest = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      manifest = null;
    }
    if (!manifest) {
      // EDGE CASE: empty state -> dashboard renders a clear message
      return res.json({ exists: false });
    }
    const verdict = passportMod.verifyPassport(manifest);
    res.json({ exists: true, manifest, signature_status: verdict });
  } catch (err) {
    logger.error("passport_view_failed", { reason: err.message });
    res.status(500).json({ error: { code: "internal", message: "failed to read passport" } });
  }
});

// ---------- merchant catalogs ----------
// Handlers live in src/routes/merchants.js; the body parsers for this path are mounted
// above, ahead of the global JSON parser.
app.use(merchantRoutes.MOUNT_PATH, merchantRoutes.router);

// ---------- mandates ----------
app.post("/api/mandates", async (req, res) => {
  try {
    const b = req.body || {};
    const problems = [];
    if (!isNonEmptyString(b.agent_id)) problems.push("agent_id must be a non-empty string");
    // isSafeInteger, matching what the engine requires of a stored mandate. Accepting a
    // cap here that the engine would later call malformed would issue a mandate that
    // can never authorise anything.
    if (!Number.isSafeInteger(b.max_spend_paise) || b.max_spend_paise <= 0)
      problems.push("max_spend_paise must be a positive integer (paise) within safe integer range");
    if (!Array.isArray(b.category_allowlist) || b.category_allowlist.length === 0 || !b.category_allowlist.every(isNonEmptyString))
      problems.push("category_allowlist must be a non-empty array of strings");
    if (!isNonEmptyString(b.expiry_timestamp) || !Number.isFinite(Date.parse(b.expiry_timestamp)))
      problems.push("expiry_timestamp must be an ISO timestamp");
    if (typeof b.single_use !== "boolean") problems.push("single_use must be boolean");
    if (problems.length > 0) return badRequest(res, "mandate creation rejected: malformed payload", { problems });

    const m = await mandates.createMandate({
      agent_id: b.agent_id.trim(),
      max_spend_paise: b.max_spend_paise,
      category_allowlist: b.category_allowlist,
      expiry_timestamp: b.expiry_timestamp,
      single_use: b.single_use,
    });
    audit.append({
      agent_id: m.agent_id,
      mandate_id: m.mandate_id,
      action: "mandate_issued",
      result: "ok",
      reason_code: "created",
      reason: `mandate issued: max_spend=${m.max_spend_paise}p, categories=[${m.category_allowlist.join(",")}], single_use=${m.single_use}, expires=${m.expiry_timestamp}`,
      meta: {
        max_spend_paise: m.max_spend_paise,
        category_allowlist: m.category_allowlist,
        single_use: m.single_use,
        expires: m.expiry_timestamp,
      },
    });
    await audit.flush();
    res.status(201).json(m);
  } catch (err) {
    logger.error("mandate_create_failed", { reason: err.message });
    res.status(500).json({ error: { code: "internal", message: "mandate creation failed" } });
  }
});

app.get("/api/mandates", async (req, res) => {
  try {
    const store = mandates.loadStore();
    const nowMs = Date.now();
    const list = Object.values(store).map((m) => {
      // Compared as instants, not as strings. An expiry supplied with an offset
      // ("...+05:30") sorts wrong against a "...Z" string, which would have shown a
      // mandate as active here while the engine was correctly refusing it as expired.
      const expiryMs = Date.parse(m.expiry_timestamp);
      let computed_status;
      if (m.status === "revoked") computed_status = "revoked";
      else if (m.status === "consumed" || m.consumed_at) computed_status = "consumed";
      else if (Number.isFinite(expiryMs) && nowMs > expiryMs) computed_status = "expired";
      else if (m.status === "claimed") computed_status = "claimed";
      else computed_status = "active";
      return { ...m, computed_status };
    });
    res.json({ mandates: list });
  } catch (err) {
    logger.error("mandate_list_failed", { reason: err.message });
    res.status(500).json({ error: { code: "internal", message: "failed to list mandates" } });
  }
});

app.post("/api/mandates/:mandate_id/revoke", async (req, res) => {
  try {
    const mandate_id = req.params.mandate_id;
    if (!isNonEmptyString(mandate_id)) {
      return badRequest(res, "mandate_id must be a non-empty string");
    }
    const result = await mandates.revokeMandate(mandate_id);
    await audit.flush();
    if (!result.ok) {
      if (result.status === 404) {
        return res.status(404).json({ error: { code: "not_found", message: result.explanation, reason_code: result.reason_code } });
      }
      if (result.status === 400) {
        return badRequest(res, result.explanation, { reason_code: result.reason_code });
      }
      if (result.status === 409) {
        return conflict(res, result.reason_code, result.explanation);
      }
      return badRequest(res, result.explanation, { reason_code: result.reason_code });
    }
    res.status(200).json(result.mandate);
  } catch (err) {
    logger.error("mandate_revoke_endpoint_failed", { reason: err.message });
    res.status(500).json({ error: { code: "internal", message: "failed to revoke mandate" } });
  }
});

// ---------- bounded transaction execution ----------
app.post("/api/transactions", async (req, res) => {
  const started = Date.now();
  // Set once the mandate has been claimed. Every exit path from that point on must
  // either consume the claim or hand it back; a claim left dangling would brick a
  // single-use mandate that never actually paid for anything.
  let reserved = false;
  let mandateIdForRelease = null;
  try {
    const b = req.body || {};
    // GUARDRAIL: validate input shape before anything else
    if (!isNonEmptyString(b.agent_id)) return badRequest(res, "agent_id must be a non-empty string");
    if (!isNonEmptyString(b.mandate_id)) return badRequest(res, "mandate_id must be a non-empty string");

    let amount_paise;
    let category;
    let source;
    if (isNonEmptyString(b.item_id)) {
      /**
       * §9 PRICING SOURCE. This priced from `passportMod.CATALOG` — a hardcoded array
       * compiled into the process — while the passport it was supposedly honouring was
       * signed over a merchant's uploaded catalog. The two could say different things and
       * nothing would notice: every merchant on the rail was charged from one shared
       * price list, so two merchants selling the same sku id at different prices would
       * both have been billed the first one's price, and an ingested catalog affected the
       * passport but never the money.
       *
       * Pricing now reads the same stored, versioned catalog file the passport was signed
       * over, for the merchant named in the request. `catalog_version` prices against a
       * specific historical version, so an agent holding an older passport can transact
       * at the prices that passport actually attests instead of at whatever was uploaded
       * since.
       */
      const merchant_id = isNonEmptyString(b.merchant_id) ? b.merchant_id.trim() : passportMod.DEFAULT_MERCHANT_ID;
      const found = store.findProduct(merchant_id, b.item_id, { version: b.catalog_version });
      if (!found.ok) {
        if (found.reason_code === "catalog_unreadable") {
          // The catalog cannot be read, so nothing can be priced. Not the agent's fault
          // and not a mandate decision: reported as ours, naming the actual problem.
          logger.error("pricing_catalog_unreadable", { merchant_id, item_id: b.item_id, reason: found.reason });
          return res.status(500).json({ error: { code: "catalog_unreadable", message: found.reason } });
        }
        // Everything else is the request naming something that cannot be priced — an
        // unknown merchant, an unknown version, an unknown sku. 400, as before.
        return badRequest(res, `unknown item_id ${b.item_id}: ${found.reason}`, { merchant_id, reason_code: found.reason_code });
      }
      const item = found.product;

      // GUARDRAIL: money stays integer paise end to end. A catalog is validated at
      // ingestion and again at signing, but this reads a FILE, and a hand-edited price of
      // 349.9 would otherwise multiply into a float amount and be sent to the gateway.
      // The last chance to refuse is immediately before the arithmetic.
      if (!Number.isSafeInteger(item.price_paise) || item.price_paise <= 0 || !Number.isSafeInteger(item.stock) || item.stock < 0) {
        logger.error("pricing_catalog_entry_invalid", {
          merchant_id: found.merchant_id, version: found.version, item_id: item.id,
          price_paise: item.price_paise, stock: item.stock,
        });
        return res.status(500).json({
          error: {
            code: "catalog_price_invalid",
            message: `item "${item.id}" in merchant "${found.merchant_id}" catalog version ${found.version} does not carry a usable integer price and stock, so it cannot be priced`,
          },
        });
      }

      // A quantity that is present but unusable is rejected, not quietly rewritten.
      // This used to fall back to 1 for any bad value, which meant a request for
      // quantity "3" or 2.5 was silently priced as one unit — the server deciding a
      // different amount than the caller asked for, on the money path.
      if (b.quantity !== undefined && (!Number.isInteger(b.quantity) || b.quantity <= 0)) {
        return badRequest(res, "quantity must be a positive integer when supplied", { received: b.quantity });
      }
      const qty = b.quantity === undefined ? 1 : b.quantity;
      amount_paise = item.price_paise * qty; // integer math, paise throughout
      // A quantity large enough to push the total past exact-integer range would make
      // every later comparison against the mandate bound meaningless.
      if (!Number.isSafeInteger(amount_paise)) {
        return badRequest(res, "quantity is too large to price exactly", { item_id: item.id, quantity: qty });
      }
      category = item.category;
      // Names the merchant and the catalog version the price came from, so the audit
      // trail answers "priced from what?" and not merely "priced from a catalog".
      source = `catalog:${found.merchant_id}@v${found.version}:${item.id} x${qty}`;
      if (item.stock < qty) {
        audit.append({
          agent_id: b.agent_id, mandate_id: b.mandate_id, action: "transaction_attempt",
          result: "fail", reason_code: "item_unavailable",
          reason: `item ${item.id} has stock ${item.stock}, requested ${qty}`,
          amount_paise,
          meta: { merchant_id: found.merchant_id, catalog_version: found.version, item_id: item.id },
        });
        // Wait for the record to reach disk before reporting the decision. See audit.flush.
        await audit.flush();
        return res.status(409).json({ decision: "rejected", reason_code: "item_unavailable", explanation: `Item "${item.name}" is unavailable (stock ${item.stock}).` });
      }
      // The merchant's own availability flag, which the passport is signed over. In stock
      // but withdrawn from sale is a real state, and selling into it would put the rail in
      // direct contradiction with the passport it just issued.
      if (item.available === false) {
        audit.append({
          agent_id: b.agent_id, mandate_id: b.mandate_id, action: "transaction_attempt",
          result: "fail", reason_code: "item_not_for_sale",
          reason: `item ${item.id} is marked available=false in catalog version ${found.version}`,
          amount_paise,
          meta: { merchant_id: found.merchant_id, catalog_version: found.version, item_id: item.id },
        });
        await audit.flush();
        return res.status(409).json({
          decision: "rejected",
          reason_code: "item_not_for_sale",
          explanation: `Item "${item.name}" is in stock but marked not for sale in the signed catalog, so it cannot be purchased.`,
        });
      }
    } else {
      // Explicit declared amount (what buyer agents typically send). Still validated as integer paise.
      // isSafeInteger, matching the engine: above 2**53 an integer is no longer
      // distinguishable from its neighbours, so comparing it against a bound proves
      // nothing. Accepting it here and having the engine call it malformed later would
      // reject the transaction for the wrong reason.
      if (!Number.isSafeInteger(b.amount_paise) || b.amount_paise <= 0)
        return badRequest(res, "amount_paise must be a positive integer (paise) within safe integer range OR provide item_id to price from catalog");
      if (!isNonEmptyString(b.category)) return badRequest(res, "category is required when sending explicit amount_paise");
      amount_paise = b.amount_paise;
      category = b.category;
      source = "declared_amount";
    }

    // GUARDRAIL: the mandate is checked AND claimed here, in one indivisible step,
    // before any Razorpay call. Claiming is part of the gate rather than a later
    // step because the gateway call below takes real time (235ms in this project's
    // own log), and a gate that only checked would let a second request slip into
    // that window and clear the same single-use mandate a second time.
    // No bypass flag exists.
    const verdict = await mandates.reserveMandateForTransaction({
      mandate_id: b.mandate_id,
      agent_id: b.agent_id,
      amount_paise,
      category,
    });

    if (!verdict.allowed) {
      const detail = {
        amount_paise,
        category,
        note: "No payment was attempted; the bound was enforced before any gateway call.",
      };
      // The refusal was recorded by the engine; make sure it is durable before the
      // agent is told it was refused.
      await audit.flush();
      return verdict.reason_code === mandates.REJECT_CODES.IN_FLIGHT
        ? conflict(res, verdict.reason_code, verdict.explanation, detail)
        : forbidden(res, verdict.reason_code, verdict.explanation, detail);
    }
    reserved = true;
    mandateIdForRelease = b.mandate_id;

    // Bounded execution: create Razorpay order (live test-mode call)
    const txId = "tx_" + crypto.randomBytes(6).toString("hex");
    let order;
    try {
      order = await rzp.createOrder({
        amount_paise,
        receipt: txId,
        notes: { mandate_id: b.mandate_id, agent_id: b.agent_id, category },
      });
    } catch (err) {
      // The order never existed, so no money moved and the claim must go back. The
      // agent keeps the spending power it was granted and can retry.
      await mandates.releaseMandate(b.mandate_id, {
        reason: "the payment gateway did not accept the order",
        amount_paise,
        meta: { txId, reason_code: err.code || "order_creation_failed" },
      });
      reserved = false;
      audit.append({
        agent_id: b.agent_id, mandate_id: b.mandate_id, action: "transaction",
        result: "fail", reason_code: err.code || "order_creation_failed",
        reason: `Razorpay order creation failed after mandate passed validation: ${err.message}`,
        amount_paise, meta: { txId, mandate_claim: "released; no spending power was consumed" },
      });
      await audit.flush();
      return res.status(500).json({
        decision: "failed",
        error: { code: "gateway_error", message: "payment gateway did not accept the order; no charge occurred", txId },
        mandate_consumed: false,
        explanation: "The order was refused before any charge, so the mandate's claim was released and it can be used again.",
      });
    }

    // Optional capture step (used when a test-mode payment_id exists, e.g. paid via checkout/webhook flow)
    let capture = null;
    if (isNonEmptyString(b.payment_id)) {
      try {
        capture = await rzp.capturePayment({ payment_id: b.payment_id, amount_paise });
      } catch (err) {
        audit.append({
          agent_id: b.agent_id, mandate_id: b.mandate_id, action: "capture",
          result: "fail", reason_code: "capture_failed",
          reason: `capture failed after retry policy: ${err.message}`,
          amount_paise, meta: { txId, order_id: order.id, payment_id: b.payment_id },
        });
        capture = { error: err.code };
      }
    }

    // The order exists, so the authorisation was used. Burn it.
    const burned = await mandates.consumeMandate(b.mandate_id, { transaction_id: txId, amount_paise });
    reserved = false;
    // Reported from what actually happened to the mandate, not asserted. This was
    // hardcoded true, which was a false claim on every reusable mandate: those are
    // deliberately NOT consumed, and the response said otherwise.
    const mandate_consumed = burned ? burned.status === "consumed" : false;

    audit.append({
      agent_id: b.agent_id, mandate_id: b.mandate_id, action: "transaction",
      result: "success", reason_code: "within_bounds_executed",
      reason: `executed because mandate validation passed pre-call (amount ${amount_paise}p <= bound, category "${category}" allowed, mandate unexpired/unconsumed); order created live`,
      amount_paise,
      meta: { txId, order_id: order.id, priced_from: source, capture: capture ? capture.status || capture.error : "pending_payment", duration_ms: Date.now() - started },
    });
    await audit.flush();

    res.json({
      decision: "approved",
      txId,
      amount_paise,
      category,
      priced_from: source,
      order: { id: order.id, amount: order.amount, currency: order.currency, status: order.status, receipt: order.receipt },
      capture: capture ? { status: capture.status || null, error: capture.error || null } : { status: null, note: "awaiting payment instrument; webhook will finalize lifecycle" },
      mandate_consumed,
      explanation: mandate_consumed
        ? "Mandate bounds were validated before the gateway call; order creation succeeded within bounds, and this single-use mandate is now spent."
        : "Mandate bounds were validated before the gateway call; order creation succeeded within bounds. This mandate is reusable, so it remains active — each transaction is checked against the same per-transaction cap.",
    });
  } catch (err) {
    // EDGE CASE: nothing here may crash the server, and nothing here may leave a
    // mandate claimed by a transaction that will never finish. Releasing is safe
    // even if the claim was already consumed: release only acts on a claimed one.
    if (reserved && mandateIdForRelease) {
      try {
        await mandates.releaseMandate(mandateIdForRelease, {
          reason: "the transaction aborted before completing",
          meta: { aborted_with: err.message },
        });
      } catch (releaseErr) {
        logger.error("mandate_release_failed", { mandate_id: mandateIdForRelease, reason: releaseErr.message });
      }
    }
    logger.error("transaction_handler_error", { reason: err.message, stack: (err.stack || "").split("\n")[1] });
    if (!res.headersSent) {
      res.status(500).json({ error: { code: "internal", message: "unexpected server error; transaction aborted safely" } });
    }
  }
});

// ---------- webhook ----------
// The raw body parser for this path is mounted at the top of the file, ahead of
// express.json(). Do not add a route-level parser here: it would be a no-op.
// Async, but every path is inside the try/catch below — Express 4 does not route a
// rejected handler promise to the error boundary, so this handler must never reject.
app.post("/api/webhooks/razorpay", async (req, res) => {
  try {
    const sig = req.get("X-Razorpay-Signature");
    const raw = Buffer.isBuffer(req.body) ? req.body : null;

    // A body that did not arrive as raw bytes cannot be verified at all. Treat that
    // as a failed verification, never as a pass.
    const ok = raw !== null && rzp.verifyWebhookSignature(raw, sig);
    if (!ok) {
      // GUARDRAIL: immediate rejection + already logged as security_event inside connector
      audit.append({
        action: "webhook_received",
        result: "fail",
        reason_code: "signature_invalid",
        reason: raw
          ? "webhook rejected: HMAC-SHA256 signature verification failed"
          : "webhook rejected: request body did not reach the handler as raw bytes, so its signature could not be verified",
        meta: { security_event: true, signature_present: !!sig },
      });
      // A rejected webhook is the security event this rail exists to show. It has to be
      // on disk before the rejection goes back, or a sender who disconnects the service
      // immediately after probing it leaves no trace of having probed.
      await audit.flush();
      return res.status(403).json({ decision: "rejected", explanation: "webhook signature verification failed; event ignored" });
    }

    // Signature verified. Anything wrong from here is bad input from an authenticated
    // sender — a 400 — not a server fault, and it must not read as a security event.
    let event;
    try {
      event = JSON.parse(raw.toString("utf8"));
    } catch {
      audit.append({
        action: "webhook_received",
        result: "fail",
        reason_code: "webhook_payload_unparseable",
        reason: "webhook signature verified but the payload was not valid JSON; event ignored",
      });
      await audit.flush();
      return badRequest(res, "webhook signature verified but the payload is not valid JSON");
    }

    logger.info("webhook_accepted", { event_type: event.event, contains_payment: !!event.payload?.payment });
    audit.append({
      action: "webhook_received",
      result: "ok",
      reason_code: event.event || "unknown_event",
      reason: `verified webhook event ${event.event || ""} accepted`,
      amount_paise: event.payload?.payment?.entity?.amount ?? null,
    });
    await audit.flush();
    res.json({ received: true });
  } catch (err) {
    logger.error("webhook_handler_error", { reason: err.message });
    if (!res.headersSent) {
      res.status(500).json({ error: { code: "internal", message: "webhook processing failed" } });
    }
  }
});

// ---------- audit trail (read-only by design) ----------
app.get("/api/audit", (req, res) => {
  try {
    const entries = audit.readAll();
    entries.sort((a, b2) => (a.ts || "").localeCompare(b2.ts || ""));
    res.json({ count: entries.length, entries });
  } catch (err) {
    logger.error("audit_read_failed", { reason: err.message });
    res.status(500).json({ error: { code: "internal", message: "failed to read audit trail" } });
  }
});

app.get("/api/health", (_req, res) =>
  res.json({ ok: true, keys_configured: config.keysConfigured, service: "kavach-trust-rail" })
);

app.use(express.static(path.join(__dirname, "..", "public")));

app.use((req, res) => res.status(404).json({ error: { code: "not_found", message: `no route ${req.method} ${req.path}` } }));

// Final error boundary: server must never crash on a bad request
app.use((err, _req, res, _next) => {
  if (err && err.type === "entity.parse.failed") {
    return res.status(400).json({ error: { code: "bad_json", message: "request body is not valid JSON" } });
  }
  if (err && err.type === "entity.too.large") {
    // Refusing an oversized body is the parser doing its job, not a server fault.
    return res.status(413).json({ error: { code: "body_too_large", message: "request body exceeds the 1mb limit" } });
  }
  // body-parser and friends set err.status on anything they consider the caller's
  // fault. Reporting all of those as 500 blamed the server for malformed requests and
  // told the caller to retry something that will never succeed.
  const status = Number.isInteger(err && err.status) && err.status >= 400 && err.status < 500 ? err.status : 500;
  if (status !== 500) {
    logger.warn("rejected_request", { status, reason: err.message, type: err.type || null });
    if (!res.headersSent) {
      res.status(status).json({ error: { code: err.type || "bad_request", message: err.message || "request rejected" } });
    }
    return;
  }
  logger.error("unhandled_error", { reason: err && err.message });
  if (!res.headersSent) {
    res.status(500).json({ error: { code: "internal", message: "unexpected server error" } });
  }
});

// A last-resort net, not a recovery mechanism: the process state after an uncaught
// throw is unknown, so this records what happened and lets the operator see it rather
// than pretending the service is healthy.
process.on("uncaughtException", (err) => logger.error("uncaught_exception", { reason: err.message, stack: (err.stack || "").split("\n")[1] }));
process.on("unhandledRejection", (err) => logger.error("unhandled_rejection", { reason: String(err) }));

audit.append({
  action: "server_start",
  result: "ok",
  reason_code: "boot",
  reason: `kavach trust rail listening; razorpay keys configured=${config.keysConfigured}`,
});

const server = app.listen(config.port, () => console.log(`[kavach] listening on http://localhost:${config.port}`));

// A failed bind used to reach uncaughtException, which only logs — so a port already
// in use printed an error and left a process running that was serving nothing. The
// test suite spawns servers on fixed ports, which makes that the common failure.
server.on("error", (err) => {
  const reason =
    err.code === "EADDRINUSE"
      ? `port ${config.port} is already in use; another kavach instance is probably running`
      : err.message;
  logger.error("server_listen_failed", { port: config.port, code: err.code || null, reason });
  console.error(`[kavach] could not start: ${reason}`);
  audit.flush().finally(() => process.exit(1));
});
