# MuscleDesk 1.0 backend deployment runbook — for approval

Prepared 29 October 2026. **Nothing here has been run.** Each step marked
**[approval]** needs Raj's explicit go-ahead. Follow the backup, validation and
rollback discipline in the Flutter project's `docs/privacy-policy-deployment-plan.md`;
this runbook is the concrete version for this release.

## What is being deployed

Base: commit `ae1d7d7` (pushed to `origin/main`; the live privacy page matched it on
29 October, which suggests but does not prove the server runs it). Adds:

- Final privacy policy (`src/modules/privacyPolicy/privacy-policy.html`), effective October 29, 2026.
- Manual deletion fulfillment: operator mode, server worker and `npm run deletion:operator`
  (`src/modules/accountDeletion/automation.*`, `src/scripts/accountDeletionOperator.js`,
  `src/app.js`, `src/server.js`, `src/config/env.js`, `src/middleware/errorHandler.js`,
  `src/modules/passwordRecovery/recovery.delivery.js`).
- Updated public deletion page wording (`src/modules/accountDeletion/routes.js`).
- `package.json` (one npm script). **Lockfile unchanged: no dependency install needed.**
- New collection `deletionjobs` and its two indexes, created by normal startup. No migration, no drops.

Unchanged: API contract used by the app, authentication, gym data. Old code ignores
the new environment keys, so rollback needs no `.env` change.

Placeholders to fill from the server's read-only inspection (step 2):
`<APP_DIR>` (release directory), `<PM2_NAME>` (process name).

## 1. Local: commit and push — [approval]

```bash
cd /Users/semgroup/Desktop/BackendProjects/gym_management_backend
git switch -c release/1.0-privacy-deletion
git add .env.example docs package.json src tests
git commit -m "feat: final privacy policy and operator-reviewed account deletion"
git push -u origin release/1.0-privacy-deletion
```

Check `git status` first: only the files listed above should be staged, and `.env` must not be.
Merge to `main` through your normal review. Note the commit hash as `<NEW_REV>`.

## 2. Server: read-only inspection

```bash
pm2 ls                                   # find <PM2_NAME>
pm2 describe <PM2_NAME> | grep -E "exec cwd|script path|node.js version|status"
cd <APP_DIR> && git rev-parse --short HEAD && git status --short   # expect ae1d7d7, clean
node -v                                  # expect v24.x
grep -oE '^(ACCOUNT_DELETION_[A-Z_]+|RECOVERY_SMTP_[A-Z_]+|RECOVERY_EMAIL_FROM)=.' .env   # names only, no values
curl -sS https://gym-api.semgroup.in/ready
```

Stop if the server revision is not `ae1d7d7`, the tree is dirty, or Node is not 24.x:
the change set must then be re-reviewed against what is live.

## 3. Backups — [approval]

```bash
cd <APP_DIR>/..
cp -a <APP_DIR> <APP_DIR>.backup-ae1d7d7-$(date +%Y%m%d%H%M)
cp -p <APP_DIR>/.env ~/env.backup-$(date +%Y%m%d%H%M) && chmod 600 ~/env.backup-*
```

In MongoDB Atlas: take an on-demand snapshot of the production cluster (or confirm a
recent scheduled one) and note its time. While there, record the cluster's backup
retention setting; the policy's deletion-record criterion depends on it.

## 4. Configure the server environment — [approval]

Edit `<APP_DIR>/.env` without printing secrets:

```bash
cd <APP_DIR>
printf '\nACCOUNT_DELETION_AUTOMATION=operator\nACCOUNT_DELETION_NOTICE_KEY=%s\n' "$(openssl rand -hex 32)" >> .env
```

Also confirm `RECOVERY_SMTP_USER`, `RECOVERY_EMAIL_FROM` and `RECOVERY_SMTP_PASSWORD`
(a Gmail **app password**) are set; operator mode refuses to start without them.
Keep a private copy of the notice key: if it is lost, queued requests cannot send
their completion email. Do not change any other key.

## 5. Deploy and restart — [approval]

```bash
cd <APP_DIR>
git fetch origin && git checkout <NEW_REV>
node --env-file=.env -e "const c=require('./src/config/env').loadConfig(process.env); console.log('config ok, deletion mode:', c.accountDeletion.mode)"
pm2 restart <PM2_NAME> --update-env
pm2 logs <PM2_NAME> --lines 40 --nostream
```

The config check prints only field names on failure. Expect `deletion mode: operator`,
then the log line `API server started`.

## 6. Verify (read-only)

```bash
curl -sS https://gym-api.semgroup.in/ready
curl -sS https://gym-api.semgroup.in/privacy-policy | grep -o "Effective date: October 29, 2026" | head -1
curl -sS https://gym-api.semgroup.in/privacy-policy | grep -ci "draft"          # expect 0
curl -sS https://gym-api.semgroup.in/account-deletion | grep -o "manual review\|fulfils manually" | head -1
curl -sS -o /dev/null -w "%{http_code}\n" https://gym-api.semgroup.in/api/v1/auth/account-deletion-request          # expect 401
curl -sS -o /dev/null -w "%{http_code}\n" https://gym-api.semgroup.in/api/v1/auth/account-deletion/options          # expect 404 (self-service off)
cd <APP_DIR> && npm run deletion:operator -- list                                # read-only
```

Also open the privacy and deletion pages on a phone browser, and from the app's
Privacy & support screen.

## 7. End-to-end deletion rehearsal — [approval, writes production data]

This is the only way to prove hosted Gmail and Cloudinary deletion work. Use a
throwaway owner account you create for this purpose, with a synthetic gym and one
test photo:

1. In the app: sign up the test owner, add a photo, then More → Request account deletion.
2. On the server: `npm run deletion:operator -- list`, then `show <id>`.
3. `npm run deletion:operator -- fulfill <id> <gymId>=close --yes --closure-confirmed`
4. Within a few minutes: `status <id>` shows `completed`; the test mailbox gets the
   completion email; the photo is gone from the Cloudinary media library; the app
   shows the account can no longer sign in.

Skipping this leaves hosted email delivery and photo deletion unverified.

## 8. Rollback — if any check in 5–7 fails

```bash
cd <APP_DIR>
git checkout ae1d7d7
pm2 restart <PM2_NAME> --update-env
curl -sS https://gym-api.semgroup.in/ready
```

The new `.env` keys are ignored by the old code; leave them. The `deletionjobs`
collection is harmless to the old code and is picked up again after redeploying.
Do not restore the database for a code failure: that would discard real writes made
since the snapshot. Rolling back also restores the old draft policy, which blocks the AAB.

## 9. Then build the signed AAB — locally, after step 6 passes

```bash
cd /Users/semgroup/Desktop/FlutterProjects/gym_management_app
python3 tool/play_release.py --config release/production.json --check-urls --ca-file /etc/ssl/cert.pem --build
python3 tool/play_release.py --verify-bundle build/app/outputs/bundle/release/app-release.aab
shasum -a 256 build/app/outputs/bundle/release/app-release.aab
```

Uploading to Play Console is a separate approval.
