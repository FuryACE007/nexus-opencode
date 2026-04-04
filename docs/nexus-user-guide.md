# Nexus CLI — User Guide

> Nexus is your enterprise AI coding assistant. It knows your codebase, your product
> architecture, and your team's past solutions — all without any configuration on your end.

---

## What Nexus Is

Nexus is a terminal-based AI agent built on OpenCode. Unlike generic AI tools:

- **Zero setup** — no API keys, no model selection, no configuration files
- **Context-aware** — knows your product's architecture, standards, and Confluence docs automatically
- **Team memory** — when someone solves a bug, that fix is available to every developer who hits the same error
- **Truly agentic** — explores code, plans changes, edits files, runs tests, and iterates — without you driving every step

---

## Installation

Nexus is distributed as a **standalone binary** — no Node.js, no npm, no Bun, no runtime
dependencies of any kind. You just download one file and run it.

### Mac (Apple Silicon — M1/M2/M3)
```bash
# Download (use sudo -E to preserve proxy settings if needed)
sudo -E curl -L -o /usr/local/bin/nexus \
  https://github.com/YOUR-ORG/nexus-opencode/releases/latest/download/nexus-darwin-arm64

# Make executable and bypass Gatekeeper
sudo chmod +x /usr/local/bin/nexus
sudo xattr -d com.apple.quarantine /usr/local/bin/nexus

nexus --version
```

### Mac (Intel)
```bash
# Download (use sudo -E to preserve proxy settings if needed)
sudo -E curl -L -o /usr/local/bin/nexus \
  https://github.com/YOUR-ORG/nexus-opencode/releases/latest/download/nexus-darwin-x64

# Make executable and bypass Gatekeeper
sudo chmod +x /usr/local/bin/nexus
sudo xattr -d com.apple.quarantine /usr/local/bin/nexus

nexus --version
```

### Windows (PowerShell)
```powershell
# 1. Create an install folder and download the binary
New-Item -ItemType Directory -Force "$env:LOCALAPPDATA\Programs\nexus" | Out-Null
Invoke-WebRequest `
  -Uri "https://github.com/YOUR-ORG/nexus-opencode/releases/latest/download/nexus-windows-x64.exe" `
  -OutFile "$env:LOCALAPPDATA\Programs\nexus\nexus.exe"

# 2. Add it to your PATH permanently (run once, then restart your terminal)
$path = [Environment]::GetEnvironmentVariable("PATH", "User")
if ($path -notlike "*nexus*") {
  [Environment]::SetEnvironmentVariable(
    "PATH", "$path;$env:LOCALAPPDATA\Programs\nexus", "User"
  )
}

# 3. Restart your terminal, then verify
nexus --version
```

> Replace `YOUR-ORG` with your actual GitHub org. Ask your platform team for the exact URL.

> **No admin rights needed on Mac** — if `/usr/local/bin` is restricted, install to `~/bin`:
> ```bash
> mkdir -p ~/bin
> curl -L -o ~/bin/nexus https://github.com/YOUR-ORG/nexus-opencode/releases/latest/download/nexus-darwin-arm64
> chmod +x ~/bin/nexus
> echo 'export PATH="$HOME/bin:$PATH"' >> ~/.zshrc && source ~/.zshrc
> ```

---

## For Platform Teams: Building the Binary

The binary is produced using **Bun's compile feature**, which embeds the runtime into the
executable. End users get a single file with zero dependencies — not even Node.js is needed.

**Requirements to build:** A machine (CI or developer workstation) with [Bun](https://bun.sh) installed.

```bash
# Clone and build
git clone https://github.com/YOUR-ORG/nexus-opencode
cd nexus-opencode
bun install

# Build self-contained binaries for all platforms
bun run packages/opencode/script/build.ts
# Output: packages/opencode/dist/
#   nexus-darwin-arm64   ← Mac M1/M2/M3
#   nexus-darwin-x64     ← Mac Intel
#   nexus-windows-x64.exe
```

**Release workflow:**
1. Create a GitHub Release tagged with the version (e.g., `v1.3.13`)
2. Upload all files from `packages/opencode/dist/` as release assets
3. Users download via the `curl` commands in the Installation section above

> The binary filename on disk determines the command name. If saved as `nexus`, the command is `nexus`.

---

> Your backend must be running and reachable. Ask your platform team for `NEXUS_BASE_URL`
> if the default (`http://localhost:8000`) doesn't apply to your setup.

**Custom backend URL** (if needed):
```bash
export NEXUS_BASE_URL=https://nexus.internal.yourcompany.com
```

Add that line to your `~/.zshrc` or `~/.bashrc`.

---

## First Run

```bash
cd your-repo
nexus
```

On first launch in a new repo, Nexus:
1. Verifies the backend is reachable
2. Detects which product context applies (staking, payments, etc.) from your repo name and files
3. Caches the selection so future launches are instant

You'll see something like:
```
Nexus  v1.0.0
Product context: staking  (auto-detected)
Ready.
```

---

## Basic Usage

Type naturally. Nexus is a full agent — it reads files, edits code, runs commands, and loops
until the task is done.

```
> fix the null pointer in the validator registration flow
```

Nexus will:
1. Search the codebase to find the relevant files
2. Read and understand the surrounding code
3. Plan the change
4. Apply the edit
5. Run diagnostics (LSP) to check for type errors
6. Iterate if needed

You don't need to tell it which files to look at. It figures that out.

---

## Modes

Nexus has two modes accessible by pressing **Tab**.

### Build mode (default)
Full agent access — reads files, edits code, runs commands. This is what you use for
implementing features, fixing bugs, and refactoring.

### Plan mode
Read-only — the agent explores and produces a step-by-step plan without touching anything.
Use this when you want to understand what Nexus would do before letting it act.

```
# Switch to plan mode: press Tab
# Switch back to build mode: press Tab again
```

Workflow for large or risky changes:
1. Press Tab → enter plan mode
2. Describe the task
3. Review the plan
4. Press Tab → back to build mode
5. Say "go ahead" or "implement the plan"

---

## Product Context (Skills)

Nexus injects your product's architecture docs, Confluence pages, and code standards into
every conversation automatically. The active skill is shown at startup.

### Auto-detection
Nexus detects the right context from your repo name, git remote, and top-level files.
A `staking-contracts` repo gets staking context. A `payment-service` repo gets payments context.

### Switching mid-session
If you're working across products or the auto-detection picked wrong:

```
> @payments fix the settlement calculation
```

Prefix your message with `@skillname`. Nexus validates the skill exists, switches context,
and strips the tag before sending to the backend. All subsequent messages in the session
use the new context.

### Available skills
Ask your platform team or check:
```bash
curl http://localhost:8000/api/skills | jq '.[].name'
```

### Resetting the cached skill
```bash
# Edit ~/.nexus/config and remove the entry for your repo path
# Or delete the file to reset all mappings
rm ~/.nexus/config
```

---

## AgentOverflow: /solve

AgentOverflow is Nexus's team knowledge base. When you hit a bug or error, `/solve` queries
the knowledge base before calling the LLM. If a teammate already solved the same problem,
you get the answer instantly.

### Usage

```
/solve auth middleware returning 403 after token refresh
/solve java.lang.NullPointerException in ValidatorRegistry.register
/solve webpack build fails with MODULE_NOT_FOUND after upgrading to v5
```

Nexus captures:
- Your git diff (what's changed)
- Recent commits (temporal context)
- Your full file list (repo scope)

And returns one of:
- **Cache hit** — teammate already fixed this, instant answer
- **LLM analysis** — novel issue, backend queries Confluence and product docs, generates suggestion
- **Persisted** — novel issue with high confidence, answer stored for future teammates

### After fixing the issue

When you commit after a `/solve` session, Nexus automatically captures the fix:

```bash
git add .
git commit -m "fix: move TokenRefreshMiddleware before AuthMiddleware"
# ↑ Nexus detects this commit and sends the diff to the knowledge base
# Your fix will surface for the next developer who hits the same error
```

### Adding an explicit note (optional)

If your commit message doesn't capture the full story:

```
/solved moved token refresh before expiry check on line 47 in middleware.py
```

`/solved` with a note stores your explanation directly instead of the diff.
`/solved` with no arguments uses the last commit diff (backend summarizes via LLM).

---

## Common Workflows

### Fix a bug
```
> the staking validator registration is failing with a null pointer on line 203

Nexus will find the file, read surrounding context, identify the cause, and apply the fix.
```

### Implement a feature
```
> add pagination to the delegation history endpoint — use cursor-based pagination consistent
> with how we do it in the validator list endpoint
```

Nexus reads the existing endpoint, understands the pattern, and implements the new one to match.

### Explore before acting (large refactor)
```
[Tab — switch to plan mode]
> refactor the reward calculation to support variable epoch lengths
[Review the plan]
[Tab — switch to build mode]
> implement the plan
```

### Fix an error you've seen before
```
/solve DEADLINE_EXCEEDED on the consensus vote aggregation RPC
```

If this error has been solved before, you get the answer instantly. If not, Nexus analyzes
it with your product's architecture in context.

### Switch product context
```
> @staking fix the epoch boundary calculation
```

### Ask without changing anything
```
> how does the delegation unbonding period work in this codebase?
```

Nexus reads the relevant files and explains. No files are changed.

---

## Keyboard Shortcuts

| Key | Action |
|---|---|
| `Tab` | Toggle between build and plan mode |
| `Ctrl+C` | Cancel current operation |
| `Ctrl+L` | Clear screen |
| `↑ / ↓` | Navigate message history |
| `Esc` | Cancel pending input |

---

## Tips

**Be specific about constraints**
```
# Less effective:
> fix the auth bug

# More effective:
> the refresh token endpoint returns 403 when the access token has expired — it should
> exchange the refresh token for a new access token instead
```

**Use plan mode for anything touching multiple services**
Cross-service changes are high risk. Use Tab → plan mode → review → execute.

**Trust the auto-detection, but override when needed**
If Nexus picked the wrong product context, type `@correctskill` in your first message.
The selection is cached, so you only need to do this once per repo.

**Let it iterate**
Nexus loops automatically — if an edit causes a type error, it reads the error and tries
again. Don't interrupt unless it's clearly going wrong.

**Use /solve before debugging manually**
The knowledge base might already have the answer. A 3-second `/solve` before 30 minutes
of debugging is almost always worth it.

---

## Configuration

Nexus stores one file locally:

**`~/.nexus/config`** — skill cache (repo path → skill name mappings)
```json
{
  "skill_mappings": {
    "/Users/you/projects/staking-contracts": "staking",
    "/Users/you/projects/payment-service": "payments"
  }
}
```

This file is auto-managed. You normally never need to touch it.

**`NEXUS_BASE_URL`** environment variable — backend URL (default: `http://localhost:8000`)

---

## Troubleshooting

### Nexus exits immediately with "Backend unreachable"

```
╔══════════════════════════════════════════════════════════════════╗
║              NEXUS ERROR: Backend unreachable                    ║
╚══════════════════════════════════════════════════════════════════╝
```

Nexus **requires** the Nexus Core Engine backend to run. It will not start
without it — there is no fallback to a generic AI tool.

- **Check your VPN** — the backend is only accessible on the corporate network
- **Check `NEXUS_BASE_URL`** — if your org runs the backend at a custom URL:
  ```bash
  export NEXUS_BASE_URL=https://nexus.yourcompany.com
  nexus
  ```
- **Ask your platform team** if the backend URL or deployment status is unclear

### "No pending issue found" on /solved
You typed `/solved` without a prior `/solve`. Run `/solve <description>` first.

### Wrong product context detected
Type `@correctskill` as a prefix in your next message. For example: `@payments fix the settlement bug`.
To reset permanently, delete `~/.nexus/config`.

### Agent seems stuck or going in circles
Press `Ctrl+C` to stop the current operation. Then give a more specific instruction or
switch to plan mode (Tab) to review the approach before continuing.

### LSP errors after edits
Nexus picks these up automatically — if a file edit causes type errors, the agent reads
the diagnostic and tries to fix it. If it loops more than 2-3 times on the same error,
intervene with a clarification.

---

## What Nexus Knows About Your Codebase

Nexus has access to (injected by the backend, not configured by you):

- **Your product's SKILLS.md** — architecture rules, coding standards, patterns to follow
- **Relevant Confluence pages** — fetched dynamically based on your question
- **Your repo** — all git-tracked files are visible to the agent for reading and editing
- **Team knowledge base** — past `/solve` sessions from all developers on your product

It does **not** have access to:
- Files outside the current git repo
- Secrets or credentials in `.env` files (git-ignored files are not tracked)
- Other teams' codebases unless they're in your dependencies

---

## Testing with the Mock Backend (Contributors / Local Dev)

If you're working on Nexus CLI itself, or the production backend isn't available yet,
you can test against a lightweight mock backend included in the `nexus-cli` repo.

### Requirements
- Python 3.9+
- `pip install fastapi uvicorn` (one-time setup)

### Steps

**1. Start the mock backend**
```bash
# From the nexus-cli repo
cd /path/to/nexus-cli
python3 mock_backend.py
# Listening on http://localhost:8000
```

The mock backend implements all Nexus API endpoints:
- `POST /v1/chat/completions` — streaming LLM responses
- `GET  /v1/models` — returns `nexus-agent`
- `GET  /api/skills` — returns mock skills (staking, payments)
- `GET  /api/skills/{name}` — skill detail
- `POST /api/overflow/ingest` — AgentOverflow query + cache simulation
- `POST /api/overflow/resolve` — resolution capture
- `GET  /test/last-request` — debug: inspect the last request headers/body

**2. Run Nexus pointing at the mock**
```bash
# In a new terminal, from any repo directory
cd /path/to/some-project
nexus
```

The default `NEXUS_BASE_URL` is `http://localhost:8000`, so no extra config is needed.

**3. Verify Nexus-specific features**

Check the `X-Nexus-Skill` header is flowing to the backend:
```bash
curl http://localhost:8000/test/last-request | python3 -m json.tool | grep -i nexus
```

Test AgentOverflow manually:
```bash
curl -s -X POST http://localhost:8000/api/overflow/ingest \
  -H "Content-Type: application/json" \
  -H "X-Nexus-Skill: staking" \
  -d '{
    "description": "NullPointerException in ValidatorRegistry on line 203",
    "git_diff": "",
    "dirty_files": [],
    "recent_commits": [],
    "all_files": []
  }' | python3 -m json.tool
```

**4. Expected behaviour with mock backend**

| Action | Expected |
|---|---|
| `nexus` starts | Backend reachable check passes, skill auto-detected |
| Backend not running | Nexus exits immediately with "Backend unreachable" error |
| `/solve my bug` | AgentOverflow ingest called, issue ID stored |
| `git commit` after `/solve` | Auto-resolve fires, issue marked resolved |
| `/solved` | Manual resolution confirmed to backend |
| `@payments fix this` | Skill switches to payments, `X-Nexus-Skill: payments` on next request |
