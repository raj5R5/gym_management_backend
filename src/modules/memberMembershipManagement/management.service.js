const { objectId } = require('../gyms/gym.validation');
const { historyQuery, cancelSubscription } = require('./management.validation');
function fail(code) { const error = new Error('Membership management failed.'); error.code = code; throw error; }
function createMembershipManagementService({ summaryService, subscriptionService, paymentService }) {
  async function item(auth, authorization, memberId, subscriptionId) {
    if (!objectId.safeParse(subscriptionId).success) fail('VALIDATION_ERROR');
    await summaryService.authorizeRead(auth, authorization, memberId);
    const subscription = await subscriptionService.get(auth, authorization, subscriptionId);
    if (subscription.memberId !== memberId.toLowerCase() || subscription.gymId !== authorization.gymId) fail('SUBSCRIPTION_NOT_FOUND');
    return subscription;
  }
  return {
    async list(auth, authorization, memberId, query) {
      const parsed = historyQuery.safeParse(query); if (!parsed.success) fail('VALIDATION_ERROR');
      const history = await summaryService.membershipHistory(auth, authorization, memberId, parsed.data);
      const records = [...history.subscriptions, ...(history.currentMembership ? [history.currentMembership] : [])];
      const totals = await paymentService.summariesForMemberships(auth, authorization, memberId, records);
      const enriched = (record) => record ? { ...record, paymentSummary: totals[record.id] } : null;
      return { data: { member: history.member, currentMembership: enriched(history.currentMembership), subscriptions: history.subscriptions.map(enriched) }, pagination: history.pagination };
    },
    async get(auth, authorization, memberId, subscriptionId) {
      const subscription = await item(auth, authorization, memberId, subscriptionId);
      const totals = await paymentService.summariesForMemberships(auth, authorization, memberId, [subscription]);
      return { subscription, paymentSummary: totals[subscription.id] };
    },
    async cancel(auth, authorization, memberId, subscriptionId, input) {
      const parsed = cancelSubscription.safeParse(input); if (!parsed.success) fail('VALIDATION_ERROR');
      await item(auth, authorization, memberId, subscriptionId);
      return subscriptionService.cancelForMember(auth, authorization, memberId, subscriptionId, parsed.data);
    },
  };
}
module.exports = { createMembershipManagementService };
