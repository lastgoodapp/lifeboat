# Lifeboat

Nightly backup of a Supabase (or any Postgres) database, and of the repository's code, issues and pull requests, to S3-compatible storage, with every Supabase Storage file when the storage login is set. A monthly test restore (rolling out) loads the newest dump into a throwaway Postgres on the GitHub Actions runner and posts a signed status to LastGood.

This folder is the action. It does not import the LastGood website. It can be moved into its own public repository without the rest of this repo. A licence for that repository is Nick's choice; this folder does not pretend one has been chosen yet.

## What a run does

`backup`:

1. `pg_dump` from `/usr/lib/postgresql/<major>/bin`, not the older client already on the runner `PATH`. Custom format, without owners or ACLs, so the dump includes application schemas and `auth`. If the server is a newer major than that client, the run stops before the upload.
2. Encrypts the dump on the runner, then uploads `lifeboat/db/<timestamp>.backup.age` to the destination bucket. See "Encryption" below.
3. Copies every Supabase Storage file with the storage login, encrypted into one archive at `lifeboat/storage/<timestamp>.tar.age`. See "Storage objects" below.
4. Copies the code and its GitHub history. See "Code, issues and pull requests" below.
5. When `supabase-token` is set, copies the Edge Functions source and the Supabase settings. See "Supabase setup" below.
6. When `vercel-token` is set, copies the Vercel project's environment variables, then its settings, domains and DNS records. See "The Vercel copy" below.
7. Counts the Supabase Auth users in the dump: accounts in `auth.users`, the ones with a password hash, and sign-in identities in `auth.identities`. `pg_restore` reads the rows on the runner and only the counts are kept, so no email, id or hash is printed. The log prints one line, such as `Users: 1204 accounts, 980 with a password, 1310 sign-in identities.`, and the check-in carries the counts. A database without Supabase Auth says so. If the dump has the `auth.users` table without its rows, the run fails, because users could not log in after a restore. The check runs after the storage, code, Supabase setup and Vercel copies, so everything else the run copies is uploaded by then.
8. When `monthly-copies` is true, makes this month's monthly copy. See "Monthly copies" below.
9. Deletes destination objects under the prefix that are older than the retention window. The default is 30 days. Monthly copies follow their own rule.
10. Posts a signed check-in. The database URL, the storage keys and the tokens are not in that body. If LastGood doesn't answer, or answers 408, 429 or 5xx, it tries twice more (after 5 and 15 seconds, signing each try afresh), so a blip on LastGood's side doesn't fail a good backup. A refusal fails the run at once.

`restore-test`:

1. Downloads the newest `.backup`, `.backup.age` or `.backup.enc` under the prefix, decrypts it when it is encrypted, and deletes the encrypted download before restore. A copy that fails age's integrity check stops the test before anything is restored.
2. Checks whether the dump needs PostGIS. It looks for a `postgis`, `postgis_raster`, `postgis_topology` or `postgis_sfcgal` entry in `pg_restore --list`, and for a `geometry`, `geography` or `raster` column type, such as `extensions.geometry`, in `pg_restore --schema-only`. Neither command connects to a database. If the dump needs PostGIS and the throwaway database does not offer it, the action replaces that database, but only when the workflow set `LIFEBOAT_RESTORE_CONTAINER`. The replacement is `LIFEBOAT_RESTORE_POSTGIS_IMAGE`, or `postgis/postgis:<major>-3.5` when that is empty. It runs on the same port, with user `postgres`, database `restore` and password `throwaway`. The action logs one line that says why it switched. The image's own PostGIS install is turned off, so the dump creates the extension in the schema the source used, which is `extensions` on Supabase. If the action cannot switch, or the PostGIS image does not start, the restore test fails before anything is restored, and the message names PostGIS. PostGIS is not a Supabase-only extension, so it is never skipped as a warning.
3. On the throwaway database, creates `anon`, `authenticated`, `service_role`, `supabase_admin` and `authenticator` when they are missing. Then drops every event trigger, every publication, objects already in `public`, and every other non-system schema except schemas an extension owns (`extensions`, `graphql`, `vault`, `cron` and the rest). That database is disposable. `public` stays. `pg_restore -L` then skips extensions the target does not offer, including `pg_cron`, `pg_net`, `pgsodium` and `supabase_vault`, and objects in those extension schemas. An extension, publication, or event trigger that is still there is left in place. An `already exists` error is a warning. A data error, or a row count that does not match, fails the job.
4. Restores with `--no-owner` and `--no-acl`. A missing extension is a warning. A data error fails the job.
5. Compares `count(*)` on up to three small user tables with the `COPY` rows in the dump. An extension's config table, such as PostGIS's `spatial_ref_sys`, is not sampled, because the extension fills it when it is created.
6. When the dump holds Supabase Auth users, checks the throwaway database has the same number of accounts, accounts with a password hash, and sign-in identities as the dump. A count that does not match fails the job, by count only.
7. Counts the rows the dump holds in tables it left out with an extension the throwaway database does not offer, such as Vault's `vault.secrets` on stock Postgres, so a pass says what it did not check. `pg_restore` streams each table's rows on the runner and only the count is kept. The log prints one line per table, such as `Not checked by this test restore: vault.secrets (3 rows in the dump), because this database does not offer supabase_vault.`, and the check-in carries each such extension with its table and row counts. It then checks every table the restore list loaded: one that is not there, most likely because its load failed with only a warning for an extension outside the action's list, or one that is there but empty while the dump has rows for it, is counted the same way and reported as `other`. A name with a space or a quote in it is read from the dump's own `COPY` line, because `pg_restore -l` prints names unquoted, and every name reaches the database only as data (hex, read with `to_regclass`), never as SQL.
8. Loads the newest code copy under `repo/`, opened the same way as the dump: every branch and tag clones back out of the bundle (`git clone --mirror`), `git fsck --full` checks every object, a file on the default branch reads back, and the GitHub metadata parses. A copy that does not open, a damaged bundle, or damaged metadata fails the job and says the code did not restore. With encryption on, a plain code copy is not restored, like a plain dump. The log prints one line, such as `Code: 14 branches and 9 tags cloned back out of 20261018T161700Z.tar.gz.age, and git fsck found no damage.`. Before the first code copy, the log says the test restore loaded the database only.
9. Reads back the newest Supabase setup copy under `setup/`, opened the same way: `functions.json` lists the functions, each function's files (or its bundle) read back at the size they were saved, and every settings and database extras file parses. A setup copy is only ever made encrypted, so a plain one is not restored, and one holding a link or anything other than plain files and folders is refused before it is extracted. A missing or cut-short file, or one whose recorded path would land outside its function's folder, fails the job and names it. The log prints one line, such as `Supabase setup: 3 Edge Functions, auth and storage settings, 2 cron jobs, 1 database webhooks and 4 Vault secret names read back out of 20261018T161700Z.tar.gz.age, every function file at the size it was saved.`, and the check-in carries the function and cron job counts. Before the first setup copy, the log says the test restore did not check Edge Functions or settings. It does not deploy the functions or apply the settings: that is the guided restore.
10. Posts a check-in with `kind` `restore-test`.

The throwaway database is thrown away with the runner. It is not a second backup.

## Encryption

Each app has its own [age](https://age-encryption.org) key pair (X25519). The action installs age from Ubuntu's archive and checks it can make and open a test copy before the run starts.

- **Backup** encrypts every copy to `LIFEBOAT_PUBLIC_KEY` on the runner, before upload: `.backup.age` for the database and `.tar.age` for storage. The public key can only encrypt. If `LIFEBOAT_PRIVATE_KEY` is also set, the run first checks that the two are one pair, and stops before the dump if they are not, so a changed variable cannot send copies to a key nobody here holds. With only the private key set, the public half is worked out from it.
- **Restore test** opens the copy with `LIFEBOAT_PRIVATE_KEY`. age authenticates the header and every 64 KiB chunk, so a changed byte, a cut-short copy or a copy made for another key fails, and nothing is restored. The key is written to a file only the runner user can read, for as long as age needs it, then deleted.
- **By hand:** `age --decrypt --identity key.txt <copy>.backup.age > copy.backup`, then `pg_restore`. `key.txt` holds the private key, alone or as the file `age-keygen` writes.
- **The older passphrase setup** (OpenSSL AES-256-CBC with PBKDF2, `.backup.enc`) still works when no key pair is set, and the log says to move over: CBC has no integrity check, so a changed copy can decrypt to wrong data without an error. Once a key pair is set, new copies use it even if the passphrase is still there, and the passphrase only opens older `.enc` copies until they age out.

## Code, issues and pull requests

Each backup also copies the repository the workflow runs in, using the workflow's own token (`github-token`, which defaults to `github.token`). `permissions` in the workflow file limits that token to `contents`, `issues` and `pull-requests`, each `read`.

- **Code:** a bare `git clone` holds every branch and every tag, including branches that were never merged and tags whose branch was deleted. `git bundle create --all` turns it into one file, and `git bundle verify` checks it before upload. The token goes in an HTTP header set from the environment, never in the URL or on the command line, and is masked in the log. Git LFS files are not included: the bundle holds their pointers.
- **GitHub metadata:** `scripts/github-metadata.mjs` reads `repository.json`, then every page of issues (which GitHub lists with pull requests), issue and pull request comments, pull requests, and review comments, as JSON. Only `GET` requests. Review summaries (the text sent with an approval or a request for changes) are not copied, because GitHub lists them only one pull request at a time. Issues switched off in the repository settings give an empty list and a log line. A token without `issues: read` or `pull-requests: read` stops the run with a message that names the missing permission.
- Both go into one `tar.gz`, encrypted like the dump, at `lifeboat/repo/<timestamp>.tar.gz.age` with a key pair. A repository still on the older passphrase gets `.tar.gz.enc`, and one with encryption turned off gets a plain `.tar.gz`. Same retention as the database copies. The log prints one line, such as `Code: 14 branches, 9 tags. GitHub: 31 issues, 12 pull requests, 140 comments.`, and the check-in carries the same counts.
- The database copy is uploaded first. If the code copy fails, the run fails and says why, and the database copy is already safe.
- The monthly test restore loads the newest code copy as well as the database. See `restore-test` under "What a run does" above.
- Outside GitHub Actions (no `GITHUB_REPOSITORY`) the code copy is skipped.

To put the code into a new repository by hand (a `.tar.gz.enc` copy opens with `openssl enc -d -aes-256-cbc -pbkdf2` and the passphrase instead of `age`):

```bash
age --decrypt --identity key.txt 20261018T161700Z.tar.gz.age > code.tar.gz
tar -xzf code.tar.gz            # code.bundle and github/*.json
git clone --mirror code.bundle restored.git
cd restored.git && git push --mirror https://github.com/<owner>/<new-empty-repo>.git
```

## Supabase setup

With `supabase-token` (the `LIFEBOAT_SUPABASE_TOKEN` secret), each backup also copies what `pg_dump` cannot: the Edge Functions source and the project's settings, through Supabase's Management API. The token should be a scoped access token (it starts with `sbp_fc`) for this one project, with only these Read permissions: Edge Functions, Auth Config, Storage, Storage Config and Database. A token that is not scoped still works, but the log carries a warning to replace it, because it can change the project. The token goes in a header and is masked in the log.

- **Project:** `supabase-project-ref`, or the ref in the Session pooler username (`role.<project-ref>`) when that is empty.
- **Edge Functions:** `functions.json` lists them, and each one gets `functions/<slug>/`. Supabase sends the source as files, which land in `files/` under the path Supabase gives them, with `source.json` naming each file and the entry point. A function Supabase sends as one bundle instead is kept as `body.eszip`. A file path that would land outside the function's folder stops the copy.
- **Settings:** `auth-config.json` (providers, redirect URLs and the rest of the auth settings), `auth-third-party.json`, `storage-config.json` and `buckets.json`.
- **Database extras:** cron jobs (`cron-jobs.json`), database webhooks (`database-webhooks.json`, the triggers that call `supabase_functions.http_request`) and the names of Vault secrets (`vault-secret-names.json`; the secret values are never read). These go through the read-only query endpoint, which runs as Supabase's read-only database user. A database without `pg_cron` or Vault gives an empty list.
- Only `GET` requests, and that read-only SQL. A rate limit waits as long as Supabase asks, up to a minute. A missing permission stops the copy with a message that names it, and an expired token says so.
- Everything goes into one `tar.gz`, encrypted like the dump, at `lifeboat/setup/<timestamp>.tar.gz.age` (`.tar.gz.enc` on the older passphrase). The auth settings can hold provider secrets and SMTP details, so with `encrypt` off the setup copy is skipped with a warning rather than uploaded in the clear. The log prints one line, such as `Supabase setup: 3 Edge Functions, auth and storage settings, 2 cron jobs, 1 database webhooks, 4 Vault secret names.`, and the check-in carries the function and cron job counts.
- The database, storage and code copies are uploaded first. If the setup copy fails, nothing is uploaded for the setup, the users check still runs and reports its counts, and then the run fails and says why. Retention does not run that night, because it deletes by age and would otherwise remove older setup copies while the newest one is missing.
- Without the token the setup copy is skipped, and the log says so.
- The monthly test restore reads the newest setup copy back. See `restore-test` under "What a run does" above.

## The Vercel copy

With `vercel-token` (the `LIFEBOAT_VERCEL_TOKEN` secret, the customer's own Vercel token) and `vercel-project-id`, each backup also copies the Vercel project's environment variables: every name, its targets, branch and type, and every value Vercel returns. The customer's own workflow fetches them on its runner and encrypts them to the app's key there, so LastGood never sees a value. Set `vercel-team-id` when the project belongs to a team. The token goes in a header and is masked in the log, and no value is ever printed.

- **What cannot be copied:** Vercel never returns a value it marks "sensitive" to anyone, the token's owner included, nor the values it sets itself (such as `VERCEL_URL`). Those are copied by name only, with a note. **Keep the values of sensitive variables yourself, for example in a password manager: LastGood cannot restore them.** The log warns, every night, how many variables have no value in the copy. A value Vercel sends back still encrypted is treated the same way.
- **Requests:** `GET /v10/projects/<project>/env` for the list, then `GET /v1/projects/<project>/env/<id>` for each value that is not sensitive. Only `GET`. A rate limit waits as long as Vercel asks, up to a minute. An expired token, a token from the wrong team, and a wrong project each stop the copy with a message that says which. A list Vercel sends in more than one page stops the copy rather than leave variables out without saying so.
- Everything goes into one `env.json`, readable only by the runner's user, packed and encrypted like the dump at `lifeboat/vercel/<timestamp>.tar.gz.age` (`.tar.gz.enc` on the older passphrase). The readable copy is deleted before the upload starts. The values are secrets, so with `encrypt` off the Vercel copy is skipped with a warning rather than uploaded in the clear. The log prints one line, such as `Vercel: 24 environment variables, 21 with their values.`, and the check-in carries those two counts, never names or values.
- **Settings, domains and DNS records (B8):** with the same token, the copy also reads the project (`GET /v9/projects/<project>`), its domains (`GET /v9/projects/<project>/domains`, every page) and the DNS records of each apex domain (`GET /v5/domains/<apex>/records`, every page). Only `GET`, through the same helper as the environment variables. The project is kept through a list of the fields a rebuild needs: the framework, the build, install and output settings, the root directory, the Node version, the function region and defaults, the Git link with the production branch, deploy hook names and branches, and the cron schedules. Nothing else is kept, so a deploy hook's URL (which works without a token), protection bypass secrets and the environment variables never enter this part. `*.vercel.app` is Vercel's own, so its DNS is not asked for. A domain whose DNS this token cannot read (Vercel answers 403 or 404), most likely because it is kept outside Vercel, is listed with a note, and the log warns. Everything goes into `settings.json` in the same archive as `env.json`. The log prints a line such as `Vercel settings: the project, 2 domains, 14 DNS records.`, and the check-in carries those counts, never a domain name.
- If the environment variable copy fails, nothing is uploaded for Vercel, the users check still runs and reports its counts, and then the run fails and says why. Retention does not run that night, as with the Supabase setup. If only the settings copy fails, the environment variables still go up, and then the run fails and says why.
- Without the token the Vercel copy is skipped and the log says so: the backup has no copy of the project's settings, domains, DNS records or environment variables, and the check-in says `vercelSource: "none"` so LastGood's status page can say so too. LastGood never holds a Vercel token. Revoking the token in Vercel, or deleting the secret, stops the copy.

## Monthly copies

With `monthly-copies` true (the `LIFEBOAT_MONTHLY_COPIES` variable), the first good backup of each UTC month also keeps a monthly copy. Off by default.

- After every part has uploaded, the action copies each of that night's copies, inside the bucket, to `lifeboat/monthly/<YYYYMM>/<part>/`, for example `lifeboat/monthly/202610/db/20261001T161700Z.backup.age`. Nothing is downloaded or encrypted again: the monthly copy is the same file.
- One copy per part per month. A night that fails makes none. A part that has no monthly copy yet, because it was skipped or its copy failed, gets one from the next good backup that month. Files a backup with `encrypt` off syncs one by one are not included.
- Retention keeps monthly copies for this month and the eleven before it, and deletes older ones, whether `monthly-copies` is on or off, so turning it off lets the existing ones age out.
- It needs `manage-retention` true. When the bucket's own rule decides how long copies are kept, that rule would delete the monthly copies with the nightly ones, so the action makes none and the log warns.
- A monthly copy that cannot be made fails the run and says so. That night's copies are already in the bucket, and the next backup tries again. The bucket is asked for each monthly copy's size; one that is not the size of the night's copy is removed, never recorded, and the run fails, so the next backup makes it again. Each monthly copy is listed in the check-in's `copies`, with the size and SHA-256 of the file it was copied from.
- The access key needs to read objects as well as write them, because the copy is made from the object in the bucket.

## Sydney is the default

Leave the endpoint and region unset and the action uses Sydney, Australia (`ap-southeast-2`). Backups are stored in the region you choose when those values are set. Any S3-compatible API works. Create an access key that can list, put and delete objects in one bucket. Do not use the root account key if you can avoid it. Hosted storage sets the endpoint for you and turns deletion off, because the bucket keeps the objects.

### Amazon S3

Set the endpoint to the regional S3 endpoint, for example `https://s3.ap-southeast-2.amazonaws.com`, and the region to `ap-southeast-2`.

### Cloudflare R2

Set the endpoint to `https://<account-id>.r2.cloudflarestorage.com` and the region to `auto`. The action sets path-style addressing, which R2 expects. Create an R2 token that can read and write the bucket.

## Supabase database URL

For Supabase, LastGood can write `DATABASE_URL` after you connect the project. The URL is the Session pooler on port 5432. The username must include the project ref, like `lastgood_backup.<project-ref>`. The host looks like `aws-0-<region>.pooler.supabase.com`. Do not use the direct host `db.<project-ref>.supabase.co`. That host is IPv6-only, and GitHub-hosted runners fail with `Network is unreachable`. Do not use the transaction pooler on port 6543. A manual URL is the fallback. LastGood writes the secret and does not keep a copy.

## Storage objects

When you connect, LastGood makes a storage login on the Supabase project: a user, `lastgood-backup@lastgood.invalid`, with storage policies (named `lastgood_backup_...`) that let it read every bucket and file and never add, change or delete one. Supabase gives every signed-in user the `authenticated` role, so outside storage the login can do whatever the app lets any signed-in user do. LastGood writes:

| Name | Kind | What it is |
|---|---|---|
| `LIFEBOAT_STORAGE_LOGIN` | secret, the `storage-login` input | the login, as `<email>:<password>`; the password is generated at connect and not kept |
| `LIFEBOAT_SUPABASE_PUBLISHABLE_KEY` | variable, the `supabase-publishable-key` input | the project's publishable key (`sb_publishable_...`, or the legacy anon key), which you paste at connect; it is public |

Each backup signs in with the login (`scripts/storage-copy.mjs`), lists every bucket and every file through the Storage API, and downloads them on the runner, four at a time. The session is refreshed before it runs out, so a long copy keeps going, and a busy answer is tried again. It only reads: it never uploads, moves, copies or deletes a file. The login and its password are masked in the log. The files go up as one archive, encrypted like the dump, at `lifeboat/storage/<timestamp>.tar.age`; with `encrypt` off, each bucket is synced to `lifeboat/storage/<bucket>/` instead. Nothing readable is left on the runner. The log prints one line, such as `Files: 2140 files in 3 buckets, 96200000 bytes, read with the storage login.`, and the check-in carries the file count. If the login cannot sign in or read a bucket, nothing is uploaded for the files, the other copies and the users check still run, and then the run fails and says what to do. Retention does not run that night.

Without the login, the action uses S3 keys for the project's storage when they are set (Storage → S3 in Supabase): `SUPABASE_STORAGE_S3_ENDPOINT`, `SUPABASE_STORAGE_S3_REGION`, `SUPABASE_STORAGE_S3_ACCESS_KEY_ID` and `SUPABASE_STORAGE_S3_SECRET_ACCESS_KEY`. Those keys can also write and delete, which is why LastGood does not make them. With neither, the database dump still runs and the log says the files were skipped. A very large bucket needs a runner with enough disk.

## Check-in

When `CHECKIN_SECRET` is set, the action `POST`s JSON to `https://lastgood.app/api/checkin` (override with `CHECKIN_URL`).

Headers:

- `X-LastGood-Timestamp`: unix seconds
- `X-LastGood-Signature`: hex HMAC-SHA256 of `${timestamp}.${rawBody}` using the secret

The body is the raw JSON that was signed. A signature older than five minutes, or one that does not match the bytes, must be rejected. The JSON has `version`, `ok`, `kind` (`backup` or `restore-test`), `project`, `startedAt`, `finishedAt`, `dumpBytes`, `storageObjects`, `storageSource`, `retentionDays`, `deletedObjects`, `codeBranches`, `codeTags`, `codeBytes`, `githubIssues`, `githubPullRequests`, `githubComments`, `authUsers`, `authUsersWithPassword`, `authIdentities`, `setupFunctions`, `setupCronJobs`, `setupBytes`, `vercelEnvVars`, `vercelEnvValues`, `vercelSource`, `vercelDomains`, `vercelDnsRecords`, `vercelDnsUnreadable`, `copies`, `notChecked` and `error`. In a backup the code counts are what was copied; in a restore test they are what came back out of the newest code copy. They are `null` when the run made or checked no code copy. `storageSource` says how a backup read the files: `login` (the storage login), `s3` (hand-set S3 keys), or `none` when it had no way to, so LastGood's status page shows the files as not copied that night; it is `null` in a restore test. The users counts are `null` when the database has no Supabase Auth users. The setup counts are `null` when the run made no Supabase setup copy, and the Vercel counts when it made no Vercel copy (the settings counts also when only the settings failed). `vercelSource` says how a backup copied Vercel: `token`, or `none` when the app has no Vercel token; it is `null` in a restore test and when encryption is off. `copies` lists each copy a backup uploaded as one file, at most twelve: its `key`, its size in `bytes`, the `sha256` of the bytes uploaded (the encrypted file, when encryption is on) and the bucket's `versionId`, which is `null` when the bucket has no versioning or the keys cannot read it. Files a backup with `encrypt` off syncs one by one are not listed. A restore test sends an empty list. LastGood keeps these records, write-once by key and only from a check-in signed with the repository's own secret, so a restore can refuse a copy that does not match (owner decision D18). A copy is recorded only when its name carries a time within the run (two minutes either side), and for storage LastGood hosts, only under the app's own folder. Records are kept for the retention window plus a week, and 400 days for a monthly copy. A backup's check-in answer includes `copies` with how many were `reported` and `recorded`; when fewer were recorded, the log prints a warning, because a restore refuses a copy with no record. `notChecked` lists, for a restore test, each extension whose tables it left out because the throwaway database does not offer it, at most ten, with its `extension` name, how many `tables` and how many `rows` the dump holds in them, and a backup sends an empty list. Only extensions on the action's own list are named, with `other` for tables that did not load for any other, so no table or schema name the customer chose is sent. It does not contain the database URL, keys, the tokens, row data, emails, password hashes, code, issue text, function source, settings, or environment variable names or values.

`project` should be a stable id, such as the Supabase project ref, so an alert can name the app. The action signs with whatever secret it is given. LastGood gives each repository its own secret, HMAC-SHA256 of `lifeboat-checkin:<project>` keyed with LastGood's `CHECKIN_SECRET`, and checks each check-in against the secret for the project it names. A secret for one project cannot sign a check-in for another.

If the secret is empty, the backup still runs and the check-in is skipped.

## Workflow

`templates/lifeboat.yml` is the workflow to copy into the app repository at `.github/workflows/lifeboat.yml`.

GitHub variables:

| Name | Purpose |
|---|---|
| `LIFEBOAT_PROJECT` | Supabase project ref, or another stable name |
| `LIFEBOAT_BUCKET` | Destination bucket |
| `LIFEBOAT_PUBLIC_KEY` | The app's age public key (`age1...`). Every copy is encrypted to it. |
| `SUPABASE_STORAGE_S3_ENDPOINT` | Optional |
| `SUPABASE_STORAGE_S3_REGION` | Optional |
| `LIFEBOAT_MONTHLY_COPIES` | Optional. `true` keeps twelve monthly copies as well as the nightly ones. Off when empty. |

The template passes the destination variables. When they are empty, the action uses Sydney, Australia (`ap-southeast-2`) and keeps objects for 30 days. For Amazon S3, Cloudflare R2, another region, or a different retention, set `s3-endpoint`, `s3-region` and `retention-days`.

GitHub secrets:

| Name | Purpose |
|---|---|
| `DATABASE_URL` | Session pooler Postgres URL on port 5432. Username is `role.project-ref`. Not `db.*.supabase.co`. |
| `LIFEBOAT_ACCESS_KEY_ID` | Destination access key |
| `LIFEBOAT_SECRET_ACCESS_KEY` | Destination secret key |
| `SUPABASE_STORAGE_S3_ACCESS_KEY_ID` | Optional source key |
| `SUPABASE_STORAGE_S3_SECRET_ACCESS_KEY` | Optional source secret |
| `LIFEBOAT_PRIVATE_KEY` | The app's age private key (`AGE-SECRET-KEY-1...`). The restore test opens copies with it, and each backup checks it matches `LIFEBOAT_PUBLIC_KEY`. Leave it out to keep no private key in GitHub; then there is no automatic restore test. |
| `LIFEBOAT_ENCRYPTION_PASSPHRASE` | The older setup. Used only when no key pair is set, and to open passphrase copies until they age out. |
| `LIFEBOAT_CHECKIN_SECRET` | This repository's own check-in secret, written by LastGood for the project in `LIFEBOAT_PROJECT` |
| `LIFEBOAT_SUPABASE_TOKEN` | Optional. A scoped Supabase access token for the Supabase setup copy. See "Supabase setup". |
| `LIFEBOAT_VERCEL_TOKEN` | Optional. The customer's own Vercel token for the Vercel copy (environment variables, settings, domains and DNS records), with the `LIFEBOAT_VERCEL_PROJECT_ID` variable (and `LIFEBOAT_VERCEL_TEAM_ID` for a team project). Without it there is no Vercel copy. See "The Vercel copy". |

In a public repository, GitHub turns scheduled workflows off after 60 days without activity. A new commit doesn't turn one back on: enable it again from the repository's Actions tab. Private repositories aren't affected. The check-in is how LastGood notices the silence.

The customer workflow starts `supabase/postgres` for Postgres 15 and 17, pinned to its digest, and `postgres:<major>` otherwise. It pulls the Supabase image from ghcr.io first, then public.ecr.aws, then Docker Hub, because public.ecr.aws refuses anonymous pulls once a runner's address has used its data allowance ("toomanyrequests: Data limit exceeded"). It logs which registry gave the image, and the free disk before the image and once it is running. If no registry gives that image, it cannot start or does not become ready, or the runner has less than 10 GiB free, the job uses the stock image. A pull error such as an image rate limit does not fail the restore test. The list filter still skips extensions that image does not offer, except PostGIS. When the job ends on the stock image, the workflow writes `LIFEBOAT_RESTORE_CONTAINER=lifeboat-restore` and `LIFEBOAT_RESTORE_POSTGIS_IMAGE=postgis/postgis:<major>-3.5` to `$GITHUB_ENV`. The action uses them to swap in PostGIS after it has seen the dump. The workflow does not pull the PostGIS image itself. The database starts before the dump is downloaded, so the workflow cannot know yet whether the app uses PostGIS. Apps without PostGIS never pull that image. The Supabase image already offers PostGIS, so the workflow does not set those names when that image is running. The dump uses `pg_dump` against `DATABASE_URL` and does not write to that database. Restore writes only to `RESTORE_DATABASE_URL`. The dump is encrypted on the runner before upload. Secret values are masked and are not printed.

## Publish this folder on its own

1. Create an empty public repository, for example `lastgoodapp/lifeboat`.
2. Copy this directory to the root of that repository, including `action.yml`.
3. Publish a new release tag, such as `v1.0.1`. Do not move an existing tag.
4. In customer workflows, pin the full commit of that tag: `uses: lastgoodapp/lifeboat@<40-character sha> # v1.0.1`. Do not pin the movable tag.
5. In LastGood, set `LIFEBOAT_ACTION_SHA` and `LIFEBOAT_ACTION_VERSION` in `lib/fix-plan/files.ts` to that commit and tag. Update the pin quoted in the root `README.md`, `lib/seo/llms.ts` and `lib/fix-plan/fix-plan.test.ts`. Then refresh each customer workflow with `POST /api/lifeboat/refresh`, which opens or updates a pull request.

The PostGIS switch is in `scripts/run.sh` and `scripts/restore-list.mjs`, so it reaches customers only through a new tag and pin. A workflow that writes `LIFEBOAT_RESTORE_CONTAINER` but still pins an older commit is harmless, because the older action ignores both names. On such a pin, a PostGIS dump on the stock image still fails with `type "extensions.geometry" does not exist`.

## Tests

From the LastGood repository root, `npm test` runs `node --test lifeboat/test`. From this folder alone:

```bash
node --test test/lifeboat.test.mjs test/encrypt.test.mjs test/restore.test.mjs test/code.test.mjs test/users.test.mjs test/setup.test.mjs test/vercel.test.mjs test/copies.test.mjs test/monthly.test.mjs
```

The tests cover retention, the check-in signature, the restore list, PostGIS detection, the restore-test path through `run.sh` with fake `docker`, `psql` and `pg_restore`, and the code copy: a real local git repository, a fake GitHub API on localhost, then opening the archive with age and cloning every branch and tag back out of the bundle; the users count, from COPY rows split across stream chunks to the restore check; and the monthly copies, against a fake bucket on disk. They do not call the destination storage, Supabase, Docker or GitHub.
