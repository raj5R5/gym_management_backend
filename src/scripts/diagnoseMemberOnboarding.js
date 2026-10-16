const { createHash } = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const mongoose = require('mongoose');
const { z } = require('zod');
const { createDatabase } = require('../config/database');
const { getMemberProfileModel } = require('../modules/members/member.model');
const { getMemberSubscriptionModel } = require('../modules/subscriptions/subscription.model');
const { getPaymentModel } = require('../modules/payments/payment.model');
const { getMemberOnboardingOperationModel } = require('../modules/memberOnboardingComplete/operation.model');
const { onboardMember } = require('../modules/members/member.validation');
const { createPayment, methods } = require('../modules/payments/payment.validation');
const { idempotencyKey } = require('../modules/memberOnboardingComplete/complete.validation');

const collections = {
  member: 'memberprofiles', subscription: 'membersubscriptions',
  payment: 'payments', operation: 'memberonboardingoperations',
};
const paymentIndex = {
  name: 'payment_gym_method_reference_unique',
  key: { gymId: 1, paymentMethod: 1, transactionReference: 1 },
  partialFilterExpression: { status: 'succeeded', transactionReference: { $type: 'string' } },
};
const objectId = z.string().regex(/^[a-fA-F0-9]{24}$/).transform((value) => value.toLowerCase());
const environmentName = z.enum(['development', 'test', 'staging', 'production']);
const inputSchema = z.object({
  NODE_ENV: environmentName,
  DIAGNOSTIC_ENVIRONMENT: environmentName,
  DIAGNOSTIC_DATABASE: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$/),
  DIAGNOSTIC_CONFIRM_TARGET: z.string(),
  DIAGNOSTIC_MONGO_URI: z.string().regex(/^mongodb(?:\+srv)?:\/\/[^\s]+$/),
  DIAGNOSTIC_GYM_ID: objectId,
  DIAGNOSTIC_USER_ID: objectId,
  DIAGNOSTIC_PAYMENT_METHOD: z.enum(methods),
  DIAGNOSTIC_PAYMENT_REFERENCE: createPayment.shape.transactionReference.unwrap(),
  DIAGNOSTIC_MEMBER_CODE: onboardMember.shape.memberCode,
  DIAGNOSTIC_IDEMPOTENCY_KEY: idempotencyKey.optional(),
});

// Never attach input, raw driver errors, causes, or credentials to errors/output.
function fail(code) { const error = new Error(code); error.code = code; throw error; }

const inputFieldNames = new Set(Object.keys(inputSchema.shape));
class DiagnosticInputError extends Error {
  constructor(code, fields) {
    const safeFields = fields.filter(({ field, issue }) => inputFieldNames.has(field)
      && ['missing', 'malformed', 'mismatch'].includes(issue))
      .map(({ field, issue }) => ({ field, issue }));
    super(`Diagnostic input validation failed: ${safeFields.map(({ field, issue }) => `${field} (${issue})`).join(', ')}. No database connection was opened.`);
    this.code = code;
    this.fields = safeFields;
  }
}

function loadDiagnosticInput(environment) {
  const parsed = inputSchema.safeParse(environment);
  if (!parsed.success) {
    // Zod messages can contain input/enum values. Consume only allowlisted field names.
    const fields = [...new Set(parsed.error.issues.map((issue) => issue.path[0]))]
      .filter((field) => inputFieldNames.has(field)).sort()
      .map((field) => ({ field, issue: environment?.[field] === undefined ? 'missing' : 'malformed' }));
    throw new DiagnosticInputError('INVALID_DIAGNOSTIC_INPUT', fields);
  }
  const values = parsed.data;
  const selectedEnvironment = values.DIAGNOSTIC_ENVIRONMENT;
  const databaseName = values.DIAGNOSTIC_DATABASE;
  const mismatches = [];
  if (values.NODE_ENV !== selectedEnvironment) mismatches.push('NODE_ENV', 'DIAGNOSTIC_ENVIRONMENT');
  if (values.DIAGNOSTIC_CONFIRM_TARGET !== `${selectedEnvironment}/${databaseName}`) mismatches.push('DIAGNOSTIC_CONFIRM_TARGET');
  if (mismatches.length) throw new DiagnosticInputError('TARGET_NOT_CONFIRMED',
    mismatches.map((field) => ({ field, issue: 'mismatch' })));
  // Require an explicit database in the URI: never accept the driver's default "test" database.
  const path = values.DIAGNOSTIC_MONGO_URI.match(/^mongodb(?:\+srv)?:\/\/[^/]+\/([^?]+)(?:\?|$)/);
  let uriDatabase;
  try { uriDatabase = path && decodeURIComponent(path[1]); } catch {
    throw new DiagnosticInputError('DATABASE_TARGET_MISMATCH', [{ field: 'DIAGNOSTIC_MONGO_URI', issue: 'malformed' }]);
  }
  if (uriDatabase !== databaseName) throw new DiagnosticInputError('DATABASE_TARGET_MISMATCH', [
    { field: 'DIAGNOSTIC_DATABASE', issue: 'mismatch' }, { field: 'DIAGNOSTIC_MONGO_URI', issue: 'mismatch' },
  ]);
  return {
    selectedEnvironment, databaseName, mongoUri: values.DIAGNOSTIC_MONGO_URI,
    gymId: values.DIAGNOSTIC_GYM_ID, userId: values.DIAGNOSTIC_USER_ID,
    paymentMethod: values.DIAGNOSTIC_PAYMENT_METHOD,
    reference: values.DIAGNOSTIC_PAYMENT_REFERENCE, memberCode: values.DIAGNOSTIC_MEMBER_CODE,
    keyDigest: values.DIAGNOSTIC_IDEMPOTENCY_KEY === undefined ? undefined
      : createHash('sha256').update(values.DIAGNOSTIC_IDEMPOTENCY_KEY).digest('hex'),
  };
}

function verifyModels(connection) {
  const definitions = [
    [getMemberProfileModel, 'member', { gymId: 'ObjectId', memberCode: 'String' }],
    [getMemberSubscriptionModel, 'subscription', { gymId: 'ObjectId', memberId: 'ObjectId' }],
    [getPaymentModel, 'payment', { gymId: 'ObjectId', memberId: 'ObjectId', subscriptionId: 'ObjectId',
      paymentMethod: 'String', transactionReference: 'String', status: 'String' }],
    [getMemberOnboardingOperationModel, 'operation', { gymId: 'ObjectId', userId: 'ObjectId',
      keyDigest: 'String', 'result.operationId': 'String', 'result.member.id': 'String',
      'result.member.gymId': 'String', 'result.subscription.id': 'String',
      'result.payment.id': 'String', 'result.payment.subscriptionId': 'String' }],
  ];
  for (const [factory, kind, paths] of definitions) {
    // These factories only register schemas; autoCreate/autoIndex remain disabled.
    const model = factory(connection);
    if (model.collection.collectionName !== collections[kind]
      || model.schema.options.autoCreate !== false || model.schema.options.autoIndex !== false
      || Object.entries(paths).some(([path, type]) => model.schema.path(path)?.instance !== type)) {
      fail('UNEXPECTED_MODEL_LAYOUT');
    }
  }
}

async function verifyStorage(db) {
  const metadata = await db.listCollections({ name: { $in: Object.values(collections) } },
    { nameOnly: false, maxTimeMS: 5000 }).toArray();
  for (const name of Object.values(collections)) {
    const entry = metadata.find((value) => value.name === name);
    if (!entry || entry.type !== 'collection'
      || (entry.options?.collation && entry.options.collation.locale !== 'simple')) fail('UNEXPECTED_COLLECTION_LAYOUT');
  }
  const expected = [
    [collections.payment, paymentIndex],
    [collections.member, { name: 'member_gym_code_unique', key: { gymId: 1, memberCode: 1 } }],
    [collections.operation, { name: 'onboarding_actor_gym_key_unique', key: { gymId: 1, userId: 1, keyDigest: 1 } }],
  ];
  for (const [name, definition] of expected) {
    const indexes = await db.collection(name).listIndexes({ maxTimeMS: 5000 }).toArray();
    const index = indexes.find((value) => value.name === definition.name);
    if (!index || index.unique !== true || index.sparse === true
      || JSON.stringify(Object.entries(index.key)) !== JSON.stringify(Object.entries(definition.key))
      || !isDeepStrictEqual(index.partialFilterExpression, definition.partialFilterExpression)
      || (index.collation && index.collation.locale !== 'simple')) fail('UNEXPECTED_INDEX_LAYOUT');
  }
}

function id(value) {
  const text = value instanceof mongoose.Types.ObjectId ? value.toHexString() : value;
  if (typeof text !== 'string' || !/^[a-f0-9]{24}$/.test(text)) fail('UNEXPECTED_RECORD_LAYOUT');
  return text;
}
function summarize(record, extraIds = []) {
  if (!record) return { found: false };
  const summary = { found: true, id: id(record._id) };
  for (const field of extraIds) summary[field] = id(record[field]);
  for (const field of ['createdAt', 'updatedAt', 'paidAt']) {
    if (record[field] !== undefined) {
      if (!(record[field] instanceof Date) || !Number.isFinite(record[field].getTime())) fail('UNEXPECTED_RECORD_LAYOUT');
      summary[field] = record[field].toISOString();
    }
  }
  return summary;
}

async function investigate(db, input) {
  const gymId = new mongoose.Types.ObjectId(input.gymId);
  const userId = new mongoose.Types.ObjectId(input.userId);
  // Native read APIs with explicit projections: no model saves, hooks, initialization, or index writes.
  const read = async (kind, filter, projection) => {
    const record = await db.collection(collections[kind]).findOne({ ...filter, gymId }, {
      projection: { _id: 1, gymId: 1, createdAt: 1, updatedAt: 1, ...projection },
      maxTimeMS: 5000, readConcern: { level: 'majority' }, collation: { locale: 'simple' },
    });
    if (record && id(record.gymId) !== input.gymId) fail('UNEXPECTED_RECORD_SCOPE');
    return record;
  };
  const payment = await read('payment', { status: 'succeeded', paymentMethod: input.paymentMethod,
    transactionReference: input.reference }, { memberId: 1, subscriptionId: 1, paidAt: 1 });
  const member = await read('member', { memberCode: input.memberCode }, {});
  const report = {
    matchingSuccessfulPayment: summarize(payment, ['memberId', 'subscriptionId']),
    matchingMember: { ...summarize(member), provenance: 'unconfirmed' },
    operation: { checked: input.keyDigest !== undefined, found: false },
    operationRecords: null,
  };
  if (input.keyDigest === undefined) return report;
  const operation = await read('operation', { userId, keyDigest: input.keyDigest }, {
    userId: 1, 'result.operationId': 1, 'result.member.id': 1, 'result.member.gymId': 1,
    'result.subscription.id': 1, 'result.payment.id': 1, 'result.payment.subscriptionId': 1,
  });
  report.operation = { checked: true, ...summarize(operation) };
  if (!operation) return report;
  const result = operation.result;
  if (id(operation.userId) !== input.userId || id(result?.member?.gymId) !== input.gymId
    || id(result?.operationId) !== id(operation._id)) fail('UNEXPECTED_RECORD_SCOPE');
  const memberId = id(result.member.id);
  const subscriptionId = result.subscription === null || result.subscription === undefined ? null : id(result.subscription.id);
  const paymentId = result.payment === null || result.payment === undefined ? null : id(result.payment.id);
  if (paymentId && (!subscriptionId || id(result.payment.subscriptionId) !== subscriptionId)) fail('UNEXPECTED_RECORD_LAYOUT');
  const operationMember = await read('member', { _id: new mongoose.Types.ObjectId(memberId) }, {});
  const subscription = subscriptionId ? await read('subscription', { _id: new mongoose.Types.ObjectId(subscriptionId) }, { memberId: 1 }) : null;
  const operationPayment = paymentId ? await read('payment', { _id: new mongoose.Types.ObjectId(paymentId) },
    { memberId: 1, subscriptionId: 1, paidAt: 1 }) : null;
  const matchesSavedMember = Boolean(member && id(member._id) === memberId);
  report.operationRecords = {
    expectedMemberId: memberId, expectedSubscriptionId: subscriptionId, expectedPaymentId: paymentId,
    member: summarize(operationMember), subscription: summarize(subscription, ['memberId']),
    payment: summarize(operationPayment, ['memberId', 'subscriptionId']),
    consistency: {
      savedMemberMatchesOperation: matchesSavedMember,
      subscriptionBelongsToOperationMember: subscriptionId === null ? null
        : Boolean(subscription && id(subscription.memberId) === memberId),
      paymentBelongsToOperationMemberAndSubscription: paymentId === null ? null
        : Boolean(operationPayment && id(operationPayment.memberId) === memberId && id(operationPayment.subscriptionId) === subscriptionId),
      referenceMatchIsOperationPayment: paymentId === null ? null : Boolean(payment && id(payment._id) === paymentId),
    },
  };
  if (matchesSavedMember && operationMember) report.matchingMember.provenance = 'linked_to_committed_operation_record';
  return report;
}

const safeErrors = new Set(['DATABASE_TARGET_MISMATCH',
  'UNEXPECTED_MODEL_LAYOUT', 'UNEXPECTED_COLLECTION_LAYOUT', 'UNEXPECTED_INDEX_LAYOUT',
  'UNEXPECTED_RECORD_LAYOUT', 'UNEXPECTED_RECORD_SCOPE', 'DATABASE_CONNECTION_FAILED', 'DATABASE_DISCONNECT_FAILED',
  'COMMAND_LINE_ARGUMENTS_NOT_ALLOWED']);

async function runDiagnostic({ environment = process.env, args = process.argv.slice(2),
  databaseFactory = createDatabase, output = (value) => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`),
} = {}) {
  let database;
  let failed = false;
  try {
    if (args.length) fail('COMMAND_LINE_ARGUMENTS_NOT_ALLOWED');
    const input = loadDiagnosticInput(environment);
    output({ environment: input.selectedEnvironment, database: input.databaseName });
    const logger = { info() {}, warn() {}, error() {} };
    database = databaseFactory({ logger });
    verifyModels(database.connection);
    await database.connect({ mongoUri: input.mongoUri }, { dbName: input.databaseName,
      retryWrites: false, maxPoolSize: 1, readPreference: 'primary', readConcern: { level: 'majority' },
      monitorCommands: false,
      mongodbLogComponentSeverities: { default: 'off', command: 'off', topology: 'off',
        serverSelection: 'off', connection: 'off', client: 'off' } });
    const db = database.connection.db;
    if (db.databaseName !== input.databaseName) fail('DATABASE_TARGET_MISMATCH');
    await verifyStorage(db);
    const report = await investigate(db, input);
    output({ ...report, interpretation: [
      'A matching payment proves a reference collision in the selected gym/method, not who created it.',
      'Only a scoped operation record links IDs to a committed onboarding operation; the full saved payload was not compared.',
      'Missing records do not prove historical rollback. Sequential reads are not a point-in-time snapshot.',
      'No correction, API retry, database write, or saved-operation change was performed.',
    ] });
  } catch (error) {
    failed = true;
    output({ error: error instanceof DiagnosticInputError || safeErrors.has(error?.code) ? error.code : 'DIAGNOSTIC_READ_FAILED',
      message: error instanceof DiagnosticInputError ? error.message
        : 'Diagnostic aborted. No conclusion should be drawn from incomplete reads. Raw errors are intentionally omitted.',
      ...(error instanceof DiagnosticInputError ? { fields: error.fields } : {}),
    });
  } finally {
    if (database) {
      try { await database.disconnect(); } catch {
        failed = true;
        output({ error: 'DATABASE_DISCONNECT_FAILED' });
      }
    }
  }
  return failed ? 1 : 0;
}

if (require.main === module) {
  runDiagnostic().then((code) => { process.exitCode = code; });
}
module.exports = { collections, paymentIndex, loadDiagnosticInput, verifyModels, verifyStorage, investigate, runDiagnostic };
