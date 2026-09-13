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
  backup.sh --upstream PATH --env-file PATH --backup-dir PATH [--name BUNDLE]
  backup.sh PATH PATH PATH [BUNDLE]

The upstream path must be an existing checkout at the pinned commit. The env
file must be outside the Portfolio worktree and mode 600. The backup directory
must already exist outside the worktree. A mode-700 temporary bundle is made
under that destination filesystem, then atomically renamed to the final bundle
directory. The bundle contains one age-encrypted archive with roles, the
configured database, a secret-free catalogue security fingerprint, the external
env file, and a SHA-256 manifest. No final cross-filesystem copy is used, and
services are never started or stopped.
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

sync_file() {
  if command -v fsync >/dev/null 2>&1; then
    fsync "$1" >/dev/null 2>&1 || true
  else
    sync
  fi
}

UPSTREAM_ARG=""
ENV_ARG=""
BACKUP_DIR_ARG=""
NAME_ARG=""

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  usage
  exit 0
fi

if [[ "${1:-}" != -* && $# -ge 3 ]]; then
  UPSTREAM_ARG="$1"
  ENV_ARG="$2"
  BACKUP_DIR_ARG="$3"
  NAME_ARG="${4:-}"
  [[ $# -le 4 ]] || die "unexpected argument"
else
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --upstream) [[ $# -ge 2 ]] || die "--upstream needs a path"; UPSTREAM_ARG="$2"; shift 2 ;;
      --env-file) [[ $# -ge 2 ]] || die "--env-file needs a path"; ENV_ARG="$2"; shift 2 ;;
      --backup-dir) [[ $# -ge 2 ]] || die "--backup-dir needs a path"; BACKUP_DIR_ARG="$2"; shift 2 ;;
      --name) [[ $# -ge 2 ]] || die "--name needs a bundle name"; NAME_ARG="$2"; shift 2 ;;
      *) die "unknown argument: $1" ;;
    esac
  done
fi

[[ -n "$UPSTREAM_ARG" && -n "$ENV_ARG" && -n "$BACKUP_DIR_ARG" ]] || { usage >&2; exit 2; }

UPSTREAM="$(verify_upstream "$UPSTREAM_ARG")"
ENV_FILE="$(canonical_file "$ENV_ARG")" || die "env file must be a regular, non-symlink file"
inside_repo "$ENV_FILE" && die "env file must be outside this worktree"
mode_is_600 "$ENV_FILE" || die "env file must have mode 600"
validate_env_keys "$ENV_FILE"
SCHEMA_ARG="$(env_value PORTFOLIO_SCHEMA_FILE 2>/dev/null || true)"
[[ "$SCHEMA_ARG" == /* ]] || die "PORTFOLIO_SCHEMA_FILE must be an absolute path"
SCHEMA_FILE="$(canonical_file "$SCHEMA_ARG")" || die "schema path must be a regular, non-symlink file"
[[ "$SCHEMA_FILE" == "$CHECKOUT_ROOT/Portfolio/Supabase/schema.sql" ]] || die "schema path must be this worktree's Supabase/schema.sql"
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
BACKUP_DIR="$(canonical_dir "$BACKUP_DIR_ARG")" || die "backup directory must be an existing, non-symlink directory"
inside_repo "$BACKUP_DIR" && die "backup directory must be outside this worktree"

AGE_RECIPIENT="$(env_value PORTFOLIO_AGE_RECIPIENT 2>/dev/null || true)"
non_placeholder "$AGE_RECIPIENT" || die "PORTFOLIO_AGE_RECIPIENT is unset or still a placeholder"
case "$AGE_RECIPIENT" in
  *[[:space:]]*) die "PORTFOLIO_AGE_RECIPIENT must be one line" ;;
esac

DB_NAME="$(env_value PORTFOLIO_DB_NAME 2>/dev/null || true)"
[[ -n "$DB_NAME" ]] || DB_NAME="$(env_value POSTGRES_DB 2>/dev/null || true)"
non_placeholder "$DB_NAME" || die "PORTFOLIO_DB_NAME or POSTGRES_DB is unset"
case "$DB_NAME" in
  *[!A-Za-z0-9_-]*) die "database name contains unsupported characters" ;;
esac

if [[ -z "$NAME_ARG" ]]; then
  NAME_ARG="portfolio-$(date +%Y%m%d-%H%M%S).bundle"
fi
[[ "$NAME_ARG" != */* && "$NAME_ARG" != *..* && "$NAME_ARG" != .* ]] || die "bundle name must be a simple name"
FINAL_DIR="$BACKUP_DIR/$NAME_ARG"
inside_repo "$FINAL_DIR" && die "backup destination must be outside this checkout"
[[ ! -e "$FINAL_DIR" && ! -L "$FINAL_DIR" ]] || die "refusing to overwrite an existing backup or bundle"

# Staging is deliberately created under the final destination filesystem.
STAGE_DIR="$(mktemp -d "$BACKUP_DIR/.portfolio-backup.XXXXXX")" || die "cannot create destination staging directory"
inside_repo "$STAGE_DIR" && die "backup staging directory must be outside this checkout"
chmod 700 "$STAGE_DIR"
cleanup() {
  if [[ -n "${STAGE_DIR:-}" && -d "$STAGE_DIR" ]]; then
    rm -rf -- "$STAGE_DIR"
  fi
}
trap cleanup EXIT HUP INT TERM

BASE_COMPOSE="$UPSTREAM/docker/docker-compose.yml"
COMPOSE=(docker compose --env-file "$ENV_FILE" --project-directory "$UPSTREAM" -f "$BASE_COMPOSE" -f "$OVERLAY")
"${COMPOSE[@]}" config --quiet >/dev/null 2>&1 || die "pinned Compose configuration did not validate"

if ! "${COMPOSE[@]}" exec -T db pg_dumpall --roles-only > "$STAGE_DIR/roles.sql" 2>/dev/null; then
  die "roles-only dump failed, confirm the pinned stack is running"
fi
# --format=custom is the custom-format dump required for pg_restore.
if ! "${COMPOSE[@]}" exec -T db pg_dump --format=custom --dbname="$DB_NAME" > "$STAGE_DIR/portfolio.dump" 2>/dev/null; then
  die "database dump failed, confirm the configured database is available"
fi
if ! "${COMPOSE[@]}" exec -T db psql --dbname="$DB_NAME" --set=ON_ERROR_STOP=1 --quiet --tuples-only --no-align --file=- < "$CATALOGUE_SECURITY_FILE" > "$STAGE_DIR/catalogue-security.txt" 2>/dev/null; then
  die "database catalogue security query failed"
fi
AUTH_REQUIRED='["auth_required", true, true, true, true, true, true, true, true, true, true, true]'
grep -Fqx "$AUTH_REQUIRED" "$STAGE_DIR/catalogue-security.txt" || die "database Auth security contract is not usable"
printf '%s\n' "$(sha256_file "$STAGE_DIR/catalogue-security.txt")" > "$STAGE_DIR/catalogue.sha256"
chmod 600 "$STAGE_DIR/catalogue.sha256"
cp "$ENV_FILE" "$STAGE_DIR/env"
chmod 600 "$STAGE_DIR/env"

{
  printf '%s  %s\n' "$(sha256_file "$STAGE_DIR/env")" env
  printf '%s  %s\n' "$(sha256_file "$STAGE_DIR/roles.sql")" roles.sql
  printf '%s  %s\n' "$(sha256_file "$STAGE_DIR/portfolio.dump")" portfolio.dump
  printf '%s  %s\n' "$(sha256_file "$STAGE_DIR/catalogue.sha256")" catalogue.sha256
} > "$STAGE_DIR/manifest.sha256"

tar -C "$STAGE_DIR" -cf "$STAGE_DIR/portfolio.tar" env roles.sql portfolio.dump catalogue.sha256 manifest.sha256
age -r "$AGE_RECIPIENT" -o "$STAGE_DIR/portfolio.tar.age" "$STAGE_DIR/portfolio.tar" >/dev/null 2>&1 || die "age encryption failed"
chmod 600 "$STAGE_DIR/portfolio.tar.age"
rm -f -- "$STAGE_DIR/portfolio.tar" "$STAGE_DIR/env" "$STAGE_DIR/roles.sql" "$STAGE_DIR/portfolio.dump" "$STAGE_DIR/catalogue-security.txt" "$STAGE_DIR/catalogue.sha256" "$STAGE_DIR/manifest.sha256"
sync_file "$STAGE_DIR/portfolio.tar.age"
chmod 700 "$STAGE_DIR"

# The rename is on one filesystem and publishes a complete, immutable bundle.
mv -n "$STAGE_DIR" "$FINAL_DIR" || die "could not atomically publish the backup bundle"
[[ -d "$FINAL_DIR" && ! -L "$FINAL_DIR" && -f "$FINAL_DIR/portfolio.tar.age" && ! -L "$FINAL_DIR/portfolio.tar.age" ]] || die "published backup bundle is incomplete"
STAGE_DIR=""
sync

printf 'Encrypted backup bundle written: %s\n' "$FINAL_DIR"
