# Kavach — Agentic Commerce Trust Rail

Razorpay Builderthon Track 01. Infra layer between merchants and AI buyer agents:
**signed merchant passports · scoped payment mandates · bounded transaction execution · append-only audit trail** on Razorpay test-mode APIs.

## Setup

```
npm install
cp .env.example .env        # paste your rzp_test_... keys
npm start                   # server on http://localhost:3000
```

`.env` keys: `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`, `PASSPORT_SIGNING_KEY`.
Keys never appear in logs (logger scrubs/masks them). `.gitignore` excludes `.env`.

## 3-minute demo flow

```
# terminal 1
npm start

# terminal 2 — happy path buyer (mandate -> passport-priced order)
npm run agent:a

# terminal 3 — overspend attacker (blocked BEFORE any gateway call)
npm run agent:b

# terminal 4 — category mismatch buyer against second merchant (blocked BEFORE any gateway call)
npm run agent:c

# browser
http://localhost:3000   # Passport / Mandates / Audit Trail tabs
```

## Tests

```
npm test                 # all seven suites, sequentially
```

Or individually:

```
npm run test:passport        # tamper every field -> verification must break each time
npm run test:mandates        # expired / exceeded / category / reuse / malformed / happy path
npm run test:concurrency     # engine: a single-use mandate must not clear twice when requests race
npm run test:race            # HTTP: the same race through POST /api/transactions, real gateway in the middle
npm run test:webhook         # signature verification against the Content-Type Razorpay really sends
npm run test:ingestion       # catalog upload: validation, versioning, file types, size limits, path traversal
npm run test:multimerchant   # two merchants sharing a product id must price independently
```

`test:concurrency` and `test:race` are deliberately both here. The first drives the mandate
engine directly, so a red result points straight at the engine. The second goes over the wire
through `POST /api/transactions`, because the double-spend this project actually had lived in
the route rather than the engine — an engine-level test cannot see whether the route still uses
the atomic gate at all.

Every suite is non-destructive, and now isolated: each one points `KAVACH_DATA_DIR` at its
own `tests/.tmp-data/<suite>/` directory, so it never writes to the mandate store or the
append-only audit trail the demo reads. Before that, `npm test` left its fixtures in the
dashboard's Mandates tab and dozens of test decisions in the trail — and because the suites
end in `process.exit()`, how many of those landed varied per run, so the demo's evidence was
polluted *and* nondeterministic. `test:webhook` boots its own server on port 3011,
`test:race` on 3012, `test:ingestion` on 3013 and `test:multimerchant` on 3014, rather than
touching the one on 3000.
`test:race` needs real test keys for its full assertions; without them it says so and falls
back to the safety invariants, rather than reporting a pass that proved less than it looks like.

`test:multimerchant` is the suite for the pricing source. It has two merchants ingest a catalog
containing **the same product id at different prices**, then sends the same transaction request
twice, differing only in `merchant_id`. Its prices are read out of over-cap refusals rather than
approvals — the rail states the amount it computed and refuses before any gateway call — so the
assertions are exact and need no network. If anything shared sits between the two merchants, both
requests price identically and the suite goes red.

## API

| Route | Purpose |
|---|---|
| `POST /api/merchants/:merchant_id/catalog` | ingest a catalog as a **new version** — JSON array body, or a multipart `.json`/`.csv` upload (2 MB max, 500 products max). All-or-nothing: 400 lists every failing product and field and nothing is written; 413 over the size limit |
| `GET /api/merchants` | merchants with an ingested catalog: product count, current version, versions on record, last updated |
| `GET /api/merchants/:merchant_id/catalog` | read a stored catalog back; `?version=N` returns a specific version, so "v1 is still retrievable after v2 lands" is checkable from outside the process |
| `POST /api/passport/generate` | HMAC-SHA256 signed catalog manifest for `merchant_id` (defaults to the demo merchant), optionally `version` to sign a historical catalog version. 422 + problems if the catalog is invalid, 404 if the merchant has never ingested one, 500 if no signing key is configured |
| `GET /api/passport` | manifest + live signature verification status; `?merchant_id=` reads that merchant's own passport, no query reads the most recent one |
| `POST /api/mandates` | issue scoped mandate (`max_spend_paise`, allowlist, expiry, single_use) |
| `GET /api/mandates` | issued mandates with computed status (active / claimed / consumed / expired) |
| `POST /api/transactions` | claim mandate PRE-gateway, then create Razorpay order; prices `item_id` from `merchant_id`'s stored catalog (`catalog_version` prices against a specific version). 403 + human explanation on rejection, 409 when a single-use mandate is already claimed by an in-flight request or the item is out of stock / not for sale |
| `POST /api/webhooks/razorpay` | verifies `X-Razorpay-Signature`; bad sig = 403 + security event, verified-but-unparseable = 400 |
| `GET /api/audit` | read-only audit trail |
| `GET /api/health` | liveness + key config status |

### Ingesting a catalog

```bash
# JSON body
curl -X POST localhost:3000/api/merchants/acme-store/catalog \
  -H 'Content-Type: application/json' \
  -d '[{"id":"sku-1","name":"Widget","price_paise":149900,"stock":8,
        "category":"electronics","return_policy":"7-day return",
        "refund_terms":"Full refund within 5 business days","available":true}]'

# CSV upload — header row must name the same fields, in any order and any case
curl -X POST localhost:3000/api/merchants/acme-store/catalog -F file=@catalog.csv

# then sign it, and price against it
curl -X POST localhost:3000/api/passport/generate -d '{"merchant_id":"acme-store"}' -H 'Content-Type: application/json'
```

## Guarantees enforced in code

- Mandate checked **and claimed** in one indivisible step **before** any Razorpay call; no bypass flag exists.
  Checking and claiming cannot be separate steps, because a live gateway call sits between them
  (~235 ms). A gate that only checked would let a second request arriving inside that window read a
  still-active single-use mandate and authorise a second order against it. `test:concurrency` holds
  this to exactly one approval out of ten concurrent attempts; `test:race` holds the HTTP route to
  the same bound.
- A claim that does not result in an order is **released**, not burned: a refused gateway call moves
  no money, so it must not cost the agent its spending power. The release is itself recorded.
- `single_use: true` authorises exactly one payment. `single_use: false` authorises repeated payments,
  each bounded by `max_spend_paise` — that cap is per transaction, not a cumulative budget. The
  `mandate_consumed` field in a transaction response reports what actually happened to the mandate,
  so it is `false` for a reusable one.
- All amounts are integer paise end-to-end, and validated as *safe* integers: above 2^53 an integer
  stops being distinguishable from its neighbours, so comparing it against a bound proves nothing.
- A quantity that is present but unusable is refused with a 400 rather than quietly priced as one
  unit. The server never chooses a different amount than the caller asked for.
- **A transaction is priced from the same signed catalog its passport was issued over.** This used to
  read a hardcoded array compiled into the process, so every merchant on the rail was charged from one
  shared price list: two merchants selling the same sku id at different prices would both have been
  billed the first one's, and ingesting a catalog moved the passport but never the money. Pricing now
  reads `data/merchants/<merchant_id>/catalog_v<N>.json` for the merchant named in the request, and
  the audit entry records which merchant and version the price came from (`priced_from:
  catalog:acme-store@v2:sku-1 x1`). `test:multimerchant` compares the passport's attested price
  against the amount the rail computed, per merchant.
- An agent holding an older passport can transact at the prices that passport actually attests, by
  sending `catalog_version`. Re-uploading a catalog therefore does not silently re-price an agent
  that was shown the old one.
- `merchant_id` is the one caller-supplied string that becomes a filesystem path, and it is validated
  against an **allowlist** — alphanumerics, hyphen, underscore, 64 characters — not by stripping bad
  characters out. Stripping is how `..%2f..` becomes `..` after one pass of the wrong cleaner; an
  allowlist has no such failure mode. The resolved directory is then checked to be inside
  `data/merchants/` immediately before use, so "no write ever leaves that directory" is a property of
  the path itself rather than of a regex elsewhere in the file. `test:ingestion` asserts on the
  filesystem after a round of traversal attempts, not just on the status codes.
- Catalog ingestion is **all-or-nothing, and validated before any file write**. A refused upload
  creates no directory, no version file and no pointer, so it cannot leave a merchant serving half a
  catalog while being told the upload was rejected. Every refusal states that nothing was written and
  the previous catalog is still live.
- A re-upload **replaces as a new version** and never merges or overwrites. `catalog_v1.json` stays on
  disk when v2 lands, so a passport signed over v1 remains not just valid but *auditable* — the
  signature covers the manifest, and the version file is what shows WHAT was signed.
- CSV is mapped by header name, not column position, and cells are coerced narrowly: `"349900"`
  becomes `349900`, but `"349.9"` is **refused** rather than rounded and `"maybe"` is refused rather
  than treated as false. `Boolean("false")` is `true`, so a permissive coercion would have marked
  every withdrawn product as available and the signed passport would have advertised stock the
  merchant said not to sell. Unknown columns are dropped and named in the response.
- File type is decided from the extension allowlist (`.json`, `.csv`) **before** any parse is
  attempted, and the bytes are sniffed for NUL as well — a renamed binary passes an extension check by
  construction. The declared MIME type is checked against a denylist but is not the authority:
  browsers send `application/vnd.ms-excel` for a `.csv` and curl sends `application/octet-stream`, so
  a MIME allowlist would refuse the two most likely ways anyone uploads a catalog.
- The ingestion body parsers are mounted **ahead of** the global `express.json()`, the same ordering
  trap the webhook raw parser documents, from the other side: the global parser's limit is 1 MB, so
  mounted after it a 1.5 MB catalog would be refused before the route ran and the 2 MB limit this
  endpoint advertises would be fiction. `test:ingestion` uploads a catalog between the two limits to
  pin it.
- Audit log (`data/audit.jsonl`) is append-only JSONL with serialized writes; auto-created if missing; survives restarts; no write/delete API. Every entry carries a plain-language `human_reason` alongside its machine `reason_code`.
- A decision is on disk **before** the response reports it. Appends used to be queued and not waited
  on, so a decision could be reported as recorded while it was still only in memory — and lost if the
  process exited. Anything still queued is also flushed on Ctrl+C, bounded by a one-second grace
  period so a stuck write can never make the server unstoppable. (That signal path is a narrowing of
  the window, not the guarantee; the guarantee is the flush on the response path. On Windows an
  external `SIGTERM` terminates the process outright and no handler runs.)
- Every handler wrapped; bad input = 400, mandate rejection = 403 (+ human-readable explanation), contested claim = 409, oversized body = 413, genuine failure = 500. Server cannot crash on a bad request.
- Capture uses retry-once-on-timeout policy, then fails with logged reason. The Razorpay SDK rejects
  API refusals with a plain object rather than an `Error`, so the reason is extracted from
  `error.description` instead of a `.message` that does not exist — the cause reaches the trail
  rather than the string "undefined".
- Webhook signature failures are logged as security events and rejected immediately. The raw-body
  parser for the webhook route is mounted **ahead of** `express.json()` on purpose: mounted after it,
  body-parser drains the stream first and the signature is computed over a parsed object instead of
  the bytes that were signed — which silently breaks verification for every webhook Razorpay actually
  sends, since it sends `Content-Type: application/json`. `test:webhook` pins that content type.
- Signature verification never throws and never returns true on a doubtful path, including when the
  webhook secret is unset — an unset secret rejects every webhook rather than verifying against an
  empty key. The same holds for `PASSPORT_SIGNING_KEY`: `crypto.createHmac` accepts an empty key and
  returns a well-formed digest, so an unset key refuses to sign or verify rather than issuing
  passports anyone who noticed could forge.
- Signature comparisons are constant-time over **bytes**, not characters. `timingSafeEqual` throws
  `RangeError` on unequal buffer lengths, and a string's `.length` counts UTF-16 code units while the
  buffer it becomes counts UTF-8 bytes — so a length guard on the string let a multi-byte signature
  through to a throw, turning a refusal into a 500.
- The passport's `signature_algorithm` is **inside** the signed field set. Left outside it, the
  manifest's own account of how it was signed could be rewritten while the manifest still verified as
  valid. A passport signed under the older scheme is refused as `signature_scheme_outdated` rather
  than `signature_mismatch`: it needs regenerating, and calling it tampered would be an accusation
  the evidence does not support.
- An unreadable or corrupt mandate store is never treated as an empty one on a write path. Reporting
  "no mandates" for a file that could not be read would persist that emptiness on the next write and
  delete every mandate on disk — reachable in practice, since this repository lives under OneDrive
  where brief file locks are routine.

