/// <reference path="../env.d.ts" />
/**
 * AgentOverflow nexus-solved tool
 *
 * Saves an approved resolution to the team knowledge base.
 *
 * Flow:
 *   1. LLM helps user resolve an issue (via nexus-solve or independently)
 *   2. LLM summarizes the complete fix (all steps, root cause, solution)
 *   3. LLM presents the draft to the user for review + approval
 *   4. User approves or requests edits
 *   5. LLM calls this tool with the approved resolution text
 *
 * The resolution can be anything — code fix, config change, explanation,
 * workaround — it does not require a git commit.
 */

import { tool } from "@opencode-ai/plugin"
import { execSync } from "child_process"

const NEXUS_BASE_URL = process.env.NEXUS_BASE_URL ?? "http://127.0.0.1:8000"

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
      ? diff.slice(0, 8000) + "\n\n... (diff truncated)"
      : diff
  } catch {
    return null
  }
}

export default tool({
  description: `Save a resolution to the team knowledge base (AgentOverflow).

Use ONLY after the user has explicitly approved the resolution text. Never auto-save.

Before calling this tool, you must:
1. Summarize the complete fix: original problem, all steps taken, root cause, and what solved it
2. Present the summary to the user: "Want to save this to the team KB? You can approve or edit first."
3. Wait for explicit user approval (or incorporate their edits)
4. Then call this tool with the approved text

The resolution can be anything — code fix, config change, explanation, workaround. No git commit required.`,
  args: {
    resolution: tool.schema
      .string()
      .describe(
        "The approved resolution text. Should include: original problem, steps taken to fix it, root cause (if known), and the final solution. This is what gets stored for future developers.",
      ),
    include_diff: tool.schema
      .boolean()
      .optional()
      .describe(
        "Optional: if true, also appends the latest git commit diff as supplementary context. Useful when the fix involved a code change that was just committed.",
      ),
  },
  async execute(args, context) {
    const cwd = context.directory
    const skill = process.env._NEXUS_ACTIVE_SKILL ?? "default"
    const issueId = process.env._NEXUS_LAST_ISSUE_ID

    const payload: Record<string, string> = { resolution: args.resolution }

    if (issueId) payload.issue_id = issueId

    if (args.include_diff) {
      const diff = getCommittedDiff(cwd)
      if (diff) payload.committed_diff = diff
    }

    try {
      const resp = await fetch(`${NEXUS_BASE_URL}/api/overflow/resolve`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Nexus-Skill": skill,
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(15000),
      })

      if (!resp.ok) {
        return `[nexus-solved] Backend returned HTTP ${resp.status}. Resolution not saved — try again.`
      }

      if (issueId) delete process.env._NEXUS_LAST_ISSUE_ID

      return "Saved. Future developers will see this solution when they hit the same problem."
    } catch {
      return "[nexus-solved] Failed to reach backend. Resolution not saved — try again when backend is available."
    }
  },
})
