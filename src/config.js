require("dotenv").config();

// A non-numeric PORT would make parseInt return NaN, and app.listen(NaN) binds a
// random free port instead of failing — so the server reports a successful start on
// an address nothing is pointed at. Fall back to the documented default instead.
function readPort(raw) {
  const n = parseInt(raw || "", 10);
  return Number.isInteger(n) && n >= 0 && n <= 65535 ? n : 3000;
}

const config = {
  port: readPort(process.env.PORT),
  razorpay: {
    keyId: process.env.RAZORPAY_KEY_ID || "",
    keySecret: process.env.RAZORPAY_KEY_SECRET || "",
    webhookSecret: process.env.RAZORPAY_WEBHOOK_SECRET || "",
  },
  passportSigningKey: process.env.PASSPORT_SIGNING_KEY || "",
  // KAVACH_DATA_DIR lets the test suites run against their own store instead of the
  // demo's. Without it, `npm test` left its fixtures in the mandate store and the audit
  // trail the dashboard reads. Resolved once here, at load, which is why tests/_isolate.js
  // has to set the variable before anything requires this module.
  dataDir: process.env.KAVACH_DATA_DIR || require("path").join(__dirname, "..", "data"),
};

// Boolean(), not the bare && chain: with an empty keyId the chain evaluates to "" and
// /api/health reported keys_configured:"" — a falsy value that renders as blank rather
// than as a clear false.
config.keysConfigured = Boolean(
  config.razorpay.keyId &&
    !config.razorpay.keyId.includes("REPLACE_ME") &&
    config.razorpay.keySecret &&
    config.razorpay.keySecret !== "REPLACE_ME"
);

function maskSecret(value) {
  if (!value || typeof value !== "string") return "<empty>";
  if (value.length <= 8) return "***";
  return value.slice(0, 7) + "...***";
}

module.exports = { config, maskSecret };
