const { maskSecret } = require("./config");

const SECRET_PATTERNS = [
  /(key_secret["']?\s*[:=]\s*["']?)([^"'\s,}]+)/gi,
  /(key_id["']?\s*[:=]\s*["']?)(rzp_[^"'\s,}]+)/gi,
  /(authorization["']?\s*:\s*["']?)([^"'\s,}]+)/gi,
];

function scrub(value) {
  let out = String(value);
  for (const re of SECRET_PATTERNS) {
    out = out.replace(re, (_m, prefix) => `${prefix}${maskSecret(_m.slice(prefix.length).replace(/["']/g, ""))}`);
  }
  return out;
}

function line(level, event, data) {
  const entry = {
    ts: new Date().toISOString(),
    level,
    event,
    ...(data && typeof data === "object" ? data : { detail: data }),
  };
  const serialized = scrub(JSON.stringify(entry));
  (level === "error" ? console.error : console.log)(serialized);
}

module.exports = {
  info: (event, data) => line("info", event, data),
  warn: (event, data) => line("warn", event, data),
  error: (event, data) => line("error", event, data),
};
