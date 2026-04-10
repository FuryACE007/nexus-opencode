/// <reference path="../env.d.ts" />
/**
 * AgentOverflow nexus-solve tool
 *
 * Queries the Nexus AgentOverflow semantic cache for known solutions to bugs,
 * errors, or product-specific problems. Designed to be called proactively by
 * the LLM when it detects the user is stuck — not only on explicit /solve.
 *
 * Cache decision (backend-side, transparent to the LLM):
 *   similarity >= 0.87  -> cache hit, instant answer, no LLM call
 *   0.65 - 0.87         -> similar, LLM called with related context
 *   < 0.65 + conf>=0.72 -> novel, LLM answer auto-stored (6-month TTL)
 *   < 0.65 + low conf   -> answered but not stored
 */

import { tool } from "@opencode-ai/plugin"
import { execSync } from "child_process"

const NEXUS_BASE_URL = process.env.NEXUS_BASE_URL ?? "http://127.0.0.1:8000"

function exec(cmd: string, cwd: string): string {
  try {
    return execSync(cmd, { cwd, timeout: 10000, encoding: "utf-8", maxBuffer: 1024 * 1024 }).trim()
  } catch {
    return ""
  }
}

export default tool({
  description: `Query AgentOverflow (team knowledge base) for known solutions to bugs, errors, or product-specific problems.

Use this tool:
- When the user describes an error, bug, or unexpected behavior
- When you are unsure how a product-specific service or pattern works and nexus-search did not help
- Proactively when you detect the user is stuck on a recurring or product-specific issue — do not wait for /solve

After the user's problem is resolved (with or without code changes), summarize the complete fix and ask the user if they want to save it to the team knowledge base using nexus-solved. Always get user approval before saving.`,
  args: {
    description: tool.schema
      .string()
      .describe("What is the problem or error? Describe it clearly — include what was attempted and what failed."),
    error_message: tool.schema
      .string()
      .optional()
      .describe("Optional: paste the exact error message or stack trace here for more precise KB matching."),
    code_snippet: tool.schema
      .string()
      .optional()
      .describe("Optional: relevant code fragment that is causing or related to the issue."),
  },
  async execute(args, context) {
    const cwd = context.directory
    const skill = process.env._NEXUS_ACTIVE_SKILL ?? "default"

    // Git context — supplementary signal for backend retrieval scoping.
    // Non-blocking: empty strings are fine if repo has no changes yet.
    const gitDiff = exec("git diff", cwd)
    const dirtyFiles = exec("git diff --name-only", cwd).split("\n").filter(Boolean)
    const recentCommits = exec("git log --oneline -5 --no-decorate", cwd).split("\n").filter(Boolean)
    const allFiles = exec("git ls-files", cwd).split("\n").filter(Boolean)

    const payload: Record<string, unknown> = {
      description: args.description,
      git_diff: gitDiff,
      dirty_files: dirtyFiles,
      recent_commits: recentCommits,
      all_files: allFiles,
    }
    if (args.error_message) payload.error_message = args.error_message
    if (args.code_snippet) payload.code_snippet = args.code_snippet

    const resp = await fetch(`${NEXUS_BASE_URL}/api/overflow/ingest`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Nexus-Skill": skill,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(30000),
    }).catch((err: unknown) => `[nexus-solve] Failed to reach backend: ${err}`)

    if (typeof resp === "string") return resp
    if (!resp.ok) return `[nexus-solve] Backend returned HTTP ${resp.status}`

    const result = (await resp.json()) as {
      issue_id?: string
      suggestion?: string
      cached?: boolean
      confidence_score?: number
      persisted?: boolean
    }

    // Store issue ID for nexus-solved to reference when saving resolution
    if (result.issue_id) {
      process.env._NEXUS_LAST_ISSUE_ID = result.issue_id
    }

    const lines: string[] = []

    if (result.cached) {
      lines.push("Cache hit — returning matched solution from knowledge base.")
    } else {
      lines.push("Analyzed with LLM + team context.")
      if (result.persisted) lines.push("Stored as new entry in team knowledge base.")
    }

    if (result.suggestion) {
      lines.push("", result.suggestion)
    }

    if (result.confidence_score !== undefined && result.confidence_score < 0.6) {
      lines.push(`\n(Low confidence: ${(result.confidence_score * 100).toFixed(0)}%) — treat as starting point, verify before applying.`)
    }

    return lines.join("\n")
  },
})
