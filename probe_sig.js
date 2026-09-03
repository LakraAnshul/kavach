// PROBE: is every manifest field covered by the signature?
const { generatePassport, verifyPassport } = require("./src/passport/generator");

const g = generatePassport();
const m = JSON.parse(JSON.stringify(g.manifest));
console.log("baseline valid:", verifyPassport(m).valid);

const t1 = JSON.parse(JSON.stringify(g.manifest));
t1.signature_algorithm = "PLAINTEXT-NO-CRYPTO-LOL";
console.log("tampered signature_algorithm -> verify:", JSON.stringify(verifyPassport(t1)));

const t2 = JSON.parse(JSON.stringify(g.manifest));
t2.payload.merchant_id = "attacker-merchant";
console.log("tampered payload.merchant_id -> verify:", JSON.stringify(verifyPassport(t2)));

const t3 = JSON.parse(JSON.stringify(g.manifest));
t3.injected_field = "whatever";
console.log("added unknown top-level field -> verify:", JSON.stringify(verifyPassport(t3)));

// Is the signing key empty when PASSPORT_SIGNING_KEY is unset?
const { config } = require("./src/config");
console.log("passportSigningKey length:", config.passportSigningKey.length);
console.log("webhookSecret length:", config.razorpay.webhookSecret.length);
console.log("keysConfigured value:", JSON.stringify(config.keysConfigured), "typeof:", typeof config.keysConfigured);
