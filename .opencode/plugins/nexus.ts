/// <reference path="../env.d.ts" />
/**
 * Nexus Plugin for OpenCode
 *
 * Thin glue layer between OpenCode and the Nexus backend. The backend is the brain:
 * it handles RAG retrieval, agentic session management, LLM routing, and the
 * AgentOverflow knowledge base. This plugin's only jobs are:
 *
 * 1. Route all LLM traffic to the Nexus backend (zero-config, no API keys on client)
 * 2. Detect the active product skill from repo metadata and cache it locally
 * 3. Stamp `X-Nexus-Skill` on every LLM request so the backend loads the right context
 * 4. Intercept `@skillname` in user messages to switch product context mid-session
 * 5. Auto-capture committed fixes in AgentOverflow (tool.execute.after on git commit)
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

async function detectActiveSkill(directory: string): Promise<string> {
  const config = loadConfig()
  const skillMappings: Record<string, string> = config.skill_mappings ?? {}
  const repoKey = resolve(directory)

  // Check cache
  if (skillMappings[repoKey]) {
    return skillMappings[repoKey]
  }

  // Fetch available skills from backend
  let skills: Skill[]
  try {
    const resp = await fetch(`${NEXUS_BASE_URL}/api/skills`, {
      signal: AbortSignal.timeout(10000),
    })
    if (!resp.ok) return "default"
    skills = await resp.json()
  } catch {
    return "default"
  }

  if (!skills || skills.length === 0) return "default"

  // Score and select
  const metadata = getRepoMetadata(directory)
  const scored = skills
    .map((skill) => ({ skill, score: scoreSkill(skill, metadata) }))
    .sort((a, b) => b.score - a.score)

  const best = scored[0]
  const selected =
    best.score >= 10 && (scored.length < 2 || best.score > scored[1].score * 2)
      ? best.skill.name
      : scored[0].skill.name // default to top-scored

  // Cache the selection
  skillMappings[repoKey] = selected
  config.skill_mappings = skillMappings
  saveConfig(config)

  return selected
}

// ── Validate and switch @skill ──────────────────────────────────────────────

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

    // Update cache
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

  // Detect skill on startup and make it available to tools
  activeSkill = await detectActiveSkill(directory)
  process.env._NEXUS_ACTIVE_SKILL = activeSkill

  // Verify backend is reachable
  try {
    await fetch(`${NEXUS_BASE_URL}/v1/models`, { signal: AbortSignal.timeout(5000) })
  } catch {
    console.warn(`[nexus] Backend not reachable at ${NEXUS_BASE_URL}. Continuing without Nexus integration.`)
  }

  const hooks: Hooks = {
    // ── Stamp X-Nexus-Skill on every LLM request ──────────────────────────
    // The backend uses this to load the right product context (SKILLS.md,
    // Confluence docs, code standards) before forwarding to Lumin8.
    "chat.headers": async (_input, output) => {
      output.headers["X-Nexus-Skill"] = activeSkill
    },

    // ── Intercept @skillname in user messages ─────────────────────────────
    // Validates against /api/skills/{name}, updates the active skill, and
    // strips the tag from the message before it reaches the backend.
    "chat.message": async (_input, output) => {
      // In OpenCode, the message parts are stored in output.parts, not output.message.content
      const textParts = output.parts.filter((p): p is Extract<typeof p, { type: "text" }> => p.type === "text")
      const text = textParts.map((p) => p.text).join(" ")
      if (!text) return

      const skillMatch = text.match(/@(\w+)/)
      if (!skillMatch) return

      const skillName = skillMatch[1]
      const switched = await validateAndSwitchSkill(skillName, directory)
      if (switched) {
        activeSkill = skillName
        process.env._NEXUS_ACTIVE_SKILL = skillName
        // Strip the @skill tag from text parts
        for (const part of textParts) {
          part.text = part.text.replace(new RegExp(`@${skillName}\\s*`), "").trim()
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
