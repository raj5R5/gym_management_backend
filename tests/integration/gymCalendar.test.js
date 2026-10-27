const {test} = require('node:test');
const assert = require('node:assert/strict');
const {localDate, gymCalendar} = require('../../src/modules/gymDashboard/dashboard.period');
for (const [zone, instant, day] of [
 ['Asia/Kolkata', '2026-10-26T19:00:00Z', '2026-10-27'],
 ['America/New_York', '2026-10-27T01:00:00Z', '2026-10-26'],
 ['Asia/Kathmandu', '2026-10-26T18:20:00Z', '2026-10-27'],
 ['America/New_York', '2026-03-08T07:01:00Z', '2026-03-08'],
]) test('gym calendar: ' + zone + ' ' + instant, () => assert.equal(localDate(new Date(instant), zone), day));
test('missing timezone retains explicit UTC fallback; invalid configured timezone fails closed', async () => {
 const model = settings => ({findOne: () => ({session(){return this;},select(){return this;},async lean(){return {settings};}})});
 assert.equal((await gymCalendar(model(undefined), 'test', new Date('2026-10-26T19:00Z'))).label, '2026-10-26');
 await assert.rejects(gymCalendar(model({timezone:'invalid-zone'}), 'test'), {code:'INVALID_DASHBOARD_STATE'});
});
