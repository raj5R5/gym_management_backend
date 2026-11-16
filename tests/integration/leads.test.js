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

let isolated, database, config, models, app, gymA, gymB, admin, trainer, passwordHash;
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
  await models.MembershipPlan.create({ gymId: gymA._id, name: 'Monthly', normalizedName: 'monthly', durationDays: 30, price: 150000 });
});

const iso = (offset) => utcDay(offset).toISOString().slice(0, 10);
const leads = (gym = gymA) => `/api/v1/gyms/${gym._id}/leads`;
async function enquiry(token, body = {}) {
  const response = await send('post', leads(), token, { firstName: 'Riya', phone: '98200 11111', ...body });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return response.body.data;
}

test('new enquiry gets today as its first follow-up; duplicates point at the open one', async () => {
  const token = await login();
  const lead = await enquiry(token, { lastName: 'Shah', source: 'instagram', note: 'Wants evening batch' });
  assert.equal(lead.status, 'new');
  assert.equal(lead.nextFollowUpOn, iso(0));
  assert.equal(lead.followUpDue, true);
  assert.equal(lead.notes[0].text, 'Wants evening batch');
  const response = await send('post', leads(), token, { firstName: 'Riya', phone: '+91-98200-11111'.replace('+91-', '') });
  assert.equal(response.status, 409);
  assert.equal(response.body.error.code, 'DUPLICATE_LEAD');
  assert.equal(response.body.error.details.leadId, lead.id);
});
test('pipeline: contacted with a follow-up, notes, lost needs a reason, list counts and due filter', async () => {
  const token = await login();
  const lead = await enquiry(token);
  const later = await enquiry(token, { firstName: 'Arjun', phone: '98200 22222', nextFollowUpOn: iso(3) });
  let response = await send('patch', `${leads()}/${lead.id}`, token, { status: 'contacted', nextFollowUpOn: iso(2) });
  assert.equal(response.status, 200);
  assert.equal(response.body.data.status, 'contacted'); assert.equal(response.body.data.followUpDue, false);
  response = await send('post', `${leads()}/${lead.id}/notes`, token, { text: 'Called, will visit Saturday' });
  assert.equal(response.status, 201); assert.equal(response.body.data.notes[0].text, 'Called, will visit Saturday');
  assert.equal((await send('patch', `${leads()}/${later.id}`, token, { status: 'lost' })).status, 400);
  response = await send('patch', `${leads()}/${later.id}`, token, { status: 'lost', lostReason: 'Too far' });
  assert.equal(response.body.data.nextFollowUpOn, null);
  await enquiry(token, { firstName: 'Due', phone: '98200 33333' });
  response = await send('get', `${leads()}?followUp=due`, token);
  assert.deepEqual(response.body.data.data.map((row) => row.firstName), ['Due']);
  assert.deepEqual(response.body.data.counts, { new: 1, contacted: 1, trial: 0, joined: 0, lost: 1, open: 2, followUpsDue: 1 });
  response = await send('get', `${leads()}?search=2222`, token);
  assert.deepEqual(response.body.data.data.map((row) => row.firstName), ['Arjun']);
});
test('a trial lasts 3 days from today and sets the follow-up to its last day', async () => {
  const token = await login();
  const lead = await enquiry(token);
  let response = await send('post', `${leads()}/${lead.id}/trial`, token, {});
  assert.equal(response.status, 200, JSON.stringify(response.body));
  const data = response.body.data;
  assert.deepEqual([data.status, data.trialStartDate, data.trialEndDate, data.nextFollowUpOn, data.trialActive],
    ['trial', iso(0), iso(3), iso(2), true]);
  response = await send('post', `${leads()}/${lead.id}/trial`, token, {});
  assert.equal(response.status, 409, 'already on trial');
  const other = await enquiry(token, { firstName: 'Past', phone: '98200 44444' });
  assert.equal((await send('post', `${leads()}/${other.id}/trial`, token, { startDate: iso(-1) })).status, 400);
});
test('convert links the new member, is idempotent, and records referrals', async () => {
  const token = await login();
  const referrer = await member('Aarav');
  const lead = await enquiry(token, { referredByMemberId: String(referrer._id) });
  assert.equal(lead.source, 'referral');
  assert.equal(lead.referredBy.name, 'Aarav Test');
  const joined = await member('Riya');
  let response = await send('post', `${leads()}/${lead.id}/convert`, token, { memberId: String(joined._id) });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(response.body.data.status, 'joined');
  assert.equal(response.body.data.convertedMember.name, 'Riya Test');
  assert.equal((await send('post', `${leads()}/${lead.id}/convert`, token, { memberId: String(joined._id) })).status, 200);
  const someoneElse = await member('Else');
  assert.equal((await send('post', `${leads()}/${lead.id}/convert`, token, { memberId: String(someoneElse._id) })).status, 409);
  assert.equal((await send('patch', `${leads()}/${lead.id}`, token, { status: 'new' })).status, 409, 'joined is final');
  await enquiry(token, { firstName: 'Second', phone: '98200 55555', referredByMemberId: String(referrer._id) });
  response = await send('get', `${leads()}/referrals`, token);
  assert.deepEqual(response.body.data.data, [{ member: { id: String(referrer._id), name: 'Aarav Test', memberCode: referrer.memberCode },
    referred: 2, joined: 1 }]);
  response = await send('get', `${leads()}?referredByMemberId=${referrer._id}`, token);
  assert.equal(response.body.data.pagination.total, 2);
  const outsider = await member('Outsider', gymB);
  assert.equal((await send('post', `${leads()}/${lead.id}/convert`, token, { memberId: String(outsider._id) })).status, 404);
  assert.equal((await send('post', leads(), token, { firstName: 'X', phone: '98200 66666', referredByMemberId: String(outsider._id) })).status, 404);
});
test('enquiries are admin-only and gym-scoped; bad input is rejected', async () => {
  const token = await login();
  const lead = await enquiry(token);
  assert.equal((await send('get', leads(), await login(trainer))).status, 403);
  assert.equal((await send('get', leads(gymB), token)).status, 403);
  assert.equal((await send('get', `${leads()}/000000000000000000000000`, token)).status, 404);
  for (const body of [{}, { firstName: 'A', phone: '12' }, { firstName: 'A', phone: '9820011111', source: 'tv' },
    { firstName: 'A', phone: '9820011112', gymId: 'x' }]) {
    assert.equal((await send('post', leads(), token, body)).status, 400, JSON.stringify(body));
  }
  assert.equal((await send('patch', `${leads()}/${lead.id}`, token, { status: 'joined' })).status, 400);
});
test('birthdays: upcoming within the window, soonest first, with the age turning', async () => {
  const token = await login();
  const birth = (offset, yearsAgo) => { const d = utcDay(offset); d.setUTCFullYear(d.getUTCFullYear() - yearsAgo); return d; };
  const a = await member('Today'); await models.MemberProfile.updateOne({ _id: a._id }, { dateOfBirth: birth(0, 30) });
  const b = await member('Soon'); await models.MemberProfile.updateOne({ _id: b._id }, { dateOfBirth: birth(5, 25) });
  const c = await member('Later'); await models.MemberProfile.updateOne({ _id: c._id }, { dateOfBirth: birth(20, 40) });
  await member('NoDob');
  let response = await send('get', `/api/v1/gyms/${gymA._id}/member-overview/birthdays`, token);
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.deepEqual(response.body.data.data.map((row) => [row.member.firstName, row.daysUntil, row.turning]),
    [['Today', 0, 30], ['Soon', 5, 25]]);
  response = await send('get', `/api/v1/gyms/${gymA._id}/member-overview/birthdays?days=30`, token);
  assert.equal(response.body.data.data.length, 3);
  assert.equal((await send('get', `/api/v1/gyms/${gymA._id}/member-overview/birthdays?days=99`, token)).status, 400);
});
test('dashboard reports new enquiries, joins, due follow-ups and active trials', async () => {
  const token = await login();
  const one = await enquiry(token);
  await enquiry(token, { firstName: 'Two', phone: '98200 77777', nextFollowUpOn: iso(5) });
  await send('post', `${leads()}/${one.id}/trial`, token, {});
  const response = await send('get', `/api/v1/gyms/${gymA._id}/dashboard`, token);
  assert.deepEqual(response.body.data.leads, { newInPeriod: 2, joinedInPeriod: 0, followUpsDue: 0, activeTrials: 1 });
});
