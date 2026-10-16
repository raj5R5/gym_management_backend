# Read-only member onboarding diagnostic

Utility: `src/scripts/diagnoseMemberOnboarding.js` (CommonJS, Node.js 24).

Do not execute against a live database until the utility and target have been reviewed and explicitly approved. It never calls the onboarding API or changes the Flutter saved operation. It does not implement correction or reconciliation.

## Target and input safety

Use a dedicated MongoDB principal with the built-in **read** role restricted to the selected database, supplied by your database administrator. Do not create users or change database privileges as part of this investigation. The program only calls `listCollections`, `listIndexes` and projected `findOne` reads. Model factories register schemas with automatic collection/index creation disabled; the utility never imports the server, runs migrations, initializes indexes or opens a transaction. Driver command logging and automatic write retries are disabled.

It deliberately does **not** load `.env`, fall back to application `MONGO_URI`, or accept command-line arguments. Supply these environment variables in a private terminal session:

| Variable | Required value |
| --- | --- |
| `NODE_ENV` | Actual API environment: development, test, staging or production; no default |
| `DIAGNOSTIC_ENVIRONMENT` | Same environment, explicitly selected |
| `DIAGNOSTIC_DATABASE` | Exact database name, simple letters/digits/underscores/hyphens |
| `DIAGNOSTIC_CONFIRM_TARGET` | Exact `environment/database` selection |
| `DIAGNOSTIC_MONGO_URI` | Read-only connection URI with that database explicitly present in its path |
| `DIAGNOSTIC_GYM_ID` | Exactly 24 hexadecimal characters: gym ObjectId from the saved operation |
| `DIAGNOSTIC_USER_ID` | Exactly 24 hexadecimal characters: ObjectId of the authenticated administrator who submitted it, not the member account |
| `DIAGNOSTIC_PAYMENT_METHOD` | Exact saved method: cash, upi, bank_transfer, card or other |
| `DIAGNOSTIC_PAYMENT_REFERENCE` | Exact saved reference, entered privately; trimmed length 3–120, begins with ASCII letter/digit, remainder letters/digits/spaces or `._:/-` |
| `DIAGNOSTIC_MEMBER_CODE` | Saved member code; trimmed/uppercased length 2–32, begins with letter/digit, remainder letters/digits/underscore/hyphen |
| `DIAGNOSTIC_IDEMPOTENCY_KEY` | Original saved key if available; 8–128 ASCII letters/digits/underscores/hyphens; omit entirely if unavailable |

Confirm the environment/database mapping against the approved API deployment configuration before supplying values. Environment labels are operator-confirmed: the database has no existing environment-marker record to independently attest which deployment uses it. If that mapping is unknown, **stop**. The utility checks both environment labels, confirmation string, URI database path and the connected database's actual name before any collection/document query. It prints only the environment label and database name. It cannot prove that an operator supplied the correct deployment URI.

Do not paste secret values into shell assignments, command arguments, terminal recordings, screenshots or logs. Do not use `set -x`, environment dumps or MongoDB command tracing. Environment variables remain accessible to appropriately privileged local processes; use a trusted terminal/machine and temporary credentials where available.

For the project's zsh shell, hidden interactive entry keeps values out of shell history. Input entry and validation do not query the database; live execution still requires explicit approval. The URI, reference and key are entered at prompts, not in commands:

Enter **one `read` command at a time**, answer its prompt, then enter the corresponding `export` command. Do not paste the entire interactive block into a terminal: queued commands can be consumed as prompt answers. Enter raw values without surrounding quotes, JSON, header labels or shell assignment syntax. Environment labels and payment methods must use the lowercase spellings in the table. Exports must remain in the **same terminal** used for validation/execution; completing a prompt without its export is insufficient. The Node program itself does not prompt for inputs.

```zsh
read -r 'NODE_ENV?API environment: '
export NODE_ENV
read -r 'DIAGNOSTIC_ENVIRONMENT?Confirm API environment: '
export DIAGNOSTIC_ENVIRONMENT
read -r 'DIAGNOSTIC_DATABASE?Exact database name: '
export DIAGNOSTIC_DATABASE
read -r 'DIAGNOSTIC_CONFIRM_TARGET?Confirm environment/database: '
export DIAGNOSTIC_CONFIRM_TARGET
read -r -s 'DIAGNOSTIC_MONGO_URI?Read-only URI (hidden): '
export DIAGNOSTIC_MONGO_URI
read -r 'DIAGNOSTIC_GYM_ID?Saved gym ID: '
export DIAGNOSTIC_GYM_ID
read -r 'DIAGNOSTIC_USER_ID?Submitting administrator ID: '
export DIAGNOSTIC_USER_ID
read -r 'DIAGNOSTIC_PAYMENT_METHOD?Saved payment method: '
export DIAGNOSTIC_PAYMENT_METHOD
read -r -s 'DIAGNOSTIC_PAYMENT_REFERENCE?Exact saved payment reference (hidden): '
export DIAGNOSTIC_PAYMENT_REFERENCE
read -r -s 'DIAGNOSTIC_MEMBER_CODE?Saved member code (hidden): '
export DIAGNOSTIC_MEMBER_CODE
# Only if the original key is available:
read -r -s 'DIAGNOSTIC_IDEMPOTENCY_KEY?Original saved key (hidden): '
export DIAGNOSTIC_IDEMPOTENCY_KEY
# Otherwise use: unset DIAGNOSTIC_IDEMPOTENCY_KEY
```

An empty supplied key is invalid, not treated as unavailable. Use the original saved key (8–128 ASCII letters/digits/underscores/hyphens); never generate a replacement. Preserve the original saved payload and rejection. Exit status is zero for a completed investigation, including missing records, and one for invalid inputs or incomplete/failed reads. Raw errors, causes and stacks are suppressed because driver errors may contain credentials or query values. An error means **no conclusion** should be drawn from that run.

Run this validation-only command after exporting the inputs. It calls only `loadDiagnosticInput`; it never constructs the database abstraction, connects, checks indexes or queries collections. It is safe to use before live-query approval. Do not print the returned configuration object: it contains private input values.

```sh
node - <<'NODE'
const { loadDiagnosticInput } = require('./src/scripts/diagnoseMemberOnboarding');
try {
  loadDiagnosticInput(process.env);
  console.log('Input validation passed. No database connection was opened.');
} catch (error) {
  const codes = ['INVALID_DIAGNOSTIC_INPUT', 'TARGET_NOT_CONFIRMED', 'DATABASE_TARGET_MISMATCH'];
  console.log(JSON.stringify({
    error: codes.includes(error.code) ? error.code : 'INPUT_CHECK_FAILED',
    fields: error.fields,
    message: 'Input check failed. No database connection was opened.',
  }, null, 2));
  process.exitCode = 1;
}
NODE
```

Do not proceed on a failed check. Re-enter/export only the named fields, then repeat the validation-only command. With a missing required URI and a blank optional key, safe output includes:

```json
{
  "error": "INVALID_DIAGNOSTIC_INPUT",
  "fields": [
    { "field": "DIAGNOSTIC_IDEMPOTENCY_KEY", "issue": "malformed" },
    { "field": "DIAGNOSTIC_MONGO_URI", "issue": "missing" }
  ],
  "message": "Input check failed. No database connection was opened."
}
```

### Immediate input errors

- `INVALID_DIAGNOSTIC_INPUT` has exactly one origin: the initial Zod schema check. Its field list now distinguishes missing exports (`missing`) from supplied but invalid values (`malformed`). Values and Zod's raw messages are never included. The earlier generic response discarded the failing field names and cannot retrospectively identify which prompt/export failed.
- A valid environment label that disagrees with the other label, or a confirmation string that is not exactly the selected `environment/database`, produces `TARGET_NOT_CONFIRMED`, with the involved fields marked `mismatch`. For fictional selections `development` and `gym_dev_example`, enter `development/gym_dev_example`, with no quotes or additional whitespace.
- A URI with no explicit database path, a different database name, or malformed percent encoding produces `DATABASE_TARGET_MISMATCH`. This is a separate check after schema validation. A placeholder, wrong URI prefix or whitespace in the URI fails the earlier schema check instead.
- All of these input failures occur before any database connection. There is no `.env` loading or fallback to `MONGO_URI`. A bare invocation in an unconfigured/new terminal fails even when the application's `.env` is complete.
- Common unsupported prompt answers include uppercase payment methods, non-hex or quoted IDs, a copied `Idempotency-Key:` header instead of its raw value, a blank supplied optional key, or a full URI entered at the database-name prompt. A syntactically valid but wrong ID cannot be detected by input validation alone; compare it privately with the saved operation.

After input validation succeeds and live execution is explicitly approved, run in the same terminal:

```sh
node src/scripts/diagnoseMemberOnboarding.js
```

Once finished, remove the temporary variables from that terminal:

```sh
unset DIAGNOSTIC_MONGO_URI DIAGNOSTIC_PAYMENT_REFERENCE DIAGNOSTIC_IDEMPOTENCY_KEY
unset DIAGNOSTIC_GYM_ID DIAGNOSTIC_USER_ID DIAGNOSTIC_MEMBER_CODE DIAGNOSTIC_PAYMENT_METHOD
unset DIAGNOSTIC_ENVIRONMENT DIAGNOSTIC_DATABASE DIAGNOSTIC_CONFIRM_TARGET NODE_ENV
```

## Verified collections and queries

| Model / collection | Lookup and relevant fields |
| --- | --- |
| Payment / `payments` | `gymId`, `paymentMethod`, trimmed `transactionReference`, `status: 'succeeded'`; return IDs and timestamps only |
| MemberProfile / `memberprofiles` | `gymId`, trimmed/uppercased `memberCode` |
| MemberOnboardingOperation / `memberonboardingoperations` | `gymId`, submitting `userId`, locally SHA-256 hashed original key in `keyDigest`; read only result IDs |
| MemberSubscription / `membersubscriptions` | Operation result subscription `id`, scoped by `gymId`; check `memberId` |
| Payment / `payments` | Operation result payment `id`, scoped by `gymId`; check `memberId` and `subscriptionId` |

The member referenced by the operation result is also fetched by ID within the gym. All document queries have explicit projections, a five-second server execution limit, primary reads, majority read concern and simple case-sensitive collation. Names, contact details, payment references, raw keys/digests, credentials and full requests/results never appear in output.

The utility verifies model collection mappings and field types against the current factories. Before document reads, it requires ordinary existing collections, simple collation, and these existing unique indexes with the expected keys/partial filters:

- `payment_gym_method_reference_unique`: `{ gymId: 1, paymentMethod: 1, transactionReference: 1 }`, partial `{ status: 'succeeded', transactionReference: { $type: 'string' } }`.
- `member_gym_code_unique`: `{ gymId: 1, memberCode: 1 }`.
- `onboarding_actor_gym_key_unique`: `{ gymId: 1, userId: 1, keyDigest: 1 }`.

Unexpected/missing collections, views, indexes, incompatible collation, malformed record IDs or mismatched operation scope cause a safe abort. No schema/index repair is attempted. Reference case is preserved; only outer whitespace is removed, exactly as in existing Zod validation. The successful-payment unique index enforces duplicates at insert time; the existing error handler maps that violation to HTTP 409 `DUPLICATE_PAYMENT_REFERENCE`. Changing the method or reference to evade the constraint is not a recovery procedure.

## Fictional output and interpretation

Example: an existing payment and member were found, but no committed operation matched the supplied actor/gym/key. All IDs and dates below are fictional. The utility also appends interpretation notes to the report.

```json
{
  "environment": "development",
  "database": "gym_dev_example"
}
{
  "matchingSuccessfulPayment": {
    "found": true,
    "id": "555555555555555555555555",
    "memberId": "333333333333333333333333",
    "subscriptionId": "444444444444444444444444",
    "createdAt": "2026-01-01T10:00:00.000Z",
    "updatedAt": "2026-01-01T10:00:00.000Z",
    "paidAt": "2026-01-01T10:00:00.000Z"
  },
  "matchingMember": {
    "found": true,
    "id": "333333333333333333333333",
    "createdAt": "2026-01-01T10:00:00.000Z",
    "updatedAt": "2026-01-01T10:00:00.000Z",
    "provenance": "unconfirmed"
  },
  "operation": { "checked": true, "found": false },
  "operationRecords": null
}
```

A matching payment proves a collision in this gym/method at read time. It does not establish who created the payment or whether it belongs to the rejected registration. A matching member alone has **unconfirmed** provenance. A scoped durable operation record links its referenced IDs to a committed onboarding operation; a matching member ID is labeled `linked_to_committed_operation_record`. This is evidence tied to that original actor/gym/key, not a comparison against the complete saved request digest, which this utility does not accept or reconstruct. Missing referenced records or mismatched relationships are flagged; missing optional subscription/payment produce null checks rather than failures.

Without a key, operation lookup is explicitly `checked: false`. No operation record means the utility cannot attribute matching records to the failed attempt. Absence is not proof of historical rollback or an exhaustive search for differently keyed/coded attempts. Reads are sequential, not a transactional snapshot: concurrent changes can affect consistency checks. Subscription/payment IDs are followed from the operation result only; this does not enumerate all historical payments or subscriptions for a matching member.

Keep the saved operation blocked and intact. Review the sanitized result with the authorized gym administrator against the actual payment evidence. A mismatch, unexpected record or unresolved provenance needs investigation. Any later correction/reconciliation requires its own reviewed workflow; this utility must not retry, clear, invent a reference or create another registration.

## Local validation

```sh
node --test tests/integration/onboardingDiagnostic.test.js
npm run lint
git diff --check
```

Tests use only mocked metadata/read methods and disconnected Mongoose schemas. They do not load `.env`, connect to MongoDB, run migrations, call an API or modify a live/test database.
