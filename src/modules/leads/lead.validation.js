const { z } = require('zod');
const { objectId, listQuery } = require('../gyms/gym.validation');
const { calendarDate } = require('../subscriptions/subscription.validation');
const { statuses, sources } = require('./lead.model');

const name = z.string().trim().min(1).max(80);
const phone = z.string().trim().regex(/^\+?[0-9 ()-]{7,25}$/)
  .refine((value) => { const digits = value.replace(/\D/g, '').length; return digits >= 7 && digits <= 15; }, 'Invalid phone');
// Owner choice: trials last 3 days.
const TRIAL_DAYS = 3;

const createLead = z.strictObject({
  firstName: name, lastName: name.optional(), phone,
  source: z.enum(sources).default('walk_in'),
  referredByMemberId: objectId.optional(), interestedPlanId: objectId.optional(),
  nextFollowUpOn: calendarDate.optional(), note: z.string().trim().min(1).max(1000).optional(),
});
// Status changes here exclude 'trial' and 'joined', which have their own actions.
const updateLead = z.strictObject({
  firstName: name.optional(), lastName: name.nullable().optional(), phone: phone.optional(),
  source: z.enum(sources).optional(), status: z.enum(['new', 'contacted', 'lost']).optional(),
  lostReason: z.string().trim().min(1).max(300).optional(),
  nextFollowUpOn: calendarDate.nullable().optional(),
  referredByMemberId: objectId.nullable().optional(), interestedPlanId: objectId.nullable().optional(),
}).refine((value) => Object.keys(value).length > 0, 'Update cannot be empty')
  .refine((value) => value.status !== 'lost' || Boolean(value.lostReason), 'A lost enquiry needs a reason');
const addNote = z.strictObject({ text: z.string().trim().min(1).max(1000) });
const startTrial = z.strictObject({ startDate: calendarDate.optional() });
const convertLead = z.strictObject({ memberId: objectId });
const leadParams = z.strictObject({ gymId: objectId, leadId: objectId });
const leadListQuery = listQuery.extend({
  status: z.enum([...statuses, 'open']).optional(),
  // 'due': open enquiries whose follow-up date is today or earlier.
  followUp: z.enum(['due']).optional(),
  referredByMemberId: objectId.optional(),
  search: z.string().trim().min(1).max(100).optional(),
});
module.exports = { TRIAL_DAYS, createLead, updateLead, addNote, startTrial, convertLead, leadParams, leadListQuery };
