/* ═══════════════════════════════════════════════════════════════════════
   KAVACH TRUST RAIL — dashboard

   Presentation only. Nothing here validates, signs, or decides anything;
   it reads what the rail already recorded and renders it.

   Two rules from styles.css are enforced in the markup this file emits:
     · mono type for machine-authored strings, sans for human sentences
     · saturated colour only where a decision was actually made
   ═══════════════════════════════════════════════════════════════════════ */

const $ = (id) => document.getElementById(id);

const PAGE_EVENTS = 12; // table rows per page — fits 1366×768 without scrolling
const PAGE_RUNS = 6;    // runs per page in rail mode
const POLL_MS = 4000;

const state = {
  view: "passport",
  mode: "rail",
  page: 0,
  q: "",
  agent: "",
  result: "",
  action: "",
  selectedMerchant: "kavach-demo-merchant-001",
  merchants: [],
  sortDesc: true,
  entries: [],
  mandates: [],
  passport: null,
  seen: new Set(),
  fresh: new Set(),
  primed: false,
  open: new Set(),
  sig: { passport: null, mandates: null, audit: null, merchants: null },
};

/* ── formatting ───────────────────────────────────────────────────────── */

const INR = new Intl.NumberFormat("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const COUNT = new Intl.NumberFormat("en-IN");

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// Amounts are held as integer paise everywhere. This is the only place they
// are divided, and only to be looked at.
function rs(paise) {
  return Number.isInteger(paise) ? "₹" + INR.format(paise / 100) : null;
}

function pad(n, w = 2) {
  return String(n).padStart(w, "0");
}
// `new Date(null)` is the epoch, not an invalid date, so a corrupt log line
// with ts:null would otherwise render as 01 Jan 1970. Guard the falsy case.
function clock(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  return isNaN(d) ? "—" : `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}
function daystamp(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  return isNaN(d) ? "" : d.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
}
function rel(iso) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "—";
  const delta = t - Date.now();
  const a = Math.abs(delta);
  let n, unit;
  if (a < 60000) { n = Math.max(1, Math.round(a / 1000)); unit = "second"; }
  else if (a < 3600000) { n = Math.round(a / 60000); unit = "minute"; }
  else if (a < 86400000) { n = Math.round(a / 3600000); unit = "hour"; }
  else { n = Math.round(a / 86400000); unit = "day"; }
  return `${n} ${unit}${n === 1 ? "" : "s"} ${delta >= 0 ? "from now" : "ago"}`;
}

/* JSON syntax highlighting, ~20 lines instead of a CDN dependency.
   Everything outside a matched token is JSON structure only ({}[],: and
   whitespace) so it needs no escaping; strings and keys are escaped as
   they are emitted. */
function hljson(value) {
  const src = JSON.stringify(value, null, 2) ?? "null";
  return src.replace(
    /("(?:\\.|[^"\\])*")(\s*:)?|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|\b(true|false|null)\b/g,
    (m, str, colon, num, atom) => {
      if (str) {
        return colon
          ? `<span class="j-key">${esc(str)}</span>${esc(colon)}`
          : `<span class="j-str">${esc(str)}</span>`;
      }
      if (num) return `<span class="j-num">${num}</span>`;
      return `<span class="j-atom">${atom}</span>`;
    }
  );
}

async function jget(url, opts) {
  const res = await fetch(url, opts);
  return { status: res.status, body: await res.json().catch(() => null) };
}

/* ── aspects ──────────────────────────────────────────────────────────── */

const ALLOWED = ["pass", "ok", "success"];

// An outstanding mandate is spending power that has not been used yet: in
// block-signalling terms the section is set but nothing has entered it. That
// is a caution, not a clear — which is where the amber aspect earns its keep.
function aspectOf(e) {
  if (e.result === "fail") return "danger";
  if (e.result === "skipped") return "dormant";
  if (e.action === "server_start") return "dormant";
  if (e.action === "mandate_issued") return "caution";
  // A released claim succeeded at being undone, which is not the same as money
  // having moved. The section was set and then cleared with nothing passing
  // through it — amber, for the same reason an outstanding mandate is amber.
  if (e.action === "mandate_released") return "caution";
  if (ALLOWED.includes(e.result)) return "clear";
  return "dormant";
}
function isBurn(e) {
  return e.action === "mandate_consumed";
}
function glyphOf(aspect) {
  return aspect === "clear" ? "✓" : aspect === "danger" ? "■" : aspect === "caution" ? "◆" : "–";
}

function runVerdict(events) {
  const blocked = events.find((e) => e.action === "mandate_validation" && e.result === "fail");
  if (blocked) {
    return blocked.reason_code === "mandate_in_flight"
      ? { aspect: "danger", text: "refused · mandate already claimed" }
      : { aspect: "danger", text: "blocked at the bound" };
  }
  if (events.some((e) => e.result === "fail")) return { aspect: "danger", text: "failed at the gateway" };
  if (events.some((e) => e.action === "transaction" && e.result === "success")) {
    return { aspect: "clear", text: "cleared · order created" };
  }
  if (events.some(isBurn)) return { aspect: "clear", text: "spent and closed" };
  // A claim taken and handed back: the bound held, and it cost the agent nothing.
  if (events.some((e) => e.action === "mandate_released")) return { aspect: "caution", text: "claim released · nothing spent" };
  if (events.some((e) => e.action === "mandate_issued")) return { aspect: "caution", text: "issued · no attempt yet" };
  return { aspect: "dormant", text: events[0] ? events[0].action.replace(/_/g, " ") : "recorded" };
}

function systemVerdict(e) {
  if (e.action === "server_start") return "service started";
  if (e.action === "webhook_received") return e.result === "fail" ? "webhook rejected" : "webhook accepted";
  return String(e.action || "recorded").replace(/_/g, " ");
}

function keyOf(e) {
  return `${e.ts}|${e.action}|${e.reason_code || ""}`;
}

/* ── health ───────────────────────────────────────────────────────────── */

async function loadHealth() {
  const live = $("live");
  const text = live.querySelector(".live-text");
  try {
    const r = await jget("/api/health");
    if (r.body && r.body.ok) {
      const keyed = r.body.keys_configured;
      live.className = `live is-up ${keyed ? "aspect-clear" : "aspect-caution"}`;
      text.textContent = keyed ? "Service up · Razorpay keys set" : "Service up · Razorpay keys not set";
    } else {
      live.className = "live aspect-danger";
      text.textContent = "Service answered, but reports a fault";
    }
  } catch {
    live.className = "live aspect-danger";
    text.textContent = "Service unreachable on this port";
  }
}

/* ── passport ─────────────────────────────────────────────────────────── */

// Failure belongs in the interface, in the interface's voice — not in a
// browser alert box.
function showNotice(title, body, list) {
  const n = $("passport-notice");
  n.className = "notice aspect-danger";
  n.innerHTML = `
    <span class="dot" aria-hidden="true"></span>
    <div>
      <p class="notice-title">${esc(title)}</p>
      <p class="notice-body">${esc(body)}</p>
      ${list && list.length ? `<ul class="notice-list">${list.map((p) => `<li>${esc(p)}</li>`).join("")}</ul>` : ""}
    </div>`;
  n.hidden = false;
}

// A rejected entry arrives in one of two shapes: a list of absent fields, or a
// single field that holds a value the rule forbids. Say which, and say the rule.
function problemLine(p) {
  const sku = p.sku || "an unnamed item";
  if (Array.isArray(p.missing_fields) && p.missing_fields.length) {
    return `${sku} — missing ${p.missing_fields.join(", ")}`;
  }
  if (p.field) {
    return `${sku} — ${p.field} is ${JSON.stringify(p.value)}${p.rule ? `; it ${p.rule}` : ""}`;
  }
  return `${sku} — ${p.reason_code || "failed validation"}`;
}

async function loadMerchants() {
  try {
    const r = await jget("/api/merchants");
    state.merchants = (r.body && Array.isArray(r.body.merchants)) ? r.body.merchants : [];
    syncMerchantPicker();
  } catch {
    state.merchants = [];
  }
}

function syncMerchantPicker() {
  const sel = $("merchant-select");
  if (!sel) return;
  const list = state.merchants.length > 0
    ? state.merchants
    : [{ merchant_id: "kavach-demo-merchant-001", product_count: 3, current_version: 1 }];

  const curIds = list.map((m) => m.merchant_id).join("|");
  if (state.sig.merchants !== curIds) {
    state.sig.merchants = curIds;
    sel.innerHTML = "";
    for (const m of list) {
      const opt = document.createElement("option");
      opt.value = m.merchant_id;
      const count = Number.isInteger(m.product_count) ? ` (${m.product_count} SKUs, v${m.current_version || 1})` : "";
      opt.textContent = `${m.merchant_id}${count}`;
      sel.appendChild(opt);
    }
  }
  if (!list.some((m) => m.merchant_id === state.selectedMerchant)) {
    state.selectedMerchant = list[0]?.merchant_id || "kavach-demo-merchant-001";
  }
  sel.value = state.selectedMerchant;
}

async function generatePassport(btn) {
  if (btn) { btn.disabled = true; btn.textContent = "Signing…"; }
  const mid = state.selectedMerchant || "kavach-demo-merchant-001";
  try {
    const r = await jget("/api/passport/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ merchant_id: mid }),
    });
    if (r.status === 200) {
      $("passport-notice").hidden = true;
    } else {
      const problems = r.body?.error?.problems;
      showNotice(
        "The catalog was refused, so nothing was signed.",
        problems
          ? "Every listed item has to pass validation before a signature is issued. Fix these entries in the catalog and sign again."
          : r.body?.error?.message || "The server did not say why. Check its console output.",
        (problems || []).map(problemLine)
      );
    }
  } catch {
    showNotice("Could not reach the service.", "The signing request never completed. Confirm the server is running, then try again.");
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = btn.id === "regen" ? "Sign catalog" : "Sign the catalog"; }
    state.sig.passport = null;
    await loadPassport();
  }
}

async function loadPassport() {
  const mid = state.selectedMerchant || "kavach-demo-merchant-001";
  const r = await jget(`/api/passport?merchant_id=${encodeURIComponent(mid)}`);
  state.passport = r.body && r.body.exists ? r.body : null;
  renderPassport();
}

function renderPassport() {
  const p = state.passport;
  const empty = $("passport-empty");
  const body = $("passport-body");
  const regen = $("regen");

  if (!p) {
    empty.hidden = false;
    body.hidden = true;
    regen.hidden = true;
    $("count-passport").textContent = "—";
    state.sig.passport = "none";
    return;
  }

  const valid = !!(p.signature_status && p.signature_status.valid);
  const catalog = (p.manifest.payload && p.manifest.payload.catalog) || [];
  // The reason code is part of the cache key: the seal's wording now differs per
  // failure, so two different refusals of the same signature must not render as one.
  const sig = `${p.manifest.signature}|${valid}|${p.signature_status?.reason_code || ""}`;
  $("count-passport").textContent = COUNT.format(catalog.length);
  empty.hidden = true;
  body.hidden = false;
  regen.hidden = false;
  if (state.sig.passport === sig) return;
  state.sig.passport = sig;

  // ── the trust-proof moment
  const seal = $("seal");
  const hex = String(p.manifest.signature || "");
  const groups = hex.match(/.{1,8}/g) || [];
  const code = p.signature_status?.reason_code;

  // Each verdict has one cause, so each gets its own sentence. This map used to be
  // computed and then ignored, with the seal telling every failure "the manifest
  // changed after it was signed" — an accusation of tampering that is simply untrue
  // for a stale signature or an unconfigured server, and which would send whoever is
  // looking at it hunting for an attacker instead of the actual cause.
  const FAILURES = {
    signature_mismatch: {
      title: "Signature invalid",
      aspect: "danger",
      cause: "The manifest no longer matches its signature — something changed after it was signed. Treat this catalog as untrusted.",
    },
    missing_manifest_fields: {
      title: "Signature unverifiable",
      aspect: "danger",
      cause: "The manifest is missing fields that the signature is computed over, so there is nothing to verify against.",
    },
    malformed_manifest: {
      title: "Signature unverifiable",
      aspect: "danger",
      cause: "The stored passport could not be read as a manifest at all.",
    },
    unsupported_signature_algorithm: {
      title: "Signature unverifiable",
      aspect: "danger",
      cause: "The manifest names a signing algorithm this rail does not verify. Either the field was rewritten or the passport came from elsewhere.",
    },
    signature_scheme_outdated: {
      title: "Signature stale",
      aspect: "caution",
      cause: "This passport was signed before the algorithm field was brought inside the signature, so that field cannot be trusted. Nothing suggests tampering — sign the catalog again.",
    },
    signing_key_missing: {
      title: "Cannot verify",
      aspect: "caution",
      cause: "The server has no PASSPORT_SIGNING_KEY configured, so it cannot verify any signature. This is a server setting, not a problem with the catalog.",
    },
  };
  const failure = FAILURES[code] || {
    title: "Signature invalid",
    aspect: "danger",
    cause: "The server could not verify this manifest.",
  };

  seal.className = `seal ${valid ? "aspect-clear" : `aspect-${failure.aspect}`}`;
  seal.innerHTML = `
    <div class="seal-badge">
      <svg viewBox="0 0 32 32" aria-hidden="true">
        ${valid ? '<path d="M8 16.5 13.5 22 24 10.5" />' : '<path d="M10 10l12 12M22 10 10 22" />'}
      </svg>
    </div>
    <div class="seal-body">
      <h2 class="seal-title">${valid ? "Signature valid" : esc(failure.title)}</h2>
      <p class="seal-sub">${valid
        ? "The server recomputed the HMAC over the canonical manifest and it matched. An agent can price against this catalog."
        : `${esc(failure.cause)} <code>${esc(code || "unknown")}</code>`}</p>
      <dl class="seal-facts">
        <div><dt>Algorithm</dt><dd>${esc(p.manifest.signature_algorithm)}</dd></div>
        <div><dt>Version</dt><dd>${esc(p.manifest.passport_version)}</dd></div>
        <div><dt>Signed</dt><dd>${esc(clock(p.manifest.generated_at))} · ${esc(daystamp(p.manifest.generated_at))}</dd></div>
        <div><dt>Merchant</dt><dd>${esc(p.manifest.payload?.merchant_id || "—")}</dd></div>
      </dl>
    </div>
    <div class="seal-sig">
      <span class="seal-sig-label">signature · ${esc(hex.length)} hex characters</span>
      <div class="seal-sig-hex">${groups.map((g) => `<span>${esc(g)}</span>`).join("")}</div>
    </div>`;

  // ── one collapsible section per catalog item
  $("catalog").innerHTML = catalog
    .map((item, i) => {
      const ok = item.stock > 0;
      const aspect = ok ? "aspect-clear" : "aspect-caution";
      const dkey = `item:${item.id}`;
      return `
        <details class="item ${aspect} anim-in" data-dkey="${esc(dkey)}" ${state.open.has(dkey) ? "open" : ""} style="animation-delay:${i * 45}ms">
          <summary>
            <span class="dot" aria-hidden="true"></span>
            <span class="item-title">
              <span class="item-name">${esc(item.name)}</span>
              <code class="item-sku">${esc(item.id)}</code>
            </span>
            <span class="item-cat mono">${esc(item.category)}</span>
            <span class="item-price">${esc(rs(item.price_paise) || "—")}</span>
            <span class="item-stock">
              <span class="pill">${ok ? `${esc(COUNT.format(item.stock))} in stock` : "out of stock"}</span>
            </span>
          </summary>
          <div class="item-open">
            <dl class="terms">
              <div class="term"><dt>Returns</dt><dd>${esc(item.return_policy)}</dd></div>
              <div class="term"><dt>Refunds</dt><dd>${esc(item.refund_terms)}</dd></div>
            </dl>
            <pre class="json">${hljson(item)}</pre>
          </div>
        </details>`;
    })
    .join("");

  $("passport-json").innerHTML = hljson(p.manifest);
}

/* ── mandates ─────────────────────────────────────────────────────────── */

function renderMandates() {
  const list = state.mandates;
  const empty = $("mandates-empty");
  const body = $("mandates-body");
  $("count-mandates").textContent = COUNT.format(list.length);

  if (list.length === 0) {
    empty.hidden = false;
    body.hidden = true;
    state.sig.mandates = "none";
    return;
  }
  empty.hidden = true;
  body.hidden = false;

  const blocked = state.entries.filter((e) => e.action === "mandate_validation" && e.result === "fail");
  const blockedValue = blocked.reduce((s, e) => s + (e.amount_paise || 0), 0);
  const sig = list.map((m) => m.mandate_id + m.computed_status).join(",") + `|${blocked.length}|${blockedValue}`;
  if (state.sig.mandates === sig) return;
  state.sig.mandates = sig;

  const by = (s) => list.filter((m) => m.computed_status === s);
  // A claimed mandate is spending power that is live and mid-flight, so it belongs
  // in Active and it belongs in the ceiling. Dropping it into a group of its own
  // would make it vanish from both while the money it authorises is still moving.
  const active = by("active").concat(by("claimed"));
  const consumed = by("consumed");
  const expired = by("expired");
  const ceiling = active.reduce((s, m) => s + (m.max_spend_paise || 0), 0);

  // Four honest instruments. "Blocked at the bound" is the real value figure:
  // money an agent asked for and did not get.
  $("mandate-strip").innerHTML = `
    <div class="inst">
      <span class="inst-label">Mandates issued</span>
      <span class="inst-value">${COUNT.format(list.length)}</span>
      <span class="inst-note">across the whole record</span>
    </div>
    <div class="inst aspect-clear">
      <span class="inst-label">Active now</span>
      <span class="inst-value is-signal">${COUNT.format(active.length)}</span>
      <span class="inst-note">${COUNT.format(consumed.length)} spent · ${COUNT.format(expired.length)} lapsed</span>
    </div>
    <div class="inst">
      <span class="inst-label">Live ceiling</span>
      <span class="inst-value">${esc(rs(ceiling) || "₹0.00")}</span>
      <span class="inst-note">the most active agents could spend</span>
    </div>
    <div class="inst aspect-danger">
      <span class="inst-label">Blocked at the bound</span>
      <span class="inst-value is-signal">${esc(rs(blockedValue) || "₹0.00")}</span>
      <span class="inst-note">${COUNT.format(blocked.length)} attempt${blocked.length === 1 ? "" : "s"} refused</span>
    </div>`;

  const groups = [
    { key: "active", title: "Active", aspect: "aspect-clear", note: "Live spending power right now.", rows: active },
    { key: "consumed", title: "Consumed", aspect: "aspect-clear", note: "Single-use mandates that were spent successfully and closed.", rows: consumed },
    { key: "expired", title: "Lapsed", aspect: "aspect-dormant", note: "Past their expiry. They can no longer authorise anything.", rows: expired },
  ].filter((g) => g.rows.length > 0);

  $("mandate-groups").innerHTML = groups
    .map(
      (g) => `
      <section class="mgroup ${g.aspect}">
        <header class="mgroup-head">
          <span class="dot ${g.key === "consumed" ? "is-hollow" : ""}" aria-hidden="true"></span>
          <h3>${esc(g.title)}</h3>
          <span class="mgroup-count mono">${COUNT.format(g.rows.length)}</span>
          <p class="mgroup-note">${esc(g.note)}</p>
        </header>
        <div class="mrow-head mrow">
          <span>Mandate</span><span>Ceiling</span><span class="h-cats">Categories</span><span class="h-exp">Expiry</span><span class="num">Status</span>
        </div>
        <div class="mlist">${g.rows.map((m, i) => mandateRow(m, g.key, i)).join("")}</div>
      </section>`
    )
    .join("");
}

function mandateRow(m, group, i) {
  const live = group === "active";
  const claimed = m.computed_status === "claimed";
  const aspect = group === "expired" ? "aspect-dormant" : claimed ? "aspect-caution" : "aspect-clear";
  // Amber, not green: the authorisation is spoken for but the payment has not
  // landed yet. That is a caution, not a clear.
  const label = group === "expired" ? "lapsed" : claimed ? "in flight" : group;
  const expiry = live
    ? claimed
      ? `claimed ${rel(m.claimed_at || m.created_at)}`
      : `expires ${rel(m.expiry_timestamp)}`
    : group === "consumed"
      ? `spent ${rel(m.consumed_at || m.expiry_timestamp)}`
      : `expired ${rel(m.expiry_timestamp)}`;

  return `
    <article class="mrow ${aspect} ${live ? "is-live" : "is-past"} anim-in" style="animation-delay:${Math.min(i, 12) * 28}ms">
      <span class="m-id">
        <span class="dot ${group === "consumed" ? "is-hollow" : ""}" aria-hidden="true"></span>
        <span class="m-id-text">
          <code class="m-mdt">${esc(m.mandate_id)}</code>
          <span class="m-agent">${esc(m.agent_id)}${m.single_use ? " · single use" : " · reusable"}</span>
        </span>
      </span>
      <span>
        <span class="m-cap">${esc(rs(m.max_spend_paise) || "—")}</span>
        <span class="m-cap-note">issued ${esc(rel(m.created_at))}</span>
      </span>
      <span class="m-cats">${(m.category_allowlist || []).map((c) => `<span class="m-cat">${esc(c)}</span>`).join("")}</span>
      <span class="m-exp">
        ${esc(expiry)}
        <time class="m-exp-abs" datetime="${esc(m.expiry_timestamp)}">${esc(clock(m.expiry_timestamp))} · ${esc(daystamp(m.expiry_timestamp))}</time>
      </span>
      <span class="m-status">
        <span class="pill ${group === "consumed" ? "is-hollow" : ""}">${esc(label)}</span>
      </span>
    </article>`;
}

/* ── audit ────────────────────────────────────────────────────────────── */

async function loadAudit() {
  const r = await jget("/api/audit");
  const list = (r.body && r.body.entries) || [];

  // Anything that appeared since the last poll is marked so it can announce
  // itself once. The very first load primes the set without flashing.
  const fresh = new Set();
  if (state.primed) {
    for (const e of list) if (!state.seen.has(keyOf(e))) fresh.add(keyOf(e));
  }
  for (const e of list) state.seen.add(keyOf(e));
  state.primed = true;
  state.fresh = fresh;
  state.entries = list;
}

function filteredEntries() {
  const q = state.q.trim().toLowerCase();
  return state.entries.filter((e) => {
    if (state.agent === "__system__" ? !!e.agent_id : state.agent && e.agent_id !== state.agent) return false;
    if (state.action && e.action !== state.action) return false;
    if (state.result === "allowed" && !ALLOWED.includes(e.result)) return false;
    if (state.result === "blocked" && e.result !== "fail") return false;
    if (q) {
      const hay = [e.ts, e.agent_id, e.mandate_id, e.action, e.result, e.reason_code, e.reason, e.human_reason,
        JSON.stringify(e.meta || {})].join(" ").toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

function groupRuns(list) {
  const map = new Map();
  const order = [];
  list.forEach((e, i) => {
    const key = e.mandate_id ? `${e.agent_id || "system"}|${e.mandate_id}` : `sys|${e.ts}|${i}`;
    if (!map.has(key)) { map.set(key, []); order.push(key); }
    map.get(key).push(e);
  });
  return order.map((k) => ({ key: k, events: map.get(k) }));
}

function renderAudit() {
  const total = state.entries.length;
  $("count-audit").textContent = COUNT.format(total);

  const filtersOn = !!(state.q || state.agent || state.result || state.action);
  $("f-clear").hidden = !filtersOn;

  if (total === 0) {
    $("audit-empty").hidden = false;
    $("audit-nomatch").hidden = true;
    $("audit-rail").hidden = true;
    $("audit-table-wrap").hidden = true;
    $("pager").hidden = true;
    $("thesis").textContent = "Nothing recorded yet. Every decision this rail makes will land here as it happens.";
    state.sig.audit = "none";
    return;
  }
  $("audit-empty").hidden = true;

  // ── the thesis: the whole product, stated in numbers that are true
  // Both mandate_validation and transaction_attempt failures are refusals the
  // rail made before Razorpay was ever called, so both belong in this count.
  const blocked = state.entries.filter(
    (e) => (e.action === "mandate_validation" || e.action === "transaction_attempt") && e.result === "fail");
  const held = blocked.reduce((s, e) => s + (e.amount_paise || 0), 0);
  const cleared = state.entries.filter((e) => e.action === "transaction" && e.result === "success").length;
  $("thesis").innerHTML = blocked.length
    ? `<strong>${COUNT.format(blocked.length)} attempt${blocked.length === 1 ? "" : "s"} stopped before any gateway call</strong>, holding back ${esc(rs(held))}. ${COUNT.format(cleared)} cleared every bound and reached Razorpay.`
    : `${COUNT.format(total)} decisions recorded, every one inside its bounds. ${COUNT.format(cleared)} reached Razorpay.`;

  const rows = filteredEntries().slice().sort((a, b) =>
    state.sortDesc ? String(b.ts || "").localeCompare(String(a.ts || "")) : String(a.ts || "").localeCompare(String(b.ts || "")));

  if (rows.length === 0) {
    $("audit-nomatch").hidden = false;
    $("audit-rail").hidden = true;
    $("audit-table-wrap").hidden = true;
    $("pager").hidden = true;
    state.sig.audit = "nomatch:" + filtersOn;
    return;
  }
  $("audit-nomatch").hidden = true;

  const units = state.mode === "rail" ? groupRuns(rows) : rows;
  const per = state.mode === "rail" ? PAGE_RUNS : PAGE_EVENTS;
  const pages = Math.max(1, Math.ceil(units.length / per));
  state.page = Math.min(state.page, pages - 1);

  // Deliberately excludes state.fresh: once an arrival has played, the set
  // emptying must not count as a change, or every new entry would trigger a
  // second full re-render 4s later and the whole view would flicker mid-demo.
  const sig = [state.mode, state.page, state.q, state.agent, state.result, state.action, state.sortDesc,
    total, state.entries[total - 1]?.ts].join("¦");
  if (state.sig.audit === sig) return;
  state.sig.audit = sig;

  const slice = units.slice(state.page * per, state.page * per + per);
  if (state.mode === "rail") renderRail(slice);
  else renderTable(slice);

  $("audit-rail").hidden = state.mode !== "rail";
  $("audit-table-wrap").hidden = state.mode === "rail";

  const unit = state.mode === "rail" ? "runs" : "entries";
  $("pager").hidden = pages === 1;
  $("pager-text").textContent =
    `${slice.length} of ${units.length} ${unit} · page ${state.page + 1} of ${pages}` +
    (filtersOn ? ` · filtered from ${total} entries` : "");
  $("page-prev").disabled = state.page === 0;
  $("page-next").disabled = state.page >= pages - 1;
}

function renderRail(runs) {
  // The sort toggle lives in the table header but its state is shared, so the
  // caption has to describe the order actually on screen.
  const caption = `<p class="synced mono" style="margin-bottom:2px">${state.sortDesc ? "newest run first" : "oldest run first"} · each run reads top to bottom</p>`;
  $("audit-rail").innerHTML = caption + runs.map((run, i) => {
    // Runs are ordered by their newest event, but a run's own story reads
    // downward in the order it actually happened.
    const events = run.events.slice().sort((a, b) => String(a.ts || "").localeCompare(String(b.ts || "")));
    const system = !events[0].mandate_id;
    const v = system
      ? { aspect: aspectOf(events[0]), text: systemVerdict(events[0]) }
      : runVerdict(events);
    const anyFresh = events.some((e) => state.fresh.has(keyOf(e)));

    return `
      <article class="run ${system ? "is-system" : ""} ${"aspect-" + v.aspect} ${anyFresh ? "is-new" : "anim-in"}"
        ${anyFresh ? "" : `style="animation-delay:${Math.min(i, 8) * 40}ms"`}>
        <header class="run-head">
          <span class="dot" aria-hidden="true"></span>
          <span class="run-agent">${esc(system ? "system" : events[0].agent_id || "unattributed")}</span>
          ${system ? "" : `<code class="run-mdt">${esc(events[0].mandate_id)}</code>`}
          <span class="run-verdict">${esc(v.text)}</span>
          <time class="run-time" datetime="${esc(events[0].ts || "")}">${esc(clock(events[0].ts))}</time>
        </header>
        <ol class="track">${events.map(stopItem).join("")}</ol>
      </article>`;
  }).join("");
}

function stopItem(e) {
  const aspect = aspectOf(e);
  const amount = rs(e.amount_paise);
  const dkey = `stop:${keyOf(e)}`;
  const hasDetail = !!(e.reason || (e.meta && Object.keys(e.meta).length));

  return `
    <li class="stop aspect-${aspect} ${isBurn(e) ? "is-hollow" : ""}">
      <span class="stop-aspect" aria-hidden="true"></span>
      <div class="stop-record mono">
        <span class="stop-action">${esc(e.action)}</span>
        <span class="stop-code">${esc(e.reason_code || e.result)}</span>
        ${amount ? `<span class="stop-amount">${esc(amount)}</span>` : ""}
        <time class="stop-time" datetime="${esc(e.ts || "")}">${esc(clock(e.ts))}</time>
      </div>
      <p class="stop-human">${esc(e.human_reason || "")}</p>
      ${hasDetail ? `
      <details class="stop-detail" data-dkey="${esc(dkey)}" ${state.open.has(dkey) ? "open" : ""}>
        <summary>technical detail</summary>
        <div class="stop-detail-body">
          ${e.reason ? `<p class="stop-reason">${esc(e.reason)}</p>` : ""}
          ${e.meta && Object.keys(e.meta).length ? `<pre class="json">${hljson(e.meta)}</pre>` : ""}
        </div>
      </details>` : ""}
    </li>`;
}

function renderTable(rows) {
  $("audit-rows").innerHTML = rows.map((e, i) => {
    const aspect = aspectOf(e);
    const amount = rs(e.amount_paise);
    const isNew = state.fresh.has(keyOf(e));
    // A stagger delay is only for rows arriving as a group. A genuinely new
    // row keeps `arrive`'s own delay instead of inheriting the stagger.
    return `
      <tr class="aspect-${aspect} ${isNew ? "is-new" : "anim-in"}" ${isNew ? "" : `style="animation-delay:${Math.min(i, 14) * 22}ms"`}>
        <td class="c-time"><time datetime="${esc(e.ts || "")}">${esc(clock(e.ts))}</time><span>${esc(daystamp(e.ts))}</span></td>
        <td class="c-agent">${esc(e.agent_id || "system")}</td>
        <td class="c-mdt">${esc(e.mandate_id || "—")}</td>
        <td class="c-action">${esc(e.action)}</td>
        <td><span class="pill"><span class="pill-glyph" aria-hidden="true">${glyphOf(aspect)}</span>${esc(e.result)}</span></td>
        <td class="c-reason">
          <code class="c-code">${esc(e.reason_code || "—")}</code>
          <span class="c-human">${esc(e.human_reason || "")}</span>
        </td>
        <td class="c-amount ${amount ? "" : "is-nil"}">${esc(amount || "—")}</td>
      </tr>`;
  }).join("");
}

function syncFilterOptions() {
  const fill = (el, values, keep) => {
    const want = values.map((v) => v.value).join("|");
    if (el.dataset.built !== want) {
      el.dataset.built = want;
      const any = el.options[0];
      el.innerHTML = "";
      el.appendChild(any);
      for (const v of values) {
        const o = document.createElement("option");
        o.value = v.value;
        o.textContent = v.label;
        el.appendChild(o);
      }
      el.value = keep;
    }
    // If the kept value is no longer among the options the browser falls back
    // to "any", so the visible control and the filter state stay in step.
    return el.value;
  };

  const agents = [...new Set(state.entries.map((e) => e.agent_id).filter(Boolean))].sort();
  const opts = agents.map((a) => ({ value: a, label: a }));
  if (state.entries.some((e) => !e.agent_id)) opts.push({ value: "__system__", label: "system (no agent)" });
  state.agent = fill($("f-agent"), opts, state.agent);

  const actions = [...new Set(state.entries.map((e) => e.action).filter(Boolean))].sort();
  state.action = fill($("f-action"), actions.map((a) => ({ value: a, label: a.replace(/_/g, " ") })), state.action);
}

/* ── loading ──────────────────────────────────────────────────────────── */

async function loadRecords() {
  const [mandatesRes] = await Promise.all([jget("/api/mandates"), loadAudit()]);
  state.mandates = (mandatesRes.body && mandatesRes.body.mandates) || [];
  syncFilterOptions();
  renderMandates();
  renderAudit();
}

async function refreshAll() {
  // Each section settles on its own. A server restarted mid-demo must not take
  // the page down with it, and must not leave an unhandled rejection behind on
  // every poll. Whatever was last read successfully stays on screen.
  const results = await Promise.allSettled([loadHealth(), loadMerchants(), loadPassport(), loadRecords()]);
  const ok = results.every((r) => r.status === "fulfilled");
  const now = new Date();
  const t = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
  // #live already says *why* the service is unreachable, so this line only
  // carries the time. One job each.
  const el = $("synced");
  el.classList.toggle("is-stale", !ok);
  el.textContent = ok ? `synced ${t}` : `sync failed ${t}`;
}

/* ── navigation ───────────────────────────────────────────────────────── */

const tabs = [...document.querySelectorAll(".nav-item")];

function moveThumb() {
  const on = document.querySelector(".nav-item.is-on");
  const thumb = $("nav-thumb");
  if (!on) return;
  if (window.innerWidth > 900) {
    thumb.style.width = "2px";
    thumb.style.height = `${on.offsetHeight}px`;
    thumb.style.transform = `translateY(${on.offsetTop}px)`;
  } else {
    thumb.style.width = `${on.offsetWidth}px`;
    thumb.style.height = "";
    thumb.style.transform = `translateX(${on.offsetLeft}px)`;
  }
  thumb.style.opacity = "1";
}

function selectView(name, focus) {
  state.view = name;
  tabs.forEach((t) => {
    const on = t.dataset.view === name;
    t.classList.toggle("is-on", on);
    t.setAttribute("aria-selected", String(on));
    t.tabIndex = on ? 0 : -1;
    if (on && focus) t.focus();
  });
  document.querySelectorAll(".view").forEach((v) => { v.hidden = v.id !== `view-${name}`; });
  moveThumb();
}

tabs.forEach((t) => t.addEventListener("click", () => selectView(t.dataset.view)));

$("nav").addEventListener("keydown", (ev) => {
  const dir = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }[ev.key];
  if (!dir) return;
  ev.preventDefault();
  const i = tabs.findIndex((t) => t.classList.contains("is-on"));
  selectView(tabs[(i + dir + tabs.length) % tabs.length].dataset.view, true);
});

window.addEventListener("resize", moveThumb);

/* ── audit controls ───────────────────────────────────────────────────── */

document.querySelectorAll(".seg-btn").forEach((b) =>
  b.addEventListener("click", () => {
    if (state.mode === b.dataset.mode) return;
    state.mode = b.dataset.mode;
    state.page = 0;
    document.querySelectorAll(".seg-btn").forEach((o) => {
      const on = o === b;
      o.classList.toggle("is-on", on);
      o.setAttribute("aria-pressed", String(on));
    });
    renderAudit();
  })
);

function onFilterChange() {
  state.q = $("f-q").value;
  state.agent = $("f-agent").value;
  state.result = $("f-result").value;
  state.action = $("f-action").value;
  state.page = 0;
  renderAudit();
}
["f-q", "f-agent", "f-result", "f-action"].forEach((id) => {
  $(id).addEventListener("input", onFilterChange);
  $(id).addEventListener("change", onFilterChange);
});

function clearFilters() {
  $("f-q").value = "";
  $("f-agent").value = "";
  $("f-result").value = "";
  $("f-action").value = "";
  onFilterChange();
}
$("f-clear").addEventListener("click", clearFilters);
$("nomatch-clear").addEventListener("click", clearFilters);

$("sort-ts").addEventListener("click", () => {
  state.sortDesc = !state.sortDesc;
  state.page = 0;
  $("sort-ts").classList.toggle("is-asc", !state.sortDesc);
  renderAudit();
});

$("page-prev").addEventListener("click", () => { state.page = Math.max(0, state.page - 1); renderAudit(); });
$("page-next").addEventListener("click", () => { state.page += 1; renderAudit(); });

/* Remember which disclosures are open so a background poll never closes one. */
document.addEventListener("toggle", (ev) => {
  const key = ev.target && ev.target.dataset && ev.target.dataset.dkey;
  if (!key) return;
  if (ev.target.open) state.open.add(key);
  else state.open.delete(key);
}, true);

$("refresh").addEventListener("click", refreshAll);
$("generate").addEventListener("click", (ev) => generatePassport(ev.currentTarget));
$("regen").addEventListener("click", (ev) => generatePassport(ev.currentTarget));
const merchantSel = $("merchant-select");
if (merchantSel) {
  merchantSel.addEventListener("change", (ev) => {
    state.selectedMerchant = ev.target.value;
    state.sig.passport = null;
    loadPassport();
  });
}

/* ── boot ─────────────────────────────────────────────────────────────── */

selectView("passport");
refreshAll();
setInterval(refreshAll, POLL_MS);

// The nav items change height once the web fonts swap in, so the sliding
// marker has to be measured again afterwards.
if (document.fonts && document.fonts.ready) document.fonts.ready.then(moveThumb);
