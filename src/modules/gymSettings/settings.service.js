const { updateSettings } = require('./settings.validation');

function fail(code) { const error = new Error('Gym settings unavailable.'); error.code = code; throw error; }
function dto(gym) {
  const settings = gym.settings ?? {};
  const address = settings.address ? Object.fromEntries(['line1', 'line2', 'city', 'state', 'postalCode']
    .filter((key) => settings.address[key] !== undefined).map((key) => [key, settings.address[key]])) : null;
  return { gymId: String(gym._id), timezone: settings.timezone ?? null,
    timezoneConfigured: typeof settings.timezone === 'string' && settings.timezone.length > 0,
    gstin: settings.gstin ?? null, address, upiId: settings.upiId ?? null, upiPayeeName: settings.upiPayeeName ?? null };
}

function createGymSettingsService({ Gym, authorizationService }) {
  async function gymFor(auth, authorization) {
    authorizationService.requireRoles(auth, authorization, ['admin'], authorization?.gymId);
    const current = await authorizationService.requireGymAccess(auth, authorization.gymId);
    authorizationService.requireRoles(auth, current, ['admin'], authorization.gymId);
    return current.gymId;
  }
  return {
    async get(auth, authorization) {
      const gymId = await gymFor(auth, authorization);
      const gym = await Gym.findOne({ _id: gymId, status: 'active' }).select('settings').lean();
      if (!gym) fail('FORBIDDEN');
      return dto(gym);
    },
    async update(auth, authorization, input) {
      const gymId = await gymFor(auth, authorization);
      const parsed = updateSettings.safeParse(input); if (!parsed.success) fail('VALIDATION_ERROR');
      const set = {}, unset = {};
      for (const [key, value] of Object.entries(parsed.data)) {
        if (value === null) unset[`settings.${key}`] = ''; else set[`settings.${key}`] = value;
      }
      const gym = await Gym.findOneAndUpdate({ _id: gymId, status: 'active' },
        { ...(Object.keys(set).length ? { $set: set } : {}), ...(Object.keys(unset).length ? { $unset: unset } : {}) },
        { returnDocument: 'after', runValidators: true }).select('settings').lean();
      if (!gym) fail('FORBIDDEN');
      return dto(gym);
    },
  };
}
module.exports = { createGymSettingsService };
