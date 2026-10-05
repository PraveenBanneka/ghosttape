#!/usr/bin/env node
// GhostTape guard — PreToolUse hook. Adapted from the ZedPath guard (2026-10-05). Hard-blocks (exit 2)
// anything that could reach the wrong Cloudflare account, ZedPath, the salon project, or production
// without Praveen's explicit GO.
//
//   1. Account switching (wrangler login/logout, cf auth ...)        -> ALWAYS blocked. Praveen does it by hand.
//   2. The salon folder / salon account id                           -> ALWAYS blocked.
//   3. The ZedPath folder                                            -> ALWAYS blocked, except Read of its
//                                                                       CLAUDE.md, .claude/hooks/ and .githooks/.
//   4. ZedPath's Cloudflare resources (worker/D1 "zedpath", Vectorize "zedpath-ask", AI Gateway "zedpath",
//      rate-limit namespaces 1001/1002, zedpath.teamkestrel.workers.dev) -> ALWAYS blocked, even with GO.
//   5. Owner-only limits (limits.jsonc, limits.lock, tools/lock-limits.cjs) -> ALWAYS blocked for writes
//      and for any shell command that names them. Praveen edits them by hand.
//   6. Account connectors not used by this project (Gmail, Calendar, Drive, Canva, Claude Docs,
//      design plugins)                                               -> ALWAYS blocked.
//   7. Outward-facing Cloudflare actions (deploy, secrets, --remote data, resource create/delete,
//      Cloudflare MCP writes) -> blocked UNLESS (a) wrangler.jsonc pins exactly the GhostTape account,
//      names a "ghosttape" worker and contains no ZedPath resource, AND (b) Praveen's latest message
//      starts with "GO".
//   8. GitHub: only PraveenBanneka/ghosttape. Creating it and every push need GO; other repos are never
//      created, edited, deleted or made public.
//   9. Editing the guard itself or .claude/settings*.json needs GO (so the rules cannot be quietly removed).
//
// Reads the hook payload from stdin. Exit 0 = allow, exit 2 = block (stderr is shown to Claude).
// Wired as `node guard || exit 2`, so a crashed guard blocks everything (fail closed).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// The salon account id is stored only as a SHA-256 fingerprint, so the repo never contains it.
// Tests may add extra fake ids via GHOSTTAPE_GUARD_EXTRA_BLOCKED_ID (it can only ADD blocks, never remove).
const SALON_ACCOUNT_SHA256 = 'e817fa57f36e284be3d8310a2969b96c534e05c6737b6348d69a7268cfda514a';
const sha256 = s => crypto.createHash('sha256').update(s.toLowerCase()).digest('hex');
const isSalonId = id => sha256(id) === SALON_ACCOUNT_SHA256 ||
  (!!process.env.GHOSTTAPE_GUARD_EXTRA_BLOCKED_ID && id.toLowerCase() === process.env.GHOSTTAPE_GUARD_EXTRA_BLOCKED_ID.toLowerCase());
// The ONLY account GhostTape may deploy to (Stacklineops@gmail.com's Account, confirmed by whoami 2026-10-05).
// Shared with ZedPath, so resource names are policed separately (rule 4). Tests may substitute a fake id.
const GT_ACCOUNT_ID = (process.env.GHOSTTAPE_GUARD_TEST_ACCOUNT_ID || 'e6474e41044c5722ad57c3372ab7492e').toLowerCase();

const SALON_DIR = /new website june 20/i;
const ZEDPATH_DIR = /documents[\\/]+zedpath(?![\w-])/i;
const ZEDPATH_READABLE = /documents[\\/]+zedpath[\\/]+(claude\.md$|\.claude[\\/]+hooks[\\/][^\\/]+$|\.githooks[\\/][^\\/]+$)/i;
const ZEDPATH_RESOURCE = /zedpath/i;
const CLOUD_TOOLING = /\b(wrangler|cf|opennextjs-cloudflare|curl|wget|gh|Invoke-WebRequest|Invoke-RestMethod|iwr|irm)\b/i;
const OWNER_ONLY = /(^|[\\/\s"'`=])(limits\.jsonc|limits\.lock|lock-limits(\.cjs)?)\b/i;
const PROTECTED_CONFIG = /(^|[\\/\s"'])\.claude[\\/]+(settings(\.local)?\.json|hooks[\\/])/i;
const DENIED_MCP = /^mcp__(claude_ai_(Gmail|Google_Calendar|Google_Drive|Canva|Claude_Docs)|plugin_design_)/i;
const OUR_REPO = /github\.com[/:]PraveenBanneka\/ghosttape(\.git)?\b/i;

const ACCOUNT_SWITCH = [
  /\bwrangler(\.cmd)?\s+(login|logout)\b/i,
  /\bcf\s+auth\b/i,
];

const OUTWARD = [
  /\bwrangler(\.cmd)?\s+(deploy|publish|rollback|delete)\b/i,
  /\bwrangler(\.cmd)?\s+versions\s+(deploy|upload)\b/i,
  /\bwrangler(\.cmd)?\s+pages\s+(deploy|publish|project\s+(create|delete))\b/i,
  /\bwrangler(\.cmd)?\s+(secret|secret:bulk)\b/i,
  // optional middle word: `d1 create x` and `r2 bucket create x` (ZedPath's pattern missed the first form)
  /\bwrangler(\.cmd)?\s+(d1|kv|r2|vectorize|queues|hyperdrive)\s+(\S+\s+)?(create|delete)\b/i,
  /\bwrangler(\.cmd)?\b.*--remote\b/i,
  /\bwrangler(\.cmd)?\s+d1\s+migrations\s+apply\b(?!.*--local)/i,
  /\bopennextjs-cloudflare\s+(deploy|upload)\b/i,
  /\bnpm\s+run\s+(deploy|release|upload)\b/i,
  /\bnpx\s+.*\bdeploy\b/i,
];

function block(msg) {
  process.stderr.write(`GHOSTTAPE GUARD BLOCKED: ${msg}\n`);
  process.exit(2);
}

function readStdin() {
  try { return JSON.parse(fs.readFileSync(0, 'utf8') || '{}'); } catch { return {}; }
}

// Most recent message Praveen actually typed (skips tool results and meta entries).
function lastUserText(transcriptPath) {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return '';
  const lines = fs.readFileSync(transcriptPath, 'utf8').split('\n').filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    let e;
    try { e = JSON.parse(lines[i]); } catch { continue; }
    if (e.type !== 'user' || e.isMeta || !e.message) continue;
    const c = e.message.content;
    let texts = [];
    if (typeof c === 'string') texts = [c];
    else if (Array.isArray(c)) {
      if (c.some(b => b && b.type === 'tool_result')) continue;
      texts = c.filter(b => b && b.type === 'text').map(b => b.text);
    }
    const cleaned = texts
      .map(t => t.replace(/<(system-reminder|ide_[a-z_]+|command-[a-z-]+)[^>]*>[\s\S]*?<\/\1>/g, '').trim())
      .filter(Boolean);
    if (cleaned.length) return cleaned.join('\n');
  }
  return '';
}

const saidGo = input => /^\s*GO\b/.test(lastUserText(input.transcript_path));
const projectDirOf = input => process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();

function wranglerConfig(projectDir) {
  for (const f of ['wrangler.jsonc', 'wrangler.json', 'wrangler.toml']) {
    const p = path.join(projectDir, f);
    if (fs.existsSync(p)) return { file: f, text: fs.readFileSync(p, 'utf8') };
  }
  return { file: null, text: '' };
}

function requireGo(input, what) {
  const { file, text } = wranglerConfig(projectDirOf(input));
  if (!file) block(`${what} needs a wrangler config with account_id pinned to the GhostTape account. None found.`);
  const m = text.match(/["']?account_id["']?\s*[:=]\s*["']([0-9a-f]{32})["']/i);
  if (!m) block(`${what}: ${file} has no account_id. Pin the GhostTape account id first.`);
  const id = m[1];
  if (isSalonId(id)) block(`${what}: ${file} is pinned to the SALON account. Stop and tell Praveen.`);
  if (id.toLowerCase() !== GT_ACCOUNT_ID) block(`${what}: ${file} is pinned to ${id}, which is not the GhostTape account. Stop and tell Praveen.`);
  if (ZEDPATH_RESOURCE.test(text)) block(`${what}: ${file} mentions a ZedPath resource. GhostTape never touches ZedPath. Stop and tell Praveen.`);
  if (/namespace_id["']?\s*[:=]\s*["']?(1001|1002)\b/i.test(text)) block(`${what}: ${file} uses rate-limit namespace 1001/1002, which belong to ZedPath. Use 2001/2002.`);
  if (!/["']?name["']?\s*[:=]\s*["']ghosttape/i.test(text)) block(`${what}: ${file} must name a "ghosttape..." worker.`);
  if (!saidGo(input)) {
    block(`${what} is outward-facing. Check \`npx wrangler whoami\`, show Praveen the account, and ask for an explicit GO. ` +
          `His latest message must start with "GO".`);
  }
}

function requireGoOnly(input, what) {
  if (!saidGo(input)) block(`${what}. Ask Praveen for an explicit GO; his latest message must start with "GO".`);
}

// Rule 8: one repo (PraveenBanneka/ghosttape); creating it and pushing need GO; other repos are off-limits.
function checkGitHub(cmd, input) {
  const projectDir = projectDirOf(input);
  const gitCfg = path.join(projectDir, '.git', 'config');
  const cfg = fs.existsSync(gitCfg) ? fs.readFileSync(gitCfg, 'utf8') : '';
  const m = cmd.match(/\bgh\s+repo\s+(create|edit|delete|archive|unarchive|rename|fork|set-default)\b(.*)/i);
  if (m) {
    const [, verb, rest] = m;
    const createOurs = verb.toLowerCase() === 'create' && /^\s*PraveenBanneka\/ghosttape\s/i.test(rest + ' ') && !/\[remote "/.test(cfg);
    if (!createOurs) block(`"gh repo ${verb}" is not allowed. Only the one GhostTape repo exists, and other repos are never touched.`);
    requireGoOnly(input, 'creating the GitHub repo is outward-facing');
  }
  if (/\bgh\s+api\b/i.test(cmd) && /(-X|--method)\s*(POST|PUT|PATCH|DELETE)/i.test(cmd)) {
    if (!/repos\/PraveenBanneka\/ghosttape\b/i.test(cmd)) block('gh api write calls are only allowed against repos/PraveenBanneka/ghosttape.');
    requireGoOnly(input, 'gh api write calls are outward-facing');
  }
  if (/\bgit\s+remote\s+(add|set-url)\b/i.test(cmd) && !OUR_REPO.test(cmd)) {
    block('git remotes may only point to github.com/PraveenBanneka/ghosttape.');
  }
  if (/\bgit\s+push\b/i.test(cmd)) {
    const urls = cmd.match(/(https?:\/\/|git@)\S+/gi) || [];
    if (urls.some(u => !OUR_REPO.test(u))) block('git push to a URL other than PraveenBanneka/ghosttape.');
    const remoteUrls = [...cfg.matchAll(/^\s*url\s*=\s*(.+)$/gim)].map(x => x[1].trim());
    if (remoteUrls.some(u => !OUR_REPO.test(u))) block('this repo has a remote that is not PraveenBanneka/ghosttape. Stop and tell Praveen.');
    requireGoOnly(input, 'git push publishes commits (outward-facing)');
  }
}

const input = readStdin();
const tool = input.tool_name || '';
const ti = input.tool_input || {};
const tiText = JSON.stringify(ti);

// Rule 6: connectors on Praveen's account that this project does not use.
if (DENIED_MCP.test(tool)) block(`${tool} is not used by GhostTape (only the Cloudflare plugin and research tools are).`);

// Rules 2 + 4 for every MCP tool; rule 7 for the Cloudflare MCP (a second door to the account).
if (/^mcp__/i.test(tool)) {
  if (SALON_DIR.test(tiText)) block('the salon folder is not part of this project.');
  if ((tiText.match(/\b[0-9a-f]{32}\b/gi) || []).some(isSalonId)) block('tool input references the SALON Cloudflare account. Stop and tell Praveen.');
  if (/cloudflare/i.test(tool)) {
    if (ZEDPATH_RESOURCE.test(tiText)) block('Cloudflare MCP call mentions a ZedPath resource. GhostTape never touches ZedPath.');
    if (/docs|search/i.test(tool)) process.exit(0);
    requireGo(input, `Cloudflare MCP tool ${tool}`);
  }
  process.exit(0);
}

// File tools.
const fileish = [ti.file_path, ti.path, ti.notebook_path, ti.pattern].filter(Boolean).join(' ');
if (fileish) {
  if (SALON_DIR.test(fileish)) block('the salon folder is not part of this project.');
  if (ZEDPATH_DIR.test(fileish)) {
    const target = ti.file_path || ti.path || ti.notebook_path || '';
    if (!(tool === 'Read' && ZEDPATH_READABLE.test(target))) {
      block('ZedPath is a different project. Only Read of its CLAUDE.md, .claude/hooks/ and .githooks/ is allowed.');
    }
  }
  const writes = /^(Edit|Write|NotebookEdit|MultiEdit)$/.test(tool);
  if (writes && OWNER_ONLY.test(fileish)) block('limits.jsonc / limits.lock / lock-limits are owner-only. Praveen edits them by hand.');
  if (writes && PROTECTED_CONFIG.test(fileish)) requireGoOnly(input, 'editing the guard or .claude/settings needs GO');
}

const cmd = ti.command;
if (typeof cmd !== 'string') process.exit(0);

if (SALON_DIR.test(cmd)) block('the salon folder is not part of this project.');
if ((cmd.match(/\b[0-9a-f]{32}\b/gi) || []).some(isSalonId)) block('command references the SALON Cloudflare account. Stop and tell Praveen.');
if (ZEDPATH_DIR.test(cmd)) block('ZedPath is a different project. Use the Read tool for its CLAUDE.md/hooks; nothing else.');
if (CLOUD_TOOLING.test(cmd) && ZEDPATH_RESOURCE.test(cmd)) block('command touches a ZedPath resource. GhostTape never touches ZedPath.');
if (OWNER_ONLY.test(cmd)) block('limits.jsonc / limits.lock / lock-limits are owner-only. Praveen runs/edits them by hand.');
if (PROTECTED_CONFIG.test(cmd)) {
  const readOnly = !/[;&|>`]|\$\(/.test(cmd) &&
    /^\s*(cat|head|tail|less|ls|git\s+(diff|log|show|status|add)|node\s+--check|bash\s+\.claude\/hooks\/test-guard\.sh)\b/i.test(cmd);
  if (!readOnly) requireGoOnly(input, 'changing the guard or .claude/settings needs GO');
}
for (const re of ACCOUNT_SWITCH) {
  if (re.test(cmd)) block('switching Cloudflare accounts is done by Praveen by hand, never by Claude.');
}
checkGitHub(cmd, input);
for (const re of OUTWARD) {
  if (re.test(cmd)) { requireGo(input, `"${cmd.slice(0, 80)}"`); break; }
}
process.exit(0);
