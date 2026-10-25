#!/usr/bin/env bash
# Nightly dump, the storage files, the code with its GitHub history and the Supabase setup, or a monthly restore of the database and code into throwaway Postgres and git.
# pg_dump only reads DATABASE_URL. psql and pg_restore run only against RESTORE_DATABASE_URL.
# The dump is encrypted on the runner before upload when encryption is on, which is the default.
# Secrets are masked and are not printed.
# An empty string is treated as unset, because GitHub passes "" for a missing variable.
set -euo pipefail

mask() {
  local value="${1-}"
  [[ -n "$value" ]] || return 0
  printf '%s\n' "::add-mask::${value}"
}

mask_url_secret() {
  local url="${1-}"
  if [[ "$url" =~ ://[^/@:]+:([^@]+)@ ]]; then
    mask "${BASH_REMATCH[1]}"
  fi
}

mask "${DATABASE_URL:-}"
mask_url_secret "${DATABASE_URL:-}"
mask "${RESTORE_DATABASE_URL:-}"
mask_url_secret "${RESTORE_DATABASE_URL:-}"
mask "${S3_ACCESS_KEY_ID:-}"
mask "${S3_SECRET_ACCESS_KEY:-}"
mask "${STORAGE_S3_ACCESS_KEY_ID:-}"
mask "${STORAGE_S3_SECRET_ACCESS_KEY:-}"
mask "${LIFEBOAT_ENCRYPTION_PASSPHRASE:-}"
mask "${LIFEBOAT_PRIVATE_KEY:-}"
mask "${CHECKIN_SECRET:-}"
mask "${GITHUB_TOKEN:-}"
mask "${LIFEBOAT_SUPABASE_TOKEN:-}"
mask "${LIFEBOAT_VERCEL_TOKEN:-}"
mask "${LIFEBOAT_STORAGE_LOGIN:-}"
# The storage login is "<email>:<password>". The password alone is masked too, in case it is ever printed apart.
if [[ "${LIFEBOAT_STORAGE_LOGIN:-}" == *:* ]]; then
  mask "${LIFEBOAT_STORAGE_LOGIN##*:}"
fi

# The workflow records the database it actually started. The action input is only the fallback.
if [[ -n "${RUNNER_TEMP:-}" && -f "${RUNNER_TEMP}/lifeboat-restore-url" ]]; then
  RESTORE_DATABASE_URL="$(tr -d '\r\n' < "${RUNNER_TEMP}/lifeboat-restore-url")"
  export RESTORE_DATABASE_URL
  mask "${RESTORE_DATABASE_URL}"
  mask_url_secret "${RESTORE_DATABASE_URL}"
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MODE="${LIFEBOAT_MODE:-backup}"

value_or() {
  if [[ -z "${1:-}" ]]; then
    printf '%s' "$2"
  else
    printf '%s' "$1"
  fi
}

# "1 file", "2 files": a count and its noun, plural unless the count is 1.
counted() {
  if [[ "$1" == "1" ]]; then
    printf '%s %s' "$1" "$2"
  else
    printf '%s %ss' "$1" "$2"
  fi
}

ENDPOINT="$(value_or "${S3_ENDPOINT:-}" "https://s3.ap-southeast-2.wasabisys.com")"
REGION="$(value_or "${S3_REGION:-}" "ap-southeast-2")"
PREFIX="$(value_or "${S3_PREFIX:-}" "lifeboat")"
ENCRYPT="$(value_or "${LIFEBOAT_ENCRYPT:-}" "true")"
MANAGE_RETENTION="$(value_or "${LIFEBOAT_MANAGE_RETENTION:-}" "true")"
# Off unless the app turns it on (D9).
MONTHLY_COPIES="$(value_or "${LIFEBOAT_MONTHLY_COPIES:-}" "false")"
BUCKET="${S3_BUCKET:-}"
RETENTION_DAYS="${RETENTION_DAYS:-30}"
WORKDIR="${LIFEBOAT_WORKDIR:-$(mktemp -d)}"
STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
# Each copy this backup uploads, one per line: key, bytes, SHA-256 and version ID. The check-in reports them (D18).
COPIES_FILE="$WORKDIR/copies.tsv"
rm -f "$COPIES_FILE"

export AWS_ACCESS_KEY_ID="${S3_ACCESS_KEY_ID:-}"
export AWS_SECRET_ACCESS_KEY="${S3_SECRET_ACCESS_KEY:-}"
export AWS_DEFAULT_REGION="$REGION"
export AWS_S3_ADDRESSING_STYLE="${AWS_S3_ADDRESSING_STYLE:-path}"
export AWS_REQUEST_CHECKSUM_CALCULATION="${AWS_REQUEST_CHECKSUM_CALCULATION:-when_required}"
export AWS_RESPONSE_CHECKSUM_VALIDATION="${AWS_RESPONSE_CHECKSUM_VALIDATION:-when_required}"

DUMP_BYTES=0
STORAGE_OBJECTS=0
# How the files were read: login (the storage login), s3 (hand-set S3 keys) or none. Empty in a restore test.
STORAGE_SOURCE=""
DELETED_OBJECTS=0
# Empty until the code copy runs, so the check-in can tell "not copied" from zero.
CODE_BRANCHES=""
CODE_TAGS=""
CODE_BYTES=""
GITHUB_ISSUES=""
GITHUB_PULLS=""
GITHUB_COMMENTS=""
AUTH_USERS=""
AUTH_PASSWORDS=""
AUTH_IDENTITIES=""
SETUP_FUNCTIONS=""
SETUP_CRON_JOBS=""
SETUP_BYTES=""
VERCEL_SOURCE=""
VERCEL_ENV_VARS=""
VERCEL_ENV_VALUES=""
VERCEL_DOMAINS=""
VERCEL_DNS_RECORDS=""
VERCEL_DNS_UNREADABLE=""
RESTORE_NOT_CHECKED=""
PART_ERRORS=""
LIFEBOAT_ERROR=""
LIFEBOAT_OK=false
REPORTING=0

aws_s3() {
  aws --endpoint-url "$ENDPOINT" "$@"
}

# Records a copy just uploaded, so the signed check-in can report it and a restore can refuse a copy that does not
# match (D18). The hash is of the bytes uploaded, so for an encrypted copy it is of the encrypted file. The version
# ID is best effort: a bucket without versioning, or keys that cannot read it, leave it out.
record_copy() {
  local file="$1" key="$2" bytes sha version
  bytes="$(wc -c <"$file" | tr -d ' ')"
  sha="$(sha256sum "$file" | awk '{print $1}')"
  version="$(aws_s3 s3api head-object --bucket "$BUCKET" --key "$key" --query VersionId --output text 2>/dev/null)" || version=""
  if [[ ! "$version" =~ ^[A-Za-z0-9._+=/-]{1,200}$ || "$version" == "None" || "$version" == "null" ]]; then
    version=""
  fi
  printf '%s\t%s\t%s\t%s\n' "$key" "$bytes" "$sha" "$version" >>"$COPIES_FILE"
}

# Records a monthly copy made inside the bucket from a copy this backup already recorded. The bytes are the same, so
# the size and SHA-256 come from that record, once the bucket says the copy is that size. A copy of any other size is
# removed and never recorded, so the next backup makes it again. The version ID is best effort, as for record_copy.
record_monthly_copy() {
  local source="$1" dest="$2" bytes sha head size version
  read -r bytes sha < <(awk -F '\t' -v key="$source" '$1 == key { print $2, $3; exit }' "$COPIES_FILE") || true
  [[ -n "${bytes:-}" && -n "${sha:-}" ]] || return 0
  head="$(aws_s3 s3api head-object --bucket "$BUCKET" --key "$dest" --query '[ContentLength,VersionId]' --output text 2>/dev/null)" || head=""
  read -r size version <<<"$head" || true
  if [[ "${size:-}" != "$bytes" ]]; then
    if aws_s3 s3 rm "s3://${BUCKET}/${dest}" >/dev/null 2>&1; then
      fail "The monthly copy of ${source##*/} did not come out at ${bytes} bytes, so it was removed and not recorded. Tonight's copies are in the bucket, and the next backup makes the monthly copy again."
    fi
    fail "The monthly copy of ${source##*/} did not come out at ${bytes} bytes and could not be removed. Delete ${dest} so the next backup makes it again. It was not recorded."
  fi
  if [[ ! "${version:-}" =~ ^[A-Za-z0-9._+=/-]{1,200}$ || "$version" == "None" || "$version" == "null" ]]; then
    version=""
  fi
  printf '%s\t%s\t%s\t%s\n' "$dest" "$bytes" "$sha" "$version" >>"$COPIES_FILE"
}

fail() {
  LIFEBOAT_ERROR="$1"
  echo "$1" >&2
  exit 1
}

report() {
  local status=$?
  if [[ "$REPORTING" -eq 1 ]]; then
    exit "$status"
  fi
  REPORTING=1
  if [[ -n "${IDENTITY_FILE:-}" ]]; then
    rm -f "$IDENTITY_FILE"
  fi
  if [[ "$status" -eq 0 ]]; then
    LIFEBOAT_OK=true
  elif [[ -z "$LIFEBOAT_ERROR" ]]; then
    LIFEBOAT_ERROR="Lifeboat failed with status ${status}"
  fi
  LIFEBOAT_OK="$LIFEBOAT_OK" \
    LIFEBOAT_KIND="$MODE" \
    LIFEBOAT_STARTED_AT="$STARTED_AT" \
    LIFEBOAT_DUMP_BYTES="$DUMP_BYTES" \
    LIFEBOAT_STORAGE_OBJECTS="$STORAGE_OBJECTS" \
    LIFEBOAT_STORAGE_SOURCE="$STORAGE_SOURCE" \
    LIFEBOAT_DELETED_OBJECTS="$DELETED_OBJECTS" \
    LIFEBOAT_CODE_BRANCHES="$CODE_BRANCHES" \
    LIFEBOAT_CODE_TAGS="$CODE_TAGS" \
    LIFEBOAT_CODE_BYTES="$CODE_BYTES" \
    LIFEBOAT_GITHUB_ISSUES="$GITHUB_ISSUES" \
    LIFEBOAT_GITHUB_PULLS="$GITHUB_PULLS" \
    LIFEBOAT_GITHUB_COMMENTS="$GITHUB_COMMENTS" \
    LIFEBOAT_AUTH_USERS="$AUTH_USERS" \
    LIFEBOAT_AUTH_PASSWORDS="$AUTH_PASSWORDS" \
    LIFEBOAT_AUTH_IDENTITIES="$AUTH_IDENTITIES" \
    LIFEBOAT_SETUP_FUNCTIONS="$SETUP_FUNCTIONS" \
    LIFEBOAT_SETUP_CRON_JOBS="$SETUP_CRON_JOBS" \
    LIFEBOAT_SETUP_BYTES="$SETUP_BYTES" \
    LIFEBOAT_VERCEL_SOURCE="$VERCEL_SOURCE" \
    LIFEBOAT_VERCEL_ENV_VARS="$VERCEL_ENV_VARS" \
    LIFEBOAT_VERCEL_ENV_VALUES="$VERCEL_ENV_VALUES" \
    LIFEBOAT_VERCEL_DOMAINS="$VERCEL_DOMAINS" \
    LIFEBOAT_VERCEL_DNS_RECORDS="$VERCEL_DNS_RECORDS" \
    LIFEBOAT_VERCEL_DNS_UNREADABLE="$VERCEL_DNS_UNREADABLE" \
    LIFEBOAT_RESTORE_NOT_CHECKED="$RESTORE_NOT_CHECKED" \
    LIFEBOAT_COPIES_FILE="$COPIES_FILE" \
    LIFEBOAT_ERROR="$LIFEBOAT_ERROR" \
    RETENTION_DAYS="$RETENTION_DAYS" \
    node "$ROOT/scripts/checkin.mjs" || status=1
  exit "$status"
}
trap report EXIT

if [[ -n "${DATABASE_URL:-}" && -n "${RESTORE_DATABASE_URL:-}" && "$DATABASE_URL" == "$RESTORE_DATABASE_URL" ]]; then
  fail "Refusing to restore into DATABASE_URL."
fi

postgres_host() {
  local rest="${1-}"
  rest="${rest#*://}"
  if [[ "$rest" == *"@"* ]]; then
    rest="${rest#*@}"
  fi
  rest="${rest%%/*}"
  rest="${rest%%\?*}"
  if [[ "$rest" == \[*\]* ]]; then
    rest="${rest#\[}"
    rest="${rest%%\]*}"
  else
    rest="${rest%%:*}"
  fi
  printf '%s' "${rest,,}"
}

postgres_user() {
  local rest="${1-}"
  rest="${rest#*://}"
  if [[ "$rest" != *"@"* ]]; then
    printf '%s' ""
    return
  fi
  local userinfo="${rest%%@*}"
  local user="${userinfo%%:*}"
  user="${user//%2E/.}"
  user="${user//%2e/.}"
  printf '%s' "$user"
}

if [[ -n "${DATABASE_URL:-}" ]]; then
  db_host="$(postgres_host "$DATABASE_URL")"
  if [[ "$db_host" == db.*.supabase.co ]]; then
    fail "DATABASE_URL uses the direct Supabase host db.<project-ref>.supabase.co. That host is IPv6-only, and GitHub-hosted runners fail with Network is unreachable. Use the Session pooler URL on port 5432 (a host like aws-0-<region>.pooler.supabase.com). Do not use the transaction pooler on port 6543."
  fi
  if [[ "$db_host" == *.pooler.supabase.com ]]; then
    db_user="$(postgres_user "$DATABASE_URL")"
    if [[ ! "$db_user" =~ ^[A-Za-z_][A-Za-z0-9_]*\.[a-z]{20}$ ]]; then
      fail "The Session pooler username must include the project ref, like lastgood_backup.<project-ref>, not the role name alone. Do not use port 6543."
    fi
    unset db_user
  fi
fi

if [[ -z "$BUCKET" || -z "$AWS_ACCESS_KEY_ID" || -z "$AWS_SECRET_ACCESS_KEY" ]]; then
  fail "Set S3_BUCKET, S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY."
fi
command -v aws >/dev/null || fail "The AWS CLI is not installed on this runner."
command -v node >/dev/null || fail "Node.js is not installed on this runner."

# GitHub-hosted runners ship an older pg_dump on PATH. Use the client installed for this major.
PG_DIR="${LIFEBOAT_PG_BIN:-/usr/lib/postgresql/${POSTGRES_MAJOR:-17}/bin}"
if [[ -x "${PG_DIR}/pg_dump" && -x "${PG_DIR}/pg_restore" && -x "${PG_DIR}/psql" ]]; then
  PG_DUMP="${PG_DIR}/pg_dump"
  PG_RESTORE="${PG_DIR}/pg_restore"
  PSQL="${PG_DIR}/psql"
else
  PG_DUMP="pg_dump"
  PG_RESTORE="pg_restore"
  PSQL="psql"
fi

client_major() {
  local version major
  version="$("$1" --version 2>/dev/null || true)"
  if [[ "$version" =~ ([0-9]+)\.[0-9]+ ]]; then
    major="${BASH_REMATCH[1]}"
    printf '%s' "$major"
  fi
}

# pg_dump refuses a newer server. Say so before it aborts, and do not print the URL.
assert_client_can_read() {
  local url="$1"
  local client server_num server_major
  client="$(client_major "$PG_DUMP")"
  [[ -n "$client" ]] || return 0
  if [[ ! -x "$PSQL" ]] && ! command -v "$PSQL" >/dev/null 2>&1; then
    return 0
  fi
  server_num="$("$PSQL" "$url" --no-psqlrc --tuples-only --no-align --command "SHOW server_version_num" 2>/dev/null || true)"
  server_num="${server_num//[^0-9]/}"
  [[ "$server_num" =~ ^[0-9]{5,6}$ ]] || return 0
  server_major=$((server_num / 10000))
  if [[ "$server_major" -gt "$client" ]]; then
    fail "pg_dump ${client} cannot read Postgres ${server_major}. The database is newer than the client on this runner. Install postgresql-client-${server_major} and use /usr/lib/postgresql/${server_major}/bin/pg_dump. The runner's default pg_dump is older and is the wrong binary."
  fi
}

# Copies are encrypted with age to the app's public key (LIFEBOAT_PUBLIC_KEY), and only the private key
# (LIFEBOAT_PRIVATE_KEY) opens them. age authenticates every chunk, so a changed or cut-short copy fails to
# decrypt instead of restoring wrong data. The passphrase (OpenSSL AES-256-CBC, no authentication) is the
# older setup: it still encrypts when no key pair is set, and its copies stay restorable until they age out.
AGE_RECIPIENT='^age1[02-9ac-hj-np-z]{58}$'
AGE_IDENTITY='^AGE-SECRET-KEY-1[02-9AC-HJ-NP-Z]{58}$'
RECIPIENT=""
IDENTITY_FILE=""

require_age() {
  command -v age >/dev/null || fail "age is not installed on this runner. The action's install step adds it."
}

# The private key goes to a file only this user can read, because age reads identities from files.
write_identity() {
  [[ -n "$IDENTITY_FILE" ]] && return 0
  # Accept the bare key or a whole age key file, whose comment lines are skipped.
  local key line
  key=""
  while IFS= read -r line; do
    line="${line//[$'\r\t ']/}"
    if [[ "$line" == AGE-SECRET-KEY-1* ]]; then
      key="$line"
      break
    fi
  done <<<"${LIFEBOAT_PRIVATE_KEY:-}"
  [[ "$key" =~ $AGE_IDENTITY ]] || fail "LIFEBOAT_PRIVATE_KEY is not an age private key. It starts with AGE-SECRET-KEY-1."
  IDENTITY_FILE="$WORKDIR/identity.txt"
  (umask 077 && printf '%s\n' "$key" >"$IDENTITY_FILE")
}

forget_identity() {
  if [[ -n "$IDENTITY_FILE" ]]; then
    rm -f "$IDENTITY_FILE"
    IDENTITY_FILE=""
  fi
}

# Which public key new copies are encrypted to. When both keys are set they must be one pair,
# or tonight's copy could not be opened with the key in this repository.
resolve_recipient() {
  local public="${LIFEBOAT_PUBLIC_KEY:-}"
  public="${public//[$'\r\n\t ']/}"
  if [[ -n "$public" && ! "$public" =~ $AGE_RECIPIENT ]]; then
    fail "LIFEBOAT_PUBLIC_KEY is not an age public key. It starts with age1."
  fi
  if [[ -n "${LIFEBOAT_PRIVATE_KEY:-}" ]]; then
    require_age
    command -v age-keygen >/dev/null || fail "age-keygen is not installed on this runner. The action's install step adds it."
    write_identity
    local derived
    derived="$(age-keygen -y "$IDENTITY_FILE")" || fail "age-keygen could not read LIFEBOAT_PRIVATE_KEY."
    forget_identity
    if [[ -n "$public" && "$derived" != "$public" ]]; then
      fail "LIFEBOAT_PUBLIC_KEY and LIFEBOAT_PRIVATE_KEY are not one key pair, so tonight's copy could not be opened with the key in this repository. Nothing was uploaded. Run the connect wizard again."
    fi
    public="$derived"
  fi
  RECIPIENT="$public"
}

# The file suffix new copies get: .age with a key pair, .enc with the older passphrase, nothing when off.
encrypted_suffix() {
  if [[ "$ENCRYPT" != "true" ]]; then
    printf '%s' ""
  elif [[ -n "$RECIPIENT" ]]; then
    printf '%s' ".age"
  else
    printf '%s' ".enc"
  fi
}

encrypt_file() {
  local source="$1"
  local dest="$2"
  if [[ "$ENCRYPT" != "true" ]]; then
    cp "$source" "$dest"
    return
  fi
  if [[ -n "$RECIPIENT" ]]; then
    require_age
    age --encrypt --recipient "$RECIPIENT" --output "$dest" "$source" || fail "age could not encrypt the copy. Nothing was uploaded."
    return
  fi
  if [[ -z "${LIFEBOAT_ENCRYPTION_PASSPHRASE:-}" ]]; then
    fail "Set LIFEBOAT_PUBLIC_KEY, the public half of this app's key pair, so copies are encrypted before upload. Older setups use LIFEBOAT_ENCRYPTION_PASSPHRASE. LastGood holds neither private key nor passphrase."
  fi
  command -v openssl >/dev/null || fail "openssl is not installed on this runner."
  echo "This copy uses the older passphrase encryption, which cannot detect a changed copy. Run the connect wizard again to move to a key pair."
  openssl enc -aes-256-cbc -pbkdf2 -salt -pass env:LIFEBOAT_ENCRYPTION_PASSPHRASE -in "$source" -out "$dest"
}

decrypt_age_file() {
  local source="$1"
  local dest="$2"
  [[ -n "${LIFEBOAT_PRIVATE_KEY:-}" ]] || fail "Set LIFEBOAT_PRIVATE_KEY. This copy is encrypted to this app's key pair, and only its private key opens it."
  require_age
  write_identity
  if ! age --decrypt --identity "$IDENTITY_FILE" --output "$dest" "$source" 2>"$WORKDIR/age.err"; then
    forget_identity
    rm -f "$dest" "$WORKDIR/age.err"
    fail "This copy did not open with LIFEBOAT_PRIVATE_KEY. Either it was changed or damaged after it was made, or it was made for a different key. It was not restored."
  fi
  forget_identity
  rm -f "$WORKDIR/age.err"
}

decrypt_file() {
  local source="$1"
  local dest="$2"
  if [[ -z "${LIFEBOAT_ENCRYPTION_PASSPHRASE:-}" ]]; then
    fail "Set LIFEBOAT_ENCRYPTION_PASSPHRASE. The dump was encrypted with the passphrase kept in this repository."
  fi
  command -v openssl >/dev/null || fail "openssl is not installed on this runner."
  openssl enc -d -aes-256-cbc -pbkdf2 -salt -pass env:LIFEBOAT_ENCRYPTION_PASSPHRASE -in "$source" -out "$dest"
}

apply_retention() {
  if [[ "$MANAGE_RETENTION" != "true" ]]; then
    echo "Retention is left to the bucket. This key does not delete objects."
    return
  fi
  local list="$WORKDIR/objects.json"
  aws_s3 s3api list-objects-v2 --bucket "$BUCKET" --prefix "${PREFIX}/" --output json >"$list"
  local key
  while IFS= read -r key; do
    [[ -z "$key" ]] && continue
    aws_s3 s3 rm "s3://${BUCKET}/${key}"
    DELETED_OBJECTS=$((DELETED_OBJECTS + 1))
  done < <(node "$ROOT/scripts/retention.mjs" "$list" "$RETENTION_DAYS" "$PREFIX")
}

# Monthly copies (B14, D9). The first good backup of each UTC month is also copied, inside the bucket, to
# <prefix>/monthly/<YYYYMM>/<part>/, and retention keeps those for twelve months. Only when this key manages retention:
# a bucket whose own rule expires every object after the nightly window would delete the monthly copies with the rest.
make_monthly_copies() {
  if [[ "$MONTHLY_COPIES" != "true" ]]; then
    return
  fi
  if [[ "$MANAGE_RETENTION" != "true" ]]; then
    echo "::warning::Monthly copies are on, but this bucket's own rule decides how long copies are kept, so no monthly copy was made. Set manage-retention to true to keep them for twelve months."
    return
  fi
  [[ -s "$COPIES_FILE" ]] || return 0
  local month="${STAMP:0:6}" list="$WORKDIR/monthly.json" plan="$WORKDIR/monthly.plan" source dest
  aws_s3 s3api list-objects-v2 --bucket "$BUCKET" --prefix "${PREFIX}/monthly/${month}/" --output json >"$list"
  node "$ROOT/scripts/monthly.mjs" "$list" "$COPIES_FILE" "$PREFIX" "$month" >"$plan"
  if [[ ! -s "$plan" ]]; then
    echo "This month's monthly copy is already in ${PREFIX}/monthly/${month}/."
    return
  fi
  while IFS=$'\t' read -r source dest; do
    [[ -n "$source" && -n "$dest" ]] || continue
    aws_s3 s3 cp "s3://${BUCKET}/${source}" "s3://${BUCKET}/${dest}" ||
      fail "The monthly copy of ${source##*/} was not made. Tonight's copies are in the bucket, and the next backup tries the monthly copy again."
    record_monthly_copy "$source" "$dest"
    echo "Monthly copy kept for twelve months: ${dest}"
  done <"$plan"
}

# The newest key under <prefix>/<part>/ that ends with one of the suffixes. Keys start with a UTC stamp, so the last one sorted is the newest.
# Exits 3 when there is none.
# The newest copy of a part: the last key directly under its folder with one of the suffixes. A key in a folder below,
# such as a file an unencrypted run synced into storage/<bucket>/, is never a copy.
latest_key() {
  local part="$1"
  shift
  local list="$WORKDIR/${part}.list.json"
  aws_s3 s3api list-objects-v2 --bucket "$BUCKET" --prefix "${PREFIX}/${part}/" --output json >"$list"
  node --input-type=module -e '
    import { readFileSync } from "node:fs";
    const [file, folder, ...suffixes] = process.argv.slice(1);
    const payload = JSON.parse(readFileSync(file, "utf8"));
    const keys = (payload.Contents || [])
      .map((item) => item.Key)
      .filter((key) => key && key.startsWith(folder) && !key.slice(folder.length).includes("/"))
      .filter((key) => suffixes.some((suffix) => key.endsWith(suffix)));
    keys.sort();
    if (keys.length === 0) process.exit(3);
    process.stdout.write(keys[keys.length - 1]);
  ' "$list" "${PREFIX}/${part}/" "$@"
}

latest_dump_key() {
  latest_key db .backup .backup.enc .backup.age
}

# Supabase Storage files. With the storage login setup made (D4), the workflow signs in through the Storage API and
# reads every bucket; with S3 keys for the project's storage, it syncs every bucket. Without either, the files are
# left out and the log says so. A login that cannot read fails the run after the other copies, like the setup copy.
copy_storage() {
  local root="$WORKDIR/storage"
  rm -rf "$root" "$WORKDIR/storage.tar" "$WORKDIR/storage.err"
  if [[ -n "${LIFEBOAT_STORAGE_LOGIN:-}" ]]; then
    STORAGE_SOURCE="login"
    mkdir -p "$root"
    local counts buckets bytes
    if ! counts="$(SUPABASE_PROJECT_REF="$(supabase_project_ref)" node "$ROOT/scripts/storage-copy.mjs" "$root" 2>"$WORKDIR/storage.err")"; then
      local reason
      reason="$(tail -n 1 "$WORKDIR/storage.err")"
      rm -rf "$root" "$WORKDIR/storage.err"
      part_failed "${reason:-The storage copy failed.} Nothing was uploaded for the files."
      return
    fi
    rm -f "$WORKDIR/storage.err"
    read -r buckets STORAGE_OBJECTS bytes <<<"$counts"
    echo "Files: $(counted "$STORAGE_OBJECTS" file) in $(counted "$buckets" bucket), ${bytes} bytes, read with the storage login."
  elif [[ -n "${STORAGE_S3_ENDPOINT:-}" && -n "${STORAGE_S3_ACCESS_KEY_ID:-}" && -n "${STORAGE_S3_SECRET_ACCESS_KEY:-}" ]]; then
    STORAGE_SOURCE="s3"
    local storage_region="${STORAGE_S3_REGION:-us-east-1}"
    local names name
    names="$(
      AWS_ACCESS_KEY_ID="$STORAGE_S3_ACCESS_KEY_ID" \
        AWS_SECRET_ACCESS_KEY="$STORAGE_S3_SECRET_ACCESS_KEY" \
        AWS_DEFAULT_REGION="$storage_region" \
        aws --endpoint-url "$STORAGE_S3_ENDPOINT" s3 ls | awk '{print $3}'
    )"
    mkdir -p "$root"
    for name in $names; do
      mkdir -p "$root/$name"
      AWS_ACCESS_KEY_ID="$STORAGE_S3_ACCESS_KEY_ID" \
        AWS_SECRET_ACCESS_KEY="$STORAGE_S3_SECRET_ACCESS_KEY" \
        AWS_DEFAULT_REGION="$storage_region" \
        aws --endpoint-url "$STORAGE_S3_ENDPOINT" s3 sync "s3://${name}" "$root/$name"
    done
    STORAGE_OBJECTS="$(find "$root" -type f | wc -l | tr -d ' ')"
  else
    STORAGE_SOURCE="none"
    echo "Storage copy skipped: LIFEBOAT_STORAGE_LOGIN is not set, so your files are not in this copy. Connect again in LastGood to make the storage login."
    return
  fi
  if [[ "$ENCRYPT" == "true" ]]; then
    local suffix
    suffix="$(encrypted_suffix)"
    tar -C "$root" -cf "$WORKDIR/storage.tar" .
    encrypt_file "$WORKDIR/storage.tar" "$WORKDIR/storage.tar${suffix}"
    aws_s3 s3 cp "$WORKDIR/storage.tar${suffix}" "s3://${BUCKET}/${PREFIX}/storage/${STAMP}.tar${suffix}"
    record_copy "$WORKDIR/storage.tar${suffix}" "${PREFIX}/storage/${STAMP}.tar${suffix}"
    rm -f "$WORKDIR/storage.tar${suffix}"
  else
    local dest
    for dest in "$root"/*/; do
      [[ -d "$dest" ]] || continue
      aws_s3 s3 sync "$dest" "s3://${BUCKET}/${PREFIX}/storage/$(basename "$dest")"
    done
  fi
  rm -rf "$root" "$WORKDIR/storage.tar"
}

# Supabase Auth users ride in the dump as auth.users and auth.identities. Count the accounts, the ones with a
# password hash and the sign-in identities, so the run can say the users came across. Counts only: no email,
# id or hash is printed. Runs after the database, storage and code copies are up, so a problem here never
# costs the night's copies; the run still fails and says why.
count_auth_users() {
  local dump="$1" counts reason
  "$PG_RESTORE" --list "$dump" >"$WORKDIR/backup.toc" || fail "pg_restore could not list the dump it just made."
  if ! counts="$(LIFEBOAT_PG_RESTORE="$PG_RESTORE" node "$ROOT/scripts/restore-list.mjs" auth-count "$WORKDIR/backup.toc" "$dump" 2>"$WORKDIR/auth.err")"; then
    reason="$(tail -n 1 "$WORKDIR/auth.err")"
    rm -f "$WORKDIR/backup.toc" "$WORKDIR/auth.err"
    fail "${reason:-The users check failed.} ${PART_ERRORS:-Everything else this run copies was uploaded first.}"
  fi
  rm -f "$WORKDIR/backup.toc" "$WORKDIR/auth.err"
  if [[ "$counts" == none ]]; then
    echo "Users: this database has no Supabase Auth users."
    return
  fi
  read -r AUTH_USERS AUTH_PASSWORDS AUTH_IDENTITIES <<<"$counts"
  echo "Users: ${AUTH_USERS} accounts, ${AUTH_PASSWORDS} with a password, ${AUTH_IDENTITIES} sign-in identities."
}

# The code and its GitHub history, in backup only. Every branch and tag goes into a git bundle, and issues
# and pull requests with their comments into JSON, in one archive encrypted like the dump, under repo/.
# The workflow's own token reads them, and the workflow file limits it to read.
copy_code() {
  local repository="${GITHUB_REPOSITORY:-}"
  if [[ -z "$repository" ]]; then
    echo "Code copy skipped. It runs in GitHub Actions, which names the repository."
    return
  fi
  [[ "$repository" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || fail "GITHUB_REPOSITORY is not owner/repo."
  [[ -n "${GITHUB_TOKEN:-}" ]] || fail "Set github-token, so the workflow can read this repository's code, issues and pull requests."
  command -v git >/dev/null || fail "git is not installed on this runner."
  local server dir basic
  server="$(value_or "${GITHUB_SERVER_URL:-}" "https://github.com")"
  dir="$WORKDIR/code"
  rm -rf "$dir"
  mkdir -p "$dir/github"
  # The token goes in a header set from the environment, never in the URL or on the command line.
  basic="$(printf 'x-access-token:%s' "$GITHUB_TOKEN" | base64 | tr -d '\n')"
  mask "$basic"
  # A bare clone holds every branch and every tag, including tags on branches that were deleted.
  if ! GIT_TERMINAL_PROMPT=0 GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=http.extraHeader GIT_CONFIG_VALUE_0="AUTHORIZATION: basic ${basic}" \
    git clone --bare --quiet "${server}/${repository}.git" "$dir/repo.git"; then
    fail "git could not read ${repository} with the workflow's token. The workflow needs contents: read under permissions."
  fi
  CODE_BRANCHES="$(git -C "$dir/repo.git" for-each-ref --format='%(refname)' refs/heads | wc -l | tr -d ' ')"
  CODE_TAGS="$(git -C "$dir/repo.git" for-each-ref --format='%(refname)' refs/tags | wc -l | tr -d ' ')"
  if (( CODE_BRANCHES + CODE_TAGS > 0 )); then
    git -C "$dir/repo.git" bundle create --quiet "$dir/code.bundle" --all || fail "git could not bundle ${repository}. Nothing was uploaded for the code."
    git -C "$dir/repo.git" bundle verify --quiet "$dir/code.bundle" >/dev/null || fail "The code bundle did not verify. Nothing was uploaded for the code."
  else
    echo "${repository} has no commits yet, so this copy holds no code."
  fi
  rm -rf "$dir/repo.git"
  local counts
  if ! counts="$(node "$ROOT/scripts/github-metadata.mjs" "$dir/github" 2>"$WORKDIR/metadata.err")"; then
    local reason
    reason="$(tail -n 1 "$WORKDIR/metadata.err")"
    rm -f "$WORKDIR/metadata.err"
    fail "${reason:-The GitHub metadata copy failed.} Nothing was uploaded for the code."
  fi
  cat "$WORKDIR/metadata.err"
  rm -f "$WORKDIR/metadata.err"
  read -r GITHUB_ISSUES GITHUB_PULLS GITHUB_COMMENTS <<<"$counts"
  tar -C "$dir" -czf "$WORKDIR/code.tar.gz" .
  CODE_BYTES="$(wc -c <"$WORKDIR/code.tar.gz" | tr -d ' ')"
  local suffix
  suffix="$(encrypted_suffix)"
  if [[ -n "$suffix" ]]; then
    encrypt_file "$WORKDIR/code.tar.gz" "$WORKDIR/code.tar.gz${suffix}"
  fi
  aws_s3 s3 cp "$WORKDIR/code.tar.gz${suffix}" "s3://${BUCKET}/${PREFIX}/repo/${STAMP}.tar.gz${suffix}"
  record_copy "$WORKDIR/code.tar.gz${suffix}" "${PREFIX}/repo/${STAMP}.tar.gz${suffix}"
  rm -rf "$dir" "$WORKDIR/code.tar.gz" "$WORKDIR/code.tar.gz${suffix}"
  echo "Code: ${CODE_BRANCHES} branches, ${CODE_TAGS} tags. GitHub: ${GITHUB_ISSUES} issues, ${GITHUB_PULLS} pull requests, ${GITHUB_COMMENTS} comments."
}

# The project ref from the Session pooler username, role.<project-ref>, unless supabase-project-ref names it.
supabase_project_ref() {
  if [[ -n "${SUPABASE_PROJECT_REF:-}" ]]; then
    printf '%s' "$SUPABASE_PROJECT_REF"
    return
  fi
  local user
  user="$(postgres_user "${DATABASE_URL:-}")"
  if [[ "$user" =~ \.([a-z]{20})$ ]]; then
    printf '%s' "${BASH_REMATCH[1]}"
  fi
}

# A Supabase setup or Vercel copy that cannot run does not stop the night: the users check still runs and reports,
# then the run fails before retention, which deletes by age and would otherwise remove older copies of that part
# while tonight's is missing.
part_failed() {
  PART_ERRORS="${PART_ERRORS:+$PART_ERRORS }$1"
  echo "$1 The users check still runs; then this run fails." >&2
}

copy_supabase_setup() {
  if [[ -z "${LIFEBOAT_SUPABASE_TOKEN:-}" ]]; then
    echo "Supabase setup copy skipped: LIFEBOAT_SUPABASE_TOKEN is not set, so Edge Functions and Supabase settings are not in this copy."
    return
  fi
  # The auth settings can hold provider secrets and SMTP details, so they never go up unencrypted.
  if [[ "$ENCRYPT" != "true" ]]; then
    echo "::warning::Supabase setup copy skipped: encryption is off, and the auth settings can hold provider secrets. Turn encrypt on to copy Edge Functions and Supabase settings."
    return
  fi
  local ref
  ref="$(supabase_project_ref)"
  if [[ ! "$ref" =~ ^[a-z]{20}$ ]]; then
    part_failed "Set supabase-project-ref to the project's 20-letter ref, so the workflow knows whose Edge Functions and settings to copy."
    return
  fi
  local dir="$WORKDIR/setup"
  rm -rf "$dir"
  mkdir -p "$dir"
  local counts
  if ! counts="$(SUPABASE_PROJECT_REF="$ref" node "$ROOT/scripts/supabase-setup.mjs" "$dir" 2>"$WORKDIR/setup.err")"; then
    local reason
    reason="$(tail -n 1 "$WORKDIR/setup.err")"
    rm -rf "$dir" "$WORKDIR/setup.err"
    part_failed "${reason:-The Supabase setup copy failed.} Nothing was uploaded for the Supabase setup."
    return
  fi
  cat "$WORKDIR/setup.err"
  rm -f "$WORKDIR/setup.err"
  local webhooks vault
  read -r SETUP_FUNCTIONS SETUP_CRON_JOBS webhooks vault <<<"$counts"
  tar -C "$dir" -czf "$WORKDIR/setup.tar.gz" .
  SETUP_BYTES="$(wc -c <"$WORKDIR/setup.tar.gz" | tr -d ' ')"
  local suffix
  suffix="$(encrypted_suffix)"
  encrypt_file "$WORKDIR/setup.tar.gz" "$WORKDIR/setup.tar.gz${suffix}"
  aws_s3 s3 cp "$WORKDIR/setup.tar.gz${suffix}" "s3://${BUCKET}/${PREFIX}/setup/${STAMP}.tar.gz${suffix}"
  record_copy "$WORKDIR/setup.tar.gz${suffix}" "${PREFIX}/setup/${STAMP}.tar.gz${suffix}"
  rm -rf "$dir" "$WORKDIR/setup.tar.gz" "$WORKDIR/setup.tar.gz${suffix}"
  echo "Supabase setup: ${SETUP_FUNCTIONS} Edge Functions, auth and storage settings, ${SETUP_CRON_JOBS} cron jobs, ${webhooks} database webhooks, ${vault} Vault secret names."
}

# The Vercel project's environment variables, with the customer's own token: every name, and every value Vercel
# returns. The values are secrets, so they are encrypted before they leave the runner, and never go up in the clear.
# The Vercel copy: the project's environment variables (B9), then its settings, domains and DNS records (B8), all read
# with the customer's own token and packed into one archive encrypted to the app's key. LastGood never holds the token.
copy_vercel_env() {
  if [[ -z "${LIFEBOAT_VERCEL_TOKEN:-}" ]]; then
    VERCEL_SOURCE="none"
    echo "Vercel copy skipped: LIFEBOAT_VERCEL_TOKEN is not set, so this backup has no copy of the Vercel project's settings, domains, DNS records or environment variables."
    return
  fi
  if [[ "$ENCRYPT" != "true" ]]; then
    echo "::warning::Vercel copy skipped: encryption is off, and the environment variable values are secrets. Turn encrypt on to copy the Vercel project."
    return
  fi
  VERCEL_SOURCE="token"
  local dir="$WORKDIR/vercel"
  rm -rf "$dir"
  mkdir -m 700 -p "$dir"
  local counts
  if ! counts="$(node "$ROOT/scripts/vercel-env.mjs" "$dir/env.json" 2>"$WORKDIR/vercel.err")"; then
    local reason
    reason="$(tail -n 1 "$WORKDIR/vercel.err")"
    rm -rf "$dir" "$WORKDIR/vercel.err"
    part_failed "${reason:-The Vercel environment variable copy failed.} Nothing was uploaded for Vercel."
    return
  fi
  rm -f "$WORKDIR/vercel.err"
  local without
  read -r VERCEL_ENV_VARS VERCEL_ENV_VALUES without <<<"$counts"
  # The settings are their own part: if they fail, the environment variables still go up and the run then fails.
  local settings settings_failed=""
  if settings="$(node "$ROOT/scripts/vercel-settings.mjs" "$dir/settings.json" 2>"$WORKDIR/vercel.err")"; then
    read -r VERCEL_DOMAINS VERCEL_DNS_RECORDS VERCEL_DNS_UNREADABLE <<<"$settings"
  else
    settings_failed="$(tail -n 1 "$WORKDIR/vercel.err")"
    rm -f "$dir/settings.json"
  fi
  rm -f "$WORKDIR/vercel.err"
  tar -C "$dir" -czf "$WORKDIR/vercel.tar.gz" .
  local suffix
  suffix="$(encrypted_suffix)"
  encrypt_file "$WORKDIR/vercel.tar.gz" "$WORKDIR/vercel.tar.gz${suffix}"
  # The readable copy is gone before the upload starts.
  rm -rf "$dir" "$WORKDIR/vercel.tar.gz"
  aws_s3 s3 cp "$WORKDIR/vercel.tar.gz${suffix}" "s3://${BUCKET}/${PREFIX}/vercel/${STAMP}.tar.gz${suffix}"
  record_copy "$WORKDIR/vercel.tar.gz${suffix}" "${PREFIX}/vercel/${STAMP}.tar.gz${suffix}"
  rm -f "$WORKDIR/vercel.tar.gz${suffix}"
  echo "Vercel: ${VERCEL_ENV_VARS} environment variables, ${VERCEL_ENV_VALUES} with their values."
  if (( without > 0 )); then
    echo "::warning::${without} Vercel environment variables are copied by name only. Vercel never returns values it marks sensitive, so keep those values yourself: LastGood cannot restore them."
  fi
  if [[ -n "$VERCEL_DOMAINS" ]]; then
    echo "Vercel settings: the project, ${VERCEL_DOMAINS} domains, ${VERCEL_DNS_RECORDS} DNS records."
    if (( VERCEL_DNS_UNREADABLE > 0 )); then
      echo "::warning::This token cannot read the DNS records of ${VERCEL_DNS_UNREADABLE} of the project's domains, most likely because their DNS is kept outside Vercel. Keep a copy of those records yourself: LastGood cannot restore them."
    fi
  else
    part_failed "${settings_failed:-The Vercel settings copy failed.} The environment variables still went up."
  fi
}

# Opens a downloaded code copy the way the database copy is opened: age, the older passphrase, or plain only when this app does not encrypt.
open_code_copy() {
  local key="$1"
  local source="$2"
  local dest="$3"
  if [[ "$key" == *.age ]]; then
    decrypt_age_file "$source" "$dest"
    rm -f "$source"
  elif [[ "$key" == *.enc ]]; then
    decrypt_file "$source" "$dest"
    rm -f "$source"
  elif [[ "$ENCRYPT" == "true" ]]; then
    rm -f "$source"
    fail "The newest code copy, ${key##*/}, is not encrypted, but this app encrypts every copy, so this workflow did not make it. It was not restored."
  else
    mv "$source" "$dest"
  fi
}

# Why an archive must not be opened, from its two listings: $1 from tar -tv and $2 from tar -t. Prints "links" when it
# holds anything but plain files and folders (a link could point outside the folder it is opened into), "outside" when
# it names an absolute path or one with a ".." part, and nothing when it is fine. tar refuses such names by default,
# but the check does not lean on that. The rebuild refuses the same archives (cli/lib/rebuild.mjs checkArchive).
archive_problem() {
  if [[ "$(cut -c1 <<<"$1" | sort -u | tr -d '\n')" =~ [^d-] ]]; then
    echo links
  elif grep -qE '^/|(^|/)\.\.(/|$)' <<<"$2"; then
    echo outside
  fi
}

# Fails the run, naming the copy, when an archive must not be opened. Usage: refuse_archive <what> <name> <problem>.
refuse_archive() {
  case "$3" in
    links) fail "The $1 ${2} holds something other than plain files and folders, such as a link, which this workflow never writes. It was not restored." ;;
    outside) fail "The $1 ${2} names a path outside its own folder, which this workflow never writes. It was not restored." ;;
  esac
}

# The newest code copy loads too: every branch and tag clones back out of the bundle, git fsck checks every object,
# a file on the default branch reads back, and the GitHub metadata parses.
restore_code() {
  local key status=0
  key="$(latest_key repo .tar.gz .tar.gz.enc .tar.gz.age)" || status=$?
  if (( status == 3 )); then
    echo "No code copy under ${PREFIX}/repo/ yet, so this test restore loaded the database only."
    return
  fi
  (( status == 0 )) || fail "The code copies under ${PREFIX}/repo/ could not be listed."
  command -v git >/dev/null || fail "git is not installed on this runner."
  local name="${key##*/}"
  local dir="$WORKDIR/code-restore"
  rm -rf "$dir"
  mkdir -p "$dir"
  aws_s3 s3 cp "s3://${BUCKET}/${key}" "$WORKDIR/code.download"
  open_code_copy "$key" "$WORKDIR/code.download" "$WORKDIR/code-restore.tar.gz"
  local listing names problem
  if ! listing="$(tar -tvzf "$WORKDIR/code-restore.tar.gz" 2>/dev/null)" || ! names="$(tar -tzf "$WORKDIR/code-restore.tar.gz" 2>/dev/null)"; then
    rm -rf "$dir" "$WORKDIR/code-restore.tar.gz"
    fail "The code copy ${name} is not a readable archive. It was not restored."
  fi
  problem="$(archive_problem "$listing" "$names")"
  if [[ -n "$problem" ]]; then
    rm -rf "$dir" "$WORKDIR/code-restore.tar.gz"
    refuse_archive "code copy" "$name" "$problem"
  fi
  if ! tar -xzf "$WORKDIR/code-restore.tar.gz" -C "$dir" --no-same-owner 2>/dev/null; then
    rm -rf "$dir" "$WORKDIR/code-restore.tar.gz"
    fail "The code copy ${name} is not a readable archive. It was not restored."
  fi
  rm -f "$WORKDIR/code-restore.tar.gz"
  local counts
  if ! counts="$(node "$ROOT/scripts/github-metadata.mjs" --count "$dir/github" 2>"$WORKDIR/metadata.err")"; then
    local reason
    reason="$(tail -n 1 "$WORKDIR/metadata.err")"
    rm -rf "$dir" "$WORKDIR/metadata.err"
    fail "${reason:-The GitHub metadata in the code copy did not read back.} (${name})"
  fi
  rm -f "$WORKDIR/metadata.err"
  read -r GITHUB_ISSUES GITHUB_PULLS GITHUB_COMMENTS <<<"$counts"
  if [[ ! -f "$dir/code.bundle" ]]; then
    CODE_BRANCHES=0
    CODE_TAGS=0
    rm -rf "$dir"
    echo "Code: ${name} holds no commits, because the repository had none when it was copied. GitHub: ${GITHUB_ISSUES} issues, ${GITHUB_PULLS} pull requests, ${GITHUB_COMMENTS} comments read back."
    return
  fi
  if ! git bundle verify --quiet "$dir/code.bundle" >/dev/null 2>&1 || ! git clone --quiet --mirror "$dir/code.bundle" "$dir/restored.git" 2>/dev/null; then
    rm -rf "$dir"
    fail "The code bundle in ${name} did not clone. The code copy did not restore."
  fi
  if ! git -C "$dir/restored.git" fsck --full --no-progress >/dev/null 2>&1; then
    rm -rf "$dir"
    fail "git fsck found damaged objects in the code copy ${name}. The code copy did not restore."
  fi
  CODE_BRANCHES="$(git -C "$dir/restored.git" for-each-ref --format='%(refname)' refs/heads | wc -l | tr -d ' ')"
  CODE_TAGS="$(git -C "$dir/restored.git" for-each-ref --format='%(refname)' refs/tags | wc -l | tr -d ' ')"
  local sample=""
  if git -C "$dir/restored.git" rev-parse --verify --quiet HEAD >/dev/null; then
    # sed reads to the end, so git never sees a closed pipe.
    sample="$(git -C "$dir/restored.git" ls-tree -r --name-only HEAD | sed -n '1p')"
  fi
  if [[ -n "$sample" ]] && ! git -C "$dir/restored.git" cat-file -p "HEAD:${sample}" >/dev/null 2>&1; then
    rm -rf "$dir"
    fail "A file on the default branch did not read back from the code copy ${name}. The code copy did not restore."
  fi
  rm -rf "$dir"
  echo "Code: ${CODE_BRANCHES} branches and ${CODE_TAGS} tags cloned back out of ${name}, and git fsck found no damage. GitHub: ${GITHUB_ISSUES} issues, ${GITHUB_PULLS} pull requests, ${GITHUB_COMMENTS} comments read back."
}

# The newest Edge Functions and Supabase settings copy reads back too: the function list, every function's source at
# the size it was saved, and every settings file. The setup is only ever copied encrypted, so a plain copy is refused.
restore_setup() {
  local key status=0
  key="$(latest_key setup .tar.gz .tar.gz.enc .tar.gz.age)" || status=$?
  if (( status == 3 )); then
    echo "No Supabase setup copy under ${PREFIX}/setup/ yet, so this test restore did not check Edge Functions or settings."
    return
  fi
  (( status == 0 )) || fail "The Supabase setup copies under ${PREFIX}/setup/ could not be listed."
  local name="${key##*/}"
  local dir="$WORKDIR/setup-restore"
  rm -rf "$dir"
  mkdir -p "$dir"
  aws_s3 s3 cp "s3://${BUCKET}/${key}" "$WORKDIR/setup.download"
  if [[ "$key" == *.age ]]; then
    decrypt_age_file "$WORKDIR/setup.download" "$WORKDIR/setup-restore.tar.gz"
  elif [[ "$key" == *.enc ]]; then
    decrypt_file "$WORKDIR/setup.download" "$WORKDIR/setup-restore.tar.gz"
  else
    rm -rf "$dir" "$WORKDIR/setup.download"
    fail "The newest Supabase setup copy, ${name}, is not encrypted, but this workflow only ever copies the setup encrypted, so it did not make it. It was not restored."
  fi
  rm -f "$WORKDIR/setup.download"
  # Only plain files and folders, all inside the folder, come out: a link could point outside it, and the check would follow it.
  local listing names problem
  if ! listing="$(tar -tvzf "$WORKDIR/setup-restore.tar.gz" 2>/dev/null)" || ! names="$(tar -tzf "$WORKDIR/setup-restore.tar.gz" 2>/dev/null)"; then
    rm -rf "$dir" "$WORKDIR/setup-restore.tar.gz"
    fail "The Supabase setup copy ${name} is not a readable archive. It was not restored."
  fi
  problem="$(archive_problem "$listing" "$names")"
  if [[ -n "$problem" ]]; then
    rm -rf "$dir" "$WORKDIR/setup-restore.tar.gz"
    refuse_archive "Supabase setup copy" "$name" "$problem"
  fi
  if ! tar -xzf "$WORKDIR/setup-restore.tar.gz" -C "$dir" --no-same-owner 2>/dev/null; then
    rm -rf "$dir" "$WORKDIR/setup-restore.tar.gz"
    fail "The Supabase setup copy ${name} is not a readable archive. It was not restored."
  fi
  rm -f "$WORKDIR/setup-restore.tar.gz"
  local counts
  if ! counts="$(node "$ROOT/scripts/supabase-setup.mjs" --check "$dir" 2>"$WORKDIR/setup-check.err")"; then
    local reason
    reason="$(tail -n 1 "$WORKDIR/setup-check.err")"
    rm -rf "$dir" "$WORKDIR/setup-check.err"
    fail "${reason:-The Supabase setup copy did not read back.} (${name})"
  fi
  rm -rf "$dir" "$WORKDIR/setup-check.err"
  local webhooks vault
  read -r SETUP_FUNCTIONS SETUP_CRON_JOBS webhooks vault <<<"$counts"
  echo "Supabase setup: ${SETUP_FUNCTIONS} Edge Functions, auth and storage settings, ${SETUP_CRON_JOBS} cron jobs, ${webhooks} database webhooks and ${vault} Vault secret names read back out of ${name}, every function file at the size it was saved."
}

# The newest files copy opens too (B5): it decrypts, every entry lists, and one file comes back out at the size it was
# saved. Encrypted runs put the files in one archive; unencrypted runs sync them file by file, so there is nothing to
# open. Like the setup check, only plain files and folders come out, and a plain archive beside encrypted ones is refused.
restore_storage() {
  if [[ "$ENCRYPT" != "true" ]]; then
    echo "Files: this app copies its files one by one without encryption, so this test restore did not open a files copy."
    return
  fi
  local key status=0
  key="$(latest_key storage .tar .tar.enc .tar.age)" || status=$?
  if (( status == 3 )); then
    echo "No files copy under ${PREFIX}/storage/ yet, so this test restore did not check the files."
    return
  fi
  (( status == 0 )) || fail "The files copies under ${PREFIX}/storage/ could not be listed."
  local name="${key##*/}"
  local archive="$WORKDIR/storage-restore.tar"
  local dir="$WORKDIR/storage-restore"
  rm -rf "$dir" "$archive"
  aws_s3 s3 cp "s3://${BUCKET}/${key}" "$WORKDIR/storage.download"
  if [[ "$key" == *.age ]]; then
    decrypt_age_file "$WORKDIR/storage.download" "$archive"
  elif [[ "$key" == *.enc ]]; then
    decrypt_file "$WORKDIR/storage.download" "$archive"
  else
    rm -f "$WORKDIR/storage.download"
    fail "The newest files copy, ${name}, is not encrypted, but this app encrypts every copy, so this workflow did not make it. It was not restored."
  fi
  rm -f "$WORKDIR/storage.download"
  local listing names problem
  if ! listing="$(tar -tvf "$archive" 2>/dev/null)" || ! names="$(tar -tf "$archive" 2>/dev/null)"; then
    rm -f "$archive"
    fail "The files copy ${name} is not a readable archive. It was not restored."
  fi
  problem="$(archive_problem "$listing" "$names")"
  if [[ -n "$problem" ]]; then
    rm -f "$archive"
    refuse_archive "files copy" "$name" "$problem"
  fi
  local files buckets sample="" plain="" listed=""
  files="$(grep -c '^-' <<<"$listing" || true)"
  buckets="$(grep -cE '^\./[^/]+/$' <<<"$names" || true)"
  if (( files > 0 )); then
    # The first file with a plain name that holds any bytes, with its size, from the two lists already read: they
    # have one line per entry, in the same order, so no file costs another pass over the archive. tar's list escapes
    # a backslash or a character it cannot print, so such a name would not match the stored one. An empty file proves
    # nothing read back, and the Supabase dashboard leaves an empty .emptyFolderPlaceholder in every folder made
    # there, which sorts first in it (D17). "empty" when every plain-named file is empty.
    plain="$(paste -d ' ' <(awk '{print substr($1, 1, 1), $3}' <<<"$listing") <(printf '%s\n' "$names") | LC_ALL=C awk '
      {
        type = $1
        size = $2
        entry = $0
        sub(/^[^ ]* [^ ]* /, "", entry)
        if (type != "-" || entry ~ /\/$/ || entry !~ /^[[:print:]]+$/ || index(entry, "\\") > 0) next
        if (size ~ /^[0-9]+$/ && size > 0) { print size " " entry; found = 1; exit }
        empty = 1
      }
      END { if (!found && empty) print "empty" }
    ' || true)"
    if [[ -n "$plain" && "$plain" != "empty" ]]; then
      listed="${plain%% *}"
      sample="${plain#* }"
    fi
  fi
  if [[ -n "$sample" ]]; then
    local got
    mkdir -p "$dir"
    if ! tar -xf "$archive" -C "$dir" --no-same-owner -- "$sample" 2>/dev/null || [[ ! -f "$dir/$sample" ]]; then
      rm -rf "$dir" "$archive"
      fail "A file did not come back out of the files copy ${name}. It was not restored."
    fi
    got="$(wc -c <"$dir/$sample" | tr -d ' ')"
    if [[ "$got" != "$listed" ]]; then
      rm -rf "$dir" "$archive"
      fail "A file in the files copy ${name} did not read back at the size it was saved. It was not restored."
    fi
  fi
  rm -rf "$dir" "$archive"
  STORAGE_OBJECTS="$files"
  local listed_count
  listed_count="$(counted "$files" file) in $(counted "$buckets" bucket)"
  if [[ -n "$sample" ]]; then
    echo "Files: ${listed_count} listed out of ${name}, and a sample file of $(counted "$listed" byte) read back at the size it was saved."
  elif [[ "$plain" == "empty" ]]; then
    echo "Files: ${listed_count} listed out of ${name}. Every file with a plain name is empty, so none was read back as a sample."
  elif (( files > 0 )); then
    echo "Files: ${listed_count} listed out of ${name}. No file has a plain enough name to read back as a sample."
  else
    echo "Files: ${name} opened and lists no files."
  fi
}

# PostGIS is not a Supabase-only extension, so the list filter must not skip it.
# A dump that needs it is restored into a database that offers it, or the test stops here and names PostGIS.
# LIFEBOAT_RESTORE_CONTAINER names a throwaway container on this runner that Lifeboat may replace.
start_postgis_target() {
  local container="$1" image="$2" port="$3" url="$4"
  command -v docker >/dev/null || return 1
  docker rm -f "$container" >/dev/null 2>&1 || true
  # An empty init directory stops the image installing PostGIS into public. The dump installs it in the source's schema.
  docker run -d --name "$container" \
    -e POSTGRES_PASSWORD=throwaway \
    -e POSTGRES_DB=restore \
    -p "${port}:5432" \
    --tmpfs /docker-entrypoint-initdb.d \
    "$image" >/dev/null || return 1
  local i
  local tries="${LIFEBOAT_RESTORE_WAIT_TRIES:-60}"
  local pause="${LIFEBOAT_RESTORE_WAIT_SECONDS:-5}"
  # Over TCP, not docker exec: the image's first, socket-only server is not the one that stays up.
  for ((i = 0; i < tries; i++)); do
    if "$PSQL" "$url" --no-psqlrc --tuples-only --no-align --command "SELECT 1" >/dev/null 2>&1; then
      return 0
    fi
    sleep "$pause"
  done
  return 1
}

postgis_plan() {
  "$PSQL" "$RESTORE_DATABASE_URL" --no-psqlrc --tuples-only --no-align --command "SELECT name FROM pg_available_extensions" >"$WORKDIR/extensions.txt"
  node "$ROOT/scripts/restore-list.mjs" postgis-plan "$WORKDIR/restore.toc" "$WORKDIR/restore.schema.sql" "$WORKDIR/extensions.txt" "$WORKDIR/postgis.plan" "${1:-}"
  mapfile -t POSTGIS_PLAN <"$WORKDIR/postgis.plan"
}

ensure_postgis() {
  "$PG_RESTORE" --schema-only --no-owner --no-acl --file "$WORKDIR/restore.schema.sql" "$WORKDIR/restore.backup" ||
    fail "pg_restore could not read the schema in the dump."
  postgis_plan
  case "${POSTGIS_PLAN[0]:-}" in
    none) ;;
    ok) echo "${POSTGIS_PLAN[1]}" ;;
    switch)
      local container="${POSTGIS_PLAN[2]}" image="${POSTGIS_PLAN[3]}" port="${POSTGIS_PLAN[4]}" url="${POSTGIS_PLAN[5]}"
      echo "${POSTGIS_PLAN[1]}"
      if ! start_postgis_target "$container" "$image" "$port" "$url"; then
        fail "The dump uses PostGIS, and the PostGIS image ${image} did not start in container ${container}. The restore test stopped before restoring."
      fi
      export RESTORE_DATABASE_URL="$url"
      mask "$RESTORE_DATABASE_URL"
      postgis_plan switched
      [[ "${POSTGIS_PLAN[0]:-}" == "ok" ]] || fail "${POSTGIS_PLAN[1]:-The PostGIS image ${image} did not offer PostGIS. The restore test stopped before restoring.}"
      echo "${POSTGIS_PLAN[1]}"
      ;;
    *) fail "${POSTGIS_PLAN[1]:-The PostGIS check failed. The restore test stopped before restoring.}" ;;
  esac
  rm -f "$WORKDIR/restore.schema.sql" "$WORKDIR/postgis.plan"
}

if [[ "$MODE" == "backup" ]]; then
  [[ -n "${DATABASE_URL:-}" ]] || fail "Set DATABASE_URL. Use the Supabase Session pooler on port 5432 (aws-*.pooler.supabase.com), not the direct db.*.supabase.co host and not the transaction pooler on port 6543."
  [[ -x "$PG_DUMP" ]] || command -v "$PG_DUMP" >/dev/null || fail "pg_dump is not installed. The workflow should install postgresql-client."
  # Check the keys before reading anything, so a bad key never costs a dump.
  if [[ "$ENCRYPT" == "true" ]]; then
    resolve_recipient
  fi
  assert_client_can_read "$DATABASE_URL"
  # Read-only. pg_dump does not write to the source database.
  "$PG_DUMP" "$DATABASE_URL" --format=custom --no-owner --no-acl --file "$WORKDIR/dump.backup"
  DUMP_BYTES="$(wc -c <"$WORKDIR/dump.backup" | tr -d ' ')"
  if [[ "$ENCRYPT" == "true" ]]; then
    suffix="$(encrypted_suffix)"
    encrypt_file "$WORKDIR/dump.backup" "$WORKDIR/dump.backup${suffix}"
    aws_s3 s3 cp "$WORKDIR/dump.backup${suffix}" "s3://${BUCKET}/${PREFIX}/db/${STAMP}.backup${suffix}"
    record_copy "$WORKDIR/dump.backup${suffix}" "${PREFIX}/db/${STAMP}.backup${suffix}"
  else
    aws_s3 s3 cp "$WORKDIR/dump.backup" "s3://${BUCKET}/${PREFIX}/db/${STAMP}.backup"
    record_copy "$WORKDIR/dump.backup" "${PREFIX}/db/${STAMP}.backup"
  fi
  copy_storage
  copy_code
  copy_supabase_setup
  copy_vercel_env
  count_auth_users "$WORKDIR/dump.backup"
  [[ -z "$PART_ERRORS" ]] || fail "$PART_ERRORS"
  make_monthly_copies
  apply_retention
elif [[ "$MODE" == "restore-test" ]]; then
  [[ -n "${RESTORE_DATABASE_URL:-}" ]] || fail "Set RESTORE_DATABASE_URL to the throwaway Postgres in this runner."
  [[ -x "$PG_RESTORE" ]] || command -v "$PG_RESTORE" >/dev/null || fail "pg_restore is not installed."
  [[ -x "$PSQL" ]] || command -v "$PSQL" >/dev/null || fail "psql is not installed."
  key="$(latest_dump_key)" || fail "No .backup object was found under ${PREFIX}/db/."
  aws_s3 s3 cp "s3://${BUCKET}/${key}" "$WORKDIR/restore.download"
  if [[ "$key" == *.age ]]; then
    decrypt_age_file "$WORKDIR/restore.download" "$WORKDIR/restore.backup"
    rm -f "$WORKDIR/restore.download"
  elif [[ "$key" == *.enc ]]; then
    decrypt_file "$WORKDIR/restore.download" "$WORKDIR/restore.backup"
    rm -f "$WORKDIR/restore.download"
  elif [[ "$ENCRYPT" == "true" ]]; then
    # This workflow encrypts every copy, so a plain one was put there by someone else.
    rm -f "$WORKDIR/restore.download"
    fail "The newest copy, ${key##*/}, is not encrypted, but this app encrypts every copy, so this workflow did not make it. It was not restored."
  else
    mv "$WORKDIR/restore.download" "$WORKDIR/restore.backup"
  fi
  DUMP_BYTES="$(wc -c <"$WORKDIR/restore.backup" | tr -d ' ')"
  avail_kb="$(df -Pk "$WORKDIR" | awk 'NR==2 {print $4}')"
  echo "Restore disk free: ${avail_kb} KiB. Dump bytes: ${DUMP_BYTES}."
  if [[ "$avail_kb" =~ ^[0-9]+$ ]] && (( avail_kb * 1024 < DUMP_BYTES )); then
    fail "Not enough free disk to restore this dump."
  fi
  assert_client_can_read "$RESTORE_DATABASE_URL"
  "$PG_RESTORE" --list "$WORKDIR/restore.backup" >"$WORKDIR/restore.toc"
  ensure_postgis
  "$PSQL" "$RESTORE_DATABASE_URL" --no-psqlrc --tuples-only --no-align --command "SELECT nspname FROM pg_namespace" >"$WORKDIR/schemas.txt"
  "$PSQL" "$RESTORE_DATABASE_URL" --no-psqlrc --tuples-only --no-align --command "SELECT pubname FROM pg_publication" >"$WORKDIR/publications.txt"
  "$PSQL" "$RESTORE_DATABASE_URL" --no-psqlrc --tuples-only --no-align --command "SELECT evtname FROM pg_event_trigger" >"$WORKDIR/event_triggers.txt"
  node "$ROOT/scripts/restore-list.mjs" drop-sql "$WORKDIR/restore.toc" "$WORKDIR/schemas.txt" "$WORKDIR/drop.sql" "$WORKDIR/publications.txt" "$WORKDIR/event_triggers.txt"
  if [[ -s "$WORKDIR/drop.sql" ]]; then
    # One object that will not drop must not hide the rest. Leftovers are warnings.
    "$PSQL" "$RESTORE_DATABASE_URL" --no-psqlrc --set ON_ERROR_STOP=0 --file "$WORKDIR/drop.sql"
  fi
  "$PSQL" "$RESTORE_DATABASE_URL" --no-psqlrc --tuples-only --no-align --command "SELECT name FROM pg_available_extensions" >"$WORKDIR/extensions.txt"
  "$PSQL" "$RESTORE_DATABASE_URL" --no-psqlrc --tuples-only --no-align --command "SELECT nspname FROM pg_namespace" >"$WORKDIR/schemas.txt"
  "$PSQL" "$RESTORE_DATABASE_URL" --no-psqlrc --tuples-only --no-align --command "SELECT extname FROM pg_extension" >"$WORKDIR/installed.txt"
  "$PSQL" "$RESTORE_DATABASE_URL" --no-psqlrc --tuples-only --no-align --command "SELECT pubname FROM pg_publication" >"$WORKDIR/publications.txt"
  "$PSQL" "$RESTORE_DATABASE_URL" --no-psqlrc --tuples-only --no-align --command "SELECT evtname FROM pg_event_trigger" >"$WORKDIR/event_triggers.txt"
  node "$ROOT/scripts/restore-list.mjs" filter "$WORKDIR/restore.toc" "$WORKDIR/extensions.txt" "$WORKDIR/restore.list" "$WORKDIR/restore.skip.json" "$WORKDIR/schemas.txt" "$WORKDIR/installed.txt" "$WORKDIR/publications.txt" "$WORKDIR/event_triggers.txt"
  set +e
  "$PG_RESTORE" --dbname "$RESTORE_DATABASE_URL" --no-owner --no-acl -L "$WORKDIR/restore.list" "$WORKDIR/restore.backup" >"$WORKDIR/restore.out" 2>"$WORKDIR/restore.err"
  restore_status=$?
  set -e
  node "$ROOT/scripts/restore-list.mjs" classify "$WORKDIR/restore.err" "$WORKDIR/restore.skip.json" "$restore_status"
  LIFEBOAT_PSQL="$PSQL" LIFEBOAT_PG_RESTORE="$PG_RESTORE" \
    node "$ROOT/scripts/restore-list.mjs" sample "$WORKDIR/restore.toc" "$WORKDIR/restore.skip.json" "$WORKDIR/restore.backup"
  # The users must come back too: the same accounts, password hashes and sign-in identities as the dump.
  LIFEBOAT_PSQL="$PSQL" LIFEBOAT_PG_RESTORE="$PG_RESTORE" LIFEBOAT_AUTH_COUNTS_FILE="$WORKDIR/auth.counts" \
    node "$ROOT/scripts/restore-list.mjs" auth-verify "$WORKDIR/restore.toc" "$WORKDIR/restore.backup"
  if [[ -s "$WORKDIR/auth.counts" && "$(cat "$WORKDIR/auth.counts")" != none ]]; then
    read -r AUTH_USERS AUTH_PASSWORDS AUTH_IDENTITIES <"$WORKDIR/auth.counts"
  fi
  rm -f "$WORKDIR/auth.counts"
  # Tables left out with an extension this database does not offer, such as Vault's secrets on stock Postgres, and any
  # table the list loads that is not there afterwards, are counted in the dump, so a pass says what it did not check.
  # Extension names from the action's own list (or "other") and counts only.
  LIFEBOAT_PSQL="$PSQL" LIFEBOAT_PG_RESTORE="$PG_RESTORE" \
    node "$ROOT/scripts/restore-list.mjs" skipped-count "$WORKDIR/restore.toc" "$WORKDIR/restore.skip.json" "$WORKDIR/restore.backup" "$WORKDIR/skipped.counts" "$WORKDIR/restore.list"
  RESTORE_NOT_CHECKED="$(paste -sd ';' "$WORKDIR/skipped.counts")"
  rm -f "$WORKDIR/skipped.counts"
  rm -f "$WORKDIR/restore.backup"
  restore_code
  restore_setup
  restore_storage
  "$PSQL" "$RESTORE_DATABASE_URL" --set ON_ERROR_STOP=1 --command "SELECT current_database();"
else
  fail "LIFEBOAT_MODE must be backup or restore-test."
fi
