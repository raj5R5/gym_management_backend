// Operator tool for manually reviewed account deletion. Run on the server with its
// own environment (`npm run deletion:operator -- <command>`). It reads and queues
// requests only; the running API's deletion worker performs and verifies erasure.
// Commands:
//   list                                   open requests, oldest first
//   show <requestId>                       account, gyms and allowed choices
//   record-email <email>                   record a request confirmed by a reply from that mailbox
//   plan <requestId> <gymId>=leave|close…  dry run: what each choice deletes
//   fulfill <requestId> <gymId>=leave|close… --yes [--closure-confirmed]
//   status <requestId>
const { loadConfig } = require('../config/env');
const { createLogger } = require('../config/logger');
const { createDatabase } = require('../config/database');
const { createApp } = require('../app');
const { normalizeEmail } = require('../modules/userAccounts/userAccount.validation');

function parseChoices(args) {
  return args.filter((a) => !a.startsWith('--')).map((arg) => {
    const match = /^([a-f0-9]{24})=(leave|close)$/.exec(arg);
    if (!match) throw Object.assign(new Error(`Invalid choice "${arg}". Use <gymId>=leave or <gymId>=close.`), { code: 'USAGE' });
    return { gymId: match[1], kind: match[2] };
  });
}

async function run(args = process.argv.slice(2), environment = process.env, out = (line) => process.stdout.write(`${line}\n`)) {
  const [command, target, ...rest] = args;
  const config = loadConfig({ ...environment, LOG_LEVEL: 'silent' });
  if (config.accountDeletion.mode === 'disabled') {
    throw Object.assign(new Error('Set ACCOUNT_DELETION_AUTOMATION=operator (with its notice key and mail settings) first.'), { code: 'USAGE' });
  }
  const database = createDatabase({ logger: createLogger(config) });
  await database.connect(config);
  try {
    // Builds models and the engine only: no listener, worker or timer is started.
    const app = createApp({ config, database });
    const engine = app.locals.deletionEngine, models = database.connection.models;
    if (command === 'list') {
      const rows = await models.AccountDeletionRequest.find({ status: { $ne: 'completed' } }).sort({ requestedAt: 1 }).limit(200).lean();
      for (const row of rows) {
        const user = await models.UserAccount.findById(row.userId).select('email').lean();
        const job = await models.DeletionJob.findOne({ userId: row.userId }).select('state lastReason').lean();
        out(`${row._id}  ${row.requestedAt.toISOString()}  ${row.status}  ${user?.email ?? '(account missing)'}  ${job ? `job=${job.state}${job.lastReason ? `:${job.lastReason}` : ''}` : 'job=none'}`);
      }
      if (!rows.length) out('No open deletion requests.');
    } else if (command === 'show' || command === 'status') {
      const review = await engine.reviewRequest(target);
      out(JSON.stringify(command === 'status' ? { request: review.request, job: review.job } : review, null, 2));
    } else if (command === 'record-email') {
      const user = await models.UserAccount.findOne({ normalizedEmail: normalizeEmail(target ?? '') }).select('_id').lean();
      if (!user) throw Object.assign(new Error('No account uses that email address.'), { code: 'USAGE' });
      const row = await models.AccountDeletionRequest.findOneAndUpdate({ userId: user._id },
        { $setOnInsert: { userId: user._id, status: 'requested', requestedAt: new Date() } },
        { upsert: true, returnDocument: 'after', runValidators: true }).lean();
      out(`Request ${row._id} (${row.status}). Reply to the requester with this reference.`);
    } else if (command === 'plan') {
      out(JSON.stringify(await engine.planRequest(target, parseChoices(rest)), null, 2));
    } else if (command === 'fulfill') {
      const choices = parseChoices(rest);
      const plan = await engine.planRequest(target, choices);
      out(JSON.stringify(plan, null, 2));
      if (!rest.includes('--yes')) { out('Dry run only. Re-run with --yes to queue deletion.'); return; }
      // Closing deletes other people's gym records; it needs the owner's explicit written choice.
      if (choices.some((c) => c.kind === 'close') && !rest.includes('--closure-confirmed')) {
        throw Object.assign(new Error('Closing a gym requires --closure-confirmed after the owner confirms closure in writing.'), { code: 'USAGE' });
      }
      const job = await engine.queueRequest(target, choices);
      out(`Queued: job ${job.id} state=${job.state}. The API worker completes it and emails the requester; check with "status".`);
    } else {
      throw Object.assign(new Error('Commands: list | show <id> | record-email <email> | plan <id> <gymId>=leave|close… | fulfill <id> … --yes [--closure-confirmed] | status <id>'), { code: 'USAGE' });
    }
  } finally { await database.disconnect(); }
}
if (require.main === module) run().catch((error) => {
  // Usage and deletion-rule messages are safe to show; other errors could contain connection details.
  process.stderr.write(`${error.code === 'USAGE' || /^DELETION_|^VALIDATION_ERROR$/.test(error.code ?? '') ? `${error.code}: ${error.message}` : 'Operator command failed. No changes were queued.'}\n`);
  process.exitCode = 1;
});
module.exports = { run };
