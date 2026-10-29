const { gymModels, legacyCollections } = require('./automation.scope');
// Plain-language reasons for a request that stopped before anything was deleted.
const blockedText = {
  DELETION_SCOPE_CHANGED: 'your account, gym ownership or contact details changed after you reviewed the request',
  DELETION_OWNERSHIP_HANDOFF_REQUIRED: 'a gym you own no longer has another active owner or the selected successor is unavailable',
  DELETION_OTHER_OWNERS_PRESENT: 'a gym selected for closure now has other active owners',
  DELETION_SCOPE_INVALID: 'your gym access changed after you reviewed the request',
  DELETION_EXISTING_REVIEW_REQUIRED: 'an earlier deletion review for this account must finish first',
};

// Production adapters reuse existing photo workers and the Gmail SMTP delivery.
// With operatorEmail (manual-review mode) alerts go to the operator's mailbox
// instead of asking the requester to confirm again.
function createDeletionAdapters({ models, delivery, photoServices, logger, operatorEmail = null }) {
  return {
    async cleanupPhotos() { for (const service of photoServices) await service.cleanup(); },
    // Verifies the live database no longer holds the account or closed gyms. This is
    // not a claim about provider backups, which expire under the provider's schedule.
    async externalStatus({ userId, closedGymIds }) {
      const linked = [['UserAccount', { _id: userId }], ['GymAccess', { userId }], ['OwnerProfile', { userId }],
        ['AuthSession', { userId }], ['MemberActivation', { userId }], ['PasswordRecovery', { userId }],
        ['MemberProfile', { userId }], ['TrainerProfile', { userId }], ['Payment', { recordedByUserId: userId }],
        ['MemberOnboardingOperation', { userId }], ['RenewalOperation', { userId }]];
      for (const [name, filter] of linked) if (await models[name].exists(filter)) return { complete: false };
      const db = models.Gym.db;
      const existing = new Set((await db.db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name));
      for (const gymId of closedGymIds) {
        if (await models.Gym.exists({ _id: gymId })) return { complete: false };
        for (const name of gymModels) if (await models[name].exists({ gymId })) return { complete: false };
        for (const name of legacyCollections.filter((n) => existing.has(n))) {
          if (await db.collection(name).findOne({ gymId: new models.Gym.base.Types.ObjectId(gymId) }, { projection: { _id: 1 } })) return { complete: false };
        }
      }
      return { complete: true, evidenceRef: 'live-database-verified' };
    },
    async notify({ email, jobId, reference, closedGyms }) {
      await delivery.sendDeletionCompleted({ email, reference, closedGyms });
      // Evidence that Gmail SMTP accepted the message, not proof of mailbox delivery.
      return { evidenceRef: `smtp-accepted:${jobId}` };
    },
    async escalate({ jobId, reason, kind, email }) {
      // Record a non-personal alert for the server logs. In operator mode the operator is
      // emailed; otherwise the requester is told what to do when they can resolve it.
      logger?.warn({ jobId, reason, kind }, 'Account deletion needs attention');
      if (operatorEmail) {
        await delivery.sendDeletionOperatorAlert({ email: operatorEmail, reference: jobId, reason, kind });
      } else if (kind === 'blocked' && email && blockedText[reason]) {
        await delivery.sendDeletionNeedsAction({ email, reference: jobId, reason: blockedText[reason] });
      }
    },
  };
}
module.exports = { createDeletionAdapters, blockedText };
