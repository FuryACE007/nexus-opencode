# Nexus-OpenCode — Claude Context

Fork anomalyco/opencode. Routes LLM traffic → Nexus FastAPI backend.
Default: `dev`. No `main` locally.

Execute without confirmation unless blocked. **USE PARALLEL TOOLS.**

---

## Architecture

```
.opencode/
├── opencode.jsonc      # Config (Nexus, model, perms)
├── tui.json            # Theme/keybinds
├── plugins/nexus.ts    # LLM routing, skill detect, AgentOverflow
├── tool/
│   ├── nexus-solve.ts  # /solve → AgentOverflow
│   └── nexus-solved.ts # /solved → knowledge base
└── command/            # Slash cmds

packages/
├── opencode/           # CLI (yargs: run, gen, serve, debug, mcp)
├── plugin/             # SDK (@opencode-ai/plugin)
├── sdk/js/             # JS SDK (regen: ./packages/sdk/js/script/build.ts)
├── app/                # Web (SolidJS+Vite)
├── desktop/            # Tauri
├── desktop-electron/   # Electron
├── ui/                 # Shared UI
├── util/               # Utils
├── function/           # Serverless
└── console/            # Admin
```

---

## Nexus Integration

**Backend**: FastAPI `http://127.0.0.1:8000` (env: `NEXUS_BASE_URL`)
No API keys. Auth = server-side.
**Model**: `nexus/nexus-agent` (128k ctx, 16k out). Routes via Lumin8.
Providers (openai, anthropic) disabled → all traffic via Nexus.

**State** (env):
- `_NEXUS_ACTIVE_SKILL` = active product skill
- `_NEXUS_LAST_ISSUE_ID` = last overflow issue

**Skill order**: repo dir → git remote → config → backend API. Cache: `~/.nexus/config`.
Switch: `@skill-name`.

**AgentOverflow**:
```
/solve → POST /api/overflow/ingest
  ≥0.87 sim    → cache (no LLM)
  0.65–0.87    → LLM+context
  <0.65+≥0.72  → novel → LLM+store (6mo TTL)
/solved → POST /api/overflow/resolve
```

---

## Watch (upstream sync risk)

| File | Note |
|---|---|
| `packages/opencode/src/provider/` | Provider API |
| `packages/opencode/src/session/` | Message types (`chat.message` hook) |
| `packages/opencode/src/tool/` | Tool hooks |
| `packages/plugin/src/index.ts` | SDK types |

**Denied**: `packages/opencode/migration/*`

---

## Dev

```bash
bun run dev                               # Dev watcher (root)
bun --cwd packages/opencode typecheck    # Typecheck (not tsc)
bun typecheck                            # From pkg dir
cd packages/plugin && bun install build  # Rebuild SDK
```

Tests: from pkg dirs only (guard: `do-not-run-tests-from-root`).

---

## Upstream

```bash
git fetch upstream
git checkout dev && git merge upstream/dev
git push origin dev
```

Branches: `nexus/` prefix. PRs → fork `dev`.

---

## Style (MANDATORY)

**Vars**: 1-word default. Multi-word only if ambiguous.
- ✓ `pid`, `cfg`, `err`, `opts`, `dir`, `root`, `child`, `state`
- ✗ `inputPID`, `connectTimeout`, `workerPath`

No destructuring. Dot notation: `obj.a`.
`const` over `let`. Ternary/early-return, no reassign.
No `else`. No `try`/`catch` avoidable. No `any`.
Functional methods (`flatMap`, `filter`, `map`) over loops.
Prefer Bun APIs (`Bun.file()`, etc).
Type infer preferred. Logic = 1 fn unless composable.

**Drizzle**: snake_case (cols auto-match).
```ts
// Good
const table = sqliteTable("session", {
  id: text().primaryKey(),
  project_id: text().notNull(),
})
```

---

## Test

No mocks. Pkg dirs only. `bun typecheck` (not `tsc`).
