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
  };
}
module.exports = { createRecoveryDelivery };
