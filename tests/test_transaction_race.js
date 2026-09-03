/**
 * TRANSACTION RACE, OVER REAL HTTP — the bound must hold on the path that actually
 * moves money.
 *
 * Why this file exists alongside test_concurrency.js. That suite drives the mandate
 * engine directly, which makes it a precise, fast test of the engine's atomicity —
 * but it cannot see the route. The double-spend this project actually had lived in
 * src/server.js: it checked the bound, called the gateway, and only then burned the
 * mandate. An engine-level test written against the fixed engine would stay green
 * through exactly that regression, because nothing forces the route to keep using the
 * atomic gate. So these cases go through POST /api/transactions over the wire, with
 * the real Razorpay call in the middle, and assert on what the agent is actually told.
 *
 * Boots its own server on PORT 3012 so it never disturbs a demo on 3000.
 * Non-destructive: creates its own mandates under unique agent ids, deletes nothing.
 */
require("./_isolate"); // first: fixes the data directory before src/config resolves it
const assert = require("assert");
const path = require("path");
const { spawn } = require("child_process");

require("dotenv").config();

const PORT = process.env.KAVACH_RACE_TEST_PORT || "3012";
const BASE = `http://localhost:${PORT}`;
const CAP = 100000; // ₹1000.00
const RACERS = 6;

let failures = 0;
async function check(name, fn) {
  try {
    await fn();
    console.log(`PASS  ${name}`);
  } catch (e) {
    failures++;
    console.error(`FAIL  ${name}: ${e.message}`);
  }
}

async function post(route, body) {
  const res = await fetch(`${BASE}${route}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function get(route) {
  const res = await fetch(`${BASE}${route}`);
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function makeMandate(agent_id, { single_use = true, max_spend_paise = CAP, categories = ["electronics"] } = {}) {
  const r = await post("/api/mandates", {
    agent_id,
    max_spend_paise,
    category_allowlist: categories,
    expiry_timestamp: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    single_use,
  });
  assert.equal(r.status, 201, `mandate creation failed: HTTP ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
}

async function mandateById(mandate_id) {
  const r = await get("/api/mandates");
  assert.equal(r.status, 200, `mandate listing failed with HTTP ${r.status}`);
  return r.body.mandates.find((m) => m.mandate_id === mandate_id);
}

async function waitForServer(child, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`server exited early with code ${child.exitCode}`);
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) return res.json();
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`server did not become healthy on ${BASE} within ${timeoutMs}ms`);
}

async function run() {
  const child = spawn(process.execPath, [path.join(__dirname, "..", "src", "server.js")], {
    env: { ...process.env, PORT },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (c) => (stderr += c.toString()));
  child.on("error", (e) => {
    console.error(`FAIL  could not spawn server: ${e.message}`);
    process.exit(1);
  });

  let health;
  try {
    health = await waitForServer(child);
  } catch (e) {
    console.error(`FAIL  ${e.message}`);
    if (stderr) console.error(stderr.split("\n").slice(0, 6).join("\n"));
    child.kill();
    process.exit(1);
  }

  const keysConfigured = health.keys_configured === true;
  if (!keysConfigured) {
    // Without real test keys the gateway call fails immediately, so there is barely a
    // window for a second request to race into. The invariants below still hold and are
    // still worth asserting — but "exactly one approval" cannot be demonstrated, so say
    // so rather than reporting a pass that proved less than it appears to.
    console.log("NOTE  RAZORPAY_KEY_ID/SECRET are not configured; the race window is near zero.");
    console.log("NOTE  Asserting the safety invariants only — set real test keys to exercise the full race.");
  }

  await check(`${RACERS} concurrent transactions on one single-use mandate never authorise twice`, async () => {
    const m = await makeMandate("race-single");
    const results = await Promise.all(
      Array.from({ length: RACERS }, () =>
        post("/api/transactions", { agent_id: "race-single", mandate_id: m.mandate_id, amount_paise: CAP, category: "electronics" })
      )
    );

    const approved = results.filter((r) => r.body && r.body.decision === "approved");
    const authorised = approved.length * CAP;

    // The invariant that matters: one single-use mandate, at most one authorisation.
    assert.ok(
      approved.length <= 1,
      `${approved.length} of ${RACERS} concurrent requests were approved against ONE single-use mandate. ` +
        `That authorises ${authorised} paise against a ${CAP} paise bound. ` +
        `Statuses: ${JSON.stringify(results.map((r) => r.status))}`
    );
    assert.ok(authorised <= CAP, `${authorised} paise authorised against a ${CAP} paise cap`);

    if (keysConfigured) {
      assert.equal(
        approved.length,
        1,
        `with a live gateway call in the window, exactly one request should win. Got ${approved.length}. ` +
          `Bodies: ${JSON.stringify(results.map((r) => r.body && (r.body.decision || r.body.error)))}`
      );
    }

    // Every refusal has to say why, in a reason code and in words.
    for (const r of results.filter((x) => !x.body || x.body.decision !== "approved")) {
      const b = r.body || {};
      assert.ok(
        b.reason_code || (b.error && b.error.code),
        `a refused request carried no reason code (HTTP ${r.status}, body ${JSON.stringify(b)})`
      );
      assert.ok(b.explanation || (b.error && b.error.message), `a refused request carried no explanation (HTTP ${r.status})`);
    }
  });

  await check("the losing requests are told the mandate is contested, not that they are malformed", async () => {
    if (!keysConfigured) return; // needs a real window for a request to lose inside
    const m = await makeMandate("race-codes");
    const results = await Promise.all(
      Array.from({ length: RACERS }, () =>
        post("/api/transactions", { agent_id: "race-codes", mandate_id: m.mandate_id, amount_paise: CAP, category: "electronics" })
      )
    );
    const refusals = results.filter((r) => !r.body || r.body.decision !== "approved");
    assert.ok(refusals.length >= 1, "at least one request must lose the race");
    for (const r of refusals) {
      const code = r.body && r.body.reason_code;
      assert.ok(
        code === "mandate_in_flight" || code === "mandate_already_consumed",
        `a losing request was refused as "${code}" (HTTP ${r.status}); it should be told the mandate is claimed or spent`
      );
      // 409, not 403: the request lost a race rather than breaking a rule, and a
      // retry against a different mandate is a reasonable next move.
      if (code === "mandate_in_flight") {
        assert.equal(r.status, 409, `an in-flight refusal returned HTTP ${r.status} instead of 409`);
      }
    }
  });

  await check("no claim is left dangling after the race settles", async () => {
    const m = await makeMandate("race-dangling");
    await Promise.all(
      Array.from({ length: RACERS }, () =>
        post("/api/transactions", { agent_id: "race-dangling", mandate_id: m.mandate_id, amount_paise: CAP, category: "electronics" })
      )
    );
    const after = await mandateById(m.mandate_id);
    assert.ok(after, "the mandate must still be listed after the race");
    assert.notEqual(
      after.computed_status,
      "claimed",
      `the mandate is still "claimed" after every request finished; a dangling claim bricks a mandate that may never have paid for anything`
    );
    assert.ok(
      ["consumed", "active"].includes(after.computed_status),
      `unexpected settled status "${after.computed_status}"`
    );
  });

  await check("a refused order releases the claim, so the mandate can be used again", async () => {
    if (!keysConfigured) return; // the gateway has to actually refuse this one
    // Razorpay's minimum order is 100 paise. A 1-paise order clears every mandate
    // bound and is then refused by the gateway — which is exactly the case where the
    // claim must be handed back, because no money moved.
    const m = await makeMandate("race-release", { max_spend_paise: CAP });
    const refused = await post("/api/transactions", {
      agent_id: "race-release", mandate_id: m.mandate_id, amount_paise: 1, category: "electronics",
    });
    assert.equal(refused.status, 500, `expected the gateway to refuse a 1-paise order, got HTTP ${refused.status} ${JSON.stringify(refused.body)}`);
    assert.equal(refused.body.mandate_consumed, false, "a refused order must not report the mandate as consumed");

    const after = await mandateById(m.mandate_id);
    assert.equal(after.computed_status, "active", `a refused order left the mandate "${after.computed_status}" instead of active`);

    // And the spending power really is intact, not just labelled that way.
    const retry = await post("/api/transactions", {
      agent_id: "race-release", mandate_id: m.mandate_id, amount_paise: CAP, category: "electronics",
    });
    assert.equal(
      retry.body && retry.body.decision,
      "approved",
      `after a refused order the mandate could not be reused: HTTP ${retry.status} ${JSON.stringify(retry.body)}`
    );
  });

  await check("the route still enforces every bound before calling the gateway", async () => {
    const m = await makeMandate("race-bounds", { max_spend_paise: 50000 });

    const over = await post("/api/transactions", {
      agent_id: "race-bounds", mandate_id: m.mandate_id, amount_paise: 50001, category: "electronics",
    });
    assert.equal(over.status, 403, `an over-cap request returned HTTP ${over.status}`);
    assert.equal(over.body.reason_code, "mandate_exceeded");
    assert.ok(/no payment was attempted/i.test(over.body.note || ""), "the refusal must state that no payment was attempted");

    const wrongCat = await post("/api/transactions", {
      agent_id: "race-bounds", mandate_id: m.mandate_id, amount_paise: 100, category: "gambling",
    });
    assert.equal(wrongCat.status, 403);
    assert.equal(wrongCat.body.reason_code, "category_not_allowed");

    const wrongOwner = await post("/api/transactions", {
      agent_id: "race-someone-else", mandate_id: m.mandate_id, amount_paise: 100, category: "electronics",
    });
    assert.equal(wrongOwner.status, 403);
    assert.equal(wrongOwner.body.reason_code, "mandate_not_found");

    // None of those refusals may have spent the mandate.
    const after = await mandateById(m.mandate_id);
    assert.equal(after.computed_status, "active", `refused requests left the mandate "${after.computed_status}"`);
  });

  await check("a quantity that is present but unusable is refused, not silently priced as one", async () => {
    const m = await makeMandate("race-qty", { max_spend_paise: 10000000, categories: ["electronics"] });
    for (const bad of [0, -2, 2.5, "3", null]) {
      const r = await post("/api/transactions", {
        agent_id: "race-qty", mandate_id: m.mandate_id, item_id: "sku-mech-keyboard", quantity: bad,
      });
      assert.equal(
        r.status,
        400,
        `quantity ${JSON.stringify(bad)} was accepted (HTTP ${r.status} ${JSON.stringify(r.body)}); the server must not choose a different amount than the caller asked for`
      );
    }
  });

  await check("mandate_consumed reports what actually happened to the mandate", async () => {
    if (!keysConfigured) return; // needs a successful order to report on
    const m = await makeMandate("race-reusable-report", { single_use: false, max_spend_paise: CAP });
    const r = await post("/api/transactions", {
      agent_id: "race-reusable-report", mandate_id: m.mandate_id, amount_paise: CAP, category: "electronics",
    });
    assert.equal(r.body && r.body.decision, "approved", `expected approval, got ${JSON.stringify(r.body)}`);
    assert.equal(
      r.body.mandate_consumed,
      false,
      "a reusable mandate is deliberately not consumed, so the response must not claim it was"
    );
    const after = await mandateById(m.mandate_id);
    assert.equal(after.computed_status, "active", "a reusable mandate stays active after a successful transaction");
  });

  await check("every decision reached the append-only trail before the response returned", async () => {
    const m = await makeMandate("race-durable", { max_spend_paise: 50000 });
    const refused = await post("/api/transactions", {
      agent_id: "race-durable", mandate_id: m.mandate_id, amount_paise: 999999, category: "electronics",
    });
    assert.equal(refused.status, 403);
    // Read the trail immediately. If appends were still only queued in memory, the
    // entry would not be here yet — and a decision that is not written down is not
    // auditable, which is the one thing this rail exists to provide.
    const { body } = await get("/api/audit");
    const entry = body.entries.filter((e) => e.mandate_id === m.mandate_id && e.reason_code === "mandate_exceeded").pop();
    assert.ok(entry, "the refusal was not in the trail immediately after the response returned");
    assert.ok(entry.human_reason, "the entry must carry a plain-language reason");
  });

  child.kill();
  console.log(failures === 0 ? "\nALL TRANSACTION RACE TESTS PASSED" : `\n${failures} TEST(S) FAILED`);
  // exitCode, not process.exit(); see the same note in test_webhook.js. This suite kills
  // a spawned server the same way, so it carried the same latent abort.
  process.exitCode = failures === 0 ? 0 : 1;
}

run().catch((e) => {
  console.error("transaction race harness crashed:", e.message);
  process.exit(1);
});
