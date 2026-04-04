/// <reference path="../env.d.ts" />
/**
 * Nexus Plugin for OpenCode
 *
 * Thin glue layer between OpenCode and the Nexus backend. The backend is the brain:
 * it handles RAG retrieval, agentic session management, LLM routing, and the
 * AgentOverflow knowledge base. This plugin's jobs are:
 *
 * 1. Hard-fail if the Nexus backend is unreachable — no silent fallback to vanilla OpenCode
 * 2. Detect the active product skill from repo metadata; ask the user if ambiguous
 * 3. Stamp `X-Nexus-Skill` on every LLM request so the backend loads the right context
 * 4. Intercept `@skillname` (and plain skill name when prompted) to switch context mid-session
 * 5. Inject a brief Nexus coordination note on the first message so OpenCode's local
 *    orchestration layer knows the active skill and that AgentOverflow (/solve) exists
 * 6. Propagate `_NEXUS_ACTIVE_SKILL` into all spawned shell processes via shell.env hook
 * 7. Auto-capture committed fixes in AgentOverflow (tool.execute.after on git commit)
 *
 * Coordination principle: OpenCode is the local orchestration engine (planning, tool use,
 * LSP, file editing). Nexus Core Engine is the remote brain (RAG, team context, LLM routing).
 * They enhance each other — the plugin ensures they share the same skill context and that
 * OpenCode's agent knows to delegate hard debugging problems to AgentOverflow.
 */

import type { Plugin, PluginInput, Hooks } from "@opencode-ai/plugin"
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, chmodSync } from "fs"
import { join, resolve, basename } from "path"
import { execSync } from "child_process"
import { homedir } from "os"

// ── Configuration ───────────────────────────────────────────────────────────

const NEXUS_BASE_URL = process.env.NEXUS_BASE_URL ?? "http://localhost:8000"
const NEXUS_CONFIG_DIR = join(homedir(), ".nexus")
const NEXUS_CONFIG_FILE = join(NEXUS_CONFIG_DIR, "config")

// ── State ───────────────────────────────────────────────────────────────────
// Cross-file state (plugin ↔ tools) is shared via process.env:
//   _NEXUS_ACTIVE_SKILL   — current product context, stamped on every LLM request
//   _NEXUS_LAST_ISSUE_ID  — issue ID from the last /solve, cleared after auto-resolve

let activeSkill = "default"
let pendingSkillSelection = false   // true when auto-detection was ambiguous
let availableSkillNames: string[] = []
let nexusContextInjected = false    // inject coordination note only on first message

// ── Config persistence ──────────────────────────────────────────────────────

function loadConfig(): Record<string, any> {
  try {
    if (existsSync(NEXUS_CONFIG_FILE)) {
      return JSON.parse(readFileSync(NEXUS_CONFIG_FILE, "utf-8"))
    }
  } catch {}
  return {}
}

function saveConfig(config: Record<string, any>) {
  mkdirSync(NEXUS_CONFIG_DIR, { recursive: true })
  writeFileSync(NEXUS_CONFIG_FILE, JSON.stringify(config, null, 2))
  try {
    chmodSync(NEXUS_CONFIG_FILE, 0o600)
  } catch {}
}

// ── Repo metadata for skill detection ───────────────────────────────────────

function getRepoMetadata(directory: string) {
  const metadata = {
    directoryName: basename(resolve(directory)),
    gitRemoteUrl: "",
    topLevelFiles: [] as string[],
  }

  try {
    metadata.gitRemoteUrl = execSync("git remote get-url origin", {
      cwd: directory,
      timeout: 5000,
      encoding: "utf-8",
    }).trim()
  } catch {}

  try {
    const entries = readdirSync(directory)
      .filter((e) => !e.startsWith("."))
      .slice(0, 50)
    metadata.topLevelFiles = entries
  } catch {}

  return metadata
}

// ── Skill scoring ───────────────────────────────────────────────────────────

interface Skill {
  name: string
  description?: string
  keywords?: string[]
  skill_content?: string
}

function scoreSkill(
  skill: Skill,
  metadata: ReturnType<typeof getRepoMetadata>,
): number {
  let score = 0
  const keywords = (skill.keywords ?? []).map((k) => k.toLowerCase())
  const skillName = skill.name.toLowerCase()

  const dirName = metadata.directoryName.toLowerCase()
  const remoteUrl = metadata.gitRemoteUrl.toLowerCase()
  const topFiles = metadata.topLevelFiles.map((f) => f.toLowerCase())

  if (skillName.includes(dirName) || dirName.includes(skillName)) {
    score += 10
  }

  for (const kw of keywords) {
    if (dirName.includes(kw)) score += 5
    if (remoteUrl.includes(kw)) score += 5
    for (const f of topFiles) {
      if (f.includes(kw)) score += 2
    }
  }

  return score
}

// ── Skill detection ─────────────────────────────────────────────────────────

interface SkillDetectionResult {
  name: string
  confident: boolean
  availableSkills: Skill[]
}

async function detectActiveSkill(directory: string): Promise<SkillDetectionResult> {
  const config = loadConfig()
  const skillMappings: Record<string, string> = config.skill_mappings ?? {}
  const repoKey = resolve(directory)

  // Cached selection (was confident in a prior session)
  if (skillMappings[repoKey]) {
    return { name: skillMappings[repoKey], confident: true, availableSkills: [] }
  }

  // Fetch available skills from backend
  let skills: Skill[]
  try {
    const resp = await fetch(`${NEXUS_BASE_URL}/api/skills`, {
      signal: AbortSignal.timeout(10000),
    })
    if (!resp.ok) return { name: "default", confident: false, availableSkills: [] }
    skills = await resp.json()
  } catch {
    return { name: "default", confident: false, availableSkills: [] }
  }

  if (!skills || skills.length === 0) {
    return { name: "default", confident: true, availableSkills: [] }
  }

  const metadata = getRepoMetadata(directory)
  const scored = skills
    .map((skill) => ({ skill, score: scoreSkill(skill, metadata) }))
    .sort((a, b) => b.score - a.score)

  const best = scored[0]
  // Confident = clear winner: score ≥ 10 AND at least 2× better than second place
  const confident =
    best.score >= 10 && (scored.length < 2 || best.score > scored[1].score * 2)

  if (confident) {
    // Cache only confident auto-selections
    skillMappings[repoKey] = best.skill.name
    config.skill_mappings = skillMappings
    saveConfig(config)
    return { name: best.skill.name, confident: true, availableSkills: skills }
  }

  // Ambiguous — return the best guess but flag for user confirmation
  return { name: best.skill.name, confident: false, availableSkills: skills }
}

// ── Validate and switch skill ───────────────────────────────────────────────

async function validateAndSwitchSkill(
  skillName: string,
  directory: string,
): Promise<boolean> {
  try {
    const resp = await fetch(
      `${NEXUS_BASE_URL}/api/skills/${encodeURIComponent(skillName)}`,
      { signal: AbortSignal.timeout(10000) },
    )
    if (!resp.ok) return false

    activeSkill = skillName
    process.env._NEXUS_ACTIVE_SKILL = skillName

    // Persist the confirmed selection
    const config = loadConfig()
    const skillMappings: Record<string, string> = config.skill_mappings ?? {}
    skillMappings[resolve(directory)] = skillName
    config.skill_mappings = skillMappings
    saveConfig(config)

    return true
  } catch {
    return false
  }
}

// ── AgentOverflow helpers ───────────────────────────────────────────────────

function getCommittedDiff(directory: string): string | null {
  try {
    const diff = execSync("git show HEAD --no-color -p --stat", {
      cwd: directory,
      timeout: 10000,
      encoding: "utf-8",
      maxBuffer: 1024 * 1024,
    }).trim()
    if (!diff) return null
    return diff.length > 8000
      ? diff.slice(0, 8000) + "\n\n... (diff truncated for payload size)"
      : diff
  } catch {
    return null
  }
}

async function sendResolve(
  issueId: string,
  opts: { committedDiff?: string; resolution?: string },
): Promise<boolean> {
  const payload: Record<string, string> = { issue_id: issueId }
  if (opts.committedDiff) payload.committed_diff = opts.committedDiff
  if (opts.resolution) payload.resolution = opts.resolution

  try {
    const resp = await fetch(`${NEXUS_BASE_URL}/api/overflow/resolve`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Nexus-Skill": activeSkill,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15000),
    })
    return resp.ok
  } catch {
    return false
  }
}

// ── Plugin entry point ──────────────────────────────────────────────────────

export const server: Plugin = async (input: PluginInput) => {
  const { directory } = input

  // Hard-fail if the Nexus backend is unreachable.
  // Nexus CLI has no purpose without the backend — it is not a generic AI
  // coding tool. Failing loudly prevents silent fallback to vanilla OpenCode,
  // which would be confusing on enterprise laptops (GHCP already covers that).
  try {
    const resp = await fetch(`${NEXUS_BASE_URL}/v1/models`, {
      signal: AbortSignal.timeout(5000),
    })
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
  } catch {
    const hint =
      process.env.NEXUS_BASE_URL
        ? `NEXUS_BASE_URL is set to: ${NEXUS_BASE_URL}`
        : `Default URL: ${NEXUS_BASE_URL} — set NEXUS_BASE_URL to override`
    console.error(`
╔══════════════════════════════════════════════════════════════════╗
║              NEXUS ERROR: Backend unreachable                    ║
╠══════════════════════════════════════════════════════════════════╣
║                                                                  ║
║  Nexus CLI cannot start because it cannot reach the             ║
║  Nexus Core Engine backend.                                      ║
║                                                                  ║
║  ${hint.padEnd(64)}║
║                                                                  ║
║  What to do:                                                     ║
║  1. Confirm the backend is deployed and accessible               ║
║  2. Check your network / VPN connection                          ║
║  3. Set NEXUS_BASE_URL to the correct backend address            ║
║     e.g.  export NEXUS_BASE_URL=https://nexus.yourcompany.com   ║
║                                                                  ║
║  For local dev: start the backend first, then run nexus          ║
║                                                                  ║
╚══════════════════════════════════════════════════════════════════╝
`)
    process.exit(1)
  }

  // Detect product skill. If ambiguous, flag for user confirmation in chat.
  const detection = await detectActiveSkill(directory)
  activeSkill = detection.name
  process.env._NEXUS_ACTIVE_SKILL = activeSkill

  if (!detection.confident && detection.availableSkills.length > 0) {
    pendingSkillSelection = true
    availableSkillNames = detection.availableSkills.map((s) => s.name)
  }

  const hooks: Hooks = {
    // ── Stamp X-Nexus-Skill on every LLM request ──────────────────────────
    // The backend uses this to load the right product context (SKILLS.md,
    // Confluence docs, code standards) before forwarding to the LLM.
    "chat.headers": async (_input, output) => {
      output.headers["X-Nexus-Skill"] = activeSkill
    },

    // ── Propagate skill context to all shell processes ─────────────────────
    // Triggered for every bash tool call and the PTY. Ensures that any
    // scripts, sub-agents, or tools spawned from shell inherit the Nexus
    // context — they can read _NEXUS_ACTIVE_SKILL without calling the backend.
    "shell.env": async (_input, output) => {
      output.env["_NEXUS_ACTIVE_SKILL"] = activeSkill
      output.env["NEXUS_BASE_URL"] = NEXUS_BASE_URL
    },

    // ── Handle messages: skill switching, selection prompt, context note ───
    "chat.message": async (_input, output) => {
      const textParts = output.parts.filter(
        (p): p is Extract<typeof p, { type: "text" }> => p.type === "text",
      )
      const text = textParts.map((p) => p.text).join(" ")
      if (!text) return

      // 1. Handle @skill switching (any message)
      const skillMatch = text.match(/@(\w+)/)
      if (skillMatch) {
        const skillName = skillMatch[1]
        const switched = await validateAndSwitchSkill(skillName, directory)
        if (switched) {
          pendingSkillSelection = false
          for (const part of textParts) {
            part.text = part.text.replace(new RegExp(`@${skillName}\\s*`), "").trim()
          }
          return
        }
      }

      // 2. If skill selection is pending, also accept a plain skill name as the
      //    entire message (the LLM will have asked "which skill?" and the user
      //    simply types e.g. "staking" in reply).
      if (pendingSkillSelection && !skillMatch) {
        const trimmed = text.trim().toLowerCase()
        const matched = availableSkillNames.find((s) => s.toLowerCase() === trimmed)
        if (matched) {
          const switched = await validateAndSwitchSkill(matched, directory)
          if (switched) {
            pendingSkillSelection = false
            nexusContextInjected = true  // don't inject again; LLM will confirm skill
            for (const part of textParts) part.text = ""
            return
          }
        }
      }

      // 3. Inject a Nexus coordination note on the first message of the session.
      //    This keeps OpenCode's local orchestration layer in sync with Nexus:
      //    - tells it which product skill is active
      //    - tells it AgentOverflow is available via /solve for complex bugs
      //    - if skill is ambiguous, asks it to prompt the user before proceeding
      if (!nexusContextInjected && textParts[0]) {
        nexusContextInjected = true

        if (pendingSkillSelection) {
          const list = availableSkillNames.join(", ")
          textParts[0].text =
            `[Nexus: product skill could not be auto-detected for this repo. ` +
            `Available skills: ${list}. Before answering, ask the user which skill ` +
            `to activate. They can reply with just the skill name or type @skillname.]\n\n` +
            textParts[0].text
        } else {
          textParts[0].text =
            `[Nexus context: active skill="${activeSkill}". ` +
            `When you encounter a bug or error you cannot resolve confidently, ` +
            `use the /solve command to query the team knowledge base (AgentOverflow) ` +
            `before attempting multiple speculative fix attempts.]\n\n` +
            textParts[0].text
        }
      }
    },

    // ── Auto-resolve AgentOverflow on git commit ──────────────────────────
    // When the developer commits after a /solve session, capture the committed
    // diff and send it to /api/overflow/resolve. The backend summarizes the
    // diff via LLM and upserts the resolution into the knowledge base.
    // Failures are silent — never block the commit flow.
    "tool.execute.after": async (input, _output) => {
      if (input.tool !== "bash") return
      const issueId = process.env._NEXUS_LAST_ISSUE_ID
      if (!issueId) return

      const args = typeof input.args === "string" ? input.args : JSON.stringify(input.args)
      if (!args.includes("git commit")) return

      const committedDiff = getCommittedDiff(directory)
      if (!committedDiff) return

      const ok = await sendResolve(issueId, { committedDiff })
      if (ok) {
        delete process.env._NEXUS_LAST_ISSUE_ID
      }
    },
  }

  return hooks
}

// Active skill is shared with tools via process.env._NEXUS_ACTIVE_SKILL
// Last issue ID is shared with tools via process.env._NEXUS_LAST_ISSUE_ID
// This avoids cross-file module state coupling; env is the lingua franca between
// the plugin and the standalone tool files loaded separately by OpenCode.
