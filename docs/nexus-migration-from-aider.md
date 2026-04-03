# Nexus CLI: Migration from Aider to OpenCode

## Why we migrated

Nexus CLI was originally a fork of **aider-chat** (Python, v0.86.3). Aider is a solid
pair-programming tool but its architecture is fundamentally single-turn: the developer
sends a message, the model responds with SEARCH/REPLACE blocks, the CLI applies them,
done. There is no agentic loop, no LSP feedback, no HITL approval gate.

By 2026, this hit a hard ceiling for enterprise use:

- **No agentic execution loops** — Aider processes one message at a time. Autonomous
  explore → plan → implement → test cycles require the developer to drive every step.
- **No HITL controls** — Architect mode rushes from plan to edits with no pause gate.
  In a complex Java/Node codebase, a single wrong edit can break a deep dependency graph.
- **No LSP integration** — Edits are applied blindly. Compilation errors and type
  failures only surface if the developer runs the tests manually.
- **Fork maintenance burden** — Every upstream Aider release conflicts with our 6 modified
  files. Adding new features means accumulating more merge debt.
- **SEARCH/REPLACE is legacy** — The industry has converged on tool-calling + LSP. Keeping
  the SEARCH/REPLACE contract required special backend logic (preserve `messages[0]`,
  dual-model routing) that added complexity with no user-facing benefit.

**OpenCode** (TypeScript, MIT, actively maintained) solves all of these as first-class
features: continuous tool-calling loops, native plan agent, LSP diagnostics after every
edit, MCP support, composable hooks, plugin architecture with no fork required.

## What the Nexus system actually is

The intelligence in Nexus lives in the **backend**, not the CLI:

```
OpenCode (thin client)  →  Nexus Backend (the brain)
  - Skill detection          - RAG pipeline (Confluence, SKILLS.md)
  - X-Nexus-Skill header     - LLM routing via Lumin8
  - /solve dispatch          - AgentOverflow semantic cache
  - Auto-resolve on commit   - Agentic session management
```

The CLI's job is to:
1. Stamp `X-Nexus-Skill` on every LLM request so the backend loads the right context
2. Auto-detect which product skill applies to the current repo
3. Dispatch AgentOverflow queries (`/solve`) with git context
4. Auto-capture fixes when the developer commits

Everything else — RAG retrieval, LLM orchestration, knowledge base persistence — is the
backend's responsibility. The CLI should be as thin as possible.

## What changed in the CLI

### Removed (Aider-specific, not applicable to OpenCode)

| Component | What it did | Why removed |
|---|---|---|
| SEARCH/REPLACE format rules | Required LLM to output edits in a specific text format | OpenCode uses tool calls for editing — no special format needed |
| `messages[0]` preservation | Backend had to inject RAG after position 0 to avoid clobbering format rules | No longer a constraint — inject RAG wherever appropriate |
| `nexus-architect` model routing | Backend routed to a separate model for planning vs coding | OpenCode's plan agent handles this client-side |
| `chat_files` payload field | Aider's `/add`'d files with 50× PageRank boost | OpenCode has no `/add`; backend RAG handles relevance ranking |
| `ident_mentions` payload field | Identifiers extracted via `coder.get_ident_mentions()` | Backend's own retrieval pipeline handles this |
| `file_mentions` payload field | File paths extracted via `coder.get_file_mentions()` | Same — backend responsibility |
| `recent_messages` payload field | Last 6 Aider conversation turns for context | Backend session state handles this |
| `repo-map` PageRank scoring | Pre-computed file relevance via import graph | Replaced by LSP + dynamic agent exploration (grep/glob/read) |
| PyInstaller binary packaging | Single-executable distribution | Replaced by standard npm/bun packaging |

### Retained (framework-agnostic)

| Component | What it does | How it works in OpenCode |
|---|---|---|
| `X-Nexus-Skill` header | Tags every LLM request with product context | `chat.headers` plugin hook |
| Skill auto-detection | Scores repo metadata against skill keywords | Plugin `server()` function on init |
| `~/.nexus/config` cache | Persists skill→repo mappings between sessions | Same file, same format |
| `@skill` mid-session switching | Changes active skill without restarting | `chat.message` plugin hook |
| AgentOverflow `/solve` | Queries enterprise knowledge base | `nexus-solve` tool |
| Auto-resolve on commit | Captures fix diff when developer commits | `tool.execute.after` hook on `bash` |
| `/solved` explicit note | Manual resolution with developer explanation | `nexus-solved` tool |
| `/api/overflow/ingest` payload | git diff, dirty files, recent commits, all files | Sent from `nexus-solve` tool |

### What got simpler in the backend

The backend's `/v1/chat/completions` handler can now:
- Inject RAG context at any position (no `messages[0]` constraint)
- Remove dual-model routing (`nexus-agent` vs `nexus-architect`)
- Remove SEARCH/REPLACE format reminders from injected context

See `docs/nexus-backend-openapi.yaml` v2.0 for the updated contract.

## Plugin architecture

All Nexus customizations live in `.opencode/plugins/nexus.ts` — completely outside the
OpenCode source tree. No fork, no merge conflicts. Upstream OpenCode updates are consumed
with a simple `git pull`.

```
nexus-opencode/
  .opencode/
    plugins/
      nexus.ts          ← core plugin: auth, skills, header injection, auto-resolve
    tool/
      nexus-solve.ts    ← /solve: AgentOverflow ingest
      nexus-solved.ts   ← /solved: manual resolution capture
    command/
      solve.md          ← /solve slash command template
      solved.md         ← /solved slash command template
    agent/
      nexus-planner.md  ← read-only planning agent (architect replacement)
    opencode.jsonc      ← provider config: Nexus backend URL + passthrough key
  docs/
    nexus-backend-openapi.yaml   ← API contract v2.0
    nexus-migration-from-aider.md ← this file
```

## What to tell the backend team

The `/v1/chat/completions` endpoint needs two small changes:

1. **Remove `messages[0]` preservation logic.** You no longer need to detect and protect
   the first system message. Inject RAG context wherever makes sense for your pipeline.

2. **Remove `nexus-architect` routing.** The CLI sends only `nexus-agent` now. The backend
   can drop any logic that branched on the model name for planning vs coding modes.

The other four endpoints (`/api/skills`, `/api/skills/{name}`, `/api/overflow/ingest`,
`/api/overflow/resolve`) are unchanged. The ingest payload is smaller — `chat_files`,
`ident_mentions`, `file_mentions`, and `recent_messages` fields are dropped. The backend
should handle their absence gracefully (they were always optional).
