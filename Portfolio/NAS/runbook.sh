#!/usr/bin/env bash
set -euo pipefail
umask 077

NAS_DIR="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
SCRIPT_DIR="$NAS_DIR"
APP_ROOT="$(CDPATH= cd -- "$NAS_DIR/.." && pwd -P)"
PINNED_SHA="241bb11c0627f2981746d37033f57dbfa81d29b0"
OVERLAY="$NAS_DIR/compose.overlay.yml"

die() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

usage() {
  cat <<'HELP'
Portfolio NAS repository boundary

  runbook.sh verify-upstream PATH
      Confirm PATH is the official checkout at the pinned full commit and that
      docker/docker-compose.yml exists. This command never clones or downloads.

  runbook.sh check --upstream PATH --env-file PATH
      Run non-mutating prerequisite and Compose configuration checks. The env
      file must be outside this worktree with mode 600.

  runbook.sh start | stop
      Print the exact operator command. This script does not execute it.

  runbook.sh apply
      Report that staged apply is hard-disabled. The restore guard accepts no
      target mutation until an operator-pinned archive SHA-256, canonical
      release content hash, and separately verified fresh-target/platform
      bootstrap contract exist. No restore command is printed or executed.

  runbook.sh serve
      Print the Tailscale Serve-only command for the loopback web proxy. LAN
      policy and the host firewall remain separate controls.

Cutover gate: keep an encrypted external backup, an encrypted off-site copy,
and a real staged restore test receipt before any cutover. RAID is availability
only, it is not a backup.

The overlay requires Docker Compose >= 2.24.4. The database schema mount runs
only on first database initialisation, never against an existing PGDATA.

The curated public directory must contain exactly these files beneath its root,
with no extra files, directories, special entries, or symlinks anywhere. This
check only lists and validates them, it never copies or deletes anything:
  index.html, sw.js, Worker/theme-init.js, Worker/manifest.webmanifest,
  Worker/whale-icon.png, Worker/kjr-core.js, Worker/kjr-sortable.js,
  Worker/kjr-vault.js, Worker/kjr-migration.js, Worker/supabase.js,
  Worker/kjr-nas.js, Worker/app.js

The external env file must contain one KEY=VALUE assignment per key. Blank and
comment lines are allowed, duplicate keys and alternate assignment syntax are
rejected before any configured value is read.

The internal market service context must be this NAS directory and must contain
Market Service.js and Market Dockerfile. The service has no host-published port.
HELP
}

REQUIRED_PUBLIC_ASSETS=(
  index.html
  sw.js
  Worker/theme-init.js
  Worker/manifest.webmanifest
  Worker/whale-icon.png
  Worker/kjr-core.js
  Worker/kjr-sortable.js
  Worker/kjr-vault.js
  Worker/kjr-migration.js
  Worker/supabase.js
  Worker/kjr-nas.js
  Worker/app.js
)

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

public_asset_allowed() {
  local relative="$1" asset
  for asset in "${REQUIRED_PUBLIC_ASSETS[@]}"; do
    [[ "$relative" == "$asset" ]] && return 0
  done
  return 1
}

public_directory_allowed() {
  local relative="$1" asset
  for asset in "${REQUIRED_PUBLIC_ASSETS[@]}"; do
    [[ "$asset" == "$relative"/* ]] && return 0
  done
  return 1
}

check_public_tree() {
  local entry relative
  if ! find "$PUBLIC_DIR" -mindepth 1 -print0 | while IFS= read -r -d '' entry || [[ -n "$entry" ]]; do
    relative="${entry:${#PUBLIC_DIR}+1}"
    [[ -L "$entry" ]] && die "curated public directory contains a symlink: $relative"
    if [[ -d "$entry" ]]; then
      public_directory_allowed "$relative" || die "curated public directory contains an unapproved directory: $relative"
      continue
    fi
    [[ -f "$entry" ]] || die "curated public directory contains a non-regular entry: $relative"
    public_asset_allowed "$relative" || die "curated public directory contains an unapproved asset: $relative"
  done; then
    die "could not inspect curated public directory"
  fi
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

check_source_script_assets() {
  local source="$APP_ROOT/index.html" ref src
  [[ -f "$source" && ! -L "$source" ]] || die "Portfolio index.html is missing"
  while IFS= read -r ref || [[ -n "$ref" ]]; do
    src="${ref#src=\"}"
    src="${src%\"}"
    src="${src%%\?*}"
    case "$src" in
      ''|http://*|https://*|//*|data:*) continue ;;
    esac
    [[ -f "$PUBLIC_DIR/$src" && ! -L "$PUBLIC_DIR/$src" ]] || die "curated public directory is missing index.html script: $src"
  done < <(grep -Eo 'src="[^"]+"' "$source" || true)
}

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
  local file="$1" key="$2" line
  while IFS= read -r line || [[ -n "$line" ]]; do
    case "$line" in
      "$key="*)
        printf '%s' "${line#*=}"
        return 0
        ;;
    esac
  done < "$file"
  return 1
}

validate_env_keys() {
  local file="$1" line key existing
  local -a seen_keys
  # Bash 3.2 with nounset treats an empty array expansion as unset. Keep one
  # harmless sentinel so the duplicate scan remains portable on macOS.
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

compose_command() {
  local upstream="$1" env_file="$2"
  printf 'docker compose --env-file %q --project-directory %q -f %q -f %q' \
    "$env_file" "$upstream" "$upstream/docker/docker-compose.yml" "$OVERLAY"
}

check_compose_version() {
  local version major minor patch
  version="$(docker compose version --short 2>/dev/null || true)"
  version="${version#v}"
  IFS=. read -r major minor patch <<EOF
$version
EOF
  [[ "$major" =~ ^[0-9]+$ && "$minor" =~ ^[0-9]+$ && "$patch" =~ ^[0-9]+$ ]] || die "Docker Compose version could not be read"
  if (( major < 2 || (major == 2 && minor < 24) || (major == 2 && minor == 24 && patch < 4) )); then
    die "Docker Compose >= 2.24.4 is required"
  fi
}

audit_merged_ports() {
  local rendered="$1" violations api_count caddy_count
  command -v jq >/dev/null 2>&1 || die "jq is required for the merged Compose port audit"
  violations="$(jq -r '
    .services | to_entries[] as $service
    | ($service.value.ports // [])[]?
    | select((
        ($service.key == "api-gw" and (.host_ip // "") == "127.0.0.1" and (.protocol // "") == "tcp" and ((.published | tonumber) == 8000) and ((.target | tonumber) == 8000))
        or
        ($service.key == "caddy" and (.host_ip // "") == "127.0.0.1" and (.protocol // "") == "tcp" and ((.published | tonumber) == 8080) and ((.target | tonumber) == 8080))
      ) | not)
    | "\($service.key):\(.host_ip // ""):\(.published // "") -> \(.target // "")/\(.protocol // "")"
  ' "$rendered" 2>/dev/null)" || die "merged Compose port audit could not parse config"
  [[ -z "$violations" ]] || die "merged Compose publishes an unapproved host port: $violations"
  api_count="$(jq '[.services["api-gw"].ports // [] | .[] | select((.host_ip // "") == "127.0.0.1" and (.protocol // "") == "tcp" and ((.published | tonumber) == 8000) and ((.target | tonumber) == 8000))] | length' "$rendered" 2>/dev/null)" || die "merged Compose api-gw port audit failed"
  caddy_count="$(jq '[.services.caddy.ports // [] | .[] | select((.host_ip // "") == "127.0.0.1" and (.protocol // "") == "tcp" and ((.published | tonumber) == 8080) and ((.target | tonumber) == 8080))] | length' "$rendered" 2>/dev/null)" || die "merged Compose Caddy port audit failed"
  [[ "$api_count" == 1 && "$caddy_count" == 1 ]] || die "merged Compose is missing an approved api-gw or Caddy loopback binding"
}

audit_rendered_paths() {
  local rendered="$1" schema="$2" caddy="$3" public="$4" market="$5"
  local schema_target="/docker-entrypoint-initdb.d/migrations/zz-portfolio.sql"
  local public_target="/srv/portfolio-public"
  local caddy_target="/etc/caddy/Caddyfile"
  local schema_targets schema_matches caddy_total public_matches caddy_matches market_matches
  command -v jq >/dev/null 2>&1 || die "jq is required for the merged Compose path audit"

  schema_targets="$(jq --arg target "$schema_target" '[.services.db.volumes // [] | .[]? | select((.target // "") == $target)] | length' "$rendered" 2>/dev/null)" || die "merged Compose database mount audit failed"
  [[ "$schema_targets" == 1 ]] || die "rendered Compose database schema mount is missing or duplicated"
  schema_matches="$(jq --arg source "$schema" --arg target "$schema_target" '[.services.db.volumes // [] | .[]? | select((.type // "") == "bind" and (.source // "") == $source and (.target // "") == $target and (.read_only // false) == true)] | length' "$rendered" 2>/dev/null)" || die "merged Compose database mount audit failed"
  [[ "$schema_matches" == 1 ]] || die "rendered Compose database schema mount source or syntax mismatch"

  caddy_total="$(jq '[.services.caddy.volumes // [] | .[]?] | length' "$rendered" 2>/dev/null)" || die "merged Compose Caddy mount audit failed"
  [[ "$caddy_total" == 2 ]] || die "rendered Compose Caddy mount set is missing, duplicated, or has an alternate entry"
  public_matches="$(jq --arg source "$public" --arg target "$public_target" '[.services.caddy.volumes // [] | .[]? | select((.type // "") == "bind" and (.source // "") == $source and (.target // "") == $target and (.read_only // false) == true)] | length' "$rendered" 2>/dev/null)" || die "merged Compose Caddy mount audit failed"
  [[ "$public_matches" == 1 ]] || die "rendered Compose public mount source or syntax mismatch"
  caddy_matches="$(jq --arg source "$caddy" --arg target "$caddy_target" '[.services.caddy.volumes // [] | .[]? | select((.type // "") == "bind" and (.source // "") == $source and (.target // "") == $target and (.read_only // false) == true)] | length' "$rendered" 2>/dev/null)" || die "merged Compose Caddy mount audit failed"
  [[ "$caddy_matches" == 1 ]] || die "rendered Compose Caddyfile mount source or syntax mismatch"

  market_matches="$(jq --arg context "$market" '[.services["portfolio-market"].build.context // empty | select(type == "string" and . == $context)] | length' "$rendered" 2>/dev/null)" || die "merged Compose market build audit failed"
  [[ "$market_matches" == 1 ]] || die "rendered Compose market build context is missing or mismatched"
}

check_config() {
  local upstream_arg="$1" env_arg="$2" upstream env_file port age_recipient schema_arg schema_file expected_schema public_arg caddy_arg caddy_file expected_caddy market_arg market_context asset missing
  upstream="$(verify_upstream "$upstream_arg")"
  env_file="$(canonical_file "$env_arg")" || die "env file must be a regular, non-symlink file"
  inside_repo "$env_file" && die "env file must be outside this worktree"
  mode_is_600 "$env_file" || die "env file must have mode 600"
  validate_env_keys "$env_file"
  schema_arg="$(env_value "$env_file" PORTFOLIO_SCHEMA_FILE 2>/dev/null || true)"
  [[ "$schema_arg" == /* ]] || die "PORTFOLIO_SCHEMA_FILE must be an absolute path"
  schema_file="$(canonical_file "$schema_arg")" || die "schema path must be a regular, non-symlink file"
  expected_schema="$APP_ROOT/Supabase/schema.sql"
  [[ "$schema_file" == "$expected_schema" ]] || die "schema path must be this worktree's Supabase/schema.sql"
  caddy_arg="$(env_value "$env_file" PORTFOLIO_CADDYFILE 2>/dev/null || true)"
  [[ "$caddy_arg" == /* ]] || die "PORTFOLIO_CADDYFILE must be an absolute path"
  caddy_file="$(canonical_file "$caddy_arg")" || die "Caddyfile path must be a regular, non-symlink file"
  expected_caddy="$NAS_DIR/Caddyfile"
  [[ "$caddy_file" == "$expected_caddy" ]] || die "Caddyfile path must be this NAS Caddyfile"
  market_arg="$(env_value "$env_file" PORTFOLIO_MARKET_BUILD_CONTEXT 2>/dev/null || true)"
  [[ "$market_arg" == /* ]] || die "PORTFOLIO_MARKET_BUILD_CONTEXT must be an absolute path"
  market_context="$(canonical_dir "$market_arg")" || die "market service context must be an existing, non-symlink directory"
  [[ "$market_context" == "$NAS_DIR" ]] || die "market service context must be this NAS directory"
  [[ -f "$market_context/Market Service.js" && ! -L "$market_context/Market Service.js" ]] || die "Market Service.js is missing or is a symlink"
  [[ -f "$market_context/Market Dockerfile" && ! -L "$market_context/Market Dockerfile" ]] || die "Market Dockerfile is missing or is a symlink"
  public_arg="$(env_value "$env_file" PORTFOLIO_PUBLIC_DIR 2>/dev/null || true)"
  [[ "$public_arg" == /* ]] || die "PORTFOLIO_PUBLIC_DIR must be an absolute path"
  PUBLIC_DIR="$(canonical_dir "$public_arg")" || die "curated public directory must be an existing, non-symlink directory"
  inside_repo "$PUBLIC_DIR" && die "curated public directory must be outside this worktree"
  check_public_tree
  missing=""
  printf 'Required curated public assets:\n'
  for asset in "${REQUIRED_PUBLIC_ASSETS[@]}"; do
    printf '  %s\n' "$asset"
    [[ -f "$PUBLIC_DIR/$asset" && ! -L "$PUBLIC_DIR/$asset" ]] || missing="$missing $asset"
  done
  [[ -z "$missing" ]] || die "curated public directory is missing:$missing"
  check_source_script_assets
  port="$(env_value "$env_file" PORTFOLIO_API_GW_HTTP_PORT 2>/dev/null || true)"
  [[ -n "$port" ]] || port=8000
  [[ "$port" =~ ^[0-9]+$ && "$port" -ge 1 && "$port" -le 65535 ]] || die "gateway port is invalid"
  age_recipient="$(env_value "$env_file" PORTFOLIO_AGE_RECIPIENT 2>/dev/null || true)"
  [[ -n "$age_recipient" && "$age_recipient" != *'<'* && "$age_recipient" != *PLACEHOLDER* ]] || die "backup recipient is unset or a placeholder"
  [[ -f "$OVERLAY" && ! -L "$OVERLAY" ]] || die "NAS overlay is missing"
  check_compose_version
  command -v age >/dev/null 2>&1 || die "age is required for encrypted backups"
  COMPOSE=(docker compose --env-file "$env_file" --project-directory "$upstream" -f "$upstream/docker/docker-compose.yml" -f "$OVERLAY")
  "${COMPOSE[@]}" config --quiet >/dev/null 2>&1 || die "pinned Compose configuration did not validate"
  AUDIT_BASE="$(canonical_temp_dir "${TMPDIR:-/tmp}")" || die "temporary directory base must be an absolute, existing directory"
  inside_repo "$AUDIT_BASE" && die "temporary directory base must be outside this checkout"
  AUDIT_TMP="$(mktemp -d "$AUDIT_BASE/portfolio-compose-check.XXXXXX")" || die "cannot create read-only Compose audit workspace"
  chmod 700 "$AUDIT_TMP"
  audit_cleanup() {
    if [[ -n "${AUDIT_TMP:-}" && -d "$AUDIT_TMP" ]]; then
      rm -rf -- "$AUDIT_TMP"
    fi
  }
  trap audit_cleanup EXIT HUP INT TERM
  AUDIT_TMP="$(canonical_dir "$AUDIT_TMP")" || die "temporary directory is not a regular, non-symlink directory"
  inside_repo "$AUDIT_TMP" && die "temporary directory must be outside this checkout"
  "${COMPOSE[@]}" config --format json > "$AUDIT_TMP/compose.json" 2>/dev/null || die "pinned Compose JSON configuration did not validate"
  audit_rendered_paths "$AUDIT_TMP/compose.json" "$schema_file" "$caddy_file" "$PUBLIC_DIR" "$market_context"
  audit_merged_ports "$AUDIT_TMP/compose.json"
  printf 'Checks passed for the pinned upstream and NAS overlay. No service action was taken.\n'
}

manual_start() {
  printf 'Not executed. Review and run manually:\n'
  compose_command "<PINNED_UPSTREAM_CHECKOUT>" "<EXTERNAL_ENV_FILE>"
  printf ' up -d\n'
}

manual_stop() {
  printf 'Not executed. Review and run manually:\n'
  compose_command "<PINNED_UPSTREAM_CHECKOUT>" "<EXTERNAL_ENV_FILE>"
  printf ' stop\n'
}

manual_apply() {
  printf 'Blocked. Staged restore remains disabled until operator-pinned archive and canonical release hashes, plus a verified fresh-target/platform bootstrap contract, are independently reviewed.\n'
  printf 'No restore command was executed.\n'
}

manual_serve() {
  printf 'Not executed. Tailscale Serve only:\n'
  printf 'tailscale serve --bg --yes --https=443 http://127.0.0.1:8080\n'
}

COMMAND="${1:---help}"
case "$COMMAND" in
  --help|-h|help)
    usage
    ;;
  verify-upstream)
    [[ $# -eq 2 ]] || die "usage: runbook.sh verify-upstream PATH"
    verify_upstream "$2" >/dev/null
    printf 'Verified upstream HEAD %s and docker/docker-compose.yml.\n' "$PINNED_SHA"
    ;;
  check)
    shift
    CHECK_UPSTREAM=""
    CHECK_ENV=""
    if [[ "${1:-}" != -* && $# -ge 2 ]]; then
      CHECK_UPSTREAM="$1"
      CHECK_ENV="$2"
      shift 2
    else
      while [[ $# -gt 0 ]]; do
        case "$1" in
          --upstream) [[ $# -ge 2 ]] || die "--upstream needs a path"; CHECK_UPSTREAM="$2"; shift 2 ;;
          --env-file) [[ $# -ge 2 ]] || die "--env-file needs a path"; CHECK_ENV="$2"; shift 2 ;;
          *) die "unknown check argument: $1" ;;
        esac
      done
    fi
    [[ -n "$CHECK_UPSTREAM" && -n "$CHECK_ENV" ]] || die "check needs --upstream and --env-file"
    [[ $# -eq 0 ]] || die "unexpected check argument"
    check_config "$CHECK_UPSTREAM" "$CHECK_ENV"
    ;;
  start) [[ $# -eq 1 ]] || die "start takes no arguments"; manual_start ;;
  stop) [[ $# -eq 1 ]] || die "stop takes no arguments"; manual_stop ;;
  apply) [[ $# -eq 1 ]] || die "apply takes no arguments"; manual_apply ;;
  serve) [[ $# -eq 1 ]] || die "serve takes no arguments"; manual_serve ;;
  *) die "unknown command: $COMMAND" ;;
esac
