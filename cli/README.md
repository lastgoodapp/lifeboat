# lastgood

Opens a LastGood backup copy on your own computer. It checks the copy against the SHA-256 your backup recorded, then decrypts it with your key. Nothing is sent anywhere: the copy, the key and the opened file stay on your machine.

```bash
npx lastgood restore acme-notes-database-20261017T000000Z.backup.age \
  --key lastgood-key-acme-notes.txt \
  --sha256 <the SHA-256 from your download email>
```

- `--key` is the key file you saved when you connected the app, or its Recovery Kit. `--key -` reads it from standard input, for example from a password manager's command line.
- `--share` adds another share of the key, such as the email share saved as a text file. With a Recovery Kit, any two of your three shares rebuild the key on this computer. A share with a typo, or shares from two different apps, are refused rather than giving a wrong key.
- `--sha256` is the SHA-256 your backup recorded for that copy. It is in the email LastGood sends with each download link, and on the "Open here" page of your LastGood login. A copy that does not match is not opened.
- `--out` names the opened file. By default it is the copy's name without `.age`, next to the copy. An existing file is never written over.
- `--unchecked` opens a copy you have no SHA-256 for, and prints the copy's own SHA-256. Use it only for a copy you know came from your backup.

The opened file is the one your backup made before it was encrypted: a `pg_restore` archive for the database (`.backup`), a `tar.gz` for the code, the Supabase setup and the Vercel copy (environment variables, settings, domains and DNS records), and a `tar` for files.

With a Recovery Kit and the email share:

```bash
npx lastgood restore acme-notes-database-20261017T000000Z.backup.age \
  --key lastgood-recovery-kit-acme-notes.txt \
  --share email-share.txt \
  --sha256 <the SHA-256 from your download email>
```

The share format is LastGood's own, written out in `lib/shares.mjs` so anyone can rebuild a key without LastGood: `LG1-<KIT|EMAIL|VAULT>-` and 64 characters of Crockford base32, which hold a two-of-three share of the age key's X25519 secret and a check that ties it to its role and the app's public key.

Copies made with the older passphrase (`.enc`) open with OpenSSL instead: `openssl enc -d -aes-256-cbc -pbkdf2 -in <copy> -out <file>`.

## Rebuild into new accounts

`lastgood rebuild` puts an app back into new, empty accounts you have made, one step at a time, and shows each step's result and how long it took. It opens the copies the same way `restore` does, on this computer, and their contents go only to the repository, the Supabase project and the Vercel project you name.

```bash
LASTGOOD_DATABASE_TO='postgresql://postgres.<new-ref>:<password>@<host>:5432/postgres' \
LASTGOOD_SUPABASE_SECRET_KEY='sb_secret_...' \
LASTGOOD_SUPABASE_TOKEN='sbp_...' \
LASTGOOD_VERCEL_TOKEN='...' \
npx lastgood rebuild --key lastgood-key-acme-notes.txt \
  --code acme-notes-repo-20261017T000000Z.tar.gz.age --code-sha256 <its SHA-256> \
  --code-to git@github.com:acme/notes-rebuilt.git \
  --database acme-notes-database-20261017T000000Z.backup.age --database-sha256 <its SHA-256> \
  --files acme-notes-storage-20261017T000000Z.tar.age --files-sha256 <its SHA-256> \
  --setup acme-notes-setup-20261017T000000Z.tar.gz.age --setup-sha256 <its SHA-256> \
  --vercel acme-notes-vercel-20261017T000000Z.tar.gz.age --vercel-sha256 <its SHA-256> \
  --vercel-project prj_... --vercel-team team_...
```

- **Code.** Every branch and tag in the copy is pushed to `--code-to`, a new, empty repository, with your own git login. A repository that already has commits is refused. If the old repository was private and the new one on GitHub is public, nothing is pushed. Issues and pull requests are not recreated; they are in the copy as JSON.
- **Database.** `--database-to`, or `LASTGOOD_DATABASE_TO` to keep it out of your shell history, is the new Supabase project's connection string for its `postgres` role: the direct one, or the session pooler on port 5432 (not the transaction pooler). The project must be new and empty: one with tables, users or buckets is refused. The app's own schemas come back as they were dumped. From Supabase's own schemas only the users, their sign-in identities, the storage buckets, and the app's triggers and policies on Supabase's tables come back, because Supabase made the rest of the new project itself. Row counts and the users are then checked against the copy. LastGood's storage login from the old project is left out on purpose: its password is in the old repository's secrets. Connecting the new project to LastGood makes a new one. It is taken out after the counts are checked, so an app row that points at it, such as a profile your sign-up trigger made for it, is counted as the copy counts it. Rows whose foreign key cascades go with it and are named; a key that does not cascade stops the step, naming its table, rather than leave the login in.
- **Files.** Every file in the files copy goes up into the new project's buckets through its Storage API, with the project's secret key in `LASTGOOD_SUPABASE_SECRET_KEY` (Project Settings, then API Keys). The key stays on this computer. The buckets, with their settings, come back with the database step, so `--files` needs `--database` too. Each file's type and cache setting come from the database copy, and files over 6 MB go up in parts (Supabase's resumable uploads). A file already there at the same size is kept, and one at a different size stops the step before anything is uploaded, so nothing is ever written over. Every file is then checked at the size it was saved, one is read back, and each file's owner is set back as it was, over the database connection: an upload with the secret key has no owner, so a policy that lets users reach their own files would otherwise match none of them. Only a file whose owner is still empty is changed, and one that already has a different owner is named and left as it is. The project URL comes from the connection string; give `--files-to https://<ref>.supabase.co` if it can't be read from it.
- **Edge Functions and settings.** With an access token for the new project in `LASTGOOD_SUPABASE_TOKEN` (Account, then Access Tokens, with write access to Edge Functions, Auth Config and Storage Config), every function in the setup copy is deployed with the JWT check it had. A function already in the new project is kept, so nothing is replaced and a rerun carries on. Only the auth and storage settings that differ from the new project's are sent. A setting that holds a secret, such as a sign-in provider's secret or the SMTP password, is never sent, nor is a value the copy holds masked: those are listed to set by hand. A setting the new project's plan refuses is named and left out. `site_url` and the redirect URLs are printed as applied: if the app moves to a new domain, change them. An auth hook that calls one of the old project's Edge Functions is pointed at the same function in the new project when this run deployed it, and each hook changed is named with both refs. Any other auth setting that still names another Supabase project, such as a hook calling a function this run did not deploy, is named, so the new project does not keep calling the old one. The step then lists the secrets the functions read that the new project lacks, the cron jobs (listed, not recreated, so none calls the old project), any database webhook that still calls the old project, the Vault secret names, and the new API keys the app's environment variables need. The project comes from the connection string; give `--project-ref` if it can't be read from it.
- **Vercel environment variables.** Make the new Vercel project first, most simply by importing the new repository in Vercel, and give its ID or name as `--vercel-project` (and `--vercel-team` for a team project). With a Vercel token for that team in `LASTGOOD_VERCEL_TOKEN`, which stays on this computer, every variable in the Vercel copy that has its value goes back for the environments it had, with its Git branch and comment. A variable already set in the new project for any of the same environments is kept and never written over, so one added by an integration or by hand stays as it is and a rerun carries on. The token is never printed, nor is any value of six characters or more, even inside Vercel's refusals; a shorter one, such as `true`, is left in Vercel's message so the message still reads. If the network drops after Vercel took a variable, the refused retry is checked against the project's list and the variable counts as kept. Vercel never returns the values it marks sensitive, so the backup holds only their names: those are listed to add by hand, with their environments. Vercel's own system variables are left for it to fill in, and a variable also set for a custom environment is named, since the new project does not have that environment yet. Any value that still names the old Supabase project (its address or a pooler login), and any Supabase API key from the copy, is named to change to the new project's. Then deploy again in Vercel, since a deployment reads its variables when it builds. When the new Supabase project is known, from the connection string or `--project-ref`, the old one is told apart from it.
- **Vercel settings and domains.** The same `--vercel` copy holds the old project's settings, its domains and their DNS records, when the backup had the customer's own Vercel token (copies from before that have none, and the step says to set them by hand). Only the settings that differ from the new project's are sent, such as the Node.js version, the build command and the functions' region and time limit; one the new project's plan refuses is named. The production branch and the deploy hooks are named to set by hand, since a hook gets a new URL, and the cron jobs come back with the code's `vercel.json`. Each domain not on the new project yet is added, a redirect after the domain it points at, with its Git branch; the old `.vercel.app` address is left out. A domain Vercel refuses, most often because it is still on the old project, and one that needs proving with a TXT record are listed with what to do. DNS records go only into a zone this token can read, and only for a name and type whose records there are all in the copy too: a record changed since the backup is kept and named, never doubled up with the copy's older one. A zone kept outside this Vercel team gets its records listed to add where it is kept. SRV and HTTPS records are listed to add by hand. A record create is never retried, so a dropped connection cannot make it twice; the zone is listed again to see whether it went in. Nothing is ever deleted or written over, so a rerun carries on.
- **What it says it left out.** Extensions the new project does not offer, Vault secrets, second sign-in factors, and grants changed by hand. Each is named with what to do about it.
- **pg_restore** must be from PostgreSQL 17 or newer for copies made by PostgreSQL 17.

A failed step stops the steps after it, and the summary says which ran. Run it again with only the parts that are left: a step never writes over what an earlier run put back. If the database is back and the files step stopped, run it again with `--skip database`: the database copy is still opened for the files' types and owners, and the files already uploaded are kept.

After the summary comes **Still to do by hand**: one numbered list of everything the steps left to you, grouped by step, such as auth secrets to set, cron jobs to add again, Vercel values it never had, and settings that still name the old project. Each line is also printed where it happens. A step that did not run, or stopped part way, says its list is not known yet or may be short. The list always ends with what no rebuild does: pointing your domain at the new project where its DNS is kept, and connecting the new app to LastGood so backups start again. A run without `--vercel` also lists rebuilding the Vercel project, with the command for it. Add `--todo <file>` to write the same list to a new file as Markdown, readable only by you. It holds names only, never a value, and an existing file is never written over.

## Status

On npm as `lastgood`. It needs Node.js 22.13 or newer. To run it from a clone of this repository instead: `node cli/bin/lastgood.mjs restore ...`, after `npm install`. It takes the whole key file, or rebuilds the key from two of its three shares.

Tests, in this repository: `node --test cli/test/*.test.mjs`. In a copy of `cli/` on its own: `npm install`, then `node --test test/*.test.mjs`. There the check that `lib/lifeboat/` matches the backup action's scripts, and the rebuild tests that load the action's Supabase-shaped test dump, are skipped, because they need the full repository. The rebuild's database tests need Postgres 16 or newer server binaries (`initdb`, `pg_ctl`), and are skipped without them.
