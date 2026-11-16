const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const request = require('supertest');
const { startTestMongo } = require('../helpers/mongo');
const { testAuthEnv } = require('../helpers/authConfig');
const { loadConfig } = require('../../src/config/env');
const { createDatabase } = require('../../src/config/database');
const { createLogger } = require('../../src/config/logger');
const { createApp } = require('../../src/app');
const { initializePasswords, hashPassword } = require('../../src/modules/auth/password');

let isolated, database, config, models, app, gymA, gymB, admin, trainer, plan, passwordHash;
const password = randomBytes(24).toString('base64url');
const utcDay = (offset = 0) => { const value = new Date(); value.setUTCHours(0, 0, 0, 0); value.setUTCDate(value.getUTCDate() + offset); return value; };

function send(method, url, token, body) {
  const pending = request(app)[method](url);
  if (token) pending.set('Authorization', `Bearer ${token}`);
  if (body !== undefined) pending.send(body);
  return pending;
}
async function login(account = admin) {
  const response = await request(app).post('/api/v1/auth/login').send({ email: account.email, password, client: 'mobile' });
  assert.equal(response.status, 200); return response.body.data.accessToken;
}
let codes = 0;
async function member(firstName, gym = gymA) {
  codes += 1;
  return models.MemberProfile.create({ gymId: gym._id, memberCode: `ME${String(codes).padStart(3, '0')}`, firstName, lastName: 'Test', phone: '9876543210' });
}

before(async () => {
  await initializePasswords(); passwordHash = await hashPassword(password);
  isolated = await startTestMongo({ replicaSet: true });
  config = loadConfig({ ...testAuthEnv, NODE_ENV: 'test', LOG_LEVEL: 'silent', MONGO_URI: isolated.uri });
  database = createDatabase({ logger: createLogger(config) });
  await database.connect(config);
  createApp({ config, database }); models = database.connection.models;
  await Promise.all(Object.values(models).map((model) => model.createIndexes()));
});
after(async () => {
  try { if (database) await database.disconnect(); } finally { if (isolated) await isolated.stop(); }
});
beforeEach(async () => {
  await Promise.all(Object.values(models).map((model) => model.deleteMany({})));
  app = createApp({ config, database });
  gymA = await models.Gym.create({ name: 'Gym A', nameKey: 'gym a', status: 'active', settings: { timezone: 'UTC' } });
  gymB = await models.Gym.create({ name: 'Gym B', nameKey: 'gym b', status: 'active' });
  admin = await models.UserAccount.create({ email: 'admin@example.com', passwordHash, status: 'active' });
  trainer = await models.UserAccount.create({ email: 'trainer@example.com', passwordHash, status: 'active' });
  await models.GymAccess.create({ userId: admin._id, gymId: gymA._id, role: 'admin', status: 'active' });
  await models.GymAccess.create({ userId: trainer._id, gymId: gymA._id, role: 'trainer', status: 'active' });
  plan = await models.MembershipPlan.create({ gymId: gymA._id, name: 'Monthly', normalizedName: 'monthly', durationDays: 30, price: 150000 });
});

const branches = '/api/v1/branches';

test('an owner adds a branch, copying active plans and settings, and gets admin access', async () => {
  const token = await login();
  await models.Gym.updateOne({ _id: gymA._id }, { $set: { contact: { phone: '9876500000' },
    'settings.gstin': '27AAPFU0939F1ZV', 'settings.upiId': 'gyma@okaxis', 'settings.address': { line1: 'A', city: 'Pune' } } });
  await models.MembershipPlan.create({ gymId: gymA._id, name: 'Old', normalizedName: 'old', durationDays: 30, price: 1, status: 'inactive' });
  const response = await send('post', branches, token, { name: 'Gym A Andheri', fromGymId: String(gymA._id) });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  const gym = await models.Gym.findById(response.body.data.gymId).lean();
  assert.equal(gym.name, 'Gym A Andheri');
  assert.equal(gym.settings.timezone, 'UTC');
  assert.equal(gym.settings.gstin, '27AAPFU0939F1ZV');
  assert.equal(gym.settings.upiId, 'gyma@okaxis');
  assert.equal(gym.settings.address, undefined, 'each branch has its own address');
  assert.equal(gym.contact.phone, '9876500000');
  const plans = await models.MembershipPlan.find({ gymId: gym._id }).lean();
  assert.deepEqual(plans.map((item) => [item.name, item.price, item.status]), [['Monthly', 150000, 'active']]);
  const access = await models.GymAccess.findOne({ gymId: gym._id }).lean();
  assert.deepEqual([String(access.userId), access.role, access.status], [String(admin._id), 'admin', 'active']);
  const me = await send('get', '/api/v1/auth/me', token);
  assert.equal(me.body.data.gymAccess.filter((grant) => grant.role === 'admin').length, 2);
});
test('a blank branch copies nothing; names stay unique', async () => {
  const token = await login();
  let response = await send('post', branches, token, { name: 'Blank Branch', copyPlans: false, copySettings: false });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  assert.equal(await models.MembershipPlan.countDocuments({ gymId: response.body.data.gymId }), 0);
  response = await send('post', branches, token, { name: 'blank  branch', copyPlans: false, copySettings: false });
  assert.equal(response.status, 409); assert.equal(response.body.error.code, 'DUPLICATE_GYM_NAME');
  assert.equal((await send('post', branches, token, { name: 'X Branch' })).status, 400, 'copying needs a source');
});
test('only owners can add branches, and only copy from their own gyms', async () => {
  assert.equal((await send('post', branches, await login(trainer), { name: 'Sneaky', copyPlans: false, copySettings: false })).status, 403);
  assert.equal((await send('post', branches, await login(), { name: 'Copy B', fromGymId: String(gymB._id) })).status, 403);
  assert.equal((await send('post', branches)).status, 401);
  assert.equal(await models.Gym.countDocuments(), 2);
});
test('summary lists each owned branch with totals, never other gyms', async () => {
  const token = await login();
  const second = (await send('post', branches, token, { name: 'Gym A West', fromGymId: String(gymA._id) })).body.data.gymId;
  const a = await member('Aarav');
  await models.MemberSubscription.create({ gymId: gymA._id, memberId: a._id, membershipPlanId: plan._id,
    startDate: utcDay(-5), endDate: utcDay(25), durationDaysSnapshot: 30, pricePaiseSnapshot: 150000, planNameSnapshot: 'Monthly' });
  const response = await send('get', `${branches}/summary`, token);
  assert.equal(response.status, 200, JSON.stringify(response.body));
  const data = response.body.data;
  assert.deepEqual(data.branches.map((row) => row.name), ['Gym A', 'Gym A West']);
  assert.equal(data.branches[0].activeMembers, 1);
  assert.equal(data.branches[0].duesPaise, 150000);
  assert.equal(data.branches[1].gymId, second);
  assert.equal(data.totals.activeMembers, 1);
  assert.equal(data.totals.duesPaise, 150000);
  assert.doesNotMatch(JSON.stringify(data), /Gym B/);
  assert.equal((await send('get', `${branches}/summary`, await login(trainer))).status, 403);
});
