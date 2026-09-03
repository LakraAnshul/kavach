/**
 * WEBHOOK SIGNATURE — the endpoint has to behave the way Razorpay actually calls it.
 *
 * Razorpay posts webhooks with `Content-Type: application/json`. That detail is the
 * whole point of this test: a JSON body parser mounted ahead of the route will
 * consume the body and hand the handler a parsed object, while the signature is
 * computed over the exact bytes that were sent. When that happens the endpoint
 * stops distinguishing a signed event from a forged one — both error out
 * identically — and the security event never gets recorded.
 *
 * So every case below pins the header Razorpay really sends, not one that happens
 * to leave the raw body intact.
 *
 * Boots its own server on PORT 3011 so it never disturbs a demo on 3000.
 */
require("./_isolate"); // first: fixes the data directory before src/config resolves it
const assert = require("assert");
const crypto = require("crypto");
const path = require("path");
const { spawn } = require("child_process");

require("dotenv").config();

const PORT = process.env.KAVACH_TEST_PORT || "3011";
const BASE = `http://localhost:${PORT}`;
const SECRET = process.env.RAZORPAY_WEBHOOK_SECRET || "";

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

function sign(body) {
  return crypto.createHmac("sha256", SECRET).update(body).digest("hex");
}

async function postWebhook(body, signature, contentType = "application/json") {
  const headers = { "Content-Type": contentType };
  if (signature !== null) headers["X-Razorpay-Signature"] = signature;
  const res = await fetch(`${BASE}/api/webhooks/razorpay`, { method: "POST", headers, body });
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function waitForServer(child, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`server exited early with code ${child.exitCode}`);
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`server did not become healthy on ${BASE} within ${timeoutMs}ms`);
}

async function run() {
  if (!SECRET) {
    console.error("FAIL  RAZORPAY_WEBHOOK_SECRET is not set in .env; cannot exercise signature verification");
    process.exit(1);
  }

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

  try {
    await waitForServer(child);
  } catch (e) {
    console.error(`FAIL  ${e.message}`);
    if (stderr) console.error(stderr.split("\n").slice(0, 6).join("\n"));
    child.kill();
    process.exit(1);
  }

  const event = JSON.stringify({
    event: "payment.captured",
    payload: { payment: { entity: { id: "pay_test_webhook", amount: 349900, currency: "INR" } } },
  });

  await check("valid signature, Content-Type application/json -> 200 accepted", async () => {
    const r = await postWebhook(event, sign(event));
    assert.equal(
      r.status,
      200,
      `a correctly signed Razorpay webhook was not accepted (HTTP ${r.status}, body ${JSON.stringify(r.body)}). ` +
        `This is the exact content type Razorpay sends, so this failing means no real webhook is ever processed.`
    );
    assert.equal(r.body && r.body.received, true, "an accepted webhook must acknowledge receipt");
  });

  await check("invalid signature -> 403 rejected, never 500", async () => {
    const r = await postWebhook(event, "deadbeef".repeat(8));
    assert.equal(
      r.status,
      403,
      `a forged webhook returned HTTP ${r.status} instead of 403 (body ${JSON.stringify(r.body)}); ` +
        `a 500 here means the signature was never actually compared`
    );
    assert.equal(r.body && r.body.decision, "rejected");
    assert.ok(r.body && r.body.explanation, "a rejection must explain itself");
  });

  await check("tampered body with an otherwise-valid signature -> 403", async () => {
    const sig = sign(event);
    const tampered = event.replace('"amount":349900', '"amount":1');
    assert.notEqual(tampered, event, "the tamper must actually change the body");
    const r = await postWebhook(tampered, sig);
    assert.equal(r.status, 403, `a body edited after signing was accepted with HTTP ${r.status}`);
  });

  await check("missing signature header -> 403", async () => {
    const r = await postWebhook(event, null);
    assert.equal(r.status, 403, `an unsigned webhook returned HTTP ${r.status} instead of 403`);
  });

  await check("empty body with a signature over it -> not a 500", async () => {
    const r = await postWebhook("", sign(""));
    assert.ok(
      r.status === 400 || r.status === 403,
      `an empty signed body should be refused as bad input or bad signature, got HTTP ${r.status}`
    );
  });

  await check("valid signature over a non-JSON body -> 400, not 500", async () => {
    const notJson = "this is not json";
    const r = await postWebhook(notJson, sign(notJson));
    assert.equal(
      r.status,
      400,
      `a signed but unparseable payload returned HTTP ${r.status}; a verified sender sending junk is bad input, not a server fault`
    );
  });

  await check("the rejection was recorded as a security event in the audit trail", async () => {
    const res = await fetch(`${BASE}/api/audit`);
    const { entries } = await res.json();
    const rejection = entries
      .filter((e) => e.action === "webhook_received" && e.reason_code === "signature_invalid")
      .pop();
    assert.ok(rejection, "a refused webhook must leave a signature_invalid entry in the append-only record");
    assert.equal(rejection.result, "fail");
    assert.equal(rejection.meta && rejection.meta.security_event, true, "it must be flagged as a security event");
    assert.ok(rejection.human_reason, "the entry must carry a plain-language reason like every other entry");
  });

  child.kill();
  console.log(failures === 0 ? "\nALL WEBHOOK TESTS PASSED" : `\n${failures} TEST(S) FAILED`);
  // exitCode, not process.exit(). Calling process.exit() while the killed child's
  // handles are still closing aborts the process on Node 24 for Windows —
  // "Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), src\win\async.c" — which
  // exits 127 and made run_all.js report this suite as FAILED on a run where every
  // assertion above had passed. Setting the code and letting the loop drain naturally
  // reports the same verdict without racing libuv's teardown.
  process.exitCode = failures === 0 ? 0 : 1;
}

run().catch((e) => {
  console.error("webhook test harness crashed:", e.message);
  process.exit(1);
});
