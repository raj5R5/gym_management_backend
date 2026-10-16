const { z } = require('zod');
const methods = ['cash', 'upi', 'bank_transfer', 'card', 'other'];
const timestamp = z.iso.datetime({ offset: true }).refine((value) =>
  Date.parse(value) >= Date.parse('1970-01-01T00:00:00Z') && Date.parse(value) <= Date.now(), 'Invalid payment timestamp');
const transactionReference = z.string().trim().min(3).max(120).regex(/^[A-Za-z0-9][A-Za-z0-9 ._:/-]*$/);
module.exports = { methods, timestamp, transactionReference };
