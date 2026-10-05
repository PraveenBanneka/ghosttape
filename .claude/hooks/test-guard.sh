# Guard test suite. Run: bash .claude/hooks/test-guard.sh   (expects 0 failed)
# Adapted from ZedPath's suite. The real salon account id is NOT in this file: a fake id is registered as
# "blocked" via GHOSTTAPE_GUARD_EXTRA_BLOCKED_ID, which exercises the same isSalonId() path as the real fingerprint.
S=$(cygpath -m "$(mktemp -d)" 2>/dev/null || mktemp -d)
G="$(dirname "$0")/ghosttape-guard.cjs"
SID=deadbeefdeadbeefdeadbeefdeadbeef
GID=0123456789abcdef0123456789abcdef
export GHOSTTAPE_GUARD_EXTRA_BLOCKED_ID=$SID
export GHOSTTAPE_GUARD_TEST_ACCOUNT_ID=$GID
for d in none salon good other fresh stranger zpname zpns noname; do mkdir -p $S/$d/.git; done
printf '{"name":"ghosttape","account_id":"%s"}\n' $SID > $S/salon/wrangler.jsonc
printf '{"name":"ghosttape", // comment\n "account_id": "%s"}\n' $GID > $S/good/wrangler.jsonc
printf '{"name":"ghosttape","account_id":"fedcba9876543210fedcba9876543210"}\n' > $S/stranger/wrangler.jsonc
printf '{"name":"zedpath","account_id":"%s"}\n' $GID > $S/zpname/wrangler.jsonc
printf '{"name":"ghosttape","account_id":"%s","ratelimits":[{"name":"RL","namespace_id":"1001"}]}\n' $GID > $S/zpns/wrangler.jsonc
printf '{"name":"other-thing","account_id":"%s"}\n' $GID > $S/noname/wrangler.jsonc
printf '[remote "origin"]\n\turl = https://github.com/PraveenBanneka/ghosttape.git\n' > $S/good/.git/config
printf '[remote "origin"]\n\turl = https://github.com/PraveenBanneka/some-private-repo.git\n' > $S/other/.git/config
printf '[core]\n\tbare = false\n' > $S/fresh/.git/config
mk(){ printf '%s\n' "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"$1\"}}" '{"type":"assistant","message":{"content":[]}}' '{"type":"user","message":{"role":"user","content":[{"type":"tool_result","content":"GO"}]}}' > $S/$2.jsonl; }
mk "GO deploy it" go; mk "please ask me for a clear GO" nogo; mk "ok" ok
pass=0; fail=0
t(){ # name dir transcript tool arg expect   (arg = command for Bash/PowerShell/MCP, file_path otherwise)
  case $4 in Bash|PowerShell|mcp__*) K=command;; *) K=file_path;; esac
  P="{\"tool_name\":\"$4\",\"tool_input\":{\"$K\":\"$5\"},\"transcript_path\":\"$S/$3.jsonl\"}"
  out=$(echo "$P" | CLAUDE_PROJECT_DIR=$S/$2 node $G 2>&1); rc=$?
  r=$([ $rc -eq 0 ] && echo ALLOW || echo BLOCK)
  if [ $r = $6 ]; then mark=PASS; pass=$((pass+1)); else mark=FAIL; fail=$((fail+1)); fi
  printf '%-4s %-5s %-46s %s\n' "$mark" "$r" "$1" "$(echo $out | sed 's/GHOSTTAPE GUARD BLOCKED: //' | cut -c1-60)"; }
SALON="/c/Users/prave/OneDrive/Documents/New website june 20"
ZP="/c/Users/prave/OneDrive/Documents/ZedPath"
echo "-- local work (pinned defaults: allowed)"
t "local dev allowed"                      none ok   Bash "npx wrangler dev" ALLOW
t "whoami allowed"                         none ok   Bash "npx wrangler whoami" ALLOW
t "npm install allowed"                    none ok   Bash "npm install" ALLOW
t "npm test allowed"                       none ok   Bash "npm test" ALLOW
t "d1 local migration allowed"             good ok   Bash "npx wrangler d1 migrations apply ghosttape-history --local" ALLOW
t "grep mentioning zedpath (no cloud tool)" good ok  Bash "grep -n zedpath CLAUDE.md" ALLOW
t "firecrawl MCP allowed"                  good ok   mcp__firecrawl__firecrawl_scrape "https://docs.espressif.com" ALLOW
t "write normal project file"              good ok   Write "$S/good/src/main.ts" ALLOW
echo "-- account switching + salon (always blocked)"
t "wrangler login blocked (even w/ GO)"    good go   Bash "npx wrangler login" BLOCK
t "wrangler logout blocked"                good go   PowerShell "wrangler logout" BLOCK
t "cf auth login blocked"                  good go   Bash "cf auth login" BLOCK
t "salon folder cmd blocked"               good go   Bash "ls '$SALON'" BLOCK
t "salon folder Read blocked"              good go   Read "$SALON/x.txt" BLOCK
t "salon account id blocked"               good go   Bash "CLOUDFLARE_ACCOUNT_ID=$SID wrangler dev" BLOCK
t "salon id inside MCP input blocked"      good go   mcp__firecrawl__firecrawl_scrape "acct $SID" BLOCK
echo "-- ZedPath folder (read 3 things only)"
t "Read ZedPath CLAUDE.md allowed"         good ok   Read "$ZP/CLAUDE.md" ALLOW
t "Read ZedPath guard allowed"             good ok   Read "$ZP/.claude/hooks/zedpath-guard.cjs" ALLOW
t "Read ZedPath leak scanner allowed"      good ok   Read "$ZP/.githooks/leak-scan.cjs" ALLOW
t "Read ZedPath source blocked"            good go   Read "$ZP/worker/index.ts" BLOCK
t "Read ZedPath .dev.vars blocked"         good go   Read "$ZP/.dev.vars" BLOCK
t "Read ZedPath settings.json blocked"     good go   Read "$ZP/.claude/settings.json" BLOCK
t "Edit ZedPath CLAUDE.md blocked"         good go   Edit "$ZP/CLAUDE.md" BLOCK
t "Write into ZedPath hooks blocked"       good go   Write "$ZP/.claude/hooks/x.cjs" BLOCK
t "ZedPath folder (backslashes) blocked"   good go   Edit "C:\\\\Users\\\\prave\\\\OneDrive\\\\Documents\\\\ZedPath\\\\x.ts" BLOCK
t "Glob in ZedPath blocked"                good go   Glob "$ZP/**/*.ts" BLOCK
t "shell cmd in ZedPath folder blocked"    good go   Bash "cat '$ZP/CLAUDE.md'" BLOCK
echo "-- ZedPath Cloudflare resources (always blocked, even w/ GO)"
t "d1 execute zedpath --local blocked"     good go   Bash "npx wrangler d1 execute zedpath --local --command x" BLOCK
t "tail zedpath worker blocked"            good go   Bash "npx wrangler tail zedpath" BLOCK
t "vectorize zedpath-ask blocked"          good go   Bash "npx wrangler vectorize get zedpath-ask" BLOCK
t "curl zedpath live URL blocked"          good go   Bash "curl https://zedpath.teamkestrel.workers.dev/" BLOCK
t "gh view zedpath repo blocked"           good go   Bash "gh repo view PraveenBanneka/zedpath" BLOCK
t "CF MCP mentioning zedpath blocked"      good go   mcp__plugin_cloudflare_cloudflare__execute "delete worker zedpath" BLOCK
t "CF MCP search mentioning zedpath"       good go   mcp__plugin_cloudflare_cloudflare__search "zedpath" BLOCK
t "deploy, config named zedpath + GO"      zpname go Bash "npx wrangler deploy" BLOCK
t "deploy, ratelimit ns 1001 + GO"         zpns go   Bash "npx wrangler deploy" BLOCK
t "deploy, worker not named ghosttape"     noname go Bash "npx wrangler deploy" BLOCK
echo "-- owner-only limits (always blocked, even w/ GO)"
t "Edit limits.jsonc blocked"              good go   Edit "$S/good/limits.jsonc" BLOCK
t "Write limits.lock blocked"              good go   Write "$S/good/limits.lock" BLOCK
t "Edit lock-limits tool blocked"          good go   Edit "$S/good/tools/lock-limits.cjs" BLOCK
t "shell edit of limits.jsonc blocked"     good go   Bash "sed -i s/false/true/ limits.jsonc" BLOCK
t "running lock-limits blocked"            good go   Bash "node tools/lock-limits.cjs" BLOCK
t "PowerShell Set-Content limits blocked"  good go   PowerShell "Set-Content limits.jsonc x" BLOCK
t "Read limits.jsonc allowed"              good ok   Read "$S/good/limits.jsonc" ALLOW
t "check-limits allowed"                   good ok   Bash "node tools/check-limits.cjs" ALLOW
echo "-- unused account connectors (always blocked)"
t "Gmail blocked"                          good go   mcp__claude_ai_Gmail__send_email "x" BLOCK
t "Google Drive blocked"                   good go   mcp__claude_ai_Google_Drive__search "x" BLOCK
t "Canva blocked"                          good go   mcp__claude_ai_Canva__help "x" BLOCK
t "design plugin (figma) blocked"          good go   mcp__plugin_design_figma__get_file "x" BLOCK
echo "-- guard self-protection (needs GO)"
t "edit guard, no GO"                      good ok   Edit "$S/good/.claude/hooks/ghosttape-guard.cjs" BLOCK
t "edit guard with GO"                     good go   Edit "$S/good/.claude/hooks/ghosttape-guard.cjs" ALLOW
t "edit settings.json, no GO"              good ok   Write "$S/good/.claude/settings.json" BLOCK
t "sed on guard, no GO"                    good ok   Bash "sed -i s/a/b/ .claude/hooks/ghosttape-guard.cjs" BLOCK
t "run guard tests allowed"                good ok   Bash "bash .claude/hooks/test-guard.sh" ALLOW
t "cat guard allowed"                      good ok   Bash "cat .claude/hooks/ghosttape-guard.cjs" ALLOW
t "cat guard then overwrite, no GO"        good ok   Bash "cat x > .claude/hooks/ghosttape-guard.cjs" BLOCK
echo "-- Cloudflare outward actions (pinned account + GO)"
t "deploy, no config"                      none go   Bash "npx wrangler deploy" BLOCK
t "deploy, salon pinned (even w/ GO)"      salon go  Bash "npx wrangler deploy" BLOCK
t "deploy, good pin, no GO"                good ok   Bash "npx wrangler deploy" BLOCK
t "deploy, GO only mid-sentence"           good nogo Bash "npx wrangler deploy" BLOCK
t "deploy, good pin + GO"                  good go   Bash "npx wrangler deploy" ALLOW
t "deploy, pinned to 3rd account + GO"     stranger go Bash "npx wrangler deploy" BLOCK
t "secret put, no GO"                      good ok   Bash "npx wrangler secret put DEVICE_SECRET" BLOCK
t "d1 --remote, no GO"                     good ok   Bash "npx wrangler d1 execute ghosttape-history --remote --command x" BLOCK
t "d1 migrations apply (remote default)"   good ok   Bash "npx wrangler d1 migrations apply ghosttape-history" BLOCK
t "d1 create, no GO"                       good ok   Bash "npx wrangler d1 create ghosttape-history" BLOCK
t "r2 bucket create, no GO"                good ok   Bash "npx wrangler r2 bucket create ghosttape-x" BLOCK
t "kv namespace delete, no GO"             good ok   Bash "npx wrangler kv namespace delete --namespace-id x" BLOCK
t "npm run deploy, no GO"                 good ok   Bash "npm run deploy" BLOCK
t "CF MCP execute, no GO"                  good ok   mcp__plugin_cloudflare_cloudflare__execute "list" BLOCK
t "CF MCP execute + GO"                    good go   mcp__plugin_cloudflare_cloudflare__execute "list" ALLOW
t "CF MCP docs search allowed"             good ok   mcp__plugin_cloudflare_cloudflare__search "durable objects" ALLOW
echo "-- GitHub (one repo; create + push need GO)"
t "create ghosttape, no GO"                fresh ok  Bash "gh repo create PraveenBanneka/ghosttape --private --source ." BLOCK
t "create ghosttape + GO, no remote yet"   fresh go  Bash "gh repo create PraveenBanneka/ghosttape --private --source ." ALLOW
t "create ghosttape again (remote exists)" good go   Bash "gh repo create PraveenBanneka/ghosttape --private" BLOCK
t "create any other repo"                  fresh go  Bash "gh repo create PraveenBanneka/other --public" BLOCK
t "make a repo public"                     good go   Bash "gh repo edit PraveenBanneka/ghosttape --visibility public" BLOCK
t "delete a repo"                          good go   Bash "gh repo delete PraveenBanneka/ghosttape --yes" BLOCK
t "gh api write to other repo"             good go   Bash "gh api -X PATCH repos/PraveenBanneka/salon -f private=false" BLOCK
t "gh api write to ghosttape, no GO"       good ok   Bash "gh api -X PATCH repos/PraveenBanneka/ghosttape -f description=x" BLOCK
t "add remote to other repo"               good go   Bash "git remote add x https://github.com/PraveenBanneka/salon.git" BLOCK
t "push to ghosttape, no GO"               good ok   Bash "git push origin main" BLOCK
t "push to ghosttape + GO"                 good go   Bash "git push origin main" ALLOW
t "push with explicit other URL + GO"      good go   Bash "git push https://github.com/PraveenBanneka/salon.git main" BLOCK
t "push when origin is another repo + GO"  other go  Bash "git push origin main" BLOCK
t "local commit allowed"                   good ok   Bash "git commit -F msg.txt" ALLOW
echo "== $pass passed, $fail failed =="
[ $fail -eq 0 ]
