const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { test } = require('node:test');
const mongoose = require('mongoose');
const { collections, paymentIndex, loadDiagnosticInput, verifyModels, verifyStorage,
  investigate, runDiagnostic } = require('../../src/scripts/diagnoseMemberOnboarding');

const ids = {
  gym: '111111111111111111111111', user: '222222222222222222222222',
  member: '333333333333333333333333', subscription: '444444444444444444444444',
  payment: '555555555555555555555555', operation: '666666666666666666666666',
  other: '777777777777777777777777',
};
const oid = (value) => new mongoose.Types.ObjectId(value);
const timestamp = new Date('2026-01-01T10:00:00.000Z');
function environment(overrides = {}) {
  return { NODE_ENV: 'test', DIAGNOSTIC_ENVIRONMENT: 'test', DIAGNOSTIC_DATABASE: 'diagnostic_fixture',
    DIAGNOSTIC_CONFIRM_TARGET: 'test/diagnostic_fixture',
    DIAGNOSTIC_MONGO_URI: 'mongodb://fixture:private-password@localhost:27017/diagnostic_fixture',
    DIAGNOSTIC_GYM_ID: ids.gym, DIAGNOSTIC_USER_ID: ids.user, DIAGNOSTIC_PAYMENT_METHOD: 'upi',
    DIAGNOSTIC_PAYMENT_REFERENCE: ' Secret-Ref-123 ', DIAGNOSTIC_MEMBER_CODE: ' me01 ',
    DIAGNOSTIC_IDEMPOTENCY_KEY: 'saved-key-private', ...overrides };
}
function fixture({ committed = true } = {}) {
  const common = { gymId: oid(ids.gym), createdAt: timestamp, updatedAt: timestamp };
  return {
    [collections.member]: [{ ...common, _id: oid(ids.member), memberCode: 'ME01', phone: 'private-phone' }],
    [collections.subscription]: [{ ...common, _id: oid(ids.subscription), memberId: oid(ids.member) }],
    [collections.payment]: [{ ...common, _id: oid(ids.payment), memberId: oid(ids.member),
      subscriptionId: oid(ids.subscription), paidAt: timestamp, status: 'succeeded', paymentMethod: 'upi',
      transactionReference: 'Secret-Ref-123' }],
    [collections.operation]: committed ? [{ ...common, _id: oid(ids.operation), userId: oid(ids.user),
      keyDigest: createHash('sha256').update('saved-key-private').digest('hex'), result: {
        operationId: ids.operation, member: { id: ids.member, gymId: ids.gym, firstName: 'private-name' },
        subscription: { id: ids.subscription }, payment: { id: ids.payment, subscriptionId: ids.subscription,
          transactionReference: 'Secret-Ref-123' },
      } }] : [],
  };
}
function mockDb(records = fixture()) {
  const calls = [];
  const indexes = {
    [collections.payment]: [{ ...paymentIndex, unique: true }],
    [collections.member]: [{ name: 'member_gym_code_unique', key: { gymId: 1, memberCode: 1 }, unique: true }],
    [collections.operation]: [{ name: 'onboarding_actor_gym_key_unique', key: { gymId: 1, userId: 1, keyDigest: 1 }, unique: true }],
  };
  const metadata = Object.values(collections).map((name) => ({ name, type: 'collection' }));
  const db = {
    databaseName: 'diagnostic_fixture',
    listCollections: () => ({ toArray: async () => metadata }),
    collection(name) {
      assert.ok(Object.values(collections).includes(name));
      // No writable methods exist on the mock; unexpected mutations fail immediately.
      return {
        listIndexes: () => ({ toArray: async () => indexes[name] || [] }),
        async findOne(filter, options) {
          calls.push({ name, filter, options });
          return (records[name] || []).find((record) => Object.entries(filter)
            .every(([key, value]) => String(record[key]) === String(value))) || null;
        },
      };
    },
  };
  return { db, calls, indexes, metadata };
}
async function execute({ env = environment(), args = [], mock = mockDb(), connectError,
  disconnectError, modelMutation } = {}) {
  const output = [];
  let created = 0; let connected = 0; let disconnected = 0; let connectionOptions;
  const code = await runDiagnostic({ environment: env, args, output: (value) => output.push(value),
    databaseFactory() {
      created += 1;
      const connection = mongoose.createConnection();
      if (modelMutation) modelMutation(connection);
      return { connection,
        async connect(_config, options) {
          connected += 1; connectionOptions = options;
          if (connectError) throw connectError;
          connection.db = mock.db;
        },
        async disconnect() {
          disconnected += 1; await connection.close();
          if (disconnectError) throw disconnectError;
        },
      };
    } });
  return { code, output, created, connected, disconnected, connectionOptions, ...mock };
}

test('diagnostic uses current model collection names and paths without opening a connection', async () => {
  const connection = mongoose.createConnection();
  verifyModels(connection);
  assert.equal(connection.readyState, 0);
  assert.deepEqual(Object.values(connection.models).map((model) => model.collection.collectionName).sort(),
    Object.values(collections).sort());
  await connection.close();
});

test('inputs reuse reference trimming, member-code normalization and local SHA-256 key hashing', () => {
  const input = loadDiagnosticInput(environment());
  assert.equal(input.reference, 'Secret-Ref-123'); assert.equal(input.memberCode, 'ME01');
  assert.equal(input.keyDigest, createHash('sha256').update('saved-key-private').digest('hex'));
  assert.equal(input.idempotencyKey, undefined);
});

for (const [label, overrides] of [
  ['invalid gym ID', { DIAGNOSTIC_GYM_ID: 'invalid' }],
  ['invalid user ID', { DIAGNOSTIC_USER_ID: 'invalid' }],
  ['invalid method', { DIAGNOSTIC_PAYMENT_METHOD: 'wire' }],
  ['invalid reference', { DIAGNOSTIC_PAYMENT_REFERENCE: 'bad\nreference' }],
  ['invalid member code', { DIAGNOSTIC_MEMBER_CODE: '!bad!' }],
  ['invalid key', { DIAGNOSTIC_IDEMPOTENCY_KEY: 'bad key' }],
  ['missing explicit environment', { NODE_ENV: undefined }],
  ['ambiguous database', { DIAGNOSTIC_DATABASE: undefined }],
  ['implicit application URI', { DIAGNOSTIC_MONGO_URI: undefined, MONGO_URI: 'mongodb://localhost/app' }],
  ['different environment', { NODE_ENV: 'production' }],
  ['missing confirmation', { DIAGNOSTIC_CONFIRM_TARGET: '' }],
  ['different URI database', { DIAGNOSTIC_MONGO_URI: 'mongodb://localhost/wrong_database' }],
  ['missing URI database', { DIAGNOSTIC_MONGO_URI: 'mongodb://localhost' }],
]) {
  test(`${label} aborts before any connection or query`, async () => {
    const result = await execute({ env: environment(overrides) });
    assert.equal(result.code, 1); assert.equal(result.created, 0);
    assert.equal(result.connected, 0); assert.equal(result.calls.length, 0);
  });
}

test('an unconfigured terminal identifies every missing required field before creating a database abstraction', async () => {
  const result = await execute({ env: {} });
  const expected = ['NODE_ENV', 'DIAGNOSTIC_ENVIRONMENT', 'DIAGNOSTIC_DATABASE', 'DIAGNOSTIC_CONFIRM_TARGET',
    'DIAGNOSTIC_MONGO_URI', 'DIAGNOSTIC_GYM_ID', 'DIAGNOSTIC_USER_ID', 'DIAGNOSTIC_PAYMENT_METHOD',
    'DIAGNOSTIC_PAYMENT_REFERENCE', 'DIAGNOSTIC_MEMBER_CODE'].sort();
  assert.equal(result.code, 1); assert.equal(result.created, 0); assert.equal(result.connected, 0);
  assert.equal(result.output.length, 1); assert.equal(result.output[0].error, 'INVALID_DIAGNOSTIC_INPUT');
  assert.deepEqual(result.output[0].fields, expected.map((field) => ({ field, issue: 'missing' })));
  assert.ok(result.output[0].message.includes('No database connection was opened'));
});

test('each missing input is named without falling back to application configuration', async () => {
  for (const field of ['NODE_ENV', 'DIAGNOSTIC_ENVIRONMENT', 'DIAGNOSTIC_DATABASE', 'DIAGNOSTIC_CONFIRM_TARGET',
    'DIAGNOSTIC_MONGO_URI', 'DIAGNOSTIC_GYM_ID', 'DIAGNOSTIC_USER_ID', 'DIAGNOSTIC_PAYMENT_METHOD',
    'DIAGNOSTIC_PAYMENT_REFERENCE', 'DIAGNOSTIC_MEMBER_CODE']) {
    const result = await execute({ env: environment({ [field]: undefined, MONGO_URI: 'mongodb://localhost/ignored' }) });
    assert.equal(result.code, 1); assert.equal(result.created, 0);
    assert.equal(result.output[0].error, 'INVALID_DIAGNOSTIC_INPUT');
    assert.deepEqual(result.output[0].fields, [{ field, issue: 'missing' }]);
    assert.ok(result.output[0].message.includes(field));
    assert.ok(!JSON.stringify(result.output).includes('mongodb://localhost/ignored'));
  }
});

test('malformed input identifies field names while omitting even secret-looking input and Zod messages', async () => {
  const env = environment({ NODE_ENV: 'private-invalid-environment', DIAGNOSTIC_MONGO_URI: 'private-invalid-uri',
    DIAGNOSTIC_PAYMENT_REFERENCE: '<private-reference>', DIAGNOSTIC_IDEMPOTENCY_KEY: 'private key value' });
  const result = await execute({ env });
  assert.equal(result.code, 1); assert.equal(result.created, 0);
  assert.deepEqual(result.output[0].fields, ['NODE_ENV', 'DIAGNOSTIC_MONGO_URI', 'DIAGNOSTIC_PAYMENT_REFERENCE',
    'DIAGNOSTIC_IDEMPOTENCY_KEY'].sort().map((field) => ({ field, issue: 'malformed' })));
  for (const value of Object.values(env)) assert.ok(!JSON.stringify(result.output).includes(value));
});

test('a blank optional key from completing its prompt is malformed; unsetting it preserves optional behavior', async () => {
  const blank = await execute({ env: environment({ DIAGNOSTIC_IDEMPOTENCY_KEY: '' }) });
  assert.equal(blank.code, 1); assert.equal(blank.created, 0);
  assert.deepEqual(blank.output[0].fields, [{ field: 'DIAGNOSTIC_IDEMPOTENCY_KEY', issue: 'malformed' }]);
  const omitted = await execute({ env: environment({ DIAGNOSTIC_IDEMPOTENCY_KEY: undefined }) });
  assert.equal(omitted.code, 0); assert.equal(omitted.output[1].operation.checked, false);
});

test('unsupported method casing identifies only the payment-method field', async () => {
  const result = await execute({ env: environment({ DIAGNOSTIC_PAYMENT_METHOD: 'UPI' }) });
  assert.equal(result.code, 1); assert.equal(result.created, 0);
  assert.deepEqual(result.output[0].fields, [{ field: 'DIAGNOSTIC_PAYMENT_METHOD', issue: 'malformed' }]);
  assert.ok(!JSON.stringify(result.output).includes('UPI'));
});

test('confirmation and environment mismatches use their distinct code and name all involved fields', async () => {
  const result = await execute({ env: environment({ NODE_ENV: 'production', DIAGNOSTIC_CONFIRM_TARGET: 'private-mismatched-target' }) });
  assert.equal(result.code, 1); assert.equal(result.created, 0);
  assert.equal(result.output[0].error, 'TARGET_NOT_CONFIRMED');
  assert.deepEqual(result.output[0].fields, ['NODE_ENV', 'DIAGNOSTIC_ENVIRONMENT', 'DIAGNOSTIC_CONFIRM_TARGET']
    .map((field) => ({ field, issue: 'mismatch' })));
  assert.ok(!JSON.stringify(result.output).includes('production'));
  assert.ok(!JSON.stringify(result.output).includes('private-mismatched-target'));
});

test('URI database mismatch and malformed URI encoding name fields without printing the URI', async () => {
  for (const uri of ['mongodb://private:password@localhost/private_wrong_database', 'mongodb://localhost/%ZZ']) {
    const result = await execute({ env: environment({ DIAGNOSTIC_MONGO_URI: uri }) });
    assert.equal(result.code, 1); assert.equal(result.created, 0);
    assert.equal(result.output[0].error, 'DATABASE_TARGET_MISMATCH');
    assert.ok(result.output[0].fields.some(({ field }) => field === 'DIAGNOSTIC_MONGO_URI'));
    assert.ok(!JSON.stringify(result.output).includes(uri));
    assert.ok(!JSON.stringify(result.output).includes('private_wrong_database'));
  }
});

test('driver errors cannot impersonate a trusted input error to expose fields or claim no connection', async () => {
  const error = new Error('private-driver-message');
  error.code = 'INVALID_DIAGNOSTIC_INPUT'; error.fields = [{ field: 'private-driver-field', issue: 'malformed' }];
  const result = await execute({ connectError: error });
  assert.equal(result.code, 1); assert.equal(result.connected, 1); assert.equal(result.disconnected, 1);
  assert.equal(result.output[1].error, 'DIAGNOSTIC_READ_FAILED');
  assert.equal(result.output[1].fields, undefined);
  assert.ok(!JSON.stringify(result.output).includes('private-driver'));
  assert.ok(!result.output[1].message.includes('No database connection was opened'));
});

test('command-line arguments are refused without displaying them', async () => {
  const result = await execute({ args: ['private-argument'] });
  assert.equal(result.code, 1); assert.equal(result.connected, 0);
  assert.equal(result.output[0].error, 'COMMAND_LINE_ARGUMENTS_NOT_ALLOWED');
  assert.ok(!JSON.stringify(result.output).includes('private-argument'));
});

test('report includes committed operation relationships but no sensitive values or digests', async () => {
  const result = await execute();
  assert.equal(result.code, 0); assert.equal(result.disconnected, 1);
  assert.deepEqual(result.output[0], { environment: 'test', database: 'diagnostic_fixture' });
  const report = result.output[1];
  assert.equal(report.matchingMember.provenance, 'linked_to_committed_operation_record');
  assert.equal(report.matchingSuccessfulPayment.id, ids.payment);
  assert.equal(report.operation.id, ids.operation);
  assert.deepEqual(Object.values(report.operationRecords.consistency), [true, true, true, true]);
  assert.equal(report.operationRecords.subscription.id, ids.subscription);
  assert.equal(report.matchingSuccessfulPayment.paidAt, timestamp.toISOString());
  const serialized = JSON.stringify(result.output);
  for (const secret of ['Secret-Ref-123', 'saved-key-private', 'private-password', 'mongodb://',
    'private-name', 'private-phone', loadDiagnosticInput(environment()).keyDigest]) assert.ok(!serialized.includes(secret));
  assert.equal(result.connectionOptions.retryWrites, false);
  assert.equal(result.connectionOptions.monitorCommands, false);
  assert.ok(Object.values(result.connectionOptions.mongodbLogComponentSeverities).every((value) => value === 'off'));
  for (const { filter, options } of result.calls) {
    assert.equal(String(filter.gymId), ids.gym);
    assert.equal(options.maxTimeMS, 5000);
    assert.equal(options.readConcern.level, 'majority');
    assert.equal(options.projection.transactionReference, undefined);
    assert.equal(options.projection.result, undefined);
    assert.equal(options.projection.phone, undefined);
  }
  const operationQuery = result.calls.find((call) => call.name === collections.operation);
  assert.equal(String(operationQuery.filter.userId), ids.user);
  assert.equal(operationQuery.filter.keyDigest, loadDiagnosticInput(environment()).keyDigest);
});

test('matching member and payment without operation never imply successful onboarding', async () => {
  const report = await investigate(mockDb(fixture({ committed: false })).db, loadDiagnosticInput(environment()));
  assert.equal(report.matchingMember.found, true); assert.equal(report.matchingMember.provenance, 'unconfirmed');
  assert.deepEqual(report.operation, { checked: true, found: false }); assert.equal(report.operationRecords, null);
});

test('missing records are reported, not inferred as historical rollback', async () => {
  const result = await execute({ mock: mockDb({}) });
  assert.equal(result.code, 0);
  assert.equal(result.output[1].matchingSuccessfulPayment.found, false);
  assert.equal(result.output[1].matchingMember.found, false);
  assert.ok(result.output[1].interpretation.some((value) => value.includes('do not prove historical rollback')));
});

test('optional absent key skips operation lookup explicitly', async () => {
  const result = await execute({ env: environment({ DIAGNOSTIC_IDEMPOTENCY_KEY: undefined }) });
  assert.equal(result.code, 0); assert.deepEqual(result.output[1].operation, { checked: false, found: false });
  assert.ok(result.calls.every((call) => call.name !== collections.operation));
});

test('operation lookup isolates user and gym; payment reference isolates gym, method, status and case', async () => {
  for (const overrides of [
    { DIAGNOSTIC_USER_ID: ids.other }, { DIAGNOSTIC_GYM_ID: ids.other },
    { DIAGNOSTIC_PAYMENT_METHOD: 'card' }, { DIAGNOSTIC_PAYMENT_REFERENCE: 'secret-ref-123' },
  ]) {
    const report = await investigate(mockDb().db, loadDiagnosticInput(environment(overrides)));
    if (overrides.DIAGNOSTIC_USER_ID || overrides.DIAGNOSTIC_GYM_ID) assert.equal(report.operation.found, false);
    if (!overrides.DIAGNOSTIC_USER_ID) assert.equal(report.matchingSuccessfulPayment.found, false);
  }
  const records = fixture(); records[collections.payment][0].status = 'failed';
  assert.equal((await investigate(mockDb(records).db, loadDiagnosticInput(environment()))).matchingSuccessfulPayment.found, false);
});

test('missing operation-linked records are explicit consistency failures', async () => {
  const records = fixture(); records[collections.subscription] = []; records[collections.payment] = [];
  const report = await investigate(mockDb(records).db, loadDiagnosticInput(environment()));
  assert.equal(report.operationRecords.subscription.found, false);
  assert.equal(report.operationRecords.payment.found, false);
  assert.equal(report.operationRecords.consistency.subscriptionBelongsToOperationMember, false);
  assert.equal(report.operationRecords.consistency.paymentBelongsToOperationMemberAndSubscription, false);
});

test('operation-linked records cannot escape gym scope or hide mismatched relationships', async () => {
  const records = fixture();
  records[collections.subscription][0].gymId = oid(ids.other);
  records[collections.payment][0].memberId = oid(ids.other);
  const report = await investigate(mockDb(records).db, loadDiagnosticInput(environment()));
  assert.equal(report.operationRecords.subscription.found, false);
  assert.equal(report.operationRecords.consistency.paymentBelongsToOperationMemberAndSubscription, false);
});

test('member-only committed operation reports absent optional records without false failures', async () => {
  const records = fixture();
  records[collections.operation][0].result.subscription = null;
  records[collections.operation][0].result.payment = null;
  const report = await investigate(mockDb(records).db, loadDiagnosticInput(environment()));
  assert.equal(report.operationRecords.expectedSubscriptionId, null);
  assert.equal(report.operationRecords.consistency.subscriptionBelongsToOperationMember, null);
  assert.equal(report.operationRecords.consistency.referenceMatchIsOperationPayment, null);
});

for (const mutation of [
  (mock) => { mock.metadata.pop(); },
  (mock) => { mock.metadata[0].type = 'view'; },
  (mock) => { mock.metadata[0].options = { collation: { locale: 'en' } }; },
  (mock) => { mock.indexes[collections.payment][0].unique = false; },
  (mock) => { mock.indexes[collections.payment][0].key = { transactionReference: 1 }; },
  (mock) => { mock.indexes[collections.payment][0].partialFilterExpression = { status: 'pending' }; },
  (mock) => { mock.indexes[collections.payment][0].collation = { locale: 'en' }; },
  (mock) => { mock.indexes[collections.operation] = []; },
]) {
  test('unexpected collection/index metadata aborts before document reads', async () => {
    const mock = mockDb(); mutation(mock);
    const result = await execute({ mock });
    assert.equal(result.code, 1); assert.equal(result.calls.length, 0); assert.equal(result.disconnected, 1);
  });
}

test('connected database name mismatch aborts before metadata or document reads', async () => {
  const mock = mockDb(); mock.db.databaseName = 'other_database';
  mock.db.listCollections = () => { assert.fail('must not query wrong database'); };
  const result = await execute({ mock });
  assert.equal(result.code, 1); assert.equal(result.output[1].error, 'DATABASE_TARGET_MISMATCH');
  assert.equal(result.disconnected, 1);
});

test('model differences abort before connecting', async () => {
  const result = await execute({ modelMutation(connection) {
    connection.model('MemberProfile', new mongoose.Schema({}, { collection: 'wrong_collection' }));
  } });
  assert.equal(result.code, 1); assert.equal(result.connected, 0); assert.equal(result.disconnected, 1);
  assert.equal(result.output[1].error, 'UNEXPECTED_MODEL_LAYOUT');
});

test('malformed durable operation result aborts with no unsafe data exposure', async () => {
  const records = fixture(); records[collections.operation][0].result.member.id = 'private-malformed-record';
  const result = await execute({ mock: mockDb(records) });
  assert.equal(result.code, 1); assert.equal(result.output[1].error, 'UNEXPECTED_RECORD_LAYOUT');
  assert.ok(!JSON.stringify(result.output).includes('private-malformed-record'));
});

test('connection, query and cleanup failures omit raw errors and always attempt disconnect', async () => {
  const secretError = new Error('mongodb://private-password Secret-Ref-123 saved-key-private');
  secretError.code = 'driver-specific-secret';
  const mock = mockDb(); mock.db.listCollections = () => { throw secretError; };
  const queryMock = mockDb();
  const collection = queryMock.db.collection;
  queryMock.db.collection = (name) => ({ ...collection(name), findOne: async () => { throw secretError; } });
  for (const options of [{ connectError: secretError }, { mock }, { mock: queryMock }, { disconnectError: secretError }]) {
    const result = await execute(options);
    assert.equal(result.code, 1); assert.equal(result.disconnected, 1);
    assert.ok(!JSON.stringify(result.output).includes('private-password'));
    assert.ok(!JSON.stringify(result.output).includes('driver-specific-secret'));
  }
});

test('durable operation with a different gym in its saved result fails closed', async () => {
  const records = fixture(); records[collections.operation][0].result.member.gymId = ids.other;
  const result = await execute({ mock: mockDb(records) });
  assert.equal(result.code, 1); assert.equal(result.output[1].error, 'UNEXPECTED_RECORD_SCOPE');
  assert.equal(result.disconnected, 1);
});

test('matching member with a different ID from the committed operation retains unconfirmed provenance', async () => {
  const records = fixture();
  records[collections.member].push({ ...records[collections.member][0], _id: oid(ids.other), memberCode: 'ME02' });
  const report = await investigate(mockDb(records).db, loadDiagnosticInput(environment({ DIAGNOSTIC_MEMBER_CODE: 'ME02' })));
  assert.equal(report.matchingMember.provenance, 'unconfirmed');
  assert.equal(report.operationRecords.consistency.savedMemberMatchesOperation, false);
});

test('storage verification only invokes read metadata methods', async () => {
  const mock = mockDb(); await verifyStorage(mock.db); assert.equal(mock.calls.length, 0);
});
