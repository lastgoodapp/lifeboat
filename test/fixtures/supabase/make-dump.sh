#!/bin/bash
# Remakes dump.backup from source.sql, the way the backup job dumps: pg_dump --format=custom --no-owner --no-acl.
# The stub extensions must be loadable while source.sql runs, so this copies them into the server's extension
# folder (usually needs root) and removes them again after the dump, so a test restore on the same machine sees
# stock Postgres. Usage: make-dump.sh POSTGRES_BIN_DIR, for example /usr/lib/postgresql/16/bin. Run it on a
# machine where initdb may start a throwaway server; it never touches an existing one.
set -euo pipefail
bin="${1:?usage: make-dump.sh POSTGRES_BIN_DIR}"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
extdir="$("$bin/pg_config" --sharedir)/extension"
work="$(mktemp -d)"
port=55491
installed=()
# initdb refuses root. As root, the throwaway server runs as the postgres user.
as_server=()
if [[ "$EUID" -eq 0 ]]; then
  as_server=(runuser -u postgres --)
  chown postgres "$work"
fi
cleanup() {
  "${as_server[@]}" "$bin/pg_ctl" -D "$work/data" -m immediate stop >/dev/null 2>&1 || true
  for file in "${installed[@]}"; do rm -f "$extdir/$file"; done
  rm -rf "$work"
}
trap cleanup EXIT
for file in "$here"/stubs/*; do
  name="$(basename "$file")"
  [[ -e "$extdir/$name" ]] && { echo "$extdir/$name already exists; not overwriting it." >&2; exit 1; }
  cp "$file" "$extdir/$name"
  installed+=("$name")
done
"${as_server[@]}" "$bin/initdb" -D "$work/data" -U postgres -A trust --no-sync >/dev/null
"${as_server[@]}" "$bin/pg_ctl" -D "$work/data" -o "-p $port -k $work -c listen_addresses=''" -l "$work/server.log" -w start >/dev/null
url="postgresql://postgres@/postgres?host=$work&port=$port"
"$bin/psql" "$url" --no-psqlrc -q -c "CREATE DATABASE app"
"$bin/psql" "postgresql://postgres@/app?host=$work&port=$port" --no-psqlrc -q -f "$here/source.sql" >"$work/source.log" 2>&1 ||
  { cat "$work/source.log" >&2; exit 1; }
"$bin/pg_dump" "postgresql://postgres@/app?host=$work&port=$port" --format=custom --no-owner --no-acl --file "$here/dump.backup"
echo "Wrote $here/dump.backup ($(wc -c <"$here/dump.backup" | tr -d ' ') bytes)."
