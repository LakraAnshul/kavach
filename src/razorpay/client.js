const Razorpay = require("razorpay");
const crypto = require("crypto");
const { config } = require("../config");
const logger = require("../logger");

const ORDER_TIMEOUT_MS = 15000;
const CAPTURE_TIMEOUT_MS = 20000;

let client = null;

function getClient() {
  if (!config.keysConfigured) {
    throw new ConnectorError("razorpay_keys_not_configured", "RAZORPAY_KEY_ID/SECRET missing or placeholder in .env");
  }
  if (!client) {
    client = new Razorpay({
      key_id: config.razorpay.keyId,
      key_secret: config.razorpay.keySecret,
    });
    logger.info("razorpay_client_initialized", { key_id: config.razorpay.keyId });
  }
  return client;
}

class ConnectorError extends Error {
  constructor(code, message, httpStatus) {
    super(message);
    this.code = code;
    this.httpStatus = httpStatus || 502;
  }
}

function withTimeout(promise, ms, opName) {
  let timer;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${opName}_timeout_after_${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * The Razorpay SDK does not always reject with an Error. On an API-level refusal it
 * rejects with a plain object shaped { statusCode, error: { code, description, ... } },
 * where `.message` is undefined — so every log line about a refused order recorded
 * "undefined" as the reason and the actual cause was never written down anywhere.
 */
function describeError(err) {
  if (!err) return "unknown error";
  if (typeof err === "string") return err;
  if (typeof err.message === "string" && err.message) return err.message;
  const api = err.error;
  if (api && typeof api === "object") {
    const parts = [api.description, api.reason, api.field && `field=${api.field}`, api.step && `step=${api.step}`].filter(Boolean);
    const label = api.code ? `${api.code}` : "razorpay_error";
    return parts.length ? `${label}: ${parts.join("; ")}` : label;
  }
  if (Number.isInteger(err.statusCode)) return `razorpay returned HTTP ${err.statusCode} with no description`;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

function classifyError(err) {
  const msg = describeError(err);
  if (/timeout/i.test(msg)) return "network_timeout";
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|fetch failed|network/i.test(msg)) return "network_error";
  // Match the API's own code before the loose /auth/i sweep: a description mentioning
  // "authorised" would otherwise be filed as an auth failure.
  if (err && err.error && /AUTHENTICATION|UNAUTHORIZED/i.test(String(err.error.code || ""))) return "auth_error";
  if (Number.isInteger(err && err.statusCode) && (err.statusCode === 401 || err.statusCode === 403)) return "auth_error";
  if (/authentication failed|unauthori[sz]ed|invalid api key/i.test(msg)) return "auth_error";
  return "api_error";
}

async function createOrder({ amount_paise, receipt, currency = "INR", notes = {} }) {
  if (!Number.isInteger(amount_paise) || amount_paise <= 0) {
    throw new ConnectorError("invalid_amount", "amount must be a positive integer in paise", 400);
  }
  try {
    const sdk = getClient();
    logger.info("rzp_order_create_start", { amount_paise, currency, receipt });
    const order = await withTimeout(
      sdk.orders.create({ amount: amount_paise, currency, receipt, notes }),
      ORDER_TIMEOUT_MS,
      "order_create"
    );
    logger.info("rzp_order_created", { order_id: order.id, amount_paise, reason: "order accepted by Razorpay" });
    return order;
  } catch (err) {
    const kind = classifyError(err);
    const reason = describeError(err);
    // EDGE CASE: order creation failure -> clean error, never crash server
    logger.error("rzp_order_create_failed", {
      kind,
      reason,
      amount_paise,
      decision: "returning clean error to caller, server continues",
    });
    // The reason travels with the error so the audit entry records why the gateway
    // refused. The HTTP response to the agent stays generic; the detail belongs in the
    // trail, not in a reply to whoever asked.
    throw new ConnectorError(`order_creation_failed_${kind}`, `payment gateway rejected order creation (${reason})`);
  }
}

async function capturePayment({ payment_id, amount_paise, currency = "INR" }) {
  if (!Number.isInteger(amount_paise) || amount_paise <= 0) {
    throw new ConnectorError("invalid_amount", "amount must be a positive integer in paise", 400);
  }
  const attempt = async (n) => {
    const sdk = getClient();
    logger.info("rzp_capture_attempt", { payment_id, amount_paise, attempt: n });
    return withTimeout(sdk.payments.capture(payment_id, amount_paise, currency), CAPTURE_TIMEOUT_MS, "capture");
  };
  for (let n = 1; n <= 2; n++) {
    try {
      const payment = await attempt(n);
      logger.info("rzp_capture_success", { payment_id, amount_paise, attempt: n, status: payment.status });
      return payment;
    } catch (err) {
      const kind = classifyError(err);
      const reason = describeError(err);
      if (n === 1 && kind === "network_timeout") {
        // EDGE CASE: capture timeout -> exactly one retry
        logger.warn("rzp_capture_timeout_retry_once", { payment_id, attempt: 1, reason });
        continue;
      }
      // EDGE CASE: second failure -> mark failed with reason
      logger.error("rzp_capture_failed", {
        payment_id,
        amount_paise,
        attempts_used: n,
        kind,
        reason,
        decision: "marking transaction capture_failed",
      });
      throw new ConnectorError("capture_failed", `payment capture failed after ${n} attempt(s): ${kind} (${reason})`);
    }
  }
  // Unreachable while the loop bound is 2: every iteration either returns or throws.
  // Present so the function can never resolve undefined if that bound ever changes,
  // which would read as a successful capture that never happened.
  throw new ConnectorError("capture_failed", "payment capture exhausted every attempt without a result");
}

/**
 * GUARDRAIL: verification must return false on every doubtful path and must never
 * throw. A throw here surfaces as a 500, and a 500 tells a forger exactly nothing
 * apart from the fact that their signature was never actually compared.
 *
 * rawBody must be the exact bytes received. Anything already parsed into an object
 * is unverifiable by definition, so it is refused rather than coerced — coercing it
 * would compare an HMAC of "[object Object]" and reject genuine events too.
 */
function verifyWebhookSignature(rawBody, receivedSignature) {
  const sig = typeof receivedSignature === "string" ? receivedSignature : "";
  const body = Buffer.isBuffer(rawBody) ? rawBody : typeof rawBody === "string" ? Buffer.from(rawBody, "utf8") : null;

  if (body === null || !sig) {
    logger.error("security_event", {
      event: body === null ? "webhook_body_not_raw" : "webhook_signature_missing",
      decision: "rejected immediately",
      reason:
        body === null
          ? "webhook body was not raw bytes, so no signature could be computed over what was actually sent"
          : "no X-Razorpay-Signature header was present",
    });
    return false;
  }

  const secret = config.razorpay.webhookSecret;
  if (typeof secret !== "string" || secret.length === 0) {
    // EDGE CASE: unset secret. Refuse rather than verify against an empty key, which
    // would let anyone who guessed that fact forge a passing signature.
    logger.error("security_event", {
      event: "webhook_secret_not_configured",
      decision: "rejected every webhook",
      reason: "RAZORPAY_WEBHOOK_SECRET is not set, so no webhook can be authenticated",
    });
    return false;
  }

  let expected;
  try {
    expected = crypto.createHmac("sha256", secret).update(body).digest("hex");
  } catch (err) {
    logger.error("security_event", {
      event: "webhook_signature_uncomputable",
      decision: "rejected",
      reason: err.message,
    });
    return false;
  }

  // Compare as BYTES, not characters. timingSafeEqual throws RangeError on a length
  // mismatch, and a string length is UTF-16 code units while the buffer it becomes is
  // UTF-8 bytes. A signature containing any multi-byte character can therefore match
  // on string length and differ on byte length — which threw, and turned a rejected
  // signature into a 500 instead of a clean refusal.
  const expectedBuf = Buffer.from(expected, "utf8");
  const sigBuf = Buffer.from(sig, "utf8");
  const ok = expectedBuf.length === sigBuf.length && crypto.timingSafeEqual(expectedBuf, sigBuf);
  if (!ok) {
    // GUARDRAIL: signature mismatch is a security event, reject immediately
    logger.error("security_event", {
      event: "webhook_signature_invalid",
      decision: "rejected webhook payload",
      reason: "HMAC-SHA256 verification of X-Razorpay-Signature failed",
    });
  }
  return ok;
}

/** Checkout-callback verification, same non-throwing contract as above. */
function verifyPaymentSignature({ order_id, payment_id, signature }) {
  const sig = typeof signature === "string" ? signature : "";
  const secret = config.razorpay.keySecret;
  if (!sig || typeof secret !== "string" || secret.length === 0) return false;
  try {
    const expected = crypto.createHmac("sha256", secret).update(`${order_id}|${payment_id}`).digest("hex");
    const expectedBuf = Buffer.from(expected, "utf8");
    const sigBuf = Buffer.from(sig, "utf8");
    const ok = expectedBuf.length === sigBuf.length && crypto.timingSafeEqual(expectedBuf, sigBuf);
    if (!ok) {
      logger.error("security_event", {
        event: "payment_signature_invalid",
        decision: "rejected payment callback",
        reason: "HMAC-SHA256 verification of the order_id|payment_id signature failed",
        order_id,
      });
    }
    return ok;
  } catch {
    return false;
  }
}

module.exports = { createOrder, capturePayment, verifyWebhookSignature, verifyPaymentSignature, ConnectorError };
