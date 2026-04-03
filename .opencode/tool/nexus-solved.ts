/// <reference path="../env.d.ts" />
/**
 * AgentOverflow /solved tool
 *
 * Confirms the last /solve issue is fixed and captures the resolution
 * in the enterprise knowledge base.
 *
 * With no note: uses the most recent git commit diff (backend summarizes via LLM).
 * With a note: stores the developer's explicit description.
 */

import { tool } from "@opencode-ai/plugin"
import { execSync } from "child_process"

const NEXUS_BASE_URL = process.env.NEXUS_BASE_URL ?? "http://localhost:8000"

function getCommittedDiff(cwd: string): string | null {
  try {
    const diff = execSync("git show HEAD --no-color -p --stat", {
      cwd,
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

export default tool({
  description: `Confirm the last /solve issue is fixed and capture the resolution in the knowledge base.

Use this tool after the developer has fixed a problem that was previously submitted via
the nexus-solve tool. If called without a note, it captures the most recent git commit
diff and the backend generates a resolution summary via LLM. If called with an explicit
note, it stores the developer's description directly.

This is optional -- resolutions are also captured automatically when a git commit is
made after a /solve. Use this only when the developer wants to add a more detailed
explanation than the commit provides.`,
  args: {
    note: tool.schema
      .string()
      .optional()
      .describe(
        "Optional: explicit description of what fixed the issue. If omitted, uses the last git commit diff.",
      ),
  },
  async execute(args, context) {
    const issueId = process.env._NEXUS_LAST_ISSUE_ID
    if (!issueId) {
      return "No pending issue found. Use the nexus-solve tool first to submit an issue."
    }

    const cwd = context.directory
    const skillHeader = process.env._NEXUS_ACTIVE_SKILL ?? "default"

    const payload: Record<string, string> = { issue_id: issueId }

    if (args.note) {
      payload.resolution = args.note
    } else {
      const diff = getCommittedDiff(cwd)
      if (!diff) {
        return "No committed changes found. Commit your fix first, then use this tool. Or provide an explicit note."
      }
      payload.committed_diff = diff
    }

    try {
      const resp = await fetch(`${NEXUS_BASE_URL}/api/overflow/resolve`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Nexus-Skill": skillHeader,
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(15000),
      })

      if (!resp.ok) {
        return `AgentOverflow resolve API returned HTTP ${resp.status}. The issue_id is still stored -- try again later.`
      }

      // Clear the stored issue
      delete process.env._NEXUS_LAST_ISSUE_ID

      return "Fix captured. Future developers will see this resolution automatically when they hit the same error."
    } catch (err) {
      return `Failed to reach AgentOverflow API. The issue_id is still stored -- try again later.`
    }
  },
})
