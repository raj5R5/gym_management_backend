const { purchaseMembership } = require('./membership.validation');
const { gymCalendar } = require('../gymDashboard/dashboard.period');
function fail(code) { const error = new Error('Membership purchase failed.'); error.code = code; throw error; }
function createMemberMembershipService({ MemberSubscription, subscriptionService, paymentService, authorizationService }) {
  return { async create(auth, authorization, input) {
    authorizationService.requireRoles(auth, authorization, ['admin', 'trainer'], authorization?.gymId);
    const current = await authorizationService.requireGymAccess(auth, authorization.gymId);
    authorizationService.requireRoles(auth, current, ['admin', 'trainer'], authorization.gymId);
    const parsed = purchaseMembership.safeParse(input); if (!parsed.success) fail('VALIDATION_ERROR'); const data = parsed.data;
    const startDate = data.startDate ?? (await gymCalendar(MemberSubscription.db.models.Gym, current.gymId)).label;
    const session = await MemberSubscription.db.startSession();
    try {
      return await session.withTransaction(async () => {
        const subscription = await subscriptionService.createForPurchase(auth, current, {
          memberId: data.memberId, membershipPlanId: data.planId, startDate }, session);
        const payment = data.payment?.enabled ? await paymentService.createForPurchase(auth, current, {
          memberId: data.memberId, subscriptionId: subscription.id, amountPaise: data.payment.amountPaise,
          paymentMethod: data.payment.method, paidAt: data.payment.paidAt, transactionReference: data.payment.reference }, session) : null;
        return { subscription, payment };
      }, { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } });
    } catch (error) {
      if (error.code === 20 || error.originalError?.code === 20) fail('SUBSCRIPTION_STORAGE_UNAVAILABLE');
      throw error;
    } finally { await session.endSession(); }
  } };
}
module.exports = { createMemberMembershipService };
