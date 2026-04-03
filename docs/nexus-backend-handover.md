# Nexus Backend — Migration Handover

> **Audience**: Backend engineer or LLM implementing the Nexus FastAPI backend for the OpenCode-based CLI.
> Read this document fully before touching any code. The API contract, request shapes, and
> critical implementation constraints are all here.

---

## Context: What Changed and Why

The Nexus CLI was previously built on **Aider** (Python). It has been migrated to **OpenCode**
(TypeScript). The backend is the intelligent core — RAG retrieval, LLM routing, AgentOverflow
semantic cache. The CLI is a thin glue layer. This migration does not change what the backend
does; it changes two small things about how the CLI talks to it.

**Summary of backend changes required:**

| Area | Before (Aider CLI) | After (OpenCode CLI) | Action required |
|---|---|---|---|
| `messages[0]` preservation | Backend MUST NOT modify first message (SEARCH/REPLACE rules lived there) | No constraint — OpenCode uses tool-based editing | Remove the preservation logic |
| Dual-model routing | Backend routed `nexus-architect` to a planning model | Only `nexus-agent` is sent now | Remove the model-name branch |
| `/api/overflow/ingest` payload | Had `chat_files`, `ident_mentions`, `file_mentions`, `recent_messages` | These fields are dropped | Handle their absence gracefully (they were always optional) |

Everything else is **identical**: the skill system, AgentOverflow ingest/resolve, SSE streaming,
health check endpoint, service account auth, X-Nexus-Skill header, RAG injection.

---

## Architecture

```
OpenCode CLI  ──HTTP──►  Nexus Backend  ──►  Lumin8 (LLM gateway)
                │
                │  X-Nexus-Skill: staking
                │  POST /v1/chat/completions
                │  GET  /api/skills
                │  POST /api/overflow/ingest
                │  POST /api/overflow/resolve
```

The CLI sends **no credentials**. The backend authenticates to Lumin8 via a service account
token configured at deployment time. The CLI sends only:
- `apiKey: "nexus-passthrough"` (dummy value, backend ignores it)
- `X-Nexus-Skill: <skill_name>` header on every request

---

## Endpoint Reference

### 1. `POST /v1/chat/completions` — Main LLM endpoint

**What it does**: Receives the OpenCode agent's conversation, injects product context from
RAG, forwards to Lumin8, streams the response back.

**Request shape**:
```json
{
  "model": "nexus-agent",
  "stream": true,
  "temperature": 0,
  "messages": [
    { "role": "system", "content": "You are an AI coding assistant..." },
    { "role": "user",   "content": "Fix the authentication bug" }
  ],
  "tools": [
    { "type": "function", "function": { "name": "edit", "description": "..." } },
    { "type": "function", "function": { "name": "bash", "description": "..." } }
  ]
}
```

**Headers received**:
- `X-Nexus-Skill: staking` (or payments, default, etc.)
- `Authorization: Basic bmV4dXMtcGFzc3Rocm91Z2g=` (base64 of `nexus-passthrough`, ignore it)

**What the backend must do**:
1. Read `X-Nexus-Skill` header
2. Load the corresponding product context: SKILLS.md content + relevant Confluence chunks + code standards
3. Inject that context as a system message into the `messages` array (position does not matter — inject wherever your RAG pipeline determines is appropriate)
4. Forward augmented messages + tools to Lumin8
5. Stream the Lumin8 response back as SSE

**Critical implementation note — no message-ordering constraint**:
The previous backend had to preserve `messages[0]` because Aider stored SEARCH/REPLACE format
rules there. OpenCode uses tool calls for editing (the `tools` array above). There are no
format-sensitive messages. Inject RAG wherever you want.

**Response format** (SSE stream):
```
data: {"id":"chatcmpl-abc","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"Here"},"finish_reason":null}]}

data: {"id":"chatcmpl-abc","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_xyz","type":"function","function":{"name":"edit","arguments":"{\"path\":"}}]},"finish_reason":null}]}

data: [DONE]
```

OpenCode's AI SDK handles tool call streaming natively. Just forward what Lumin8 returns.

**Removed from previous implementation**:
- `nexus-architect` model routing — only `nexus-agent` is sent now
- `messages[0]` preservation guard — no longer needed
- SEARCH/REPLACE format reminder in injected context — no longer needed

---

### 2. `GET /api/skills` — List available product contexts

**What it does**: Returns all available skills. Called once at CLI startup for auto-detection
and cached locally in `~/.nexus/config`.

**No changes required from previous implementation.**

**Response**:
```json
[
  {
    "name": "staking",
    "description": "Staking product - validator management and delegation",
    "keywords": ["stake", "validator", "delegation", "epoch", "consensus"]
  },
  {
    "name": "payments",
    "description": "Payments processing and settlement engine",
    "keywords": ["payment", "settlement", "transaction", "ledger"]
  }
]
```

**How the CLI uses it**:
1. Fetches on startup
2. Scores each skill against repo metadata (directory name, git remote URL, top-level filenames)
3. Auto-selects if top score ≥ 10 and 2× better than second
4. Caches the result in `~/.nexus/config` keyed by absolute repo path
5. Uses cached value on subsequent startups in same repo

---

### 3. `GET /api/skills/{name}` — Fetch a specific skill

**What it does**: Validates that a skill exists and returns its metadata. Called when the
user types `@skillname` mid-session to switch product context.

**No changes required from previous implementation.**

**Response**:
```json
{
  "name": "staking",
  "description": "Staking product - validator management and delegation",
  "skill_content": "# Staking Product Skills\n\n## Architecture Rules\n..."
}
```

Return `404` if the skill does not exist. The CLI will silently ignore unrecognised `@tags`
if this endpoint returns 404.

---

### 4. `POST /api/overflow/ingest` — AgentOverflow query

**What it does**: Receives a developer's problem description, performs a semantic similarity
search against the knowledge base, and returns an answer immediately — cached or LLM-generated.

**No changes to the core logic required. The payload is now smaller** (4 Aider-specific fields
were removed). Backend must handle their absence gracefully; they were always marked optional.

**Request shape** (new, simplified):
```json
{
  "description": "Authentication middleware returns 403 after token refresh",
  "git_diff": "diff --git a/auth/middleware.py ...",
  "dirty_files": ["src/auth/middleware.py"],
  "recent_commits": ["fix: token refresh", "chore: bump deps"],
  "all_files": ["src/auth/middleware.py", "src/auth/tokens.py", "tests/test_auth.py"]
}
```

**Fields removed (compared to Aider-era payload)**:
| Field | Was | Why removed |
|---|---|---|
| `chat_files` | Aider's `/add`'d files with 50× PageRank boost | OpenCode has no `/add` concept |
| `ident_mentions` | Identifiers extracted by `coder.get_ident_mentions()` | Backend's own RAG handles this |
| `file_mentions` | File paths extracted by `coder.get_file_mentions()` | Backend's own RAG handles this |
| `recent_messages` | Last 6 Aider conversation turns | Backend session state handles this |

**Semantic cache decision tree** (unchanged):
```
EMBED description
    │
    ├─ similarity ≥ 0.87  → CACHE HIT: return stored answer immediately, no LLM call
    │                         cached: true, persisted: false
    │
    ├─ 0.65–0.87          → SIMILAR: call LLM with related context as RAG
    │                         cached: false, persisted: false
    │
    └─ < 0.65             → NOVEL: call LLM
                              confidence ≥ 0.72 → auto-persist (6-month TTL)
                                cached: false, persisted: true
                              confidence < 0.72 → serve only
                                cached: false, persisted: false
```

**Headers received**: `X-Nexus-Skill` — scope similarity search to the same product KB.

**Response** (unchanged):
```json
{
  "status": "ok",
  "issue_id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "suggestion": "The token expiry check runs before the refresh call on line 47...",
  "cached": false,
  "confidence_score": 0.82,
  "persisted": true
}
```

**`issue_id` is critical**: the CLI stores it in `process.env._NEXUS_LAST_ISSUE_ID` and
sends it to `/api/overflow/resolve` when the developer commits. Generate a stable UUID per
ingest call and persist it so the resolve endpoint can look it up.

---

### 5. `POST /api/overflow/resolve` — Capture the actual fix

**What it does**: Closes the loop on a previous ingest call. Called automatically when the
developer commits after a `/solve` session. The backend generates a resolution summary via
LLM (from the diff) and upserts it to the knowledge base.

**No changes required from previous implementation.**

**Request shape**:
```json
{
  "issue_id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "committed_diff": "commit abc123\nAuthor: Dev <dev@co.com>\n\n    fix\n\ndiff --git a/auth/middleware.py ..."
}
```

Or with explicit note (when developer types `/solved <explanation>`):
```json
{
  "issue_id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "resolution": "Moved TokenRefreshMiddleware before AuthMiddleware in the ASGI stack."
}
```

**Resolution logic**:
- If `resolution` present: store directly, skip LLM summarization
- If only `committed_diff`: feed diff + original issue description to LLM → generate
  human-readable summary → embed `"Issue: {desc}\nResolution: {summary}"` → upsert to vector DB
- If neither: return `422`

**diff is capped at 8000 chars** by the CLI. Backend should not expect larger.

**Response**:
```json
{ "status": "resolved", "message": "Fix captured." }
```

Return `404` if `issue_id` is not found. Return `422` if neither field is provided.

---

### 6. `GET /v1/models` — Health check

**What it does**: CLI calls this at startup to verify the backend is reachable.

**No changes required.**

**Response**:
```json
{
  "object": "list",
  "data": [{ "id": "nexus-agent", "object": "model" }]
}
```

---

## Complete Request Flow

### Normal coding session

```
1. OpenCode starts
   CLI → GET /v1/models                          (health check)
   CLI → GET /api/skills                         (skill detection)
   CLI scores skills, caches "staking" for this repo

2. Developer asks a question
   CLI → POST /v1/chat/completions
         X-Nexus-Skill: staking
         { model: "nexus-agent", messages: [...], tools: [...] }

   Backend:
   - Reads X-Nexus-Skill: staking
   - Loads SKILLS.md for staking
   - Fetches relevant Confluence docs (RAG)
   - Injects product context as system message
   - Forwards to Lumin8
   - Streams response back

3. Agent calls edit tool to modify a file
   (handled entirely client-side by OpenCode — backend never sees the edit)

4. Developer commits
   (no backend call unless /solve was used)
```

### /solve session

```
1. Developer types: /solve auth middleware returning 403 after refresh

   CLI → POST /api/overflow/ingest
         X-Nexus-Skill: staking
         {
           description: "auth middleware returning 403 after refresh",
           git_diff: "...",
           dirty_files: ["src/auth/middleware.py"],
           recent_commits: ["..."],
           all_files: ["src/auth/middleware.py", ...]
         }

   Backend:
   - Embeds description
   - Similarity search in KB
   - Decision: NOVEL (< 0.65)
   - Calls LLM with RAG context
   - confidence: 0.82 → auto-persist
   - Returns { issue_id: "uuid", suggestion: "...", cached: false, persisted: true }

2. Developer fixes the issue and commits

   CLI detects "git commit" in bash tool call
   CLI → POST /api/overflow/resolve
         { issue_id: "uuid", committed_diff: "..." }

   Backend:
   - Looks up issue by UUID
   - Feeds diff + original description to LLM → generates summary
   - Embeds "Issue: ...\nResolution: ..."
   - Upserts to vector DB with 6-month TTL
   - Returns { status: "resolved" }
```

### @skill mid-session switch

```
Developer types: @payments fix the settlement calculation

CLI → GET /api/skills/payments          (validate skill exists)
Backend → 200 { name: "payments", ... }

CLI updates active skill to "payments"
CLI strips "@payments" from message

Next request:
CLI → POST /v1/chat/completions
      X-Nexus-Skill: payments           (switched)
      { messages: [{ content: "fix the settlement calculation" }] }
```

---

## FastAPI Implementation Checklist

### `/v1/chat/completions`
- [ ] Read `X-Nexus-Skill` header from request
- [ ] Load product context for skill (SKILLS.md + Confluence chunks + code standards)
- [ ] Inject product context as system message in `messages` array (position = your choice)
- [ ] Forward full messages + tools array to Lumin8
- [ ] Stream SSE response back to client
- [ ] **Remove**: any `messages[0]` preservation or position-checking logic
- [ ] **Remove**: any `nexus-architect` vs `nexus-agent` model-name branching

### `/api/skills`
- [ ] Return array of `{ name, description, keywords }` objects
- [ ] No auth required (internal network + service account)

### `/api/skills/{name}`
- [ ] Return `{ name, description, skill_content }` for known skill
- [ ] Return `404` for unknown skill name

### `/api/overflow/ingest`
- [ ] Accept `description` (required) + `git_diff`, `dirty_files`, `recent_commits`, `all_files` (optional)
- [ ] **Handle absence** of `chat_files`, `ident_mentions`, `file_mentions`, `recent_messages` gracefully (removed from payload)
- [ ] Embed description, run similarity search scoped to `X-Nexus-Skill`
- [ ] Apply cache decision tree (0.87 / 0.65 / 0.72 thresholds)
- [ ] Generate and persist `issue_id` (UUID) per call
- [ ] Return `{ status, issue_id, suggestion, cached, confidence_score, persisted }`

### `/api/overflow/resolve`
- [ ] Accept `issue_id` (required) + one of `committed_diff` or `resolution`
- [ ] Look up issue by `issue_id` → `404` if not found
- [ ] If `resolution` → store directly
- [ ] If `committed_diff` only → LLM summarize → store
- [ ] If neither → `422`
- [ ] Upsert `"Issue: {desc}\nResolution: {text}"` embedding to vector DB
- [ ] Return `{ status: "resolved" }`

### `/v1/models`
- [ ] Return `{ object: "list", data: [{ id: "nexus-agent", object: "model" }] }`

---

## Environment Variables

| Variable | Description | Example |
|---|---|---|
| `NEXUS_BASE_URL` | Backend URL (set on CLI side) | `http://localhost:8000` |
| `LUMIN8_API_KEY` | Service account token for LLM gateway | (internal) |
| `CHROMADB_URL` | Vector DB for AgentOverflow | `http://vectordb:8001` |
| `CONFLUENCE_URL` | Confluence base URL for RAG | `https://confluence.internal` |
| `CONFLUENCE_TOKEN` | Confluence API token | (internal) |

---

## Testing Against the CLI

Run OpenCode against the mock backend first:

```bash
# 1. Start mock backend (from nexus-cli repo)
cd /path/to/nexus-cli
python3 mock_backend.py

# 2. Start OpenCode pointing at mock
cd /path/to/nexus-opencode
NEXUS_BASE_URL=http://localhost:8000 opencode

# 3. Test skill detection — should log "detected: staking" or similar
# 4. Test a chat message — should go through /v1/chat/completions
# 5. Test: /solve auth middleware returning 403
# 6. Make a commit, verify /api/overflow/resolve is called
# 7. Test: @payments — should switch X-Nexus-Skill header
```

The mock backend (`mock_backend.py`) logs all requests. Check its output to verify
the CLI is sending the correct headers and payloads.

---

## OpenAPI Spec

The full API contract is in `docs/nexus-backend-openapi.yaml` (v2.0).
All request/response schemas with examples are there.
