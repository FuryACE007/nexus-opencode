/// <reference path="../env.d.ts" />
/**
 * AgentOverflow /solve tool
 *
 * Submits a developer problem to the Nexus AgentOverflow semantic cache.
 * The backend (Nexus core engine) handles RAG retrieval, LLM routing, and
 * the cache decision — this tool only gathers git context and dispatches.
 *
 * Cache decision (backend-side, transparent to developer):
 *   similarity >= 0.87  -> cache hit, instant answer, no LLM call
 *   0.65 - 0.87         -> similar, LLM called with related context, not persisted
 *   < 0.65 + conf >= 0.72 -> novel, LLM answer auto-stored (6-month TTL)
 *   < 0.65 + low conf   -> answered but not stored
 */

import { tool } from "@opencode-ai/plugin"
import { execSync } from "child_process"

const NEXUS_BASE_URL = process.env.NEXUS_BASE_URL ?? "http://localhost:8000"

function exec(cmd: string, cwd: string): string {
  try {
    return execSync(cmd, { cwd, timeout: 10000, encoding: "utf-8", maxBuffer: 1024 * 1024 }).trim()
  } catch {
    return ""
  }
}

export default tool({
  description: `Submit a developer problem to Nexus AgentOverflow for instant resolution.

Use this tool when the developer describes an error, bug, or problem they need help with.
The Nexus backend queries the enterprise knowledge base and returns either a cached answer
(instant) or an LLM-generated suggestion with RAG context from Confluence and product docs.

After calling this tool, if the developer fixes the issue and commits, the fix will be
automatically captured in the knowledge base for future developers hitting the same error.`,
  args: {
    description: tool.schema
      .string()
      .describe("Description of the problem or error the developer is experiencing"),
  },
  async execute(args, context) {
    const { description } = args
    const cwd = context.directory

    // Git context — gives the backend temporal signal about what's in flux
    const gitDiff = exec("git diff", cwd)
    const dirtyFiles = exec("git diff --name-only", cwd).split("\n").filter(Boolean)
    const recentCommits = exec("git log --oneline -5 --no-decorate", cwd).split("\n").filter(Boolean)

    // Full list of tracked files — lets the backend scope its retrieval to this repo
    const allFiles = exec("git ls-files", cwd).split("\n").filter(Boolean)

    const payload = {
      description,
      git_diff: gitDiff,
      dirty_files: dirtyFiles,
      recent_commits: recentCommits,
      all_files: allFiles,
    }

    const skillHeader = process.env._NEXUS_ACTIVE_SKILL ?? "default"
    const resp = await fetch(`${NEXUS_BASE_URL}/api/overflow/ingest`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Nexus-Skill": skillHeader,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(30000),
    })

    if (!resp.ok) {
      return `AgentOverflow API returned HTTP ${resp.status}`
    }

    const result = (await resp.json()) as {
      issue_id?: string
      suggestion?: string
      cached?: boolean
      confidence_score?: number
      persisted?: boolean
    }

    // Store issue ID so the plugin's commit hook can auto-resolve
    if (result.issue_id) {
      process.env._NEXUS_LAST_ISSUE_ID = result.issue_id
    }

    const lines: string[] = []

    if (result.cached) {
      lines.push("Cache hit -- returning similar solution from knowledge base.")
    } else {
      lines.push("Analyzed with LLM.")
      if (result.persisted) lines.push("Solution saved to team knowledge base.")
    }

    if (result.suggestion) {
      lines.push("")
      lines.push(result.suggestion)
    }

    if (result.confidence_score !== undefined && result.confidence_score < 0.6) {
      lines.push(`\n(Low confidence: ${(result.confidence_score * 100).toFixed(0)}%) -- treat this as a starting point.`)
    }

    if (result.issue_id && !result.cached) {
      lines.push("\nResolution will be recorded automatically when a git commit is made.")
    }

    return lines.join("\n")
  },
})
