const { Types } = require('mongoose');
const { objectId } = require('../gyms/gym.validation');
const { gymCalendar } = require('../gymDashboard/dashboard.period');

function fail(code) { const error = new Error('Receipt unavailable.'); error.code = code; throw error; }
const label = (date) => date.toISOString().slice(0, 10);
const receiptNumber = (sequence) => `R-${String(sequence).padStart(5, '0')}`;

function createReceiptService({ Gym, MemberProfile, MemberSubscription, Payment, GymCounter, PaymentReceipt,
  authorizationService, clock = () => new Date() }) {
  let indexes;
  const ensureIndexes = () => (indexes ??= Promise.all([GymCounter.createIndexes(), PaymentReceipt.createIndexes()])
    .catch((error) => { indexes = undefined; throw error; }));

  async function issue(gymId, paymentId) {
    const existing = await PaymentReceipt.findOne({ gymId, paymentId }).lean();
    if (existing) return existing;
    await ensureIndexes();
    // Reserve the next number atomically; a lost race below may leave a gap,
    // which is acceptable: numbers stay unique and increasing.
    const counter = await GymCounter.findOneAndUpdate({ gymId, key: 'receipt' },
      { $inc: { seq: 1 }, $setOnInsert: { gymId, key: 'receipt' } },
      { upsert: true, returnDocument: 'after', runValidators: true }).lean();
    try {
      return (await PaymentReceipt.create({ gymId, paymentId, sequence: counter.seq, issuedAt: clock() })).toObject();
    } catch (error) {
      if (error.code !== 11000) throw error;
      const winner = await PaymentReceipt.findOne({ gymId, paymentId }).lean();
      if (!winner) throw error;
      return winner;
    }
  }

  return { async get(auth, authorization, paymentId) {
    authorizationService.requireRoles(auth, authorization, ['admin'], authorization?.gymId);
    const current = await authorizationService.requireGymAccess(auth, authorization.gymId);
    authorizationService.requireRoles(auth, current, ['admin'], authorization.gymId);
    return build(new Types.ObjectId(current.gymId), paymentId);
  },
  // A member's own receipt: the payment must belong to the resolved member.
  async forMember(member, paymentId) {
    return build(new Types.ObjectId(member.gymId), paymentId, member._id);
  } };

  async function build(gymId, paymentId, memberId) {
    const parsed = objectId.safeParse(paymentId); if (!parsed.success) fail('VALIDATION_ERROR');
    const payment = await Payment.findOne({ _id: parsed.data, gymId, ...(memberId ? { memberId } : {}) }).lean();
    if (!payment) fail('PAYMENT_NOT_FOUND');
    if (payment.status !== 'succeeded') fail('RECEIPT_UNAVAILABLE');
    const [gym, member, subscription, paidRows, calendar] = await Promise.all([
      Gym.findOne({ _id: gymId }).select('name contact settings').lean(),
      MemberProfile.findOne({ _id: payment.memberId, gymId }).select('memberCode firstName lastName phone').lean(),
      MemberSubscription.findOne({ _id: payment.subscriptionId, gymId })
        .select('planNameSnapshot pricePaiseSnapshot discountPaise startDate endDate status').lean(),
      Payment.aggregate([{ $match: { gymId, subscriptionId: payment.subscriptionId, status: 'succeeded' } },
        { $group: { _id: null, amount: { $sum: '$amountPaise' } } }]),
      gymCalendar(Gym, gymId),
    ]);
    if (!gym || !member || !subscription) fail('RECEIPT_UNAVAILABLE');
    const receipt = await issue(gymId, payment._id);
    const paid = paidRows[0]?.amount ?? 0;
    const address = gym.settings?.address;
    return {
      receiptNumber: receiptNumber(receipt.sequence), issuedAt: receipt.issuedAt.toISOString(),
      timezone: calendar.timezone,
      gym: { name: gym.name, phone: gym.contact?.phone ?? null, email: gym.contact?.email ?? null,
        address: address ? [address.line1, address.line2, address.city, address.state, address.postalCode]
          .filter(Boolean).join(', ') : null },
      member: { id: String(payment.memberId), memberCode: member.memberCode,
        name: `${member.firstName} ${member.lastName}`, phone: member.phone },
      payment: { id: String(payment._id), amountPaise: payment.amountPaise, method: payment.paymentMethod,
        reference: payment.transactionReference ?? null, paidAt: payment.paidAt.toISOString() },
      // Balances are as of now, so a later instalment shows on its own receipt.
      membership: { planName: subscription.planNameSnapshot, startDate: label(subscription.startDate),
        endDate: label(subscription.endDate), pricePaise: subscription.pricePaiseSnapshot,
        discountPaise: subscription.discountPaise ?? 0,
        listPricePaise: subscription.pricePaiseSnapshot + (subscription.discountPaise ?? 0),
        paidTotalPaise: paid, balancePaise: Math.max(0, subscription.pricePaiseSnapshot - paid),
        cancelled: subscription.status === 'cancelled' },
    };
  }
}
module.exports = { createReceiptService, receiptNumber };
