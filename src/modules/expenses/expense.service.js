const { Types } = require('mongoose');
const { gymCalendar } = require('../gymDashboard/dashboard.period');
const { createExpense, expenseListQuery } = require('./expense.validation');
const { objectId } = require('../gyms/gym.validation');

function fail(code) { const error = new Error('Expense operation failed.'); error.code = code; throw error; }
function parse(schema, value) { const result = schema.safeParse(value); if (!result.success) fail('VALIDATION_ERROR'); return result.data; }
const day = (text) => new Date(`${text}T00:00:00.000Z`);
const label = (date) => date.toISOString().slice(0, 10);
function dto(expense) {
  return { id: String(expense._id), category: expense.category, amountPaise: expense.amountPaise,
    spentOn: label(expense.spentOn), paymentMethod: expense.paymentMethod, note: expense.note ?? null,
    createdAt: expense.createdAt };
}

function createExpenseService({ Gym, Expense, authorizationService }) {
  async function scope(auth, authorization) {
    authorizationService.requireRoles(auth, authorization, ['admin'], authorization?.gymId);
    const current = await authorizationService.requireGymAccess(auth, authorization.gymId);
    authorizationService.requireRoles(auth, current, ['admin'], authorization.gymId);
    return new Types.ObjectId(current.gymId);
  }
  return {
    async create(auth, authorization, input) {
      const gymId = await scope(auth, authorization);
      const data = parse(createExpense, input);
      // No future-dated spending: compare with the gym-local today.
      const { label: today } = await gymCalendar(Gym, gymId);
      if (data.spentOn > today) fail('VALIDATION_ERROR');
      const expense = await Expense.create({ ...data, spentOn: day(data.spentOn), gymId, recordedByUserId: auth.user._id });
      return dto(expense.toObject());
    },
    async list(auth, authorization, query) {
      const gymId = await scope(auth, authorization);
      const { page, limit, from, to, category } = parse(expenseListQuery, query);
      const calendar = await gymCalendar(Gym, gymId);
      // Default period: the gym-local current month.
      const start = from ?? `${calendar.label.slice(0, 7)}-01`;
      const end = to ?? calendar.label;
      const filter = { gymId, status: 'active', spentOn: { $gte: day(start), $lte: day(end) }, ...(category ? { category } : {}) };
      const [records, total, byCategory] = await Promise.all([
        Expense.find(filter).sort({ spentOn: -1, _id: -1 }).skip((page - 1) * limit).limit(limit).lean(),
        Expense.countDocuments(filter),
        Expense.aggregate([{ $match: filter }, { $group: { _id: '$category', amount: { $sum: '$amountPaise' }, count: { $sum: 1 } } }]),
      ]);
      const totalPaise = byCategory.reduce((sum, row) => sum + row.amount, 0);
      if (!Number.isSafeInteger(totalPaise)) fail('INVALID_FINANCIAL_STATE');
      return { from: start, to: end, totalPaise,
        byCategory: byCategory.map((row) => ({ category: row._id, amountPaise: row.amount, count: row.count }))
          .sort((a, b) => b.amountPaise - a.amountPaise),
        data: records.map(dto), pagination: { page, limit, total } };
    },
    async remove(auth, authorization, expenseId) {
      const gymId = await scope(auth, authorization);
      const id = parse(objectId, expenseId);
      const expense = await Expense.findOneAndUpdate({ _id: id, gymId, status: 'active' },
        { $set: { status: 'removed', removedAt: new Date(), removedByUserId: auth.user._id } },
        { returnDocument: 'after', runValidators: true }).lean();
      if (!expense) fail('EXPENSE_NOT_FOUND');
      return { id: String(expense._id), removed: true };
    },
  };
}
module.exports = { createExpenseService };
