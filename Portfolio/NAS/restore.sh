#!/usr/bin/env bash
set -euo pipefail
umask 077

NAS_DIR="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
SCRIPT_DIR="$NAS_DIR"
PINNED_SHA="241bb11c0627f2981746d37033f57dbfa81d29b0"
OVERLAY="$NAS_DIR/compose.overlay.yml"

die() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

usage() {
  cat <<'HELP'
Usage:
  restore.sh --archive FILE.age|BUNDLE --env-file PATH [--identity-file PATH]
  restore.sh --archive FILE.age|BUNDLE --env-file PATH --identity-file PATH \
    --upstream PATH --staging-db NAME --staging-container NAME \
    --receipt-dir PATH --apply-staging

Default mode is verify-only. It decrypts the archive into a secure temporary
directory, requires the exact five-file payload and verifies every manifest
hash, then performs no database action. Applying is limited to an explicitly
named, empty staging database and container, and requires the exact
RESTORE_PORTFOLIO_TO_EMPTY_STAGING confirmation in PORTFOLIO_RESTORE_CONFIRM.
The env file, age identity, and durable receipt directory must be external.
Staged apply is currently hard-disabled. Before a future apply can be enabled,
the external env file must carry operator-pinned PORTFOLIO_ARCHIVE_SHA256 and
PORTFOLIO_CANONICAL_RELEASE_SHA256 values, and a separately verified fresh
target and platform bootstrap contract must exist. The archive manifest is not
producer identity and cannot authorise an apply by itself.
HELP
}

canonical_target() {
  local input="$1" parent base
  case "$input" in
    /*) ;;
    *) input="$PWD/$input" ;;
  esac
  [[ -L "$input" ]] && return 1
  parent="${input%/*}"
  base="${input##*/}"
  [[ -n "$parent" ]] || parent=/
  [[ -d "$parent" ]] || return 1
  parent="$(CDPATH= cd -P -- "$parent" && pwd -P)" || return 1
  printf '%s/%s\n' "$parent" "$base"
}

canonical_file() {
  local input="$1" resolved
  [[ -f "$input" && ! -L "$input" ]] || return 1
  resolved="$(canonical_target "$input")" || return 1
  [[ -f "$resolved" && ! -L "$resolved" ]] || return 1
  printf '%s\n' "$resolved"
}

canonical_dir() {
  local input="$1" resolved
  [[ -d "$input" && ! -L "$input" ]] || return 1
  resolved="$(CDPATH= cd -P -- "$input" && pwd -P)" || return 1
  [[ -d "$resolved" && ! -L "$resolved" ]] || return 1
  printf '%s\n' "$resolved"
}

canonical_temp_dir() {
  local input="$1" resolved
  [[ "$input" == /* && "$input" != *$'\n'* && "$input" != *$'\r'* ]] || return 1
  [[ -d "$input" && ! -L "$input" ]] || return 1
  resolved="$(CDPATH= cd -P -- "$input" && pwd -P)" || return 1
  [[ "$resolved" == /* && -d "$resolved" && ! -L "$resolved" ]] || return 1
  printf '%s\n' "$resolved"
}

resolve_checkout_root() {
  local candidate fallback git_meta gitdir worktree_path

  # Git is the source of truth. Refuse a non-absolute or non-canonical result
  # instead of silently trusting a path supplied by a broken Git wrapper.
  if command -v git >/dev/null 2>&1; then
    candidate="$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel 2>/dev/null || true)"
    if [[ -n "$candidate" ]]; then
      [[ "$candidate" == /* && "$candidate" != *$'\n'* && "$candidate" != *$'\r'* ]] || return 1
      candidate="$(canonical_dir "$candidate")" || return 1
      printf '%s\n' "$candidate"
      return 0
    fi
  fi

  # A worktree can still identify its checkout when Git is unavailable. The
  # fallback is deliberately tied to this app's fixed two-level layout and a
  # matching .git worktree file, so a copied script cannot widen the boundary.
  fallback="$(CDPATH= cd -P -- "$SCRIPT_DIR/../.." 2>/dev/null && pwd -P)" || return 1
  [[ "$fallback" == /* && -d "$fallback" && ! -L "$fallback" ]] || return 1
  [[ "$SCRIPT_DIR" == "$fallback/Portfolio/NAS" ]] || return 1
  git_meta="$fallback/.git"
  [[ ! -L "$git_meta" ]] || return 1
  if [[ -d "$git_meta" ]]; then
    [[ -f "$git_meta/HEAD" && ! -L "$git_meta/HEAD" ]] || return 1
    [[ -f "$git_meta/config" && ! -L "$git_meta/config" ]] || return 1
  elif [[ -f "$git_meta" ]]; then
    [[ "$(sed -n '1p' "$git_meta")" == gitdir:\ /* ]] || return 1
    [[ -z "$(sed -n '2p' "$git_meta")" ]] || return 1
    gitdir="$(sed -n '1s/^gitdir: //p' "$git_meta")"
    gitdir="$(canonical_dir "$gitdir")" || return 1
    [[ -f "$gitdir/HEAD" && ! -L "$gitdir/HEAD" ]] || return 1
    [[ -f "$gitdir/commondir" && ! -L "$gitdir/commondir" ]] || return 1
    [[ -f "$gitdir/gitdir" && ! -L "$gitdir/gitdir" ]] || return 1
    [[ "$(sed -n '1p' "$gitdir/gitdir")" == /* ]] || return 1
    [[ -z "$(sed -n '2p' "$gitdir/gitdir")" ]] || return 1
    worktree_path="$(sed -n '1p' "$gitdir/gitdir")"
    worktree_path="$(canonical_file "$worktree_path")" || return 1
    [[ "$worktree_path" == "$fallback/.git" ]] || return 1
  else
    return 1
  fi
  printf '%s\n' "$fallback"
}

CHECKOUT_ROOT="$(resolve_checkout_root)" || die "cannot establish the canonical checkout root"

inside_repo() {
  case "$1" in
    "$CHECKOUT_ROOT"|"$CHECKOUT_ROOT"/*) return 0 ;;
    *) return 1 ;;
  esac
}

mode_is_600() {
  local mode
  mode="$(stat -f '%Lp' "$1" 2>/dev/null || stat -c '%a' "$1" 2>/dev/null)" || return 1
  [[ "$mode" == "600" ]]
}

env_value() {
  local key="$1" line
  while IFS= read -r line || [[ -n "$line" ]]; do
    case "$line" in
      "$key="*)
        printf '%s' "${line#*=}"
        return 0
        ;;
    esac
  done < "$ENV_FILE"
  return 1
}

validate_env_keys() {
  local file="$1" line key existing
  local -a seen_keys
  # Bash 3.2 with nounset treats an empty array expansion as unset.
  seen_keys=('')
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ "$line" != *$'\r'* ]] || die "env file contains a carriage return"
    [[ "$line" =~ ^[[:space:]]*$ ]] && continue
    [[ "$line" =~ ^[[:space:]]*# ]] && continue
    [[ "$line" =~ ^([A-Z][A-Z0-9_]*)=(.*)$ ]] || die "env file contains an invalid assignment"
    key="${BASH_REMATCH[1]}"
    for existing in "${seen_keys[@]}"; do
      [[ "$existing" == "$key" ]] && die "env file contains duplicate key: $key"
    done
    seen_keys+=("$key")
  done < "$file"
}

non_placeholder() {
  [[ -n "$1" ]] || return 1
  case "$1" in
    *'<'*|*'>'*|*PLACEHOLDER*|*SET_OUTSIDE_REPO*|*PRIVATE_*) return 1 ;;
  esac
}

verify_upstream() {
  local upstream="$1" head base
  [[ -d "$upstream" && ! -L "$upstream" ]] || die "upstream path is not a real directory"
  upstream="$(CDPATH= cd -P -- "$upstream" && pwd -P)" || die "cannot resolve upstream path"
  inside_repo "$upstream" && die "upstream checkout must be outside this worktree"
  head="$(git -C "$upstream" rev-parse HEAD 2>/dev/null)" || die "upstream path is not a Git checkout"
  [[ "$head" == "$PINNED_SHA" ]] || die "upstream HEAD is not the pinned commit"
  base="$upstream/docker/docker-compose.yml"
  [[ -f "$base" && ! -L "$base" ]] || die "pinned upstream docker/docker-compose.yml is missing"
  printf '%s\n' "$upstream"
}

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

# This is a deterministic content fingerprint for the exact checked-in
# release inputs that a future restore would trust. It is intentionally
# separate from the archive manifest, whose entries are payload integrity
# checks and are not producer identity. The operator must pin the resulting
# value in the external env file, this script never treats the value as proof
# that Supabase platform ownership or ACLs have been reconstructed.
canonical_release_hash() {
  local manifest="$TMP_DIR/canonical-release.manifest" file hash
  local -a release_files release_labels
  release_files=(
    "$NAS_DIR/backup.sh"
    "$NAS_DIR/restore.sh"
    "$NAS_DIR/runbook.sh"
    "$NAS_DIR/compose.overlay.yml"
    "$NAS_DIR/Caddyfile"
    "$NAS_DIR/catalogue-security.sql"
    "$NAS_DIR/restore-security.sql"
    "$CHECKOUT_ROOT/Portfolio/Supabase/schema.sql"
  )
  release_labels=(
    Portfolio/NAS/backup.sh
    Portfolio/NAS/restore.sh
    Portfolio/NAS/runbook.sh
    Portfolio/NAS/compose.overlay.yml
    Portfolio/NAS/Caddyfile
    Portfolio/NAS/catalogue-security.sql
    Portfolio/NAS/restore-security.sql
    Portfolio/Supabase/schema.sql
  )
  : > "$manifest" || return 1
  for ((i = 0; i < ${#release_files[@]}; i += 1)); do
    file="${release_files[$i]}"
    [[ -f "$file" && ! -L "$file" ]] || return 1
    hash="$(sha256_file "$file")" || return 1
    [[ "$hash" =~ ^[0-9a-fA-F]{64}$ ]] || return 1
    printf '%s  %s\n' "$hash" "${release_labels[$i]}" >> "$manifest" || return 1
  done
  sha256_file "$manifest"
}

verify_manifest() {
  local root="$1" entry hash name
  local env_count=0 roles_count=0 dump_count=0 catalogue_count=0 line_count=0
  while IFS= read -r entry || [[ -n "$entry" ]]; do
    [[ -n "$entry" ]] || return 1
    hash="${entry%%  *}"
    name="${entry#*  }"
    [[ "$hash" =~ ^[0-9a-fA-F]{64}$ ]] || return 1
    [[ "$name" == "$entry" ]] && return 1
    case "$name" in
      env) env_count=$((env_count + 1)) ;;
      roles.sql) roles_count=$((roles_count + 1)) ;;
      portfolio.dump) dump_count=$((dump_count + 1)) ;;
      catalogue.sha256) catalogue_count=$((catalogue_count + 1)) ;;
      *) return 1 ;;
    esac
    line_count=$((line_count + 1))
  done < "$root/manifest.sha256"
  [[ "$line_count" -eq 4 && "$env_count" -eq 1 && "$roles_count" -eq 1 && "$dump_count" -eq 1 && "$catalogue_count" -eq 1 ]] || return 1
  if command -v sha256sum >/dev/null 2>&1; then
    (CDPATH= cd -- "$root" && sha256sum -c manifest.sha256 >/dev/null 2>&1)
  else
    (CDPATH= cd -- "$root" && shasum -a 256 -c manifest.sha256 >/dev/null 2>&1)
  fi
}

verify_archive_members() {
  local archive="$1" member detail first
  local env_count=0 roles_count=0 dump_count=0 catalogue_count=0 manifest_count=0 member_count=0
  tar -tf "$archive" > "$TMP_DIR/archive.list" 2>/dev/null || return 1
  while IFS= read -r member || [[ -n "$member" ]]; do
    case "$member" in
      env) env_count=$((env_count + 1)) ;;
      roles.sql) roles_count=$((roles_count + 1)) ;;
      portfolio.dump) dump_count=$((dump_count + 1)) ;;
      catalogue.sha256) catalogue_count=$((catalogue_count + 1)) ;;
      manifest.sha256) manifest_count=$((manifest_count + 1)) ;;
      *) return 1 ;;
    esac
    member_count=$((member_count + 1))
  done < "$TMP_DIR/archive.list"
  [[ "$member_count" -eq 5 && "$env_count" -eq 1 && "$roles_count" -eq 1 && "$dump_count" -eq 1 && "$catalogue_count" -eq 1 && "$manifest_count" -eq 1 ]] || return 1
  tar -tvf "$archive" > "$TMP_DIR/archive.details" 2>/dev/null || return 1
  while IFS= read -r detail || [[ -n "$detail" ]]; do
    first="${detail:0:1}"
    [[ "$first" == "-" ]] || return 1
  done < "$TMP_DIR/archive.details"
}

ARCHIVE_ARG=""
ENV_ARG=""
IDENTITY_ARG=""
UPSTREAM_ARG=""
STAGING_DB_ARG=""
STAGING_CONTAINER_ARG=""
RECEIPT_DIR_ARG=""
APPLY_STAGING=false
TMP_DIR=""
TMP_BASE=""
ROLLBACK_TMP=""

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  usage
  exit 0
fi

while [[ $# -gt 0 ]]; do
  case "$1" in
    --archive) [[ $# -ge 2 ]] || die "--archive needs a file or bundle"; ARCHIVE_ARG="$2"; shift 2 ;;
    --env-file) [[ $# -ge 2 ]] || die "--env-file needs a path"; ENV_ARG="$2"; shift 2 ;;
    --identity-file) [[ $# -ge 2 ]] || die "--identity-file needs a path"; IDENTITY_ARG="$2"; shift 2 ;;
    --upstream) [[ $# -ge 2 ]] || die "--upstream needs a path"; UPSTREAM_ARG="$2"; shift 2 ;;
    --staging-db) [[ $# -ge 2 ]] || die "--staging-db needs a name"; STAGING_DB_ARG="$2"; shift 2 ;;
    --staging-container) [[ $# -ge 2 ]] || die "--staging-container needs a name"; STAGING_CONTAINER_ARG="$2"; shift 2 ;;
    --receipt-dir) [[ $# -ge 2 ]] || die "--receipt-dir needs a path"; RECEIPT_DIR_ARG="$2"; shift 2 ;;
    --apply-staging) APPLY_STAGING=true; shift ;;
    *) die "unknown argument: $1" ;;
  esac
done

[[ -n "$ARCHIVE_ARG" && -n "$ENV_ARG" ]] || { usage >&2; exit 2; }
ENV_FILE="$(canonical_file "$ENV_ARG")" || die "env file must be a regular, non-symlink file"
inside_repo "$ENV_FILE" && die "env file must be outside this worktree"
mode_is_600 "$ENV_FILE" || die "env file must have mode 600"
validate_env_keys "$ENV_FILE"
SCHEMA_ARG="$(env_value PORTFOLIO_SCHEMA_FILE 2>/dev/null || true)"
[[ "$SCHEMA_ARG" == /* ]] || die "PORTFOLIO_SCHEMA_FILE must be an absolute path"
SCHEMA_FILE="$(canonical_file "$SCHEMA_ARG")" || die "schema path must be a regular, non-symlink file"
[[ "$SCHEMA_FILE" == "$CHECKOUT_ROOT/Portfolio/Supabase/schema.sql" ]] || die "schema path must be this worktree's Supabase/schema.sql"
RESTORE_SECURITY_FILE="$(canonical_file "$NAS_DIR/restore-security.sql")" || die "restore security manifest must be a regular, non-symlink file"
[[ "$RESTORE_SECURITY_FILE" == "$NAS_DIR/restore-security.sql" ]] || die "restore security manifest must be this worktree's NAS/restore-security.sql"
CATALOGUE_SECURITY_FILE="$(canonical_file "$NAS_DIR/catalogue-security.sql")" || die "catalogue security query must be a regular, non-symlink file"
[[ "$CATALOGUE_SECURITY_FILE" == "$NAS_DIR/catalogue-security.sql" ]] || die "catalogue security query must be this worktree's NAS/catalogue-security.sql"
CADDY_ARG="$(env_value PORTFOLIO_CADDYFILE 2>/dev/null || true)"
[[ "$CADDY_ARG" == /* ]] || die "PORTFOLIO_CADDYFILE must be an absolute path"
CADDY_FILE="$(canonical_file "$CADDY_ARG")" || die "Caddyfile path must be a regular, non-symlink file"
[[ "$CADDY_FILE" == "$NAS_DIR/Caddyfile" ]] || die "Caddyfile path must be this NAS Caddyfile"
PUBLIC_DIR_ARG="$(env_value PORTFOLIO_PUBLIC_DIR 2>/dev/null || true)"
[[ "$PUBLIC_DIR_ARG" == /* ]] || die "PORTFOLIO_PUBLIC_DIR must be an absolute path"
PUBLIC_DIR="$(canonical_dir "$PUBLIC_DIR_ARG")" || die "curated public directory must be an existing, non-symlink directory"
inside_repo "$PUBLIC_DIR" && die "curated public directory must be outside this worktree"

if [[ -d "$ARCHIVE_ARG" ]]; then
  [[ ! -L "$ARCHIVE_ARG" ]] || die "backup bundle must not be a symlink"
  BUNDLE_DIR="$(canonical_dir "$ARCHIVE_ARG")" || die "backup bundle must be an existing directory"
  inside_repo "$BUNDLE_DIR" && die "backup bundle must be outside this worktree"
  ARCHIVE="$(canonical_file "$BUNDLE_DIR/portfolio.tar.age")" || die "backup bundle lacks its encrypted archive"
else
  ARCHIVE="$(canonical_file "$ARCHIVE_ARG")" || die "archive must be a regular, non-symlink file"
  inside_repo "$ARCHIVE" && die "archive must be outside this worktree"
fi
mode_is_600 "$ARCHIVE" || die "encrypted archive must have mode 600"

if [[ -z "$IDENTITY_ARG" ]]; then
  IDENTITY_ARG="$(env_value PORTFOLIO_AGE_IDENTITY_FILE 2>/dev/null || true)"
fi
non_placeholder "$IDENTITY_ARG" || die "an external age identity file is required"
IDENTITY_FILE="$(canonical_file "$IDENTITY_ARG")" || die "age identity must be a regular, non-symlink file"
inside_repo "$IDENTITY_FILE" && die "age identity must be outside this worktree"
mode_is_600 "$IDENTITY_FILE" || die "age identity file must have mode 600"

TMP_BASE="$(canonical_temp_dir "${TMPDIR:-/tmp}")" || die "temporary directory base must be an absolute, existing directory"
inside_repo "$TMP_BASE" && die "temporary directory base must be outside this checkout"
TMP_DIR="$(mktemp -d "$TMP_BASE/portfolio-restore.XXXXXX")" || die "cannot create secure temporary directory"
chmod 700 "$TMP_DIR"
cleanup() {
  if [[ -n "${ROLLBACK_TMP:-}" && -d "$ROLLBACK_TMP" ]]; then
    rm -rf -- "$ROLLBACK_TMP"
  fi
  if [[ -n "${TMP_DIR:-}" && -d "$TMP_DIR" ]]; then
    rm -rf -- "$TMP_DIR"
  fi
}
trap cleanup EXIT HUP INT TERM
TMP_DIR="$(canonical_dir "$TMP_DIR")" || die "temporary directory is not a regular, non-symlink directory"
inside_repo "$TMP_DIR" && die "temporary directory must be outside this checkout"
mkdir "$TMP_DIR/extracted"

age --decrypt -i "$IDENTITY_FILE" -o "$TMP_DIR/archive.tar" "$ARCHIVE" >/dev/null 2>&1 || die "age decryption failed"
verify_archive_members "$TMP_DIR/archive.tar" || die "archive payload is not the exact five-file allowlist"
tar -xf "$TMP_DIR/archive.tar" -C "$TMP_DIR/extracted" >/dev/null 2>&1 || die "archive extraction failed"
for required in env roles.sql portfolio.dump catalogue.sha256 manifest.sha256; do
  [[ -f "$TMP_DIR/extracted/$required" && ! -L "$TMP_DIR/extracted/$required" ]] || die "archive member is not a regular file"
done

# This is the first and mandatory integrity gate. No database command appears before it.
verify_manifest "$TMP_DIR/extracted" || die "manifest hash verification failed"
EXPECTED_CATALOGUE_SHA="$(tr -d '\r\n' < "$TMP_DIR/extracted/catalogue.sha256")"
[[ "$EXPECTED_CATALOGUE_SHA" =~ ^[0-9a-fA-F]{64}$ ]] || die "catalogue security fingerprint is malformed"

if [[ "$APPLY_STAGING" != true ]]; then
  printf 'Verified encrypted backup. No database action was taken.\n'
  exit 0
fi

# Applying is deliberately fail-closed while the platform bootstrap and fresh
# target contract are unverified. Keep the operator pins as an offline
# prerequisite, then stop before reading a Compose file or invoking Docker,
# psql, pg_dump, pg_dumpall, or pg_restore. A future enablement must add a
# separately reviewed contract for Supabase platform ownership and ACL
# reconstruction, it cannot be inferred from roles.sql or manifest.sha256.
ARCHIVE_PIN="$(env_value PORTFOLIO_ARCHIVE_SHA256 2>/dev/null || true)"
[[ "$ARCHIVE_PIN" =~ ^[0-9a-fA-F]{64}$ ]] || die "staged restore is disabled: operator-pinned archive SHA-256 is required before any target mutation"
ACTUAL_ARCHIVE_SHA="$(sha256_file "$ARCHIVE")"
[[ "$ACTUAL_ARCHIVE_SHA" == "$ARCHIVE_PIN" ]] || die "staged restore is disabled: operator-pinned archive SHA-256 does not match"
CANONICAL_RELEASE_PIN="$(env_value PORTFOLIO_CANONICAL_RELEASE_SHA256 2>/dev/null || true)"
[[ "$CANONICAL_RELEASE_PIN" =~ ^[0-9a-fA-F]{64}$ ]] || die "staged restore is disabled: operator-pinned canonical release SHA-256 is required before any target mutation"
ACTUAL_CANONICAL_RELEASE_SHA="$(canonical_release_hash)" || die "staged restore is disabled: canonical release content could not be fingerprinted"
[[ "$ACTUAL_CANONICAL_RELEASE_SHA" == "$CANONICAL_RELEASE_PIN" ]] || die "staged restore is disabled: canonical release content hash does not match"
die "staged restore is disabled: no verified fresh-target/platform bootstrap contract is configured"

[[ "${PORTFOLIO_RESTORE_CONFIRM:-}" == "RESTORE_PORTFOLIO_TO_EMPTY_STAGING" ]] || die "set the exact staging restore confirmation"
[[ -n "$UPSTREAM_ARG" && -n "$STAGING_DB_ARG" && -n "$STAGING_CONTAINER_ARG" && -n "$RECEIPT_DIR_ARG" ]] || die "staging path, database, container, and receipt directory are required"

case "$STAGING_DB_ARG" in
  postgres|POSTGRES|Postgres) die "the default postgres database is not a staging target" ;;
  *[!A-Za-z0-9_-]*|'') die "staging database name contains unsupported characters" ;;
  *staging*) ;;
  *) die "staging database name must identify staging" ;;
esac
case "$STAGING_CONTAINER_ARG" in
  db|supabase-db|portfolio-db) die "a production-like container is not a staging target" ;;
  *[!A-Za-z0-9_.-]*|'') die "staging container name contains unsupported characters" ;;
  *staging*) ;;
  *) die "staging container name must identify staging" ;;
esac

PRODUCTION_DB="$(env_value PORTFOLIO_PRODUCTION_DB 2>/dev/null || true)"
[[ -n "$PRODUCTION_DB" ]] || PRODUCTION_DB="$(env_value PORTFOLIO_DB_NAME 2>/dev/null || true)"
non_placeholder "$PRODUCTION_DB" || die "production database name must be explicit in the external env file"
[[ "$STAGING_DB_ARG" != "$PRODUCTION_DB" ]] || die "staging database must differ from production"
PRODUCTION_CONTAINER="$(env_value PORTFOLIO_PRODUCTION_CONTAINER 2>/dev/null || true)"
non_placeholder "$PRODUCTION_CONTAINER" || die "production container name must be explicit in the external env file"
[[ "$STAGING_CONTAINER_ARG" != "$PRODUCTION_CONTAINER" ]] || die "staging container must differ from production"
AGE_RECIPIENT="$(env_value PORTFOLIO_AGE_RECIPIENT 2>/dev/null || true)"
non_placeholder "$AGE_RECIPIENT" || die "PORTFOLIO_AGE_RECIPIENT is unset or still a placeholder"

UPSTREAM="$(verify_upstream "$UPSTREAM_ARG")"
BASE_COMPOSE="$UPSTREAM/docker/docker-compose.yml"
COMPOSE=(docker compose --env-file "$ENV_FILE" --project-directory "$UPSTREAM" -f "$BASE_COMPOSE" -f "$OVERLAY")
"${COMPOSE[@]}" config --quiet >/dev/null 2>&1 || die "pinned Compose configuration did not validate"
RECEIPT_DIR="$(canonical_dir "$RECEIPT_DIR_ARG")" || die "receipt directory must be an existing, non-symlink directory"
inside_repo "$RECEIPT_DIR" && die "receipt directory must be outside this worktree"

# Both probes must be empty, including every non-system schema and relation.
EMPTY_PROBE="$(docker exec "$STAGING_CONTAINER_ARG" psql --dbname="$STAGING_DB_ARG" --tuples-only --no-align --command="SELECT CASE WHEN to_regclass('public.portfolio_records') IS NULL THEN 'empty' ELSE 'occupied' END;" 2>/dev/null)" || die "could not prove staging Portfolio table state"
EMPTY_PROBE="${EMPTY_PROBE//$'\r'/}"
EMPTY_PROBE="${EMPTY_PROBE//$'\n'/}"
[[ "$EMPTY_PROBE" == "empty" ]] || die "staging target already contains public.portfolio_records"
ALL_EMPTY_PROBE="$(docker exec "$STAGING_CONTAINER_ARG" psql --dbname="$STAGING_DB_ARG" --tuples-only --no-align --command="SELECT (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind IN ('r','p','v','m','f','S') AND n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_%') || '|' || (SELECT count(*) FROM pg_namespace n WHERE n.nspname NOT IN ('pg_catalog','information_schema','public') AND n.nspname NOT LIKE 'pg_%');" 2>/dev/null)" || die "could not prove all staging schemas and tables are empty"
ALL_EMPTY_PROBE="${ALL_EMPTY_PROBE//$'\r'/}"
ALL_EMPTY_PROBE="${ALL_EMPTY_PROBE//$'\n'/}"
[[ "$ALL_EMPTY_PROBE" == "0|0" ]] || die "staging target has non-system schemas or tables"

PRE_DUMP="$TMP_DIR/pre-action.dump"
PRE_ROLES="$TMP_DIR/pre-action.roles.sql"
docker exec "$STAGING_CONTAINER_ARG" pg_dump --format=custom --dbname="$STAGING_DB_ARG" > "$PRE_DUMP" 2>/dev/null || die "fresh pre-action staging backup failed"
docker exec "$STAGING_CONTAINER_ARG" pg_dumpall --roles-only > "$PRE_ROLES" 2>/dev/null || die "fresh pre-action roles receipt failed"
[[ -s "$PRE_DUMP" && -f "$PRE_ROLES" ]] || die "fresh pre-action backup receipt is incomplete"

# Encrypt the pre-action dump and publish its checksum and receipt durably before restore.
ROLLBACK_TMP="$(mktemp -d "$RECEIPT_DIR/.portfolio-pre-action.XXXXXX")" || die "cannot create durable pre-action staging area"
inside_repo "$ROLLBACK_TMP" && die "rollback staging directory must be outside this checkout"
chmod 700 "$ROLLBACK_TMP"
age -r "$AGE_RECIPIENT" -o "$ROLLBACK_TMP/staging.dump.age" "$PRE_DUMP" >/dev/null 2>&1 || die "pre-action staging dump encryption failed"
age -r "$AGE_RECIPIENT" -o "$ROLLBACK_TMP/roles.sql.age" "$PRE_ROLES" >/dev/null 2>&1 || die "pre-action roles encryption failed"
chmod 600 "$ROLLBACK_TMP/staging.dump.age" "$ROLLBACK_TMP/roles.sql.age"
{
  printf '%s  %s\n' "$(sha256_file "$ROLLBACK_TMP/staging.dump.age")" staging.dump.age
  printf '%s  %s\n' "$(sha256_file "$ROLLBACK_TMP/roles.sql.age")" roles.sql.age
} > "$ROLLBACK_TMP/manifest.sha256"
RECEIPT_FILE="$ROLLBACK_TMP/receipt.txt"
{
  printf 'created_utc=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  printf 'staging_container=%s\n' "$STAGING_CONTAINER_ARG"
  printf 'staging_database=%s\n' "$STAGING_DB_ARG"
  printf 'staging_dump_sha256=%s\n' "$(sha256_file "$ROLLBACK_TMP/staging.dump.age")"
  printf 'roles_dump_sha256=%s\n' "$(sha256_file "$ROLLBACK_TMP/roles.sql.age")"
} > "$RECEIPT_FILE"
chmod 600 "$ROLLBACK_TMP/manifest.sha256" "$RECEIPT_FILE"
ROLLBACK_NAME="portfolio-pre-restore-$(date +%Y%m%d-%H%M%S).bundle"
ROLLBACK_FINAL="$RECEIPT_DIR/$ROLLBACK_NAME"
inside_repo "$ROLLBACK_FINAL" && die "rollback destination must be outside this checkout"
[[ ! -e "$ROLLBACK_FINAL" && ! -L "$ROLLBACK_FINAL" ]] || die "refusing to overwrite an existing rollback bundle"
sync
mv -n "$ROLLBACK_TMP" "$ROLLBACK_FINAL" || die "could not durably publish the rollback bundle"
[[ -d "$ROLLBACK_FINAL" && -f "$ROLLBACK_FINAL/staging.dump.age" && -f "$ROLLBACK_FINAL/manifest.sha256" && -f "$ROLLBACK_FINAL/receipt.txt" ]] || die "published rollback bundle is incomplete"
ROLLBACK_TMP=""
sync

# The empty isolated target and rollback artefact are ready. Archive ownership
# and ACL metadata is untrusted, so restore only the data and definitions, then
# reapply the checked-in schema's owner, grants, search_path, RLS and tombstone
# contract below. The separate roles.sql is evidence only and is never run.
docker exec -i "$STAGING_CONTAINER_ARG" pg_restore --single-transaction --dbname="$STAGING_DB_ARG" --no-owner --no-privileges --exit-on-error < "$TMP_DIR/extracted/portfolio.dump" >/dev/null 2>&1 || die "staged restore failed"

# Archive ownership, ACLs, and roles are never trusted. Reapply the checked-in
# app migration, then require the independent catalogue audit to return its
# single exact success token before reporting a usable staged restore.
docker exec -i "$STAGING_CONTAINER_ARG" psql --dbname="$STAGING_DB_ARG" --set=ON_ERROR_STOP=1 --file=- < "$SCHEMA_FILE" >/dev/null 2>&1 || die "staged security migration failed"
SECURITY_PROBE="$(docker exec -i "$STAGING_CONTAINER_ARG" psql --dbname="$STAGING_DB_ARG" --set=ON_ERROR_STOP=1 --quiet --tuples-only --no-align --file=- < "$RESTORE_SECURITY_FILE" 2>/dev/null)" || die "staged security verification failed"
SECURITY_PROBE="${SECURITY_PROBE//$'\r'/}"
SECURITY_PROBE="${SECURITY_PROBE//$'\n'/}"
[[ "$SECURITY_PROBE" == "portfolio_restore_security_ok" ]] || die "staged security verification returned an unexpected result"

RESTORED_CATALOGUE="$TMP_DIR/restored-catalogue-security.txt"
docker exec -i "$STAGING_CONTAINER_ARG" psql --dbname="$STAGING_DB_ARG" --set=ON_ERROR_STOP=1 --quiet --tuples-only --no-align --file=- < "$CATALOGUE_SECURITY_FILE" > "$RESTORED_CATALOGUE" 2>/dev/null || die "restored catalogue security query failed"
AUTH_REQUIRED='["auth_required", true, true, true, true, true, true, true, true, true, true, true]'
grep -Fqx "$AUTH_REQUIRED" "$RESTORED_CATALOGUE" || die "restored Auth security contract is not usable"
RESTORED_CATALOGUE_SHA="$(sha256_file "$RESTORED_CATALOGUE")"
[[ "$RESTORED_CATALOGUE_SHA" == "$EXPECTED_CATALOGUE_SHA" ]] || die "restored catalogue security contract does not match backup"

printf 'Staged restore applied to %s, durable rollback bundle: %s\n' "$STAGING_CONTAINER_ARG" "$ROLLBACK_FINAL"
