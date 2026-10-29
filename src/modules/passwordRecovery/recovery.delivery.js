const nodemailer = require('nodemailer');
function createRecoveryDelivery(config, createTransport = nodemailer.createTransport) {
  const smtp = config.recovery ?? {};
  const configured = Boolean(smtp.user && smtp.password && smtp.from);
  // No socket, credential check or provider call occurs while constructing app.
  const transport = configured ? createTransport({ host: 'smtp.gmail.com', port: 465,
    secure: true, tls: { rejectUnauthorized: true, minVersion: 'TLSv1.2' },
    auth: { user: smtp.user, pass: smtp.password }, logger: false, debug: false,
    disableFileAccess: true, disableUrlAccess: true,
    connectionTimeout: 5000, greetingTimeout: 5000, socketTimeout: 5000 }) : null;
  async function send(email, subject, text) {
    if (!transport) throw new Error('Recovery delivery unavailable');
    await transport.sendMail({ from: { name: 'MuscleDesk', address: smtp.from },
      to: { address: email }, subject, text, disableFileAccess: true, disableUrlAccess: true });
  }
  return { configured,
    sendRecovery({ email, token, minutes }) {
      return send(email, 'MuscleDesk account recovery',
        `Your MuscleDesk recovery code is:\n\n${token}\n\nPaste it into Recover access in MuscleDesk. It expires in ${minutes} minutes and can be used once. If you did not request this, ignore it. Never send this code or your password to support.`);
    },
    sendChanged({ email }) {
      return send(email, 'MuscleDesk password changed',
        'Your MuscleDesk password was changed. Existing sessions have been revoked. If this was not you, use Recover access and contact the published support address. Do not send passwords or recovery codes to support.');
    },
    sendDeletionCompleted({ email, reference, closedGyms }) {
      return send(email, 'MuscleDesk account deleted',
        `Your MuscleDesk account has been deleted (reference ${reference}). Your login, sessions, owner profile and the photos linked to it were removed from the live service.${closedGyms ? ' The gym you chose to close and all of its records were deleted.' : ' Gym records you shared with other owners or staff remain with that gym, without a link to your account.'}\n\nCopies may remain in database backups until those backups expire; backups are not used for normal operation. See the MuscleDesk privacy policy for details. This is the last email about this account.`);
    },
    sendDeletionOperatorAlert({ email, reference, reason, kind }) {
      // Operator mailbox only: ids and reason codes, no requester details.
      return send(email, 'MuscleDesk deletion job needs attention',
        `Deletion job ${reference} ${kind === 'blocked' ? 'stopped before anything was deleted' : 'is retrying'}: ${reason}. Run \`npm run deletion:operator -- list\` on the server to review it.`);
    },
    sendDeletionNeedsAction({ email, reference, reason }) {
      return send(email, 'MuscleDesk account deletion needs your review',
        `Your MuscleDesk account deletion request (reference ${reference}) stopped before anything was deleted because ${reason}. Your account still works. To continue, open MuscleDesk > More > Request account deletion, or the public account-deletion page, review the changes and confirm again.`);
    },
  };
}
module.exports = { createRecoveryDelivery };
