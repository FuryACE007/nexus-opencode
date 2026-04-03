# Nexus-OpenCode – Development Guide

This document covers the fork setup, upstream sync workflow, and local development
practices for the Nexus-OpenCode integration.

---

## Architecture Overview

```
.opencode/
├── opencode.jsonc          # Project-level OpenCode config (provider, instructions, etc.)
├── tui.json                # TUI keybind / theme config
├── env.d.ts                # TypeScript ambient types for .txt imports
├── plugins/
│   └── nexus.ts            # Core Nexus plugin (LLM routing, skill detection, AgentOverflow)
├── tool/
│   ├── nexus-solve.ts      # /solve tool – submit problem to AgentOverflow
│   └── nexus-solved.ts     # /solved tool – capture resolution in knowledge base
└── command/                # Slash-command markdown (e.g. /solve, /learn, /changelog)
```

The plugin routes all LLM calls through the Nexus FastAPI backend (`NEXUS_BASE_URL`,
default `http://localhost:8000`). The backend handles:
- Service account authentication (no API keys needed on client)
- RAG context injection (Confluence, product docs)
- Lumin8 model routing to the appropriate LLM

---

## Required Environment Variables

| Variable | Default | Description |
|---|---|---|
| `NEXUS_BASE_URL` | `http://localhost:8000` | Nexus backend URL |

No API keys are required. Auth is handled server-side.

---

## Fork Setup

This repo is a fork of `anomalyco/opencode`. The remotes are configured as:

```
origin    → your team's GitHub fork (where you push feature branches)
upstream  → https://github.com/anomalyco/opencode.git (the source of truth)
```

### Initial one-time setup (after cloning your fork)

```bash
# Add upstream remote (already done for the local checkout)
git remote add upstream https://github.com/anomalyco/opencode.git
git fetch upstream

# Verify
git remote -v
```

> **Note:** Update `origin` to point to your team's fork URL once you create it on GitHub:
> ```bash
> git remote set-url origin https://github.com/YOUR-ORG/nexus-opencode.git
> ```

---

## Keeping the Fork Updated (Upstream Sync)

Run this whenever a new OpenCode release drops or you want to pull bug fixes.

```bash
# 1. Fetch latest changes from the upstream repo
git fetch upstream

# 2. Merge (or rebase) upstream/dev into your local dev branch
git checkout dev
git merge upstream/dev
# Or, to keep a cleaner history:
# git rebase upstream/dev

# 3. Resolve any conflicts, then push to your fork
git push origin dev
```

### Checking what changed upstream

Before merging, you can preview the diff:

```bash
git log dev..upstream/dev --oneline
git diff dev..upstream/dev -- packages/opencode/src/
```

### Key files to watch for breaking changes

When upstream updates ship, pay attention to these files that could affect the Nexus integration:

| File | Why it matters |
|---|---|
| `packages/opencode/src/provider/` | Provider API shape changes |
| `packages/opencode/src/session/` | Session / message type changes (affects `chat.message` hook) |
| `packages/opencode/src/tool/` | Built-in tool changes that the plugin hooks into |
| `packages/plugin/src/index.ts` | Plugin SDK type changes |
| `CHANGELOG.md` | Release notes |

---

## Updating the OpenCode Plugin SDK

The Nexus plugin uses `@opencode-ai/plugin` from the monorepo's `packages/plugin`
package. It's consumed as a local workspace dependency.

If the plugin SDK types change (e.g. new hook signatures, updated `Plugin` type):

```bash
# From the nexus-opencode root
cd packages/plugin
bun install
bun build

# Then check for type errors in the Nexus plugin
cd ../../
bun typecheck 2>/dev/null || cd packages/opencode && bun typecheck
```

---

## Running OpenCode Locally

```bash
# From repo root — starts the dev watcher
bun run dev

# Or use the installed binary (Homebrew)
opencode
```

The `.opencode/opencode.jsonc` config is automatically picked up when you run
`opencode` from any directory inside the project.

---

## Plugin Development

### How the plugin is loaded

OpenCode auto-loads all `.ts` files in `.opencode/plugins/`. The `nexus.ts` plugin
exports `server: Plugin`, which is the standard `PluginModule.server` pattern.

### Environment variable state sharing

The plugin and standalone tool files (in `.opencode/tool/`) share state via
`process.env` — this is the documented approach for OpenCode plugins:

- `_NEXUS_ACTIVE_SKILL` — the currently active product skill name
- `_NEXUS_LAST_ISSUE_ID` — the last AgentOverflow issue ID (for `/solved`)

### Testing changes

```bash
# Type-check the plugin
cd packages/opencode
bun typecheck

# Or check from root using bun's workspace support
bun --cwd packages/opencode typecheck
```

The `.opencode/` directory is NOT in `packages/opencode` — it's at the repo root.
The plugin TypeScript is picked up by OpenCode at runtime, not compiled ahead of time.

---

## Pushing a Branch / Creating a PR

```bash
# Feature work
git checkout -b nexus/my-feature
# ... make changes ...
git add -p
git commit -m "feat: describe your change"
git push origin nexus/my-feature

# Open a PR to your fork's dev branch (not to upstream)
```

Use the `nexus/` prefix for branch names to clearly distinguish Nexus integration
work from upstream contributions.

---

## Config Schema Notes

The `opencode.jsonc` config will show JSON schema warnings for:

1. **`displayName` in model config** – Valid in OpenCode's implementation but not
   in their public JSON schema. Safe to ignore.
2. **`model: "nexus/nexus-agent"`** – The custom provider ID isn't in the schema
   because it's dynamically registered. Safe to ignore.

These warnings do not affect runtime behavior.

---

## AgentOverflow Flow

```
Developer describes error
       ↓
/solve tool → POST /api/overflow/ingest
       ↓
Backend: semantic cache lookup (cosine similarity)
  ≥ 0.87 → cache hit → instant answer (no LLM)
  0.65–0.87 → similar → LLM with related context (not persisted)
  < 0.65 + conf ≥ 0.72 → novel → LLM + auto-store (6-month TTL)
  < 0.65 + low conf → answered but not stored
       ↓
Developer commits fix
       ↓
Plugin commit hook → POST /api/overflow/resolve (auto)
OR
/solved tool → POST /api/overflow/resolve (manual, with explicit note)
```

---

## Skill Selection

The plugin auto-detects the active product skill using:
1. Repository directory name
2. Git remote URL
3. Top-level config files (e.g. `pyproject.toml`, `Cargo.toml`)
4. Backend API validation (`GET /api/skills/{name}`)

The selection is cached in `~/.nexus/config` to avoid repeated API calls.

Switch skill at any time by prefixing your message with `@skill-name`:
```
@payments-service Why is the Stripe webhook failing?
```
