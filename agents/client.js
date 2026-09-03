const BASE = process.env.KAVACH_BASE_URL || "http://localhost:3000";

async function api(method, pathStr, body) {
  const res = await fetch(BASE + pathStr, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    json = { raw: "non-json response" };
  }
  return { status: res.status, ok: res.ok, body: json };
}

function paise(n) {
  return `Rs ${(n / 100).toFixed(2)}`;
}

module.exports = { api, paise };
