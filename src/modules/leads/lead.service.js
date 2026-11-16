const { Types } = require('mongoose');
const { gymCalendar } = require('../gymDashboard/dashboard.period');
const { objectId } = require('../gyms/gym.validation');
const { statuses, OPEN } = require('./lead.model');
const { TRIAL_DAYS, createLead, updateLead, addNote, startTrial, convertLead, leadListQuery } = require('./lead.validation');

const DAY = 86_400_000;
function fail(code, details) {
  const error = new Error('Enquiry operation failed.'); error.code = code;
  if (details) error.details = details;
  throw error;
}
function parse(schema, value) { const result = schema.safeParse(value); if (!result.success) fail('VALIDATION_ERROR'); return result.data; }
const day = (text) => new Date(`${text}T00:00:00.000Z`);
const label = (date) => (date ? date.toISOString().slice(0, 10) : null);
const digits = (phone) => phone.replace(/\D/g, '');
const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function createLeadService({ Gym, Lead, MemberProfile, MembershipPlan, authorizationService, clock = () => new Date() }) {
  let indexes;
  const ensureIndexes = () => (indexes ??= Lead.createIndexes().catch((error) => { indexes = undefined; throw error; }));

  async function scope(auth, authorization) {
    authorizationService.requireRoles(auth, authorization, ['admin'], authorization?.gymId);
    const current = await authorizationService.requireGymAccess(auth, authorization.gymId);
    authorizationService.requireRoles(auth, current, ['admin'], authorization.gymId);
    return new Types.ObjectId(current.gymId);
  }
  async function today(gymId) { return (await gymCalendar(Gym, gymId, clock())).day; }
  async function requireMember(gymId, memberId) {
    if (!memberId) return;
    if (!await MemberProfile.exists({ _id: memberId, gymId })) fail('MEMBER_NOT_FOUND');
  }
  async function requirePlan(gymId, planId) {
    if (!planId) return;
    if (!await MembershipPlan.exists({ _id: planId, gymId })) fail('PLAN_NOT_FOUND');
  }
  async function leadFor(gymId, leadId) {
    const lead = await Lead.findOne({ _id: parse(objectId, leadId), gymId }).lean();
    if (!lead) fail('LEAD_NOT_FOUND');
    return lead;
  }
  async function names(gymId, ids) {
    const unique = [...new Set(ids.filter(Boolean).map(String))];
    if (!unique.length) return new Map();
    const members = await MemberProfile.find({ gymId, _id: { $in: unique } }).select('firstName lastName memberCode').lean();
    return new Map(members.map((member) => [String(member._id),
      { id: String(member._id), name: `${member.firstName} ${member.lastName}`, memberCode: member.memberCode }]));
  }
  function dto(lead, people, now) {
    const due = OPEN.includes(lead.status) && lead.nextFollowUpOn && lead.nextFollowUpOn <= now;
    const trialActive = lead.status === 'trial' && lead.trialStartDate <= now && lead.trialEndDate > now;
    return { id: String(lead._id), firstName: lead.firstName, lastName: lead.lastName ?? null, phone: lead.phone,
      source: lead.source, status: lead.status, nextFollowUpOn: label(lead.nextFollowUpOn), followUpDue: Boolean(due),
      trialStartDate: label(lead.trialStartDate), trialEndDate: label(lead.trialEndDate), trialActive,
      lostReason: lead.lostReason ?? null, interestedPlanId: lead.interestedPlanId ? String(lead.interestedPlanId) : null,
      referredBy: lead.referredByMemberId ? people.get(String(lead.referredByMemberId)) ?? null : null,
      convertedMember: lead.convertedMemberId ? people.get(String(lead.convertedMemberId)) ?? null : null,
      convertedAt: lead.convertedAt ?? null,
      notes: (lead.notes ?? []).map((note) => ({ id: String(note._id), text: note.text, createdAt: note.createdAt }))
        .reverse(),
      createdAt: lead.createdAt };
  }
  async function one(gymId, leadId) {
    const lead = await leadFor(gymId, leadId);
    return dto(lead, await names(gymId, [lead.referredByMemberId, lead.convertedMemberId]), await today(gymId));
  }
  // Conditional write: only if the enquiry is still in one of `from` statuses.
  async function write(gymId, lead, from, update) {
    const result = await Lead.updateOne({ _id: lead._id, gymId, status: { $in: from } }, update, { runValidators: true });
    if (result.matchedCount !== 1) fail('LEAD_STATE_CHANGED');
  }

  return {
    async list(auth, authorization, query) {
      const gymId = await scope(auth, authorization);
      const { page, limit, status, followUp, referredByMemberId, search } = parse(leadListQuery, query);
      const now = await today(gymId);
      const filter = { gymId };
      if (status === 'open') filter.status = { $in: OPEN };
      else if (status) filter.status = status;
      if (followUp === 'due') { filter.status = { $in: OPEN }; filter.nextFollowUpOn = { $lte: now }; }
      if (referredByMemberId) filter.referredByMemberId = new Types.ObjectId(referredByMemberId);
      if (search) {
        const literal = escape(search); const phone = digits(search);
        filter.$or = [{ firstName: { $regex: literal, $options: 'i' } }, { lastName: { $regex: literal, $options: 'i' } },
          ...(phone.length >= 3 ? [{ phoneDigits: { $regex: escape(phone) } }] : [])];
      }
      // Follow-ups: soonest first. Otherwise newest enquiries first.
      const sort = followUp === 'due' ? { nextFollowUpOn: 1, _id: 1 } : { createdAt: -1, _id: -1 };
      const [records, total, grouped, due] = await Promise.all([
        Lead.find(filter).sort(sort).skip((page - 1) * limit).limit(limit).lean(),
        Lead.countDocuments(filter),
        Lead.aggregate([{ $match: { gymId } }, { $group: { _id: '$status', count: { $sum: 1 } } }]),
        Lead.countDocuments({ gymId, status: { $in: OPEN }, nextFollowUpOn: { $lte: now } }),
      ]);
      const counts = Object.fromEntries(statuses.map((value) => [value, 0]));
      for (const row of grouped) counts[row._id] = row.count;
      counts.open = OPEN.reduce((sum, value) => sum + counts[value], 0);
      counts.followUpsDue = due;
      const people = await names(gymId, records.flatMap((lead) => [lead.referredByMemberId, lead.convertedMemberId]));
      return { counts, data: records.map((lead) => dto(lead, people, now)), pagination: { page, limit, total } };
    },

    async create(auth, authorization, input) {
      const gymId = await scope(auth, authorization);
      const data = parse(createLead, input);
      await Promise.all([requireMember(gymId, data.referredByMemberId), requirePlan(gymId, data.interestedPlanId)]);
      await ensureIndexes();
      // One open enquiry per phone number: point the owner at the existing one.
      const existing = await Lead.findOne({ gymId, phoneDigits: digits(data.phone), status: { $in: OPEN } }).select('_id').lean();
      if (existing) fail('DUPLICATE_LEAD', { leadId: String(existing._id) });
      const now = clock();
      const { note, nextFollowUpOn, ...fields } = data;
      const lead = await Lead.create({ ...fields, gymId, phoneDigits: digits(data.phone),
        // Default first follow-up: the gym-local today, so new enquiries are not forgotten.
        nextFollowUpOn: nextFollowUpOn ? day(nextFollowUpOn) : await today(gymId),
        source: data.referredByMemberId ? 'referral' : data.source,
        notes: note ? [{ text: note, createdByUserId: auth.user._id, createdAt: now }] : [],
        createdByUserId: auth.user._id });
      return one(gymId, String(lead._id));
    },

    async get(auth, authorization, leadId) { return one(await scope(auth, authorization), leadId); },

    async update(auth, authorization, leadId, input) {
      const gymId = await scope(auth, authorization);
      const data = parse(updateLead, input);
      const lead = await leadFor(gymId, leadId);
      if (lead.status === 'joined') fail('LEAD_STATE_CHANGED');
      await Promise.all([requireMember(gymId, data.referredByMemberId), requirePlan(gymId, data.interestedPlanId)]);
      const set = {}, unset = {};
      for (const [key, value] of Object.entries(data)) {
        if (value === null) unset[key] = '';
        else if (key === 'nextFollowUpOn') set[key] = day(value);
        else set[key] = value;
      }
      if (data.phone) set.phoneDigits = digits(data.phone);
      if (data.status && data.status !== 'lost') unset.lostReason = '';
      // A lost enquiry has nothing to follow up.
      if (data.status === 'lost') unset.nextFollowUpOn = '';
      await write(gymId, lead, ['new', 'contacted', 'trial', 'lost'],
        { ...(Object.keys(set).length ? { $set: set } : {}), ...(Object.keys(unset).length ? { $unset: unset } : {}) });
      return one(gymId, leadId);
    },

    async addNote(auth, authorization, leadId, input) {
      const gymId = await scope(auth, authorization);
      const { text } = parse(addNote, input);
      const lead = await leadFor(gymId, leadId);
      if ((lead.notes ?? []).length >= 200) fail('VALIDATION_ERROR');
      await Lead.updateOne({ _id: lead._id, gymId },
        { $push: { notes: { text, createdByUserId: auth.user._id, createdAt: clock() } } }, { runValidators: true });
      return one(gymId, leadId);
    },

    async startTrial(auth, authorization, leadId, input) {
      const gymId = await scope(auth, authorization);
      const data = parse(startTrial, input);
      const lead = await leadFor(gymId, leadId);
      const now = await today(gymId);
      const start = data.startDate ? day(data.startDate) : now;
      if (start < now) fail('VALIDATION_ERROR');
      const end = new Date(start.getTime() + TRIAL_DAYS * DAY);
      // Follow up on the last trial day, while they are still keen.
      await write(gymId, lead, ['new', 'contacted', 'lost'], { $set: { status: 'trial', trialStartDate: start, trialEndDate: end,
        nextFollowUpOn: new Date(end.getTime() - DAY) }, $unset: { lostReason: '' } });
      return one(gymId, leadId);
    },

    async convert(auth, authorization, leadId, input) {
      const gymId = await scope(auth, authorization);
      const { memberId } = parse(convertLead, input);
      const lead = await leadFor(gymId, leadId);
      await requireMember(gymId, memberId);
      if (lead.status === 'joined') {
        if (String(lead.convertedMemberId) === memberId) return one(gymId, leadId);
        fail('LEAD_STATE_CHANGED');
      }
      await write(gymId, lead, ['new', 'contacted', 'trial', 'lost'], { $set: { status: 'joined',
        convertedMemberId: new Types.ObjectId(memberId), convertedAt: clock() }, $unset: { nextFollowUpOn: '', lostReason: '' } });
      return one(gymId, leadId);
    },

    /** Members whose referrals joined, most first. Tracking only: no rewards. */
    async referrals(auth, authorization) {
      const gymId = await scope(auth, authorization);
      const rows = await Lead.aggregate([{ $match: { gymId, referredByMemberId: { $exists: true } } },
        { $group: { _id: '$referredByMemberId', total: { $sum: 1 },
          joined: { $sum: { $cond: [{ $eq: ['$status', 'joined'] }, 1, 0] } } } },
        { $sort: { joined: -1, total: -1, _id: 1 } }, { $limit: 50 }]);
      const people = await names(gymId, rows.map((row) => row._id));
      return { data: rows.filter((row) => people.has(String(row._id)))
        .map((row) => ({ member: people.get(String(row._id)), referred: row.total, joined: row.joined })) };
    },

    /** Dashboard figures for the selected gym-local period. */
    async metrics(gymId, start, end, now) {
      const [grouped] = await Lead.aggregate([{ $match: { gymId } }, { $facet: {
        created: [{ $match: { createdAt: { $gte: start, $lt: end } } }, { $count: 'n' }],
        joined: [{ $match: { status: 'joined', convertedAt: { $gte: start, $lt: end } } }, { $count: 'n' }],
        due: [{ $match: { status: { $in: OPEN }, nextFollowUpOn: { $lte: now } } }, { $count: 'n' }],
        trials: [{ $match: { status: 'trial', trialStartDate: { $lte: now }, trialEndDate: { $gt: now } } }, { $count: 'n' }],
      } }]);
      const n = (key) => grouped?.[key]?.[0]?.n ?? 0;
      return { newInPeriod: n('created'), joinedInPeriod: n('joined'), followUpsDue: n('due'), activeTrials: n('trials') };
    },
  };
}
module.exports = { createLeadService };
