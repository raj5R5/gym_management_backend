const { Types } = require('mongoose');
const { gymCalendar, dashboardPeriod } = require('../gymDashboard/dashboard.period');
const { objectId } = require('../gyms/gym.validation');
const schemas = require('./pt.validation');

const DAY = 86_400_000;
const PAGE_DETAIL = 100;
function fail(code) { const error = new Error('Personal training operation failed.'); error.code = code; throw error; }
function parse(schema, value) { const result = schema.safeParse(value); if (!result.success) fail('VALIDATION_ERROR'); return result.data; }
const day = (text) => new Date(`${text}T00:00:00.000Z`);
const label = (date) => (date ? date.toISOString().slice(0, 10) : null);
const id = (value) => new Types.ObjectId(parse(objectId, String(value)));
// Integer paise, rounded half up; the percent has at most two decimals.
const commissionOf = (amountPaise, percent) => Math.round((amountPaise * Math.round(percent * 100)) / 10_000);

function createPtService({ Gym, PtPackage, PtPayment, PtSession, TrainerCommissionRate, TrainerProfile, MemberProfile,
  TrainerMemberAssignment, authorizationService, clock = () => new Date() }) {
  let indexes;
  const ensureIndexes = () => (indexes ??= Promise.all([PtPackage, PtPayment, PtSession, TrainerCommissionRate]
    .map((model) => model.createIndexes())).catch((error) => { indexes = undefined; throw error; }));

  // Admins see everything; a trainer is scoped to their own single active trainer profile.
  async function scope(auth, authorization, allowed = ['admin']) {
    authorizationService.requireRoles(auth, authorization, allowed, authorization?.gymId);
    const current = await authorizationService.requireGymAccess(auth, authorization.gymId);
    authorizationService.requireRoles(auth, current, allowed, authorization.gymId);
    const gymId = new Types.ObjectId(current.gymId);
    if (current.role === 'admin') return { gymId, admin: true };
    const profiles = await TrainerProfile.find({ userId: auth.user._id, gymId, status: 'active' }).select('_id').limit(2).lean();
    if (profiles.length !== 1) fail('FORBIDDEN');
    return { gymId, admin: false, trainerId: profiles[0]._id };
  }
  async function transaction(work) {
    const session = await PtPackage.db.startSession();
    try { return await session.withTransaction(() => work(session)); } finally { await session.endSession(); }
  }
  async function people(gymId, packages) {
    const memberIds = [...new Set(packages.map((pkg) => String(pkg.memberId)))];
    const trainerIds = [...new Set(packages.map((pkg) => String(pkg.trainerId)))];
    const [members, trainers] = await Promise.all([
      MemberProfile.find({ gymId, _id: { $in: memberIds } }).select('firstName lastName memberCode phone').lean(),
      TrainerProfile.find({ gymId, _id: { $in: trainerIds } }).select('firstName lastName trainerCode').lean(),
    ]);
    return {
      members: new Map(members.map((m) => [String(m._id),
        { id: String(m._id), name: `${m.firstName} ${m.lastName}`, memberCode: m.memberCode, phone: m.phone ?? null }])),
      trainers: new Map(trainers.map((t) => [String(t._id),
        { id: String(t._id), name: `${t.firstName} ${t.lastName}`, trainerCode: t.trainerCode }])),
    };
  }
  function dto(pkg, names, viewer, today) {
    const expired = Boolean(pkg.expiresOn && pkg.expiresOn <= today);
    const base = { id: String(pkg._id), name: pkg.name,
      member: names.members.get(String(pkg.memberId)) ?? null, trainer: names.trainers.get(String(pkg.trainerId)) ?? null,
      sessionsTotal: pkg.sessionsTotal, sessionsUsed: pkg.sessionsUsed, sessionsLeft: pkg.sessionsTotal - pkg.sessionsUsed,
      startDate: label(pkg.startDate), expiresOn: label(pkg.expiresOn), expired, status: pkg.status, createdAt: pkg.createdAt };
    // Trainers never see prices, payments or commission.
    if (!viewer.admin) return base;
    return { ...base, pricePaise: pkg.pricePaise, paidPaise: pkg.paidPaise, balancePaise: pkg.pricePaise - pkg.paidPaise,
      commissionPercent: pkg.commissionPercent };
  }
  async function packageFor(viewer, packageId, session) {
    const filter = { _id: id(packageId), gymId: viewer.gymId, ...(viewer.admin ? {} : { trainerId: viewer.trainerId }) };
    const pkg = await PtPackage.findOne(filter).session(session ?? null).lean();
    if (!pkg) fail('PT_PACKAGE_NOT_FOUND');
    return pkg;
  }
  async function detail(viewer, packageId) {
    const pkg = await packageFor(viewer, packageId);
    const [names, calendar, sessions, payments] = await Promise.all([
      people(viewer.gymId, [pkg]), gymCalendar(Gym, viewer.gymId, clock()),
      PtSession.find({ gymId: viewer.gymId, packageId: pkg._id }).sort({ sessionDate: -1, _id: -1 }).limit(PAGE_DETAIL).lean(),
      viewer.admin ? PtPayment.find({ gymId: viewer.gymId, packageId: pkg._id }).sort({ paidAt: -1, _id: -1 }).lean() : [],
    ]);
    return { ...dto(pkg, names, viewer, calendar.day),
      sessions: sessions.map((s) => ({ id: String(s._id), sessionDate: label(s.sessionDate), note: s.note ?? null })),
      ...(viewer.admin ? { payments: payments.map((p) => ({ id: String(p._id), amountPaise: p.amountPaise,
        method: p.paymentMethod, reference: p.reference ?? null, paidAt: p.paidAt,
        commissionPercent: p.commissionPercent, commissionPaise: p.commissionPaise })) } : {}) };
  }
  async function rateFor(gymId, trainerId, session) {
    const rate = await TrainerCommissionRate.findOne({ gymId, trainerId }).session(session ?? null).lean();
    return rate?.percent ?? 0;
  }
  // Conditional increment: fails rather than overpaying when two payments race.
  async function recordPayment(viewer, pkg, payment, auth, session) {
    const updated = await PtPackage.findOneAndUpdate(
      { _id: pkg._id, gymId: viewer.gymId, status: { $ne: 'cancelled' },
        $expr: { $lte: [{ $add: ['$paidPaise', payment.amountPaise] }, '$pricePaise'] } },
      { $inc: { paidPaise: payment.amountPaise } }, { returnDocument: 'after', session, runValidators: true }).lean();
    if (!updated) {
      const current = await PtPackage.findOne({ _id: pkg._id, gymId: viewer.gymId }).session(session).select('status').lean();
      fail(current?.status === 'cancelled' ? 'PT_PACKAGE_CLOSED' : 'PT_PAYMENT_EXCEEDS_BALANCE');
    }
    await PtPayment.create([{ gymId: viewer.gymId, packageId: pkg._id, memberId: pkg.memberId, trainerId: pkg.trainerId,
      amountPaise: payment.amountPaise, paymentMethod: payment.method, ...(payment.reference ? { reference: payment.reference } : {}),
      paidAt: clock(), commissionPercent: pkg.commissionPercent,
      commissionPaise: commissionOf(payment.amountPaise, pkg.commissionPercent), recordedByUserId: auth.user._id }], { session });
  }

  return {
    async list(auth, authorization, query) {
      const viewer = await scope(auth, authorization, ['admin', 'trainer']);
      const { page, limit, memberId, trainerId, status } = parse(schemas.packageListQuery, query);
      const filter = { gymId: viewer.gymId };
      if (memberId) filter.memberId = id(memberId);
      if (trainerId) filter.trainerId = id(trainerId);
      // A trainer filter intersects with self scope; it never widens it.
      if (!viewer.admin) {
        if (trainerId && String(trainerId).toLowerCase() !== String(viewer.trainerId)) fail('FORBIDDEN');
        filter.trainerId = viewer.trainerId;
      }
      if (status) filter.status = status;
      const [rows, total, calendar] = await Promise.all([
        PtPackage.find(filter).sort({ createdAt: -1, _id: -1 }).skip((page - 1) * limit).limit(limit).lean(),
        PtPackage.countDocuments(filter), gymCalendar(Gym, viewer.gymId, clock())]);
      const names = await people(viewer.gymId, rows);
      return { data: rows.map((row) => dto(row, names, viewer, calendar.day)), pagination: { page, limit, total } };
    },
    async get(auth, authorization, packageId) {
      return detail(await scope(auth, authorization, ['admin', 'trainer']), packageId);
    },
    async create(auth, authorization, body) {
      const viewer = await scope(auth, authorization);
      const input = parse(schemas.createPackage, body);
      await ensureIndexes();
      const packageId = await transaction(async (session) => {
        const calendar = await gymCalendar(Gym, viewer.gymId, clock(), session);
        const [member, trainer] = await Promise.all([
          MemberProfile.findOne({ _id: id(input.memberId), gymId: viewer.gymId }).session(session).select('status').lean(),
          TrainerProfile.findOne({ _id: id(input.trainerId), gymId: viewer.gymId }).session(session).select('status').lean()]);
        if (!member) fail('MEMBER_NOT_FOUND');
        if (!trainer) fail('TRAINER_NOT_FOUND');
        if (member.status !== 'active' || trainer.status !== 'active') fail('PT_PARTICIPANT_INACTIVE');
        const startDate = input.startDate ? day(input.startDate) : calendar.day;
        if (startDate < calendar.day) fail('VALIDATION_ERROR');
        if (input.payment && input.payment.amountPaise > input.pricePaise) fail('PT_PAYMENT_EXCEEDS_BALANCE');
        const [pkg] = await PtPackage.create([{ gymId: viewer.gymId, memberId: member._id, trainerId: trainer._id,
          name: input.name, sessionsTotal: input.sessions, pricePaise: input.pricePaise, startDate,
          ...(input.validDays ? { expiresOn: new Date(startDate.getTime() + input.validDays * DAY) } : {}),
          commissionPercent: await rateFor(viewer.gymId, trainer._id, session), createdByUserId: auth.user._id }], { session });
        // Selling PT links the trainer to the member so the trainer view lists them.
        const linked = await TrainerMemberAssignment.exists({ gymId: viewer.gymId, trainerId: trainer._id,
          memberId: member._id, status: 'active' }).session(session);
        if (!linked) {
          await TrainerMemberAssignment.create([{ gymId: viewer.gymId, trainerId: trainer._id, memberId: member._id,
            status: 'active', assignedAt: clock() }], { session });
        }
        if (input.payment) await recordPayment(viewer, pkg.toObject(), input.payment, auth, session);
        return pkg._id;
      });
      return detail(viewer, packageId);
    },
    async addPayment(auth, authorization, packageId, body) {
      const viewer = await scope(auth, authorization);
      const payment = parse(schemas.payment, body);
      await ensureIndexes();
      await transaction(async (session) => recordPayment(viewer, await packageFor(viewer, packageId, session), payment, auth, session));
      return detail(viewer, packageId);
    },
    async logSession(auth, authorization, packageId, body) {
      const viewer = await scope(auth, authorization, ['admin', 'trainer']);
      const input = parse(schemas.logSession, body);
      await ensureIndexes();
      await transaction(async (session) => {
        const pkg = await packageFor(viewer, packageId, session);
        const calendar = await gymCalendar(Gym, viewer.gymId, clock(), session);
        const sessionDate = input.sessionDate ? day(input.sessionDate) : calendar.day;
        if (sessionDate > calendar.day || sessionDate < pkg.startDate) fail('PT_SESSION_DATE_INVALID');
        if (pkg.expiresOn && sessionDate >= pkg.expiresOn) fail('PT_PACKAGE_EXPIRED');
        const updated = await PtPackage.findOneAndUpdate(
          { _id: pkg._id, gymId: viewer.gymId, status: 'active', $expr: { $lt: ['$sessionsUsed', '$sessionsTotal'] } },
          { $inc: { sessionsUsed: 1 } }, { returnDocument: 'after', session, runValidators: true }).lean();
        if (!updated) fail('PT_PACKAGE_CLOSED');
        if (updated.sessionsUsed === updated.sessionsTotal) {
          await PtPackage.updateOne({ _id: pkg._id, gymId: viewer.gymId, status: 'active' }, { status: 'completed' },
            { session, runValidators: true });
        }
        await PtSession.create([{ gymId: viewer.gymId, packageId: pkg._id, memberId: pkg.memberId, trainerId: pkg.trainerId,
          sessionDate, ...(input.note ? { note: input.note } : {}), loggedByUserId: auth.user._id }], { session });
      });
      return detail(viewer, packageId);
    },
    async cancel(auth, authorization, packageId) {
      const viewer = await scope(auth, authorization);
      const pkg = await packageFor(viewer, packageId);
      const result = await PtPackage.updateOne({ _id: pkg._id, gymId: viewer.gymId, status: 'active' },
        { status: 'cancelled', cancelledAt: clock() }, { runValidators: true });
      if (result.matchedCount !== 1) fail('PT_PACKAGE_CLOSED');
      return detail(viewer, packageId);
    },
    async rates(auth, authorization) {
      const viewer = await scope(auth, authorization);
      const [trainers, rates] = await Promise.all([
        TrainerProfile.find({ gymId: viewer.gymId, status: 'active' }).sort({ firstName: 1, _id: 1 })
          .select('firstName lastName trainerCode').limit(500).lean(),
        TrainerCommissionRate.find({ gymId: viewer.gymId }).lean()]);
      const byTrainer = new Map(rates.map((rate) => [String(rate.trainerId), rate.percent]));
      return trainers.map((t) => ({ trainer: { id: String(t._id), name: `${t.firstName} ${t.lastName}`, trainerCode: t.trainerCode },
        percent: byTrainer.get(String(t._id)) ?? 0 }));
    },
    async setRate(auth, authorization, trainerId, body) {
      const viewer = await scope(auth, authorization);
      const { percent } = parse(schemas.setRate, body);
      const trainer = await TrainerProfile.findOne({ _id: id(trainerId), gymId: viewer.gymId }).select('_id').lean();
      if (!trainer) fail('TRAINER_NOT_FOUND');
      await ensureIndexes();
      // Applies to packages sold from now on; existing packages keep their snapshot.
      await TrainerCommissionRate.updateOne({ gymId: viewer.gymId, trainerId: trainer._id }, { $set: { percent } },
        { upsert: true, runValidators: true });
      return { trainerId: String(trainer._id), percent };
    },
    // Commission accrues on PT money collected in the period, at each package's snapshot rate.
    async commissions(auth, authorization, query) {
      const viewer = await scope(auth, authorization);
      const input = parse(schemas.periodQuery, query);
      const calendar = await gymCalendar(Gym, viewer.gymId, clock());
      const period = await dashboardPeriod(Gym, viewer.gymId, calendar.timezone,
        input.from || input.to ? input : { preset: input.preset ?? 'thisMonth' }, clock());
      const [paid, sessions, trainers] = await Promise.all([
        PtPayment.aggregate([{ $match: { gymId: viewer.gymId, paidAt: { $gte: period.start, $lt: period.end } } },
          { $group: { _id: '$trainerId', collectedPaise: { $sum: '$amountPaise' },
            commissionPaise: { $sum: '$commissionPaise' }, payments: { $sum: 1 } } }]),
        PtSession.aggregate([{ $match: { gymId: viewer.gymId,
          sessionDate: { $gte: day(period.dto.from), $lte: day(period.dto.to) } } },
        { $group: { _id: '$trainerId', sessions: { $sum: 1 } } }]),
        TrainerProfile.find({ gymId: viewer.gymId }).select('firstName lastName trainerCode status').lean()]);
      const money = new Map(paid.map((row) => [String(row._id), row]));
      const counts = new Map(sessions.map((row) => [String(row._id), row.sessions]));
      const rows = trainers.map((t) => {
        const key = String(t._id); const row = money.get(key);
        return { trainer: { id: key, name: `${t.firstName} ${t.lastName}`, trainerCode: t.trainerCode },
          collectedPaise: row?.collectedPaise ?? 0, commissionPaise: row?.commissionPaise ?? 0,
          payments: row?.payments ?? 0, sessions: counts.get(key) ?? 0, active: t.status === 'active' };
      }).filter((row) => row.active || row.payments || row.sessions)
        .sort((a, b) => b.commissionPaise - a.commissionPaise || b.sessions - a.sessions || a.trainer.name.localeCompare(b.trainer.name));
      const sum = (field) => rows.reduce((total, row) => total + row[field], 0);
      return { period: period.dto, trainers: rows,
        totals: { collectedPaise: sum('collectedPaise'), commissionPaise: sum('commissionPaise'), sessions: sum('sessions') } };
    },
  };
}
module.exports = { createPtService, commissionOf };
