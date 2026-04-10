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
 * 4. Handle `/skill <name>` and `/nskills` commands (and plain skill name when prompted) to switch context mid-session
 * 5. Inject skill context + AgentOverflow instructions into system prompt on every LLM call
 * 6. Propagate `_NEXUS_ACTIVE_SKILL` into all spawned shell processes via shell.env hook
 *
 * Coordination principle: OpenCode is the local orchestration engine (planning, tool use,
 * LSP, file editing). Nexus Core Engine is the remote brain (RAG, team context, LLM routing).
 * They enhance each other — the plugin ensures they share the same skill context and that
 * OpenCode's agent uses nexus-search + nexus-solve for product and debugging queries.
 */

import type { Plugin, PluginInput, Hooks } from "@opencode-ai/plugin"
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, chmodSync } from "fs"
import { join, resolve, basename } from "path"
import { execSync } from "child_process"
import { homedir } from "os"

// ── Configuration ───────────────────────────────────────────────────────────

const NEXUS_BASE_URL = process.env.NEXUS_BASE_URL ?? "http://127.0.0.1:8000"
const NEXUS_CONFIG_DIR = join(homedir(), ".nexus")
const NEXUS_CONFIG_FILE = join(NEXUS_CONFIG_DIR, "config")

// ── State ───────────────────────────────────────────────────────────────────
// Cross-file state (plugin ↔ tools) is shared via process.env:
//   _NEXUS_ACTIVE_SKILL   — current product context, stamped on every LLM request
//   _NEXUS_LAST_ISSUE_ID  — issue ID from the last /solve, cleared after auto-resolve

let activeSkill = "staking"
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
  try {
    mkdirSync(NEXUS_CONFIG_DIR, { recursive: true })
    writeFileSync(NEXUS_CONFIG_FILE, JSON.stringify(config, null, 2))
    chmodSync(NEXUS_CONFIG_FILE, 0o600)
  } catch {
    // Non-fatal: config persistence failure means skill will be re-detected
    // next session, but the current session continues fine with in-memory state.
  }
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
    if (!resp.ok) return { name: "staking", confident: false, availableSkills: [] }
    skills = await resp.json()
  } catch {
    return { name: "staking", confident: false, availableSkills: [] }
  }

  if (!skills || skills.length === 0) {
    return { name: "staking", confident: true, availableSkills: [] }
  }

  const metadata = getRepoMetadata(directory)
  const scored = skills
    .map((skill) => ({ skill, score: scoreSkill(skill, metadata) }))
    .sort((a, b) => b.score - a.score)

  const best = scored[0]
  // Confident = clear winner: score ≥ 10 AND strictly more than 2× the runner-up
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
    // Restore terminal before exiting — OpenCode's TUI may have already
    // enabled alternate screen + raw mode. Without this the shell is left
    // unresponsive after the process dies.
    try { (process.stdin as any).setRawMode?.(false) } catch {}
    process.stdout.write("\x1b[?1049l") // exit alternate screen buffer
    process.stdout.write("\x1b[?25h")   // show cursor
    process.stdout.write("\x1b[0m\r\n") // reset colors, move to new line
    process.exit(1)
  }

  // Detect product skill. If ambiguous, flag for user confirmation in chat.
  const detection = await detectActiveSkill(directory)
  activeSkill = detection.name
  process.env._NEXUS_ACTIVE_SKILL = activeSkill

  if (detection.availableSkills.length > 0) {
    availableSkillNames = detection.availableSkills.map((s) => s.name)
  }
  if (!detection.confident && availableSkillNames.length > 0) {
    pendingSkillSelection = true
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

    // ── Handle messages: skill switching, skill listing, selection prompt, context note ───
    "chat.message": async (_input, output) => {
      const textParts = output.parts.filter(
        (p): p is Extract<typeof p, { type: "text" }> => p.type === "text",
      )
      const text = textParts.map((p) => p.text).join(" ")
      if (!text) return

      // 1. Handle /skill command — [NEXUS_SKILL_SWITCH:skillname]
      //    Inserted by .opencode/command/skill.md after $ARGUMENTS substitution.
      const switchMatch = text.match(/\[NEXUS_SKILL_SWITCH:(\w+)\]/)
      if (switchMatch) {
        const skillName = switchMatch[1]
        const marker = switchMatch[0]
        const switched = await validateAndSwitchSkill(skillName, directory)
        if (switched) {
          pendingSkillSelection = false
          for (const part of textParts) {
            part.text = part.text.replace(
              marker,
              `[Nexus: Skill successfully switched to "${skillName}". Inform the user the skill is now active.]`,
            ).trim()
          }
        } else {
          for (const part of textParts) {
            part.text = part.text.replace(
              marker,
              `[Nexus: Skill "${skillName}" was not found or the backend is unavailable. ` +
              `Available skills: ${availableSkillNames.join(", ") || "unknown"}. ` +
              `Inform the user and continue with the current skill "${activeSkill}".]`,
            ).trim()
          }
        }
        return
      }

      // 2. Handle /nskills command — [NEXUS_LIST_SKILLS]
      //    Inserted by .opencode/command/nskills.md.
      if (text.includes("[NEXUS_LIST_SKILLS]")) {
        // Re-fetch from backend if the list isn't populated (e.g. skill was cached from prior session)
        if (availableSkillNames.length === 0) {
          try {
            const resp = await fetch(`${NEXUS_BASE_URL}/api/skills`, {
              signal: AbortSignal.timeout(10000),
            })
            if (resp.ok) {
              const skills: Skill[] = await resp.json()
              availableSkillNames = skills.map((s) => s.name)
            }
          } catch {}
        }
        const skillDisplay = availableSkillNames.length > 0
          ? availableSkillNames.map((s) => s === activeSkill ? `${s} (active)` : s).join(", ")
          : "No skills available from backend"
        for (const part of textParts) {
          part.text = part.text.replace(
            "[NEXUS_LIST_SKILLS]",
            `[Nexus: Available skills: ${skillDisplay}. Currently active: "${activeSkill}". ` +
            `Present this list clearly to the user and mention they can switch with /skill <name>.]`,
          ).trim()
        }
        return
      }

      // 3. If skill selection is pending, also accept a plain skill name as the
      //    entire message (the LLM will have asked "which skill?" and the user
      //    simply types e.g. "staking" in reply).
      if (pendingSkillSelection) {
        const trimmed = text.trim().toLowerCase()
        const matched = availableSkillNames.find((s) => s.toLowerCase() === trimmed)
        if (matched) {
          const switched = await validateAndSwitchSkill(matched, directory)
          if (switched) {
            pendingSkillSelection = false
            nexusContextInjected = true
            for (const part of textParts) {
              part.text = `Skill set to: ${matched}`
            }
            return
          }
        }
      }

      // 4. If skill is ambiguous, inject selection prompt on first message only.
      //    For confident skill, skill context is injected via system.transform hook
      //    on every LLM call — no need to pollute the user message.
      if (!nexusContextInjected && pendingSkillSelection && textParts[0]) {
        nexusContextInjected = true
        const list = availableSkillNames.join(", ")
        textParts[0].text =
          `[Nexus: product skill could not be auto-detected for this repo. ` +
          `Available skills: ${list}. Before answering, ask the user which skill ` +
          `to activate. They can use /skill <name> to switch, or just reply with the skill name.]\n\n` +
          textParts[0].text
      }
    },

    // ── Inject Nexus skill context into system prompt on every LLM call ───
    // Uses the dedicated system transform hook so instructions live in the
    // system prompt (not the user message) and survive compaction boundaries.
    "experimental.chat.system.transform": async (_input, output) => {
      output.system.push(
        `Active Nexus skill: "${activeSkill}".\n` +
        `You have Nexus tools for team knowledge:\n` +
        `- nexus-search: query the KB for product docs, architecture, APIs, conventions. Prefer over read/grep for product context.\n` +
        `- nexus-solve: query AgentOverflow for known solutions to bugs/errors. Use proactively when you detect the user is stuck — do not wait for /solve.\n` +
        `- nexus-solved: save a resolution to the team KB. Only call after user explicitly approves.\n\n` +
        `Resolution flow: after helping resolve an issue, summarize the complete fix (problem, steps, root cause, solution) and present it to the user: ` +
        `"Want to save this to the team KB? You can approve or edit first." ` +
        `Wait for explicit approval before calling nexus-solved. Never auto-save.`,
      )
    },
  }

  return hooks
}

// Active skill is shared with tools via process.env._NEXUS_ACTIVE_SKILL
// Last issue ID is shared with tools via process.env._NEXUS_LAST_ISSUE_ID
// This avoids cross-file module state coupling; env is the lingua franca between
// the plugin and the standalone tool files loaded separately by OpenCode.
