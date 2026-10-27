const { test } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const request = require('supertest');
const { createApp } = require('../../src/app');
const { dashboardQuery } = require('../../src/modules/gymDashboard/dashboard.validation');
const { paymentListQuery } = require('../../src/modules/payments/payment.validation');
const { createMember, updateMember } = require('../../src/modules/members/member.validation');
const { createTrainer } = require('../../src/modules/trainers/trainer.validation');

const gym = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const id = 'bbbbbbbbbbbbbbbbbbbbbbbb';
test('retired feature routes return established not-found without registering domain models', async () => {
  const connection = mongoose.createConnection();
  try {
    const app = createApp({ config: { nodeEnv: 'test', logLevel: 'silent', allowedOrigins: [] }, database: { connection } });
    for (const [method, path] of [
      ['get', `/api/v1/gyms/${gym}/attendance`],
      ['get', `/api/v1/gyms/${gym}/attendance/today`],
      ['post', `/api/v1/gyms/${gym}/attendance/check-in`],
      ['post', `/api/v1/gyms/${gym}/attendance/${id}/check-out`],
      ['get', `/api/v1/gyms/${gym}/branches`],
    ]) {
      const response = await request(app)[method](path).send({});
      assert.equal(response.status, 404, path);
      assert.equal(response.body.error.code, 'NOT_FOUND');
    }
    assert.equal(connection.models.Attendance, undefined);
    assert.equal(connection.models.Branch, undefined);
    assert.ok(connection.models.GymAccess);
    assert.ok(connection.models.TrainerMemberAssignment);
  } finally { await connection.close(); }
});
test('retired branch filters are rejected rather than broadening financial reports', () => {
  assert.equal(dashboardQuery.safeParse({ branchId: id }).success, false);
  assert.equal(paymentListQuery.safeParse({ branchId: id }).success, false);
});
test('ordinary member and trainer writes reject branch assignment', () => {
  const profile = { firstName: 'Alex', lastName: 'River', phone: '9876543210', status: 'active' };
  assert.equal(createMember.safeParse({ ...profile, memberCode: 'ME01' }).success, true);
  assert.equal(createMember.safeParse({ ...profile, memberCode: 'ME01', branchId: id }).success, false);
  assert.equal(updateMember.safeParse({ firstName: 'Alex', branchId: null }).success, false);
  assert.equal(createTrainer.safeParse({ ...profile, trainerCode: 'TR01', branchId: id }).success, false);
});
