const fs = require("fs");
const path = require("path");
const { config } = require("../config");

const AUDIT_FILE = path.join(config.dataDir, "audit.jsonl");

let chain = Promise.resolve();

function ensureFile() {
  // EDGE CASE: log file missing on startup -> auto-create, never crash
  if (!fs.existsSync(config.dataDir)) fs.mkdirSync(config.dataDir, { recursive: true });
  if (!fs.existsSync(AUDIT_FILE)) {
    // Created with the append flag, not writeFileSync. writeFileSync TRUNCATES an
    // existing file, so if anything created the log between the check above and this
    // line, the "create it if missing" step would silently erase a real trail. The
    // test suite spawns a second server process against the same file, which makes
    // that interleaving reachable rather than theoretical. Appending nothing to a
    // file that now exists is a no-op; append-only holds on every path.
    fs.appendFileSync(AUDIT_FILE, "");
    console.log(`[audit] created empty audit log at ${AUDIT_FILE}`);
  }
}

// ---------- human-readable rendering of a recorded decision ----------
// PRESENTATION ONLY. Derived from reason_code + amount_paise + meta on an entry that
// has already been decided. Never consulted by, and never able to influence, a verdict.
const INR = new Intl.NumberFormat("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const STAMP = new Intl.DateTimeFormat("en-IN", {
  day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false,
});

function rupees(paise) {
  return Number.isInteger(paise) ? "₹" + INR.format(paise / 100) : null;
}
function stamp(iso) {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? STAMP.format(new Date(t)) : "an unrecorded time";
}
function categories(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return "any category";
  if (arr.length === 1) return arr[0];
  return arr.slice(0, -1).join(", ") + " and " + arr[arr.length - 1];
}
function trimStop(s) {
  return String(s || "").replace(/[.;]+\s*$/, "");
}
// Older entries predate the meta fields below; their detail lives in the `reason` template.
function issueDetail(entry) {
  const meta = entry.meta || {};
  if (Number.isInteger(meta.max_spend_paise)) return meta;
  const m = /max_spend=(\d+)p, categories=\[([^\]]*)\], single_use=(true|false), expires=(\S+)/.exec(entry.reason || "");
  if (!m) return null;
  return {
    max_spend_paise: parseInt(m[1], 10),
    category_allowlist: m[2] ? m[2].split(",").map((s) => s.trim()).filter(Boolean) : [],
    single_use: m[3] === "true",
    expires: m[4],
  };
}

function humanReason(entry) {
  const e = entry || {};
  const meta = e.meta || {};
  const code = e.reason_code || "";
  const amount = rupees(e.amount_paise);
  const cap = rupees(meta.max_spend_paise);

  switch (code) {
    case "within_bounds":
      return `Allowed: ${amount || "the request"} cleared every mandate bound before any gateway call.`;
    case "within_bounds_executed":
      return `Approved: gateway order created for ${amount || "the request"} after the mandate cleared.`;
    case "mandate_exceeded":
      return cap && amount
        ? `Blocked: ${amount} requested against a ${cap} cap. No payment was attempted.`
        : "Blocked: the amount requested sits above this mandate's cap. No payment was attempted.";
    case "mandate_expired":
      return `Blocked: this mandate expired on ${stamp(meta.expired_at || e.ts)}. No payment was attempted.`;
    case "mandate_already_consumed":
      return `Blocked: this single-use mandate was already spent on ${stamp(meta.consumed_at)} and cannot be reused.`;
    case "mandate_revoked":
      return "Blocked: this mandate was explicitly revoked and can no longer authorize payments.";
    case "revoked_by_request":
      return "Revoked: this mandate was explicitly revoked by request and can no longer authorize payments.";
    case "mandate_already_terminal":
      return "Refused: this mandate is already in a terminal state and cannot be revoked.";
    case "mandate_in_flight":
      return `Blocked: another transaction claimed this single-use mandate at ${stamp(meta.claimed_at)} and is still settling. It authorises one payment only.`;
    case "claim_released_no_payment":
      return `Released: the claim on this mandate was handed back because ${trimStop(e.reason).replace(/^claim released without spending:\s*/, "") || "the transaction did not complete"}. No money moved, and the spending power is intact.`;
    case "category_not_allowed":
      return meta.requested_category
        ? `Blocked: "${meta.requested_category}" is not on this mandate's category allowlist.`
        : "Blocked: the requested category is not on this mandate's allowlist.";
    case "mandate_not_found":
      return "Blocked: no mandate with this ID is held by this agent.";
    case "mandate_malformed":
      return "Blocked: the request was missing required fields, so no mandate could be checked.";
    case "item_unavailable":
      return "Blocked: the requested item is out of stock in the signed catalog.";
    // Distinct from item_unavailable on purpose: in stock, but the merchant withdrew it
    // from sale. Calling that "out of stock" would misreport the merchant's own decision.
    case "item_not_for_sale":
      return "Blocked: the merchant marked this item as not for sale in the signed catalog, so it was not purchased.";
    case "created": {
      const d = issueDetail(e);
      if (!d) return "Issued: a scoped mandate was granted to this agent.";
      return `Issued: spend up to ${rupees(d.max_spend_paise)} on ${categories(d.category_allowlist)}, valid until ${stamp(d.expires)}.${d.single_use ? " Single use." : ""}`;
    }
    case "single_use_burned_after_success":
      return `Spent: this single-use mandate closed after ${amount ? "the " + amount + " order" : "the order"} went through. It cannot be reused.`;
    case "capture_failed":
      return "Failed on capture: the payment could not be captured after a retry. Recorded for reconciliation rather than dropped.";
    case "signature_invalid":
      return "Rejected: the webhook signature did not match, so the event was ignored.";
    // Catalog ingestion, added alongside the existing codes rather than in place of any.
    // The record shape is unchanged: merchant_id, version and product_count travel in
    // `meta`, which is what `meta` is for.
    case "catalog_accepted": {
      const who = meta.merchant_id ? `merchant "${meta.merchant_id}"` : "the merchant";
      const count = Number.isInteger(meta.product_count) ? `${meta.product_count} product${meta.product_count === 1 ? "" : "s"}` : "the catalog";
      const asVersion = Number.isInteger(meta.version) ? ` as catalog version ${meta.version}` : "";
      const replaced = Number.isInteger(meta.previous_version)
        ? ` Version ${meta.previous_version} is kept, so passports signed against it stay checkable.`
        : "";
      return `Ingested: ${count} accepted from ${who}${asVersion}.${replaced}`;
    }
    case "boot":
      return `Service started${/configured=true/.test(e.reason || "") ? " with Razorpay keys configured" : "; Razorpay keys are not configured yet"}. The append-only log continued from where it left off.`;
    default:
      break;
  }

  if (code.startsWith("order_creation_failed")) {
    return `Failed at the gateway: the mandate cleared, but Razorpay did not accept the order${amount ? " for " + amount : ""}. No money moved.`;
  }
  if (e.action === "webhook_received" && e.result === "ok") {
    return `Accepted: a signed webhook event${code ? ` (${code})` : ""} was recorded.`;
  }
  if (e.action === "corrupt_line") {
    return "Skipped: this line could not be parsed as JSON. It was left in place, untouched.";
  }
  // A refused upload is rejected, not "blocked" — nothing was attempted against a
  // mandate. It also has to state that nothing was written, because the useful fact for
  // whoever reads this later is that the previous catalog is still the live one.
  if (e.action === "catalog_ingested" && e.result === "fail") {
    const who = meta.merchant_id ? ` from "${meta.merchant_id}"` : "";
    const detail = trimStop(e.reason) || "the upload did not satisfy a required check";
    return `Rejected: the catalog upload${who} was refused because ${detail}. Nothing was written; the previous catalog is unchanged.`;
  }
  if (e.result === "fail") {
    return `Blocked: ${trimStop(e.reason) || "the request did not satisfy a required check"}.`;
  }
  const r = trimStop(e.reason);
  return r ? r.charAt(0).toUpperCase() + r.slice(1) + "." : "";
}

// GUARDRAIL: append-only. The only write primitive is append. No truncate/overwrite API exists.
function append(entry) {
  ensureFile();
  const record = {
    ts: new Date().toISOString(),
    agent_id: entry.agent_id || null,
    mandate_id: entry.mandate_id || null,
    action: entry.action,
    result: entry.result,
    reason_code: entry.reason_code || null,
    reason: entry.reason || "",
    amount_paise: Number.isInteger(entry.amount_paise) ? entry.amount_paise : null,
    meta: entry.meta || {},
  };
  // Additive field alongside reason_code/reason: the same decision, said in plain language.
  record.human_reason = entry.human_reason || humanReason(record);
  // Serialize writes through a promise chain -> simple lock against concurrent corruption
  chain = chain.then(
    () =>
      new Promise((resolve) => {
        fs.appendFile(AUDIT_FILE, JSON.stringify(record) + "\n", (err) => {
          if (err) console.error(`[audit] APPEND FAILED: ${err.message}`);
          resolve();
        });
      })
  );
  return chain;
}

function readAll() {
  ensureFile();
  const raw = fs.readFileSync(AUDIT_FILE, "utf8");
  return raw
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => {
      let entry;
      try {
        entry = JSON.parse(l);
      } catch {
        entry = { ts: null, action: "corrupt_line", result: "skipped", reason: l.slice(0, 80) };
      }
      // Entries written before human_reason existed get theirs computed at read time.
      // The file itself is never rewritten; append-only holds.
      if (entry.human_reason == null) entry.human_reason = humanReason(entry);
      return entry;
    });
}

/**
 * Wait until everything queued so far is actually on disk.
 *
 * append() stamps its timestamp synchronously and queues the write, so ordering in
 * the file is guaranteed — but the write itself lands later. A handler that responded
 * without waiting was telling the caller a decision had been recorded while it was
 * still only in memory, and a process that exited at that moment lost it. The trail
 * IS the deliverable on this rail, so the response waits for it.
 *
 * Awaiting the chain also covers appends made from inside the mandate engine's write
 * mutators, which no request handler has a handle on.
 */
function flush() {
  return chain;
}

/**
 * A pending append should survive the process going away. beforeExit runs while the
 * loop can still do async work; the signal handler covers Ctrl+C, which beforeExit
 * does not.
 *
 * The exit is bounded by a timer and never gated on the flush finishing. A handler
 * that simply awaited would make Ctrl+C hang for as long as a stuck disk write took —
 * trading a lost log line for a server the operator cannot stop, which is a worse
 * failure. The flush gets a short grace period and then the process goes.
 *
 * Platform note: on Windows only SIGINT is delivered to a Node listener. SIGTERM is
 * registered because it costs nothing and works everywhere else, but an external kill
 * on Windows terminates the process outright and no handler runs. The real durability
 * guarantee is the per-response `await audit.flush()` in the request handlers, not
 * this; this only narrows the window for anything still queued.
 */
const EXIT_FLUSH_GRACE_MS = 1000;

process.on("beforeExit", () => {
  // No exit forcing here: beforeExit already means the loop has nothing left to do, and
  // the returned promise keeps it alive just long enough for a queued write to land.
  flush().catch(() => {});
});

let exiting = false;
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    if (exiting) process.exit(130); // a second Ctrl+C means "go now"
    exiting = true;
    const done = () => process.exit(0);
    const timer = setTimeout(done, EXIT_FLUSH_GRACE_MS);
    timer.unref();
    flush().then(done, done);
  });
}

module.exports = { append, flush, readAll, humanReason, AUDIT_FILE };
