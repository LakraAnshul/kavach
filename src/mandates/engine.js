const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { config } = require("../config");
const logger = require("../logger");
const audit = require("../audit/log");

const MANDATE_FILE = path.join(config.dataDir, "mandates.json");

/**
 * A missing store file and an unreadable one are not the same thing, and treating
 * them the same destroys data. "No file yet" is legitimately an empty store. "I
 * could not read or parse the file" means the real contents are unknown — and if
 * that is reported as empty, the next write persists the empty store and every
 * mandate on disk is gone. A transient read error is not far-fetched here: the
 * repository lives under OneDrive, where brief file locks are routine.
 *
 * So callers that are about to write pass strict:true and get a throw instead of a
 * silent {}. Read-only callers keep the lenient default, where an unreadable store
 * makes every mandate look absent — which refuses transactions rather than allowing
 * them, the safe direction to fail.
 */
function loadStore({ strict = false } = {}) {
  let raw;
  try {
    raw = fs.readFileSync(MANDATE_FILE, "utf8");
  } catch (err) {
    // EDGE CASE: store file missing -> genuinely an empty store, never a crash
    if (err && err.code === "ENOENT") return {};
    if (strict) throw new Error(`mandate store could not be read (${err.message}); refusing to overwrite it`);
    logger.error("mandate_store_unreadable", { reason: err.message, decision: "treated as empty for this read only" });
    return {};
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("mandate store is not a JSON object");
    }
    return parsed;
  } catch (err) {
    if (strict) throw new Error(`mandate store is corrupt (${err.message}); refusing to overwrite it`);
    logger.error("mandate_store_corrupt", { reason: err.message, decision: "treated as empty for this read only" });
    return {};
  }
}

/**
 * Every mutation of the store goes through this one chain, so a read-modify-write
 * is never interleaved with another. The mutator runs against a store loaded
 * inside the critical section, which is what makes check-and-claim indivisible.
 *
 * The chain must settle on every path. An early version left `resolve` uncalled
 * when the write itself failed, which stalled the chain permanently: every later
 * mandate issue and every later consume queued behind a promise that never
 * settled, and the server went on accepting requests that could no longer finish.
 * A failed write is now reported and the chain moves on.
 */
let writeChain = Promise.resolve();

function enqueueWrite(mutator) {
  let result;
  let mutatorError = null;

  const step = writeChain.then(
    () =>
      new Promise((resolve) => {
        // Nothing in here may throw out of the executor: a rejected writeChain would
        // poison every later mandate operation for the lifetime of the process.
        try {
          const store = loadStore({ strict: true });
          const before = JSON.stringify(store);
          try {
            result = mutator(store);
          } catch (err) {
            // A throwing mutator must not take the chain down with it, and must not
            // persist a half-applied store.
            mutatorError = err;
            logger.error("mandate_store_mutator_failed", { reason: err.message });
            return resolve();
          }

          // A gate that refused changes nothing, and refusals are the common case on
          // this rail. Skip the disk write rather than rewriting identical bytes.
          if (JSON.stringify(store) === before) return resolve();

          const tmp = MANDATE_FILE + ".tmp";
          fs.writeFile(tmp, JSON.stringify(store, null, 2), (err) => {
            if (err) {
              mutatorError = new Error(`mandate store write failed: ${err.message}`);
              logger.error("mandate_store_write_failed", {
                reason: err.message,
                decision: "chain released so the server keeps serving",
              });
              return resolve();
            }
            // Rename over the live file so a reader never sees a partial store.
            fs.rename(tmp, MANDATE_FILE, (renameErr) => {
              if (renameErr) {
                mutatorError = new Error(`mandate store rename failed: ${renameErr.message}`);
                logger.error("mandate_store_rename_failed", { reason: renameErr.message });
              }
              resolve();
            });
          });
        } catch (err) {
          mutatorError = err;
          logger.error("mandate_store_step_failed", { reason: err.message });
          resolve();
        }
      })
  );

  // The chain itself must never carry a rejection forward.
  writeChain = step.catch(() => {});

  return step.then(() => {
    if (mutatorError) throw mutatorError;
    return result;
  });
}

function createMandateTx(fields) {
  const id = "mdt_" + crypto.randomBytes(6).toString("hex");
  const record = {
    mandate_id: id,
    agent_id: fields.agent_id,
    max_spend_paise: fields.max_spend_paise,
    category_allowlist: fields.category_allowlist,
    expiry_timestamp: fields.expiry_timestamp,
    single_use: !!fields.single_use,
    status: "active",
    claimed_at: null,
    consumed_at: null,
    created_at: new Date().toISOString(),
  };
  return enqueueWrite((store) => {
    store[id] = record;
    logger.info("mandate_created", {
      mandate_id: id,
      agent_id: fields.agent_id,
      max_spend_paise: fields.max_spend_paise,
      single_use: record.single_use,
    });
    return record;
  });
}

const REJECT_CODES = {
  MALFORMED: "mandate_malformed",
  NOT_FOUND: "mandate_not_found",
  EXPIRED: "mandate_expired",
  EXCEEDED: "mandate_exceeded",
  CATEGORY: "category_not_allowed",
  CONSUMED: "mandate_already_consumed",
  IN_FLIGHT: "mandate_in_flight",
};

/**
 * The bounds themselves, in one place and with no I/O. Every gate below decides
 * with this function and only this function, so there is exactly one definition
 * of what "within bounds" means and no second path that could drift from it.
 */
function evaluateBounds(m, { agent_id, amount_paise, category }, nowMs) {
  const deny = (reason_code, reason, meta = {}) => ({ allowed: false, reason_code, reason, meta });

  // A mandate with no usable allowlist cannot have its category bound checked at
  // all, so it is malformed rather than permissive. Checking `Array.isArray` at the
  // point of comparison instead would skip the check entirely for such a mandate —
  // failing open on the one bound that decides what an agent is allowed to buy.
  if (
    !m ||
    typeof m !== "object" ||
    !m.mandate_id ||
    !m.agent_id ||
    !Number.isSafeInteger(m.max_spend_paise) ||
    !Array.isArray(m.category_allowlist)
  ) {
    return m
      ? deny(REJECT_CODES.MALFORMED, "stored mandate is missing required fields; refusing to process")
      : deny(REJECT_CODES.NOT_FOUND, "no mandate exists with the id supplied");
  }

  if (m.agent_id !== agent_id) {
    return deny(REJECT_CODES.NOT_FOUND, `mandate ${m.mandate_id} was not issued to agent ${agent_id}; ownership mismatch`);
  }

  // EDGE CASE: expired mandate
  const expiry = Date.parse(m.expiry_timestamp);
  if (!Number.isFinite(expiry)) {
    return deny(REJECT_CODES.MALFORMED, "mandate expiry_timestamp is not a valid ISO timestamp");
  }
  if (nowMs > expiry) {
    return deny(
      REJECT_CODES.EXPIRED,
      `mandate ${m.mandate_id} expired at ${m.expiry_timestamp}, current time ${new Date(nowMs).toISOString()}`,
      { expired_at: m.expiry_timestamp }
    );
  }

  // EDGE CASE: already-consumed single-use mandate
  if (m.single_use && (m.status === "consumed" || m.consumed_at)) {
    return deny(
      REJECT_CODES.CONSUMED,
      `single-use mandate ${m.mandate_id} was already consumed at ${m.consumed_at} and cannot be reused`,
      { consumed_at: m.consumed_at }
    );
  }

  // EDGE CASE: a single-use mandate already claimed by an in-flight transaction.
  // Without this the same mandate clears twice inside one gateway round-trip.
  if (m.single_use && m.status === "claimed") {
    return deny(
      REJECT_CODES.IN_FLIGHT,
      `single-use mandate ${m.mandate_id} is already claimed by a transaction in flight since ${m.claimed_at}; it authorises one payment only`,
      { claimed_at: m.claimed_at }
    );
  }

  // EDGE CASE: amount above bound -> reject, never partially processed
  if (amount_paise > m.max_spend_paise) {
    return deny(
      REJECT_CODES.EXCEEDED,
      `requested amount ${amount_paise} paise exceeds mandate max_spend ${m.max_spend_paise} paise by ${amount_paise - m.max_spend_paise} paise; transaction not attempted`,
      { max_spend_paise: m.max_spend_paise }
    );
  }

  // EDGE CASE: category outside allowlist. The allowlist is known to be an array by
  // now, so this comparison cannot be skipped. An empty allowlist permits nothing,
  // which is the correct reading of "these are the categories you may buy from".
  if (!m.category_allowlist.includes(category)) {
    return deny(REJECT_CODES.CATEGORY, `category "${category}" is not in mandate allowlist [${m.category_allowlist.join(", ")}]`, {
      requested_category: category,
    });
  }

  return { allowed: true, meta: { max_spend_paise: m.max_spend_paise } };
}

// A request shape bad enough that no mandate can be looked up at all.
// isSafeInteger, not isInteger: 2**53 and above stop being distinguishable from
// their neighbours, so an "integer" that large cannot be compared against a bound
// meaningfully. Amounts in paise never legitimately approach that.
function malformedRequest({ mandate_id, agent_id, amount_paise, category }) {
  return !mandate_id || !agent_id || !Number.isSafeInteger(amount_paise) || amount_paise <= 0 || !category;
}

const MALFORMED_REASON =
  "transaction request is malformed: required integer amount_paise > 0 within safe integer range, mandate_id, agent_id, category";

function recordDecision(req, decision, action) {
  audit.append({
    agent_id: req.agent_id,
    mandate_id: req.mandate_id,
    amount_paise: req.amount_paise,
    action,
    result: decision.allowed ? "pass" : "fail",
    reason_code: decision.allowed ? "within_bounds" : decision.reason_code,
    reason: decision.allowed ? "all bounds satisfied" : decision.reason,
    meta: decision.meta || {},
  });
  if (!decision.allowed) {
    logger.warn("mandate_rejected", {
      mandate_id: req.mandate_id,
      agent_id: req.agent_id,
      reason_code: decision.reason_code,
      reason: decision.reason,
      amount_paise: req.amount_paise,
    });
  }
  return decision.allowed
    ? { allowed: true }
    : { allowed: false, reason_code: decision.reason_code, explanation: decision.reason };
}

/**
 * Read-only bounds check. Decides nothing about ownership of the mandate, so two
 * callers can both be told "yes" — which is exactly why the transaction path uses
 * reserveMandateForTransaction instead. Kept for dry-run checks and for tests
 * that assert on a bound without spending it.
 */
async function validateMandateForTransaction(req) {
  if (malformedRequest(req)) {
    return recordDecision(req, { allowed: false, reason_code: REJECT_CODES.MALFORMED, reason: MALFORMED_REASON }, "mandate_validation");
  }
  const store = loadStore();
  const decision = evaluateBounds(store[req.mandate_id], req, Date.now());
  if (!decision.allowed && decision.reason_code === REJECT_CODES.NOT_FOUND && !store[req.mandate_id]) {
    decision.reason = `no mandate exists with id ${req.mandate_id}`;
  }
  return recordDecision(req, decision, "mandate_validation");
}

/**
 * GUARDRAIL: this is the ONLY gate to money movement, and it both checks the
 * bounds and claims the mandate in one indivisible step.
 *
 * Checking and claiming have to be indivisible because they are not adjacent in
 * time. Between them the caller makes a live gateway call — 235 ms in this
 * project's own server log. A gate that merely *checked* would let a second
 * request arriving inside that window read a still-active single-use mandate,
 * clear every bound, and create a second order against a mandate that authorises
 * one payment. So the claim is taken here, inside the same critical section as
 * the check, and released again if the gateway call fails.
 *
 * There is deliberately no bypass flag.
 */
async function reserveMandateForTransaction(req) {
  if (malformedRequest(req)) {
    return recordDecision(req, { allowed: false, reason_code: REJECT_CODES.MALFORMED, reason: MALFORMED_REASON }, "mandate_validation");
  }

  let decision;
  try {
    decision = await enqueueWrite((store) => {
      const m = store[req.mandate_id];
      const verdict = evaluateBounds(m, req, Date.now());
      if (!verdict.allowed && verdict.reason_code === REJECT_CODES.NOT_FOUND && !m) {
        verdict.reason = `no mandate exists with id ${req.mandate_id}`;
      }
      // A single-use mandate leaves this critical section already claimed, so no
      // other request can clear it while the gateway call is outstanding.
      if (verdict.allowed && m.single_use) {
        m.status = "claimed";
        m.claimed_at = new Date().toISOString();
      }
      return verdict;
    });
  } catch (err) {
    // The claim could not be persisted. Refusing is the only safe answer: a claim
    // we failed to write is a claim another request would not see.
    logger.error("mandate_reserve_failed", { mandate_id: req.mandate_id, reason: err.message });
    return recordDecision(
      req,
      {
        allowed: false,
        reason_code: REJECT_CODES.MALFORMED,
        reason: `mandate could not be claimed because the mandate store could not be written (${err.message}); refusing rather than risking a double spend`,
      },
      "mandate_validation"
    );
  }

  return recordDecision(req, decision, "mandate_validation");
}

/** Consume a single-use mandate AFTER a successful bounded execution. */
async function consumeMandate(mandate_id, context = {}) {
  return enqueueWrite((store) => {
    const m = store[mandate_id];
    if (m && m.single_use && (m.status === "active" || m.status === "claimed")) {
      m.status = "consumed";
      m.claimed_at = m.claimed_at || null;
      m.consumed_at = new Date().toISOString();
      audit.append({
        agent_id: m.agent_id,
        mandate_id,
        action: "mandate_consumed",
        result: "ok",
        reason_code: "single_use_burned_after_success",
        reason: `mandate burned after successful transaction ${context.transaction_id || ""}`.trim(),
        amount_paise: context.amount_paise ?? null,
      });
    }
    return m;
  });
}

/**
 * Hand a claim back when the transaction it was taken for did not happen. An
 * order the gateway refused moved no money, so it must not cost the agent its
 * spending power — but the release has to be recorded, or the trail would show a
 * claim with nothing after it.
 */
async function releaseMandate(mandate_id, context = {}) {
  return enqueueWrite((store) => {
    const m = store[mandate_id];
    if (m && m.status === "claimed") {
      m.status = "active";
      m.claimed_at = null;
      audit.append({
        agent_id: m.agent_id,
        mandate_id,
        action: "mandate_released",
        result: "ok",
        reason_code: "claim_released_no_payment",
        reason: `claim released without spending: ${context.reason || "the transaction did not complete"}`,
        amount_paise: context.amount_paise ?? null,
        meta: context.meta || {},
      });
    }
    return m;
  });
}

module.exports = {
  createMandate: createMandateTx,
  validateMandateForTransaction,
  reserveMandateForTransaction,
  consumeMandate,
  releaseMandate,
  evaluateBounds,
  loadStore,
  REJECT_CODES,
};
