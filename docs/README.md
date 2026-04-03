# Nexus CLI — Documentation Index

Enterprise AI coding assistant built on [OpenCode](https://github.com/anomalyco/opencode).

---

## For developers using Nexus

**[nexus-user-guide.md](nexus-user-guide.md)**
Installation, first run, all commands (`/solve`, `/solved`, `@skill`), workflows, keyboard
shortcuts, and troubleshooting. Start here.

---

## For backend engineers

**[nexus-backend-handover.md](nexus-backend-handover.md)**
Everything needed to implement or update the Nexus FastAPI backend for the OpenCode CLI.
Covers all 6 endpoints, complete request/response shapes, the two migration changes
required, full request flow walkthroughs, and an implementation checklist.

**[nexus-backend-openapi.yaml](nexus-backend-openapi.yaml)**
OpenAPI 3.1 spec — the authoritative API contract. v2.0 reflects the OpenCode migration.

---

## Migration reference

**[nexus-migration-from-aider.md](nexus-migration-from-aider.md)**
Why the CLI migrated from Aider to OpenCode, what was removed, what was retained,
and what the backend team needs to change. Read this if you're wondering why something
that existed before is now gone.

---

## Plugin source

All Nexus customizations live in `.opencode/` at the repo root — no fork required.

```
.opencode/
  plugins/nexus.ts        ← skill detection, header injection, auto-resolve on commit
  tool/nexus-solve.ts     ← AgentOverflow /solve
  tool/nexus-solved.ts    ← AgentOverflow /solved
  command/solve.md        ← /solve slash command template
  command/solved.md       ← /solved slash command template
  agent/nexus-planner.md  ← read-only planning agent
  opencode.jsonc          ← provider config (Nexus backend URL + passthrough auth)
```
