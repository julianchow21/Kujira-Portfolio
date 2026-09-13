'use strict';

// Static and synthetic guard for the repository-side NAS boundary. The path
// probes use fake command shims, and the restore probe verifies an archive with
// synthetic bytes before the apply guard stops. No Docker daemon, database,
// Tailscale service, credential, or private data is touched.
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const appDir = path.resolve(__dirname, '..');
const nasDir = path.join(appDir, 'NAS');
const files = {
  ref: path.join(nasDir, 'upstream.ref'),
  overlay: path.join(nasDir, 'compose.overlay.yml'),
  caddyfile: path.join(nasDir, 'Caddyfile'),
  dockerignore: path.join(nasDir, '.dockerignore'),
  marketService: path.join(nasDir, 'Market Service.js'),
  marketDockerfile: path.join(nasDir, 'Market Dockerfile'),
  env: path.join(nasDir, '.env.example'),
  grants: path.join(nasDir, 'tailscale-grants.hujson'),
  backup: path.join(nasDir, 'backup.sh'),
  restore: path.join(nasDir, 'restore.sh'),
  restoreSecurity: path.join(nasDir, 'restore-security.sql'),
  catalogueSecurity: path.join(nasDir, 'catalogue-security.sql'),
  runbook: path.join(nasDir, 'runbook.sh'),
  schema: path.join(appDir, 'Supabase', 'schema.sql')
};
const publicAssetPaths = [
  'index.html',
  'sw.js',
  'Worker/theme-init.js',
  'Worker/manifest.webmanifest',
  'Worker/whale-icon.png',
  'Worker/kjr-core.js',
  'Worker/kjr-sortable.js',
  'Worker/kjr-vault.js',
  'Worker/kjr-migration.js',
  'Worker/supabase.js',
  'Worker/kjr-nas.js',
  'Worker/app.js'
];

let checks = 0;
const failures = [];
function check(condition, message) {
  checks += 1;
  if (!condition) failures.push(message);
}
function read(name) {
  try {
    return fs.readFileSync(files[name], 'utf8');
  } catch (error) {
    failures.push(`cannot read ${name}: ${error.message}`);
    return '';
  }
}
function has(text, literal) {
  return text.includes(literal);
}

const ref = read('ref');
const overlay = read('overlay');
const caddyfile = read('caddyfile');
const dockerignore = read('dockerignore');
const marketService = read('marketService');
const marketDockerfile = read('marketDockerfile');
const env = read('env');
const grants = read('grants');
const backup = read('backup');
const restore = read('restore');
const restoreSecurity = read('restoreSecurity');
const catalogueSecurity = read('catalogueSecurity');
const runbook = read('runbook');
const indexHtml = fs.readFileSync(path.join(appDir, 'index.html'), 'utf8');
const all = [ref, overlay, caddyfile, dockerignore, marketService, marketDockerfile, env, grants, backup, restore, restoreSecurity, catalogueSecurity, runbook].join('\n');

check(has(ref, 'release=self-hosted/v0.8.0'), 'official self-hosted release is not recorded');
check(has(ref, 'tag=self-hosted/v0.8.0'), 'upstream tag is not recorded');
check(has(ref, 'commit=241bb11c0627f2981746d37033f57dbfa81d29b0'), 'immutable upstream SHA is not recorded');
check(has(ref, 'compose_path=docker/docker-compose.yml'), 'base Compose path is not recorded');

check(has(overlay, 'ports: !override'), 'gateway ports do not use Compose !override');
check(has(overlay, '127.0.0.1:${PORTFOLIO_API_GW_HTTP_PORT:-8000}:8000/tcp'), 'gateway is not loopback-only on TCP 8000');
check(has(overlay, 'ports: !reset []'), 'supavisor host ports are not reset');
check(has(overlay, '${PORTFOLIO_SCHEMA_FILE:?set absolute Portfolio schema path}:/docker-entrypoint-initdb.d/migrations/zz-portfolio.sql:ro'), 'absolute read-only first-init schema mount is missing');
for (const setting of [
  'GOTRUE_DISABLE_SIGNUP: "true"',
  'GOTRUE_EXTERNAL_EMAIL_ENABLED: "true"',
  'GOTRUE_EXTERNAL_ANONYMOUS_USERS_ENABLED: "false"',
  'GOTRUE_EXTERNAL_PHONE_ENABLED: "false"'
]) check(has(overlay, setting), `auth setting is missing: ${setting}`);
for (const setting of ['API_EXTERNAL_URL:', 'GOTRUE_SITE_URL:', 'GOTRUE_URI_ALLOW_LIST:']) {
  check(has(overlay, setting), `private auth URL setting is missing: ${setting}`);
}
check(!has(overlay, 'SUPABASE_PUBLIC_URL:'), 'SUPABASE_PUBLIC_URL is incorrectly invented as an auth key');
check(has(overlay, 'image: caddy:2.11.4-alpine@sha256:5f5c8640aae01df9654968d946d8f1a56c497f1dd5c5cda4cf95ab7c14d58648'), 'Caddy image is not pinned by the required digest');
check(has(overlay, '127.0.0.1:${PORTFOLIO_WEB_PORT:-8080}:8080/tcp'), 'Caddy is not loopback-only on TCP 8080');
check(has(overlay, '${PORTFOLIO_PUBLIC_DIR:?set absolute curated public directory}:/srv/portfolio-public:ro'), 'curated public directory is not a read-only mount');
check(has(overlay, '${PORTFOLIO_CADDYFILE:?set absolute NAS Caddyfile path}:/etc/caddy/Caddyfile:ro'), 'Caddyfile is not an absolute read-only mount');
check(has(overlay, 'api-gw:\n    networks:\n      - default') && has(overlay, 'caddy:\n    image: caddy:'), 'Caddy and api-gw are not explicitly on the same Compose network');
check(!/\.\.?\/Portfolio|\.\.?\/Portfolio\/NAS|:\/srv\/portfolio-public/.test(overlay.replace(/\$\{PORTFOLIO_PUBLIC_DIR:\?set absolute curated public directory\}:\/srv\/portfolio-public:ro/, '')), 'overlay contains a broad repository static mount');
const publishedPorts = overlay.split('\n').filter((line) => /-\s*"[^"\n]+:\d+\/(?:tcp|udp)"/.test(line));
check(publishedPorts.length === 2, 'overlay does not publish exactly gateway and Caddy loopback ports');
check(publishedPorts.every((line) => line.includes('127.0.0.1:')), 'a published overlay port is not loopback-bound');
check(!/5432|6543/.test(overlay), 'Postgres or pooler host port appears in the overlay');

check(has(caddyfile, 'admin off'), 'Caddy admin API is not disabled');
check(has(caddyfile, 'auto_https off'), 'Caddy automatic HTTPS is not disabled');
check(has(caddyfile, '@supabase_api path /auth/v1 /auth/v1/* /rest/v1 /rest/v1/*'), 'Caddy proxy matcher is broader or incomplete');
check((caddyfile.match(/reverse_proxy\s+api-gw:8000/g) || []).length === 1, 'Caddy does not have exactly one preserved api-gw:8000 proxy');
check(!/handle_path|strip_prefix|uri\s/.test(caddyfile), 'Caddy rewrites or strips the upstream API path');
check(has(caddyfile, 'root * /srv/portfolio-public') && has(caddyfile, '@public_asset path') && has(caddyfile, 'handle @public_asset') && has(caddyfile, 'rewrite * /index.html') && has(caddyfile, 'file_server'), 'Caddy curated static serving or SPA fallback is missing');
check(!/path\s+\/\*|path\s+\/Worker\/\*/.test(caddyfile), 'Caddy public asset matcher contains a wildcard');
check(!/try_files/.test(caddyfile), 'Caddy fallback can serve an unlisted file');
const caddyPublicAssetLine = caddyfile.split(/\r?\n/).find((line) => line.trimStart().startsWith('@public_asset path ')) || '';
const caddyPublicAssetPaths = caddyPublicAssetLine.trim().split(/\s+/).slice(2);
check(caddyPublicAssetPaths.length === publicAssetPaths.length && caddyPublicAssetPaths.every((asset, index) => asset === `/${publicAssetPaths[index]}`), 'Caddy public asset allowlist is not exactly the runbook allowlist');
for (const asset of publicAssetPaths) {
  check(has(caddyfile, `/${asset}`), `Caddy public asset allowlist is missing ${asset}`);
}
check(/^\*$/m.test(dockerignore) && /!Market Service\.js/.test(dockerignore) && /!Market Dockerfile/.test(dockerignore), 'market Docker build context is not deny-by-default');
check(!/(?:backup\.sh|restore\.sh|runbook\.sh|compose\.overlay\.yml|catalogue-security\.sql|restore-security\.sql|\.env\.example)/.test(dockerignore), 'market Docker build context re-includes operational or secret-bearing files');
check(has(runbook, 'check_public_tree') && has(runbook, 'find "$PUBLIC_DIR" -mindepth 1 -print0'), 'runbook does not recursively inspect the public tree');
check(has(runbook, 'public_asset_allowed') && has(runbook, 'public_directory_allowed') && has(runbook, '[[ -L "$entry" ]]'), 'runbook public tree allowlist or symlink rejection is incomplete');
check(has(runbook, 'validate_env_keys') && has(runbook, 'env file contains duplicate key'), 'runbook does not reject duplicate env keys');
const envValidationCall = runbook.indexOf('validate_env_keys "$env_file"');
const firstEnvValueRead = runbook.indexOf('env_value "$env_file"');
check(envValidationCall >= 0 && firstEnvValueRead > envValidationCall, 'runbook reads an env value before validating all env keys');
check(has(runbook, 'env file contains an invalid assignment') && has(runbook, 'env file contains a carriage return'), 'runbook does not reject alternate env assignment syntax');
check(!/(studio|pg-meta|mcp|realtime|storage|functions|graphql|supavisor|5432|6543)/i.test(caddyfile), 'Caddyfile exposes a forbidden route or port');

const envLines = env.split(/\r?\n/).filter((line) => line.trim() && !line.trim().startsWith('#'));
const allowedPortLine = 'PORTFOLIO_API_GW_HTTP_PORT=8000';
check(envLines.includes(allowedPortLine), 'env template does not pin the documented gateway default');
check(envLines.includes('PORTFOLIO_WEB_PORT=8080'), 'env template does not pin the documented Caddy default');
check(envLines.includes('PORTFOLIO_SCHEMA_FILE=<ABSOLUTE_PORTFOLIO_SCHEMA_PATH>'), 'env template does not require the absolute schema path');
check(envLines.includes('PORTFOLIO_PUBLIC_DIR=<ABSOLUTE_CURATED_PUBLIC_DIR>'), 'env template does not require the curated public directory');
check(envLines.includes('PORTFOLIO_CADDYFILE=<ABSOLUTE_NAS_CADDYFILE_PATH>'), 'env template does not require the absolute Caddyfile path');
check(envLines.includes('SUPABASE_PUBLIC_URL=https://<PRIVATE_PORTFOLIO_ORIGIN>'), 'public URL example is not the exact private HTTPS origin placeholder');
check(envLines.includes('API_EXTERNAL_URL=https://<PRIVATE_PORTFOLIO_ORIGIN>/auth/v1'), 'auth API external URL example is not the auth root');
check(envLines.includes('SITE_URL=https://<PRIVATE_PORTFOLIO_ORIGIN>') && envLines.includes('ADDITIONAL_REDIRECT_URLS=https://<PRIVATE_PORTFOLIO_ORIGIN>'), 'site and redirect examples do not use the exact private HTTPS origin');
check(envLines.length >= 10, 'env template does not declare the required boundary values');
check(!/eyJ[A-Za-z0-9_-]{20,}/.test(env), 'env template contains a JWT-like literal');
check(!/\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/i.test(env), 'env template contains a UUID-like literal');
check(!/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(env), 'env template contains an email literal');
check(!/\bage1[a-z0-9]{20,}/i.test(env), 'env template contains an age recipient literal');
for (const line of envLines) {
  const separator = line.indexOf('=');
  check(separator > 0, `env line is not KEY=VALUE: ${line}`);
  if (separator > 0) {
    const key = line.slice(0, separator);
    const value = line.slice(separator + 1);
    check(/^[A-Z][A-Z0-9_]+$/.test(key), `env key is malformed: ${key}`);
    check(value === '8000' || value === '8080' || (value.includes('<') && value.includes('>')), `env value is not a placeholder: ${key}`);
  }
}

check(has(grants, 'OWNER_IDENTITY_PLACEHOLDER'), 'Tailscale owner identity is not a placeholder');
check(has(grants, 'tag:portfolio-nas'), 'Tailscale destination tag is missing');
check(has(grants, '"grants"'), 'current Tailscale grants key is missing');
check(!has(grants, '"acls"'), 'legacy Tailscale acls key remains');
check(has(grants, '"ip": ["tcp:443"]'), 'Tailscale grant is not limited to HTTPS TCP 443');
check(has(grants, 'Tailscale Serve only'), 'Tailscale Serve-only policy text is missing');
check(!/\*\s*:\s*\*/.test(grants), 'Tailscale policy contains a wildcard destination');
check(!/5432|6543/.test(grants), 'Tailscale policy exposes Postgres or pooler ports');
check(!/tailscale\s+funnel/i.test(all), 'public Tailscale exposure command is present');

const backupEnvValidator = backup.match(/validate_env_keys\(\) \{([\s\S]*?)\n\}/);
const restoreEnvValidator = restore.match(/validate_env_keys\(\) \{([\s\S]*?)\n\}/);
check(Boolean(backupEnvValidator) && Boolean(restoreEnvValidator), 'backup or restore is missing the strict env validator');
check(backupEnvValidator && restoreEnvValidator && backupEnvValidator[1] === restoreEnvValidator[1], 'backup and restore do not use the same strict env validator');
for (const [name, script] of [['backup', backup], ['restore', restore]]) {
  check(has(script, 'env file contains duplicate key: $key'), `${name} does not reject duplicate env keys`);
  check(has(script, 'env file contains an invalid assignment'), `${name} does not reject malformed env assignments`);
  check(has(script, 'env file contains a carriage return'), `${name} does not reject CRLF env assignments`);
  const validatorCall = script.indexOf('validate_env_keys "$ENV_FILE"');
  const firstRead = script.indexOf('SCHEMA_ARG="$(env_value PORTFOLIO_SCHEMA_FILE');
  check(validatorCall >= 0 && firstRead > validatorCall, `${name} reads the env file before strict validation`);
  check(script.indexOf('docker compose') > validatorCall, `${name} can call Compose before strict env validation`);
}

check(has(backup, 'git -C "$upstream" rev-parse HEAD'), 'backup does not verify the upstream Git HEAD');
check(has(backup, 'git -C "$SCRIPT_DIR" rev-parse --show-toplevel'), 'backup does not derive the checkout root from the script directory');
check(has(backup, 'resolve_checkout_root') && has(backup, 'SCRIPT_DIR/../..') && has(backup, 'gitdir'), 'backup fallback does not require matching .git worktree evidence');
check(has(backup, 'CHECKOUT_ROOT') && !has(backup, 'REPO_ROOT="$(CDPATH= cd -- "$NAS_DIR/.."'), 'backup does not use the actual checkout root boundary');
check(has(backup, 'pg_dumpall --roles-only'), 'backup does not capture roles');
check(has(backup, 'pg_dump --format=custom'), 'backup does not capture a custom-format database dump');
check(has(backup, '< "$CATALOGUE_SECURITY_FILE"') && has(backup, 'catalogue-security.txt'), 'backup does not capture the canonical catalogue security contract');
check(has(backup, 'catalogue.sha256') && has(backup, 'database Auth security contract is not usable'), 'backup does not require a usable Auth contract and hash it');
check(has(backup, 'PORTFOLIO_AGE_RECIPIENT'), 'backup does not require the age recipient');
check(has(backup, 'age -r'), 'backup does not encrypt with age');
check(has(backup, 'manifest.sha256') && has(backup, 'sha256_file'), 'backup manifest hashing is missing');
check(has(backup, 'mktemp -d') && has(backup, 'umask 077') && has(backup, 'trap cleanup EXIT'), 'backup temporary-file safeguards are incomplete');
check(has(backup, 'inside_repo') && has(backup, 'mode_is_600') && has(backup, '! -L'), 'backup path and env safety checks are incomplete');
check(has(backup, 'PORTFOLIO_SCHEMA_FILE') && has(backup, 'Supabase/schema.sql'), 'backup does not validate the exact schema path');
check(has(backup, 'PORTFOLIO_CADDYFILE') && has(backup, 'NAS_DIR/Caddyfile'), 'backup does not validate the exact Caddyfile path');
check(has(backup, 'refusing to overwrite an existing backup'), 'backup overwrite refusal is missing');
check(has(backup, 'cp "$ENV_FILE" "$STAGE_DIR/env"'), 'external env file is not included in the backup archive');
check(has(backup, 'docker compose') && has(backup, 'config --quiet'), 'backup does not validate pinned Compose config');
check(has(backup, 'mktemp -d "$BACKUP_DIR/.portfolio-backup.XXXXXX"'), 'backup staging is not created under the explicit destination');
check(has(backup, 'chmod 700 "$STAGE_DIR"'), 'backup staging directory is not mode 700');
check(has(backup, 'mv -n "$STAGE_DIR" "$FINAL_DIR"'), 'backup is not atomically published as a destination-side bundle');
check(has(backup, 'sync_file "$STAGE_DIR/portfolio.tar.age"') && has(backup, 'sync'), 'backup does not flush the encrypted payload before publication');
check(!/mv[^\n]*TMP_DIR[^\n]*(?:BACKUP|FINAL)/.test(backup), 'backup performs a cross-filesystem final copy');
check(has(backup, 'FINAL_DIR/portfolio.tar.age') && has(backup, 'published backup bundle is incomplete'), 'backup does not validate a complete immutable bundle');
check(has(backup, 'inside_repo "$FINAL_DIR"') && has(backup, 'inside_repo "$STAGE_DIR"'), 'backup does not re-check final and staging destinations against the checkout boundary');

check(has(restore, 'age --decrypt'), 'restore does not decrypt with age');
check(has(restore, 'git -C "$SCRIPT_DIR" rev-parse --show-toplevel'), 'restore does not derive the checkout root from the script directory');
check(has(restore, 'resolve_checkout_root') && has(restore, 'SCRIPT_DIR/../..') && has(restore, 'gitdir'), 'restore fallback does not require matching .git worktree evidence');
check(has(restore, 'CHECKOUT_ROOT') && !has(restore, 'REPO_ROOT="$(CDPATH= cd -- "$NAS_DIR/.."'), 'restore does not use the actual checkout root boundary');
check(has(restore, 'verify_manifest') && has(restore, 'sha256'), 'restore manifest verification is missing');
check(has(restore, 'if [[ "$APPLY_STAGING" != true ]]'), 'restore is not verify-only by default');
check(has(restore, 'RESTORE_PORTFOLIO_TO_EMPTY_STAGING'), 'exact staging confirmation is missing');
check(has(restore, 'public.portfolio_records'), 'restore does not prove the staging target is empty');
check(has(restore, 'PRE_DUMP') && has(restore, 'PRE_ROLES') && has(restore, 'RECEIPT_FILE'), 'fresh pre-action backup receipt is missing');
check(has(restore, 'pg_restore') && has(restore, '--no-owner') && has(restore, '--no-privileges'), 'restore does not strip untrusted archive owner and ACL metadata');
check(has(restore, 'postgres|POSTGRES|Postgres'), 'restore does not refuse the default postgres target');
check(!/\-\-(?:clean|create)\b/.test(restore), 'restore includes a database recreation flag');
check(!/\bDROP\b/.test(restore), 'restore contains a table or database removal command');
const manifestGate = restore.indexOf('verify_manifest "$TMP_DIR/extracted"');
const databaseAction = restore.indexOf('pg_restore --single-transaction');
check(manifestGate >= 0 && databaseAction > manifestGate, 'manifest verification does not precede pg_restore');
check(has(restore, 'PORTFOLIO_ARCHIVE_SHA256') && has(restore, 'PORTFOLIO_CANONICAL_RELEASE_SHA256'), 'restore does not require operator-pinned archive and canonical release hashes');
check(has(restore, 'canonical_release_hash') && has(restore, 'archive manifest is not') && has(restore, 'producer identity'), 'restore does not distinguish canonical release trust from archive payload integrity');
const applyDisabledGate = restore.indexOf('no verified fresh-target/platform bootstrap contract is configured');
check(applyDisabledGate > manifestGate && databaseAction > applyDisabledGate, 'restore apply is not hard-disabled after offline validation and before database mutation');
check(has(restore, 'operator-pinned archive SHA-256 does not match') && has(restore, 'canonical release content hash does not match'), 'restore does not reject mismatched operator trust pins');
check(has(restore, 'docker exec "$STAGING_CONTAINER_ARG"') && has(restore, 'staging container must differ from production'), 'restore staging identity checks are incomplete');
check(has(restore, 'PORTFOLIO_SCHEMA_FILE') && has(restore, 'Supabase/schema.sql'), 'restore does not validate the exact schema path');
check(has(restore, 'PORTFOLIO_CADDYFILE') && has(restore, 'NAS_DIR/Caddyfile'), 'restore does not validate the exact Caddyfile path');
check(has(restore, 'verify_archive_members') && has(restore, '"$member_count" -eq 5') && has(restore, '"$catalogue_count" -eq 1') && has(restore, '"$env_count" -eq 1'), 'restore does not enforce exact archive membership and duplicate rejection');
check(has(restore, 'tar -tvf') && has(restore, 'first="${detail:0:1}"') && has(restore, 'first" == "-"'), 'restore does not reject archive symlinks or non-regular members');
check(has(restore, 'pg_class') && has(restore, 'pg_namespace') && has(restore, 'NOT LIKE \'pg_%\'') && has(restore, 'ALL_EMPTY_PROBE') && has(restore, '0|0'), 'restore does not prove all non-system schemas and tables are empty');
check(has(restore, '--single-transaction'), 'restore is not transactional');
check(has(restore, 'ROLLBACK_TMP') && has(restore, 'staging.dump.age') && has(restore, 'ROLLBACK_FINAL'), 'encrypted durable rollback artefact is missing');
check(has(restore, 'RECEIPT_FILE') && has(restore, 'manifest.sha256') && has(restore, 'chmod 700 "$ROLLBACK_TMP"'), 'rollback checksum receipt and restrictive permissions are incomplete');
check(has(restore, 'refusing to overwrite an existing rollback bundle') && has(restore, 'mv -n "$ROLLBACK_TMP" "$ROLLBACK_FINAL"'), 'rollback publication is not protected and atomic');
check(has(restore, 'canonical_temp_dir') && has(restore, 'inside_repo "$TMP_BASE"'), 'restore does not reject a temporary secret directory inside the checkout');
check(has(restore, 'inside_repo "$TMP_DIR"') && has(restore, 'inside_repo "$ROLLBACK_TMP"') && has(restore, 'inside_repo "$ROLLBACK_FINAL"'), 'restore does not re-check temporary and rollback destinations against the checkout boundary');
check(has(restore, 'RESTORE_SECURITY_FILE="$(canonical_file "$NAS_DIR/restore-security.sql")"') && has(restore, 'NAS_DIR/restore-security.sql'), 'restore does not pin the checked-in security manifest');
check(has(restore, '< "$SCHEMA_FILE"') && has(restore, 'staged security migration failed'), 'restore does not reapply the trusted current schema after archive restore');
check(has(restore, '< "$RESTORE_SECURITY_FILE"') && has(restore, 'portfolio_restore_security_ok'), 'restore does not fail closed on the independent catalogue audit');
check(!/psql[^\n]*(?:roles\.sql)|<[^\n]*roles\.sql/.test(restore), 'restore executes untrusted archive role metadata');
check(has(restore, '< "$CATALOGUE_SECURITY_FILE"') && has(restore, 'RESTORED_CATALOGUE_SHA') && has(restore, 'EXPECTED_CATALOGUE_SHA'), 'restore does not compare the complete restored catalogue contract');
check(has(restore, 'restored Auth security contract is not usable') && has(restore, 'restored catalogue security contract does not match backup'), 'restore does not fail closed on Auth or catalogue mismatch');
const archiveRestore = restore.indexOf('pg_restore --single-transaction');
const securityMigration = restore.indexOf('staged security migration failed');
const securityAudit = restore.indexOf('SECURITY_PROBE="$(docker exec');
const catalogueAudit = restore.indexOf('RESTORED_CATALOGUE="$TMP_DIR/restored-catalogue-security.txt"');
const restoreReceipt = restore.lastIndexOf("printf 'Staged restore applied");
check(archiveRestore >= 0 && securityMigration > archiveRestore && securityAudit > securityMigration && catalogueAudit > securityAudit && restoreReceipt > catalogueAudit, 'security migration and complete catalogue audits do not precede the restore receipt');

for (const signature of [
  'portfolio_stamp_record()',
  'portfolio_bind_auth_user()',
  'portfolio_upsert_record(text,text,jsonb,integer,bigint)',
  'portfolio_delete_record(text,text,bigint)',
  'portfolio_restore_record(text,text,jsonb,integer,bigint)',
  'portfolio_restore_record(text,text,bigint)',
  'portfolio_get_records_page(bigint,bigint,integer)',
  'portfolio_sync_page(bigint,integer)',
  'portfolio_sync_boundary()',
  'auth.uid()',
  'auth.jwt()'
]) check(has(restoreSecurity, signature), `restore security audit omits ${signature}`);
for (const contract of [
  "current_setting('portfolio.trusted_function_hashes', true)",
  'pg_catalog.md5(pg_catalog.pg_get_functiondef(v_function))',
  'trusted canonical function body manifest is required',
  'Portfolio function body content mismatch'
]) check(has(restoreSecurity, contract), `restore security audit omits body-content contract: ${contract}`);
for (const contract of [
  'rolbypassrls',
  'pg_auth_members',
  'pg_get_userbyid(p.proowner)',
  'p.prosecdef',
  'search_path=""',
  'has_function_privilege',
  'has_table_privilege',
  'has_sequence_privilege',
  'has_schema_privilege',
  'relrowsecurity',
  'relforcerowsecurity',
  'portfolio_records_owner_select',
  'portfolio_records_rpc_insert',
  'portfolio_records_rpc_update',
  "select 'portfolio_restore_security_ok'"
]) check(has(restoreSecurity, contract), `restore security audit omits contract: ${contract}`);
check(has(restoreSecurity, "acldefault('f'") && has(restoreSecurity, "acldefault('r'") && has(restoreSecurity, "acldefault('s'") && has(restoreSecurity, "acldefault('n'"), 'restore security audit does not reject unexpected direct grants');
check(has(restoreSecurity, "raise exception 'Portfolio records policy count mismatch'") && has(restoreSecurity, '<> 3'), 'restore security audit does not reject additional RLS policies');
for (const contract of [
  "p.proname like 'portfolio\\_%' escape '\\'",
  "c.relname like 'portfolio\\_%' escape '\\'",
  "t.typname like 'portfolio\\_%' escape '\\'",
  "policy.polname like 'portfolio\\_%' escape '\\'",
  "trigger.tgname like 'portfolio\\_%' escape '\\'",
  "raise exception 'unexpected Portfolio-prefixed function exists'",
  "raise exception 'unexpected Portfolio-prefixed relation exists'",
  "raise exception 'unexpected Portfolio-prefixed type exists'",
  "raise exception 'unexpected Portfolio-prefixed policy exists'",
  "raise exception 'unexpected Portfolio trigger exists'",
  "raise exception 'unexpected Portfolio rewrite rule exists'",
  "raise exception 'Portfolio records are unexpectedly published'",
  "raise exception 'unexpected Portfolio default privilege exists'"
]) check(has(restoreSecurity, contract), `restore security audit omits unexpected Portfolio object gate: ${contract}`);
const restoreSuccessToken = restoreSecurity.indexOf("select 'portfolio_restore_security_ok'");
for (const staleGate of [
  "raise exception 'unexpected Portfolio-prefixed function exists'",
  "raise exception 'unexpected Portfolio-prefixed relation exists'"
]) check(restoreSecurity.indexOf(staleGate) >= 0 && restoreSecurity.indexOf(staleGate) < restoreSuccessToken, `stale Portfolio object gate does not precede the success token: ${staleGate}`);
for (const contract of [
  'relation.relpersistence::text',
  'pg_get_userbyid(relation.relowner) <> current_user::text',
  'relation.relrowsecurity <> expected.row_security',
  'relation.relforcerowsecurity <> expected.force_row_security',
  'relation.relreplident::text',
  'relation.reltoastrelid',
  'relation.reltablespace <> 0',
  "('private', 'portfolio_owner_owner_id_key', 'i', 'btree'",
  "('private', 'portfolio_owner_pkey', 'i', 'btree'",
  "('public', 'portfolio_records', 'r', 'heap', true, true",
  'from pg_attribute as attribute',
  'format_type(attribute.atttypid, attribute.atttypmod)',
  'attribute.attnotnull',
  'pg_get_expr(default_value.adbin, default_value.adrelid, false)',
  'attribute.attcollation',
  'attribute.attidentity',
  'attribute.attgenerated',
  'attribute.attisdropped',
  'from pg_constraint as constraint_row',
  'pg_get_constraintdef(constraint_row.oid, false)',
  'constraint_row.convalidated',
  'and conindid =',
  'from pg_index as index_row',
  'index_row.indisunique',
  'index_row.indisprimary',
  'index_row.indisvalid',
  'index_row.indisready',
  'index_row.indislive',
  'pg_get_indexdef(index_row.indexrelid, 0, false)',
  'from pg_sequence as sequence_row',
  'sequence_row.seqstart = 1',
  'sequence_row.seqincrement = 1',
  'sequence_row.seqmax = 9223372036854775807',
  'sequence_row.seqmin = 1',
  'sequence_row.seqcache = 1',
  'not sequence_row.seqcycle',
  'dependency.refobjsubid = 7',
  'lock table public.portfolio_records in share mode',
  'sequence_state.last_value::numeric',
  'sequence_state.is_called',
  'v_sequence_next_value := v_sequence_last_value',
  'case when v_sequence_is_called then v_sequence_increment else 0::numeric end',
  'max(records.change_seq)::numeric',
  'v_sequence_next_value > 9223372036854775807::numeric',
  'v_sequence_next_value <= v_sequence_max_record',
  'select count(*) <> 4 or bool_or(trigger.tgenabled <>',
  'pg_get_triggerdef(trigger.oid, false)',
  'pg_get_expr(polqual, polrelid, false) = v_owner_predicate'
]) check(has(restoreSecurity, contract), `restore security structural audit omits contract: ${contract}`);
for (const structuralGate of [
  "raise exception 'Portfolio relation structure mismatch'",
  "raise exception 'Portfolio column structure mismatch'",
  "raise exception 'Portfolio column metadata mismatch'",
  "raise exception 'Portfolio constraint structure mismatch'",
  "raise exception 'Portfolio constraint metadata mismatch'",
  "raise exception 'Portfolio constraint index binding mismatch'",
  "raise exception 'Portfolio index structure mismatch'",
  "raise exception 'Portfolio index metadata mismatch'",
  "raise exception 'Portfolio sequence structure mismatch'",
  "raise exception 'Portfolio sequence next value is not safely ahead of records'",
  "pg_get_functiondef(to_regprocedure('public.portfolio_stamp_record()'))",
  'pg_catalog.pg_advisory_xact_lock(741234567890123457)',
  'v_nextval_marker',
  "raise exception 'Portfolio sequence allocation lock contract mismatch'",
  "raise exception 'Portfolio foreign key trigger structure mismatch'",
  "raise exception 'required Portfolio trigger contract mismatch'"
]) check(restoreSecurity.indexOf(structuralGate) >= 0 && restoreSecurity.indexOf(structuralGate) < restoreSuccessToken, `Portfolio structure gate does not precede the success token: ${structuralGate}`);
check(!/\b(?:nextval|setval)\s*\(/i.test(restoreSecurity), 'restore security audit consumes or mutates the sequence while checking state');
const sequenceStateLock = restoreSecurity.indexOf('lock table public.portfolio_records in share mode');
const sequenceStateRead = restoreSecurity.indexOf('sequence_state.last_value::numeric');
const sequenceStateGate = restoreSecurity.indexOf("raise exception 'Portfolio sequence next value is not safely ahead of records'");
check(sequenceStateLock >= 0 && sequenceStateRead > sequenceStateLock && sequenceStateGate > sequenceStateRead && restoreSuccessToken > sequenceStateGate, 'sequence state is not locked, read, checked, and rejected before the success token');
const stampDefinitionRead = restoreSecurity.indexOf("pg_get_functiondef(to_regprocedure('public.portfolio_stamp_record()'))");
const allocationLockRead = restoreSecurity.indexOf('pg_catalog.pg_advisory_xact_lock(741234567890123457)', stampDefinitionRead);
const allocationNextvalRead = restoreSecurity.indexOf('position(v_nextval_marker', stampDefinitionRead);
const allocationLockGate = restoreSecurity.indexOf("raise exception 'Portfolio sequence allocation lock contract mismatch'");
check(stampDefinitionRead >= 0 && allocationLockRead > stampDefinitionRead && allocationNextvalRead > allocationLockRead && allocationLockGate > allocationNextvalRead && allocationLockGate < restoreSuccessToken, 'sequence allocation lock is not audited before nextval and restore success');

for (const contract of [
  'portfolio_catalogue_security_v1',
  "'auth_required'",
  "'auth_owners'",
  "'supabase_auth_admin'",
  "has_database_privilege('supabase_auth_admin', current_database(), 'CONNECT')",
  "has_schema_privilege('supabase_auth_admin', 'auth', 'USAGE')",
  "has_schema_privilege('supabase_auth_admin', 'auth', 'CREATE')",
  "has_table_privilege('supabase_auth_admin', 'auth.users', 'SELECT')",
  "'schema_acl'",
  "'relation_acl'",
  "'column_acl'",
  "'function_acl'",
  "'type_acl'",
  "'default_acl'",
  "'policy'",
  "'trigger'",
  "'publication'"
]) check(has(catalogueSecurity, contract), `catalogue security query omits contract: ${contract}`);
check(!/rolpassword|password/i.test(catalogueSecurity), 'catalogue security query reads password material');
check(has(catalogueSecurity, "role.rolname <> 'portfolio_rpc'") && has(catalogueSecurity, "schema.nspname <> 'private'"), 'catalogue security query does not isolate the separately audited Portfolio role and private schema contract');
check(!has(catalogueSecurity, "relation.relname like 'portfolio_%'") && !has(catalogueSecurity, "function.proname like 'portfolio_%'") && !has(catalogueSecurity, "type.typname like 'portfolio_%'"), 'catalogue security query broadly excludes Portfolio-prefixed objects');
for (const canonical of [
  "('portfolio_records', 'r')",
  "('portfolio_change_seq', 'S')",
  "('portfolio_records_pkey', 'i')",
  "('portfolio_records_sync_idx', 'i')",
  "policy.polname in (",
  "schema.nspname = 'auth' and relation.relname = 'users'"
]) check(has(catalogueSecurity, canonical), `catalogue security query omits an exact canonical Portfolio exclusion: ${canonical}`);
for (const signature of [
  'portfolio_stamp_record()',
  'portfolio_bind_auth_user()',
  'portfolio_upsert_record(text,text,jsonb,integer,bigint)',
  'portfolio_delete_record(text,text,bigint)',
  'portfolio_restore_record(text,text,jsonb,integer,bigint)',
  'portfolio_restore_record(text,text,bigint)',
  'portfolio_get_records_page(bigint,bigint,integer)',
  'portfolio_sync_page(bigint,integer)',
  'portfolio_sync_boundary()'
]) check(has(catalogueSecurity, `to_regprocedure('public.${signature}')::oid`), `catalogue security query omits exact canonical function exclusion: ${signature}`);

// Synthetic path-boundary probes. These execute only the early fail-closed
// guards with fake Git output and temporary fixtures, never Docker, age, or
// a real database. The fixture root is outside the checkout and is removed
// after each probe.
const checkoutRoot = path.resolve(appDir, '..');
const isInsideCheckout = (candidate) => {
  const relative = path.relative(checkoutRoot, path.resolve(candidate));
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
};
check(isInsideCheckout(path.join(checkoutRoot, 'CLAUDE.md')), 'synthetic repo-root sibling is not classified inside the checkout');
check(isInsideCheckout(path.join(appDir, '..')), 'synthetic traversal to the checkout root is not classified inside the checkout');
check(!isInsideCheckout(path.join(checkoutRoot, '..', 'portfolio-boundary-external')), 'synthetic path outside the checkout is classified inside the checkout');

function runBoundaryProbe(script, args, environment) {
  return spawnSync('bash', [script, ...args], {
    cwd: checkoutRoot,
    env: environment,
    encoding: 'utf8'
  });
}

const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'portfolio-nas-boundary-'));
try {
  const fixtureBin = path.join(fixtureRoot, 'bin');
  const upstreamRoot = path.join(fixtureRoot, 'upstream');
  const upstreamDocker = path.join(upstreamRoot, 'docker');
  const externalRoot = path.join(fixtureRoot, 'external');
  const publicRoot = path.join(externalRoot, 'public');
  fs.mkdirSync(fixtureBin, { recursive: true });
  fs.mkdirSync(upstreamDocker, { recursive: true });
  fs.mkdirSync(publicRoot, { recursive: true });
  fs.writeFileSync(path.join(upstreamDocker, 'docker-compose.yml'), 'services: {}\n');
  const fakeGit = path.join(fixtureBin, 'git');
  fs.writeFileSync(fakeGit, `#!/bin/sh
case "$*" in
  *"--show-toplevel"*) printf '%s\\n' '${checkoutRoot.replace(/'/g, "'\\''")}' ;;
  *"rev-parse HEAD"*) printf '%s\\n' '241bb11c0627f2981746d37033f57dbfa81d29b0' ;;
  *) exit 1 ;;
esac
`);
  fs.chmodSync(fakeGit, 0o700);
  const envFile = path.join(externalRoot, 'env');
  fs.writeFileSync(envFile, [
    `PORTFOLIO_SCHEMA_FILE=${path.join(appDir, 'Supabase/schema.sql')}`,
    `PORTFOLIO_CADDYFILE=${path.join(nasDir, 'Caddyfile')}`,
    `PORTFOLIO_PUBLIC_DIR=${publicRoot}`,
    'PORTFOLIO_AGE_RECIPIENT=age1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq',
    'PORTFOLIO_DB_NAME=portfolio',
    'PORTFOLIO_PRODUCTION_DB=portfolio',
    'PORTFOLIO_PRODUCTION_CONTAINER=portfolio-db'
  ].join('\n') + '\n');
  fs.chmodSync(envFile, 0o600);
  const archiveFile = path.join(externalRoot, 'archive.age');
  const identityFile = path.join(externalRoot, 'identity');
  fs.writeFileSync(archiveFile, 'synthetic archive');
  fs.writeFileSync(identityFile, 'synthetic identity');
  fs.chmodSync(archiveFile, 0o600);
  fs.chmodSync(identityFile, 0o600);
  const probeEnv = {
    ...process.env,
    PATH: `${fixtureBin}${path.delimiter}${process.env.PATH || ''}`
  };
  const backupScript = files.backup;
  const restoreScript = files.restore;
  const runbookScript = files.runbook;
  const backupArgs = ['--upstream', upstreamRoot, '--env-file', envFile, '--backup-dir', externalRoot];

  const earlyCommandLog = path.join(externalRoot, 'early-database-commands.log');
  for (const command of ['docker', 'psql', 'pg_dump', 'pg_dumpall', 'pg_restore']) {
    const shim = path.join(fixtureBin, command);
    fs.writeFileSync(shim, `#!/bin/sh
printf '%s\\n' '${command} $*' >> '${earlyCommandLog.replace(/'/g, "'\\''")}'
exit 97
`);
    fs.chmodSync(shim, 0o700);
  }
  const baseEnvLines = fs.readFileSync(envFile, 'utf8').trimEnd().split('\n');
  const directEnv = (name, lines, separator = '\n') => {
    const file = path.join(externalRoot, name);
    fs.writeFileSync(file, `${lines.join(separator)}${separator}`);
    fs.chmodSync(file, 0o600);
    return file;
  };
  const correctSchema = `PORTFOLIO_SCHEMA_FILE=${path.join(appDir, 'Supabase/schema.sql')}`;
  const wrongSchema = `PORTFOLIO_SCHEMA_FILE=${path.join(checkoutRoot, 'Trading', 'index.html')}`;
  const directEnvProbes = [
    {
      name: 'direct-duplicate-first-good.env',
      file: directEnv('direct-duplicate-first-good.env', [...baseEnvLines, wrongSchema]),
      expected: /env file contains duplicate key: PORTFOLIO_SCHEMA_FILE/
    },
    {
      name: 'direct-duplicate-first-bad.env',
      file: directEnv('direct-duplicate-first-bad.env', [wrongSchema, ...baseEnvLines.slice(1), correctSchema]),
      expected: /env file contains duplicate key: PORTFOLIO_SCHEMA_FILE/
    },
    {
      name: 'direct-malformed.env',
      file: directEnv('direct-malformed.env', [`export ${correctSchema}`, ...baseEnvLines.slice(1)]),
      expected: /env file contains an invalid assignment/
    },
    {
      name: 'direct-crlf.env',
      file: directEnv('direct-crlf.env', baseEnvLines, '\r\n'),
      expected: /env file contains a carriage return/
    }
  ];
  for (const probe of directEnvProbes) {
    const directBackup = runBoundaryProbe(backupScript, [
      '--upstream', upstreamRoot,
      '--env-file', probe.file,
      '--backup-dir', externalRoot
    ], probeEnv);
    check(directBackup.status !== 0 && probe.expected.test(directBackup.stderr), `backup accepted ${probe.name}`);

    const directRestore = runBoundaryProbe(restoreScript, [
      '--archive', archiveFile,
      '--env-file', probe.file,
      '--identity-file', identityFile
    ], probeEnv);
    check(directRestore.status !== 0 && probe.expected.test(directRestore.stderr), `restore accepted ${probe.name}`);
  }
  check(!fs.existsSync(earlyCommandLog) || fs.readFileSync(earlyCommandLog, 'utf8') === '', 'invalid direct-script env probes invoked Docker or a database command');

  const backupRootSibling = runBoundaryProbe(backupScript, [
    '--upstream', upstreamRoot,
    '--env-file', path.join(checkoutRoot, 'CLAUDE.md'),
    '--backup-dir', externalRoot
  ], probeEnv);
  check(backupRootSibling.status !== 0 && /env file must be outside/.test(backupRootSibling.stderr), 'backup accepted an env file in a checkout-root sibling');

  const backupRootDestination = runBoundaryProbe(backupScript, [
    ...backupArgs.slice(0, 4),
    '--backup-dir', path.join(checkoutRoot, 'Portfolio', '..')
  ], probeEnv);
  check(backupRootDestination.status !== 0 && /backup directory must be outside/.test(backupRootDestination.stderr), 'backup accepted a traversal destination at the checkout root');

  const envSymlink = path.join(externalRoot, 'env-link');
  fs.symlinkSync(envFile, envSymlink);
  const backupSymlink = runBoundaryProbe(backupScript, [
    '--upstream', upstreamRoot,
    '--env-file', envSymlink,
    '--backup-dir', externalRoot
  ], probeEnv);
  check(backupSymlink.status !== 0 && /regular, non-symlink/.test(backupSymlink.stderr), 'backup accepted a symlinked secret env file');

  const runbookRootSibling = runBoundaryProbe(runbookScript, [
    'check',
    '--upstream', upstreamRoot,
    '--env-file', path.join(checkoutRoot, 'CLAUDE.md')
  ], probeEnv);
  check(runbookRootSibling.status !== 0 && /env file must be outside/.test(runbookRootSibling.stderr), 'runbook accepted a secret env file in a checkout-root sibling');

  const runbookEnv = (name, publicDir) => {
    const file = path.join(externalRoot, name);
    fs.writeFileSync(file, [
      `PORTFOLIO_SCHEMA_FILE=${path.join(appDir, 'Supabase/schema.sql')}`,
      `PORTFOLIO_CADDYFILE=${path.join(nasDir, 'Caddyfile')}`,
      `PORTFOLIO_MARKET_BUILD_CONTEXT=${nasDir}`,
      `PORTFOLIO_PUBLIC_DIR=${publicDir}`,
      'PORTFOLIO_AGE_RECIPIENT=age1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq',
      'PORTFOLIO_API_GW_HTTP_PORT=8000'
    ].join('\n') + '\n');
    fs.chmodSync(file, 0o600);
    return file;
  };

  const populatePublicTree = (root) => {
    for (const asset of publicAssetPaths) {
      const target = path.join(root, asset);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      const source = path.join(appDir, asset);
      if (fs.existsSync(source)) fs.copyFileSync(source, target);
      else fs.writeFileSync(target, 'synthetic public asset\n');
    }
  };

  const assertRunbookRejectsPublicVariant = (name, mutate, expected, message) => {
    const root = path.join(externalRoot, name);
    populatePublicTree(root);
    mutate(root);
    const variantEnv = runbookEnv(`${name}.env`, root);
    const probe = runBoundaryProbe(runbookScript, [
      'check',
      '--upstream', upstreamRoot,
      '--env-file', variantEnv
    ], probeEnv);
    check(probe.status !== 0 && expected.test(probe.stderr), message);
  };

  assertRunbookRejectsPublicVariant(
    'public-extra-root',
    (root) => fs.writeFileSync(path.join(root, 'debug.txt'), 'synthetic extra file\n'),
    /unapproved asset: debug\.txt/,
    'runbook accepted an extra root public file'
  );
  assertRunbookRejectsPublicVariant(
    'public-extra-nested',
    (root) => fs.writeFileSync(path.join(root, 'Worker', 'debug.js'), 'synthetic nested extra file\n'),
    /unapproved asset: Worker\/debug\.js/,
    'runbook accepted an extra nested public file'
  );
  assertRunbookRejectsPublicVariant(
    'public-extra-directory',
    (root) => fs.mkdirSync(path.join(root, 'debug-directory')),
    /unapproved directory: debug-directory/,
    'runbook accepted an extra public directory'
  );
  assertRunbookRejectsPublicVariant(
    'public-top-level-symlink',
    (root) => fs.symlinkSync(path.join(root, 'index.html'), path.join(root, 'index-link.html')),
    /contains a symlink: index-link\.html/,
    'runbook accepted a top-level public symlink'
  );
  assertRunbookRejectsPublicVariant(
    'public-nested-symlink',
    (root) => fs.symlinkSync(path.join(root, 'index.html'), path.join(root, 'Worker', 'index-link.js')),
    /contains a symlink: Worker\/index-link\.js/,
    'runbook accepted a nested public symlink'
  );

  const duplicatePublicRoot = path.join(externalRoot, 'duplicate-public');
  populatePublicTree(duplicatePublicRoot);
  const duplicateSchemaBad = path.join(checkoutRoot, 'Trading', 'index.html');
  const duplicateFirstGoodEnv = runbookEnv('duplicate-first-good.env', duplicatePublicRoot);
  fs.appendFileSync(duplicateFirstGoodEnv, `PORTFOLIO_SCHEMA_FILE=${duplicateSchemaBad}\n`);
  const duplicateFirstGood = runBoundaryProbe(runbookScript, [
    'check',
    '--upstream', upstreamRoot,
    '--env-file', duplicateFirstGoodEnv
  ], probeEnv);
  check(duplicateFirstGood.status !== 0 && /env file contains duplicate key: PORTFOLIO_SCHEMA_FILE/.test(duplicateFirstGood.stderr), 'runbook accepted a first-good, last-bad duplicate env key');

  const duplicateFirstBadEnv = runbookEnv('duplicate-first-bad.env', duplicatePublicRoot);
  const duplicateFirstBadLines = fs.readFileSync(duplicateFirstBadEnv, 'utf8').trimEnd().split('\n');
  duplicateFirstBadLines[0] = `PORTFOLIO_SCHEMA_FILE=${duplicateSchemaBad}`;
  fs.writeFileSync(duplicateFirstBadEnv, `${duplicateFirstBadLines.join('\n')}\n`);
  fs.appendFileSync(duplicateFirstBadEnv, `PORTFOLIO_SCHEMA_FILE=${path.join(appDir, 'Supabase/schema.sql')}\n`);
  fs.chmodSync(duplicateFirstBadEnv, 0o600);
  const duplicateFirstBad = runBoundaryProbe(runbookScript, [
    'check',
    '--upstream', upstreamRoot,
    '--env-file', duplicateFirstBadEnv
  ], probeEnv);
  check(duplicateFirstBad.status !== 0 && /env file contains duplicate key: PORTFOLIO_SCHEMA_FILE/.test(duplicateFirstBad.stderr), 'runbook accepted a first-bad, last-good duplicate env key');

  const renderedPublicRoot = path.join(externalRoot, 'rendered-public');
  populatePublicTree(renderedPublicRoot);
  const renderedEnv = runbookEnv('rendered-path-mismatch.env', renderedPublicRoot);
  const renderedBin = path.join(fixtureRoot, 'rendered-bin');
  fs.mkdirSync(renderedBin, { recursive: true });
  const renderedGit = path.join(renderedBin, 'git');
  fs.copyFileSync(fakeGit, renderedGit);
  fs.chmodSync(renderedGit, 0o700);
  const renderedAge = path.join(renderedBin, 'age');
  fs.writeFileSync(renderedAge, '#!/bin/sh\nexit 0\n');
  fs.chmodSync(renderedAge, 0o700);
  const renderedConfig = {
    services: {
      'api-gw': {
        ports: [{ host_ip: '127.0.0.1', published: 8000, target: 8000, protocol: 'tcp' }]
      },
      caddy: {
        ports: [{ host_ip: '127.0.0.1', published: 8080, target: 8080, protocol: 'tcp' }],
        volumes: [
          { type: 'bind', source: renderedPublicRoot, target: '/srv/portfolio-public', read_only: true },
          { type: 'bind', source: path.join(nasDir, 'Caddyfile'), target: '/etc/caddy/Caddyfile', read_only: true }
        ]
      },
      db: {
        volumes: [
          { type: 'bind', source: path.join(externalRoot, 'wrong-schema.sql'), target: '/docker-entrypoint-initdb.d/migrations/zz-portfolio.sql', read_only: true }
        ]
      },
      'portfolio-market': {
        build: { context: nasDir, dockerfile: 'Market Dockerfile' }
      }
    }
  };
  const renderedJson = JSON.stringify(renderedConfig).replace(/'/g, "'\\''");
  const renderedDocker = path.join(renderedBin, 'docker');
  fs.writeFileSync(renderedDocker, `#!/bin/sh
case "$*" in
  *"compose version --short"*) printf '%s\\n' '2.24.4' ;;
  *"config --format json"*) printf '%s\\n' '${renderedJson}' ;;
  *"config --quiet"*) exit 0 ;;
  *) exit 1 ;;
esac
`);
  fs.chmodSync(renderedDocker, 0o700);
  const renderedProbe = runBoundaryProbe(runbookScript, [
    'check',
    '--upstream', upstreamRoot,
    '--env-file', renderedEnv
  ], {
    ...probeEnv,
    PATH: `${renderedBin}${path.delimiter}${process.env.PATH || ''}`
  });
  check(renderedProbe.status !== 0 && /rendered Compose database schema mount source or syntax mismatch/.test(renderedProbe.stderr), 'runbook accepted a rendered Compose schema mount source mismatch');

  const runbookSiblingEnv = runbookEnv('runbook-sibling.env', path.join(checkoutRoot, 'Trading'));
  const runbookRootPublic = runBoundaryProbe(runbookScript, [
    'check',
    '--upstream', upstreamRoot,
    '--env-file', runbookSiblingEnv
  ], probeEnv);
  check(runbookRootPublic.status !== 0 && /curated public directory must be outside/.test(runbookRootPublic.stderr), 'runbook accepted a curated public directory in a checkout sibling');

  const runbookEnvSymlink = path.join(externalRoot, 'runbook-env-link');
  fs.symlinkSync(runbookSiblingEnv, runbookEnvSymlink);
  const runbookSymlinkSecret = runBoundaryProbe(runbookScript, [
    'check',
    '--upstream', upstreamRoot,
    '--env-file', runbookEnvSymlink
  ], probeEnv);
  check(runbookSymlinkSecret.status !== 0 && /env file must be a regular, non-symlink file/.test(runbookSymlinkSecret.stderr), 'runbook accepted a symlinked secret env file');

  const runbookNestedEnv = runbookEnv('runbook-nested.env', path.join(appDir, '..', 'Trading', 'Worker'));
  const runbookNestedPublic = runBoundaryProbe(runbookScript, [
    'check',
    '--upstream', upstreamRoot,
    '--env-file', runbookNestedEnv
  ], probeEnv);
  check(runbookNestedPublic.status !== 0 && /curated public directory must be outside/.test(runbookNestedPublic.stderr), 'runbook accepted a nested path inside the checkout');

  const runbookPublicSymlink = path.join(externalRoot, 'runbook-public-link');
  fs.symlinkSync(path.join(checkoutRoot, 'Trading'), runbookPublicSymlink);
  const runbookSymlinkEnv = runbookEnv('runbook-symlink.env', runbookPublicSymlink);
  const runbookSymlinkPublic = runBoundaryProbe(runbookScript, [
    'check',
    '--upstream', upstreamRoot,
    '--env-file', runbookSymlinkEnv
  ], probeEnv);
  check(runbookSymlinkPublic.status !== 0 && /curated public directory must be an existing, non-symlink directory/.test(runbookSymlinkPublic.stderr), 'runbook accepted a symlinked curated public directory');

  const runbookCheckoutLink = path.join(fixtureRoot, 'runbook-checkout-link');
  fs.symlinkSync(path.join(checkoutRoot, 'Trading'), runbookCheckoutLink);
  const runbookNestedSymlinkEnv = runbookEnv('runbook-nested-symlink.env', path.join(runbookCheckoutLink, 'Worker'));
  const runbookNestedSymlink = runBoundaryProbe(runbookScript, [
    'check',
    '--upstream', upstreamRoot,
    '--env-file', runbookNestedSymlinkEnv
  ], probeEnv);
  check(runbookNestedSymlink.status !== 0 && /curated public directory must be outside/.test(runbookNestedSymlink.stderr), 'runbook accepted a nested path through a symlink into the checkout');

  const fallbackRoot = path.join(fixtureRoot, 'fallback-checkout');
  const fallbackNas = path.join(fallbackRoot, 'Portfolio', 'NAS');
  const fallbackSibling = path.join(fallbackRoot, 'Trading');
  const fallbackSiblingDocker = path.join(fallbackSibling, 'docker');
  const fallbackGitMeta = path.join(fixtureRoot, 'fallback-git-meta');
  const fallbackBin = path.join(fixtureRoot, 'fallback-bin');
  fs.mkdirSync(fallbackNas, { recursive: true });
  fs.mkdirSync(fallbackSiblingDocker, { recursive: true });
  fs.mkdirSync(fallbackGitMeta, { recursive: true });
  fs.mkdirSync(fallbackBin, { recursive: true });
  fs.writeFileSync(path.join(fallbackSiblingDocker, 'docker-compose.yml'), 'services: {}\n');
  fs.writeFileSync(path.join(fallbackRoot, '.git'), `gitdir: ${fallbackGitMeta}\n`);
  fs.writeFileSync(path.join(fallbackGitMeta, 'HEAD'), 'ref: refs/heads/main\n');
  fs.writeFileSync(path.join(fallbackGitMeta, 'commondir'), '../..\n');
  fs.writeFileSync(path.join(fallbackGitMeta, 'gitdir'), `${path.join(fallbackRoot, '.git')}\n`);
  const fallbackRunbook = path.join(fallbackNas, 'runbook.sh');
  fs.copyFileSync(runbookScript, fallbackRunbook);
  fs.chmodSync(fallbackRunbook, 0o700);
  const fallbackGit = path.join(fallbackBin, 'git');
  fs.writeFileSync(fallbackGit, `#!/bin/sh
case "$*" in
  *"--show-toplevel"*) exit 1 ;;
  *"rev-parse HEAD"*) printf '%s\\n' '241bb11c0627f2981746d37033f57dbfa81d29b0' ;;
  *) exit 1 ;;
esac
`);
  fs.chmodSync(fallbackGit, 0o700);
  const fallbackEnv = {
    ...probeEnv,
    PATH: `${fallbackBin}${path.delimiter}${process.env.PATH || ''}`
  };
  const fallbackSiblingProbe = runBoundaryProbe(fallbackRunbook, [
    'verify-upstream', fallbackSibling
  ], fallbackEnv);
  check(fallbackSiblingProbe.status !== 0 && /upstream checkout must be outside this worktree/.test(fallbackSiblingProbe.stderr), 'runbook fallback accepted a sibling inside the checkout');

  const restoreRootSource = runBoundaryProbe(restoreScript, [
    '--archive', path.join(checkoutRoot, 'CLAUDE.md'),
    '--env-file', envFile
  ], probeEnv);
  check(restoreRootSource.status !== 0 && /archive must be outside/.test(restoreRootSource.stderr), 'restore accepted an archive from a checkout-root sibling');

  const archiveSymlink = path.join(externalRoot, 'archive-link.age');
  fs.symlinkSync(archiveFile, archiveSymlink);
  const restoreSymlink = runBoundaryProbe(restoreScript, [
    '--archive', archiveSymlink,
    '--env-file', envFile,
    '--identity-file', identityFile
  ], probeEnv);
  check(restoreSymlink.status !== 0 && /regular, non-symlink/.test(restoreSymlink.stderr), 'restore accepted a symlinked archive source');

  const restoreRootIdentity = runBoundaryProbe(restoreScript, [
    '--archive', archiveFile,
    '--env-file', envFile,
    '--identity-file', path.join(checkoutRoot, 'CLAUDE.md')
  ], probeEnv);
  check(restoreRootIdentity.status !== 0 && /age identity must be outside/.test(restoreRootIdentity.stderr), 'restore accepted key material in the checkout');

  const restoreRootTemp = runBoundaryProbe(restoreScript, [
    '--archive', archiveFile,
    '--env-file', envFile,
    '--identity-file', identityFile
  ], { ...probeEnv, TMPDIR: path.join(checkoutRoot, 'Portfolio') });
  check(restoreRootTemp.status !== 0 && /temporary directory base must be outside/.test(restoreRootTemp.stderr), 'restore accepted a decrypted temporary directory in the checkout');

  const tempSymlink = path.join(fixtureRoot, 'tmp-link');
  fs.symlinkSync(publicRoot, tempSymlink);
  const restoreSymlinkTemp = runBoundaryProbe(restoreScript, [
    '--archive', archiveFile,
    '--env-file', envFile,
    '--identity-file', identityFile
  ], { ...probeEnv, TMPDIR: tempSymlink });
  check(restoreSymlinkTemp.status !== 0 && /temporary directory base must be an absolute, existing directory/.test(restoreSymlinkTemp.stderr), 'restore accepted a symlinked temporary directory base');

  // Exercise the complete offline verification path with synthetic command
  // shims, then prove the apply guard stops before any database command. No
  // Docker daemon, database, real archive, key, or user data is touched.
  const commandLog = path.join(externalRoot, 'restore-commands.log');
  const fakeAge = path.join(fixtureBin, 'age');
  fs.writeFileSync(fakeAge, `#!/bin/sh
output=''
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) output="$2"; shift 2 ;;
    *) shift ;;
  esac
done
[ -n "$output" ] || exit 1
printf '%s\n' 'synthetic encrypted bytes' > "$output"
`);
  fs.chmodSync(fakeAge, 0o700);
  const fakeTar = path.join(fixtureBin, 'tar');
  fs.writeFileSync(fakeTar, `#!/bin/sh
case "$1" in
  -tf)
    printf '%s\n' env roles.sql portfolio.dump catalogue.sha256 manifest.sha256
    ;;
  -tvf)
    printf '%s\n' '-rw------- 0/0 1 env' '-rw------- 0/0 1 roles.sql' '-rw------- 0/0 1 portfolio.dump' '-rw------- 0/0 1 catalogue.sha256' '-rw------- 0/0 1 manifest.sha256'
    ;;
  -xf)
    destination=''
    while [ "$#" -gt 0 ]; do
      case "$1" in
        -C) destination="$2"; shift 2 ;;
        *) shift ;;
      esac
    done
    [ -n "$destination" ] || exit 1
    printf '%s\n' synthetic > "$destination/env"
    printf '%s\n' synthetic > "$destination/roles.sql"
    printf '%s\n' synthetic > "$destination/portfolio.dump"
    hash='0000000000000000000000000000000000000000000000000000000000000000'
    printf '%s\n' "$hash" > "$destination/catalogue.sha256"
    printf '%s  %s\n' "$hash" env "$hash" roles.sql "$hash" portfolio.dump "$hash" catalogue.sha256 > "$destination/manifest.sha256"
    ;;
  *) exit 1 ;;
esac
`);
  fs.chmodSync(fakeTar, 0o700);
  const fakeSha256 = path.join(fixtureBin, 'sha256sum');
  fs.writeFileSync(fakeSha256, `#!/bin/sh
if [ "\${1}" = '-c' ]; then exit 0; fi
hash='0000000000000000000000000000000000000000000000000000000000000000'
case "\${1}" in
  *restored-catalogue-security.txt) hash="\${SYNTHETIC_CATALOGUE_SHA:-$hash}" ;;
esac
printf '%s  %s\n' "$hash" "\${1}"
`);
  fs.chmodSync(fakeSha256, 0o700);
  const fakeDocker = path.join(fixtureBin, 'docker');
  fs.writeFileSync(fakeDocker, `#!/bin/sh
printf '%s\n' "$*" >> '${commandLog.replace(/'/g, "'\\''")}'
if [ "$1" = 'compose' ]; then exit 0; fi
[ "$1" = 'exec' ] || exit 1
shift
if [ "$1" = '-i' ]; then shift; fi
shift
command="$1"
shift
case "$command" in
  psql)
    case "$*" in
      *"to_regclass"*) printf '%s\n' empty ;;
      *"pg_class"*) printf '%s\n' '0|0' ;;
      *"--file=-"*)
        payload="$(cat)"
        if printf '%s' "$payload" | grep -q 'portfolio_restore_security_ok'; then
          printf '%s\n' 'portfolio-security-audit' >> '${commandLog.replace(/'/g, "'\\''")}'
          printf '%s\n' "\${SYNTHETIC_SECURITY_RESULT:-portfolio_restore_security_ok}"
        elif printf '%s' "$payload" | grep -q 'portfolio_catalogue_security_v1'; then
          printf '%s\n' 'catalogue-security-audit' >> '${commandLog.replace(/'/g, "'\\''")}'
          if [ "\${SYNTHETIC_AUTH_REQUIRED:-true}" = 'true' ]; then
            printf '%s\n' '["auth_required", true, true, true, true, true, true, true, true, true, true, true]'
          fi
          printf '%s\n' '["contract", "portfolio_catalogue_security_v1"]'
        fi
        ;;
      *) exit 1 ;;
    esac
    ;;
  pg_dump) printf '%s\n' 'synthetic dump' ;;
  pg_dumpall) printf '%s\n' 'synthetic roles' ;;
  pg_restore) command cat >/dev/null ;;
  *) exit 1 ;;
esac
`);
  fs.chmodSync(fakeDocker, 0o700);

  const restoreArgs = (restoreEnv) => [
    '--archive', archiveFile,
    '--env-file', restoreEnv,
    '--identity-file', identityFile,
    '--upstream', upstreamRoot,
    '--staging-db', 'portfolio_staging',
    '--staging-container', 'portfolio-staging-db',
    '--receipt-dir', externalRoot,
    '--apply-staging'
  ];
  const restoreProbeEnv = {
    ...probeEnv,
    PORTFOLIO_RESTORE_CONFIRM: 'RESTORE_PORTFOLIO_TO_EMPTY_STAGING'
  };
  const zeroHash = '0000000000000000000000000000000000000000000000000000000000000000';
  const pinnedApplyEnv = directEnv('restore-apply-pinned.env', [
    ...baseEnvLines,
    `PORTFOLIO_ARCHIVE_SHA256=${zeroHash}`,
    `PORTFOLIO_CANONICAL_RELEASE_SHA256=${zeroHash}`
  ]);
  const targetMarker = path.join(externalRoot, 'synthetic-target.marker');
  fs.writeFileSync(targetMarker, 'untouched\n');
  fs.rmSync(commandLog, { force: true });

  const blockedApply = runBoundaryProbe(restoreScript, restoreArgs(pinnedApplyEnv), restoreProbeEnv);
  check(blockedApply.status !== 0 && /staged restore is disabled: no verified fresh-target\/platform bootstrap contract is configured/.test(blockedApply.stderr), 'restore apply did not stop on the missing fresh-target/platform contract');
  check(!/Staged restore applied/.test(blockedApply.stdout), 'restore reported success after the hard-disabled apply gate');
  check(!fs.existsSync(commandLog) || fs.readFileSync(commandLog, 'utf8') === '', 'hard-disabled restore apply invoked Docker or a database command');
  check(fs.readFileSync(targetMarker, 'utf8') === 'untouched\n', 'hard-disabled restore apply changed the synthetic target marker');

  const mismatchedApplyEnv = directEnv('restore-apply-mismatched.env', [
    ...baseEnvLines,
    `PORTFOLIO_ARCHIVE_SHA256=${'1'.repeat(64)}`,
    `PORTFOLIO_CANONICAL_RELEASE_SHA256=${zeroHash}`
  ]);
  const mismatchedApply = runBoundaryProbe(restoreScript, restoreArgs(mismatchedApplyEnv), restoreProbeEnv);
  check(mismatchedApply.status !== 0 && /operator-pinned archive SHA-256 does not match/.test(mismatchedApply.stderr), 'restore accepted an archive whose operator pin did not match');
  check(!fs.existsSync(commandLog) || fs.readFileSync(commandLog, 'utf8') === '', 'mismatched restore pin invoked Docker or a database command');
  check(fs.readFileSync(targetMarker, 'utf8') === 'untouched\n', 'mismatched restore pin changed the synthetic target marker');

  const verifyOnly = runBoundaryProbe(restoreScript, [
    '--archive', archiveFile,
    '--env-file', envFile,
    '--identity-file', identityFile
  ], probeEnv);
  check(verifyOnly.status === 0 && /Verified encrypted backup\. No database action was taken\./.test(verifyOnly.stdout), `restore verify-only mode was blocked: ${verifyOnly.stderr}`);
} finally {
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
}

check(has(runbook, 'verify-upstream PATH') && has(runbook, 'never clones or downloads'), 'runbook upstream verification boundary is unclear');
check(has(runbook, 'check --upstream PATH --env-file PATH'), 'runbook check command is missing');
check(has(runbook, 'Not executed') && has(runbook, 'up -d') && has(runbook, ' stop'), 'runbook start and stop are not manual-only');
check(has(runbook, 'staged apply is hard-disabled') && has(runbook, 'Staged restore remains disabled') && has(runbook, 'No restore command was executed'), 'runbook does not report the hard-disabled restore gate');
check(has(runbook, 'tailscale serve --bg --yes --https=443 http://127.0.0.1:8080'), 'runbook does not document the exact Tailscale Serve command');
check(has(runbook, 'git -C "$SCRIPT_DIR" rev-parse --show-toplevel'), 'runbook does not derive the checkout root from the script directory');
check(has(runbook, 'resolve_checkout_root') && has(runbook, 'SCRIPT_DIR/../..') && has(runbook, 'gitdir'), 'runbook fallback does not require matching .git worktree evidence');
check(has(runbook, 'CHECKOUT_ROOT') && has(runbook, 'APP_ROOT') && !has(runbook, 'REPO_ROOT="'), 'runbook does not keep separate checkout and app roots');
check(has(runbook, 'expected_schema="$APP_ROOT/Supabase/schema.sql"') && has(runbook, 'schema_file="$('), 'runbook does not canonicalise and validate the exact schema path');
check(has(runbook, 'PORTFOLIO_PUBLIC_DIR') && has(runbook, 'REQUIRED_PUBLIC_ASSETS') && has(runbook, 'never copies or deletes'), 'runbook does not validate and list curated public assets');
for (const asset of ['Worker/kjr-migration.js', 'Worker/supabase.js', 'Worker/kjr-nas.js']) {
  check(has(runbook, asset), `curated public asset list is missing ${asset}`);
}
const sourceScripts = Array.from(indexHtml.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g))
  .map((match) => match[1].split('?')[0])
  .filter((src) => !/^(?:https?:)?\/\//.test(src));
for (const asset of sourceScripts) {
  check(has(runbook, asset), `curated public asset list does not cover index.html script ${asset}`);
}
check(has(runbook, 'check_source_script_assets') && has(runbook, 'grep -Eo'), 'runbook does not cross-check current index.html scripts');
check(has(runbook, 'expected_caddy="$NAS_DIR/Caddyfile"'), 'runbook does not validate the exact Caddyfile path');
check(has(runbook, 'canonical_temp_dir') && has(runbook, 'inside_repo "$AUDIT_BASE"') && has(runbook, 'inside_repo "$AUDIT_TMP"'), 'runbook does not keep the merged Compose audit workspace outside the checkout');
const runbookPublicAssetMatch = runbook.match(/REQUIRED_PUBLIC_ASSETS=\(\n([\s\S]*?)\n\)/);
const runbookPublicAssetPaths = runbookPublicAssetMatch
  ? runbookPublicAssetMatch[1].split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  : [];
check(JSON.stringify(runbookPublicAssetPaths) === JSON.stringify(publicAssetPaths), 'runbook public asset allowlist is not exact');
check(has(runbook, 'audit_merged_ports') && has(runbook, 'config --format json') && has(runbook, 'jq'), 'runbook lacks a merged Compose JSON port audit');
check(has(runbook, 'audit_rendered_paths') && has(runbook, 'schema_target="/docker-entrypoint-initdb.d/migrations/zz-portfolio.sql"') && has(runbook, 'public_target="/srv/portfolio-public"') && has(runbook, 'caddy_target="/etc/caddy/Caddyfile"'), 'runbook lacks canonical rendered Compose path targets');
check(has(runbook, 'schema_matches') && has(runbook, 'public_matches') && has(runbook, 'caddy_matches') && has(runbook, 'market_matches'), 'rendered Compose path audit does not compare all controlled paths');
const renderedConfigCall = runbook.indexOf('config --format json >');
const renderedPathAuditCall = runbook.indexOf('audit_rendered_paths "$AUDIT_TMP/compose.json"');
check(renderedConfigCall >= 0 && renderedPathAuditCall > renderedConfigCall, 'rendered Compose path audit does not follow JSON rendering');
check(has(runbook, '$service.key == "api-gw"') && has(runbook, '$service.key == "caddy"') && has(runbook, 'publishes an unapproved host port'), 'merged port audit does not enforce the two approved loopback bindings');
check(has(runbook, 'api_count" == 1 && "$caddy_count" == 1'), 'merged port audit does not require exactly one gateway and Caddy binding');
check(!/docker\s+compose\s+(?:up|down|start|stop|restart)\b/.test(runbook.replace(/printf[^\n]*\n/g, '')), 'runbook executes a service lifecycle action');
check(has(runbook, 'encrypted off-site copy') && has(runbook, 'real staged restore test'), 'runbook cutover gates are incomplete');
check(!/git\s+clone|\bcurl\b|\bwget\b/i.test(runbook), 'runbook contains a download or network action');

check(has(marketDockerfile, 'FROM node:24.20.0-bookworm-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e'), 'market Dockerfile does not use the pinned Node image');
check(has(marketDockerfile, 'COPY --chown=node:node ["Market Service.js", "/opt/portfolio-market/Market Service.js"]'), 'market Dockerfile does not copy the checked-in service');
check(has(marketDockerfile, 'USER node') && has(marketDockerfile, 'ENV NODE_ENV=production'), 'market Dockerfile does not run as the unprivileged node user');
check(has(marketDockerfile, 'EXPOSE 8081') && has(marketDockerfile, 'CMD ["node", "/opt/portfolio-market/Market Service.js"]'), 'market Dockerfile entrypoint or internal port is missing');
check(!/npm\s+(?:install|ci|run)|yarn|pnpm|curl|wget|git\s+clone/i.test(marketDockerfile), 'market Dockerfile adds dependencies or a download step');

check(has(overlay, 'portfolio-market:') && has(overlay, 'context: "${PORTFOLIO_MARKET_BUILD_CONTEXT:?set absolute market service context}"'), 'internal market service build context is missing');
check(has(overlay, 'dockerfile: "Market Dockerfile"') && has(overlay, 'image: portfolio-market:node-24.20.0'), 'internal market service image definition is incomplete');
check(has(overlay, 'read_only: true') && has(overlay, 'cap_drop:') && has(overlay, 'no-new-privileges:true'), 'market service container hardening is incomplete');
check(has(overlay, 'expose:\n      - "8081/tcp"') && has(overlay, 'networks:\n      - default'), 'market service is not internal-only on the Compose network');
check(has(overlay, 'healthcheck:') && has(overlay, "fetch('http://127.0.0.1:8081/healthz')"), 'market service healthcheck is missing');
const marketSectionStart = overlay.indexOf('  portfolio-market:');
const marketSectionEnd = overlay.indexOf('\n  db:', marketSectionStart);
const marketSection = marketSectionStart >= 0 && marketSectionEnd > marketSectionStart
  ? overlay.slice(marketSectionStart, marketSectionEnd)
  : '';
check(!/\n\s+ports:/m.test(marketSection), 'market service publishes a host port');
check(!/(?:POSTGRES|JWT_SECRET|ANON_KEY|SERVICE_ROLE_KEY|password|secret)/i.test(marketSection), 'market service receives a database or secret setting');

const marketRouteIndex = caddyfile.indexOf('@market_api path /market/v1 /market/v1/*');
const marketProxyIndex = caddyfile.indexOf('reverse_proxy portfolio-market:8081');
const staticFallbackIndex = caddyfile.indexOf('root * /srv/portfolio-public');
check(marketRouteIndex >= 0 && marketProxyIndex > marketRouteIndex, 'Caddy market route is missing or does not preserve order');
check(staticFallbackIndex > marketProxyIndex, 'Caddy static fallback precedes the market route');
check(!/handle_path|strip_prefix|uri\s/.test(caddyfile.slice(0, Math.max(0, staticFallbackIndex))), 'Caddy rewrites the market request path');

check(envLines.includes('PORTFOLIO_MARKET_BUILD_CONTEXT=<ABSOLUTE_MARKET_SERVICE_CONTEXT>'), 'env template does not declare the market service context');
check(has(runbook, 'PORTFOLIO_MARKET_BUILD_CONTEXT') && has(runbook, 'market service context must be this NAS directory'), 'runbook does not validate the market service context');
check(has(runbook, 'Market Service.js') && has(runbook, 'Market Dockerfile'), 'runbook does not validate both market service files');

check(has(marketService, "'/market/v1/quotes'") && has(marketService, "'/market/v1/fundamentals'") && has(marketService, "'/market/v1/fx'") && has(marketService, "'/market/v1/crypto'") && has(marketService, "'/market/v1/history'"), 'market service fixed routes are incomplete');
check(has(marketService, 'DEFAULT_UPSTREAM_TIMEOUT_MS = 8_000') && has(marketService, 'DEFAULT_REQUEST_DEADLINE_MS = 20_000'), 'market service timeout defaults are missing');
check(has(marketService, 'DEFAULT_BODY_LIMIT_BYTES = 512 * 1024') && has(marketService, 'DEFAULT_DOWNSTREAM_LIMIT_BYTES = 1 * 1024 * 1024'), 'market service body caps are missing');
check(has(marketService, 'const MAX_CONCURRENCY = 8') && has(marketService, 'const RATE_MAX_ENTRIES = 10_000'), 'market service concurrency or rate bounds are missing');
check(has(marketService, "redirect: 'error'") && has(marketService, 'UPSTREAM_REDIRECT'), 'market service does not reject redirects');
check(has(marketService, 'ALLOWED_UPSTREAM_HOSTS') && has(marketService, 'query1.finance.yahoo.com') && has(marketService, 'api.coingecko.com'), 'market service fixed upstream host allowlist is missing');
check(!/console\.(?:log|info|warn|error)|process\.env|authorization|api[_-]?key|service[_-]?role/i.test(marketService), 'market service contains sensitive logging or secret configuration');
check(has(marketService, "method: 'GET'") && has(marketService, 'Request body is not accepted'), 'market service GET-only boundary is missing');
check(has(marketService, 'Content-Type') && has(marketService, 'application/json'), 'market service JSON response boundary is missing');

for (const [name, file] of Object.entries({ backup: files.backup, restore: files.restore, runbook: files.runbook })) {
  const syntax = spawnSync('bash', ['-n', file], { encoding: 'utf8' });
  check(syntax.status === 0, `${name}.sh failed bash -n: ${syntax.stderr || 'unknown syntax error'}`);
}

if (failures.length) {
  console.error(`NAS config checks failed (${failures.length}):`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
console.log(`NAS config checks passed (${checks} assertions)`);
