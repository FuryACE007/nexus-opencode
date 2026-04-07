/// <reference path="../env.d.ts" />
/**
 * nexus-search — Active KB retrieval tool for the Nexus CLI
 *
 * WHY THIS EXISTS:
 * ─────────────────────────────────────────────────────────
 * The Nexus backend injects a passive RAG context (SKILLS.md + top-N chunks)
 * into each request's system message. This covers the user's *initial* query
 * well, but the LLM often needs to look up additional context mid-session —
 * e.g. "how does the Lumin8 streaming API work?" or "what does StakeRegistry
 * expose?". Without an active KB query tool, the model defaults to OpenCode's
 * built-in `read` tool, reading raw files from disk instead of the curated,
 * already-ingested knowledge base. That defeats the purpose of having a KB.
 *
 * This tool gives the LLM a first-class way to query the Nexus KB on demand.
 * The model MUST prefer this over `read` or `webfetch` for any service,
 * pattern, or concept that belongs to the active skill context.
 */

import { tool } from "@opencode-ai/plugin"

const NEXUS_BASE_URL = process.env.NEXUS_BASE_URL ?? "http://127.0.0.1:8000"

export default tool({
  description: `Search the Nexus Knowledge Base for context about the active product skill.

ALWAYS use this tool INSTEAD of \`read\`, \`grep\`, or \`webfetch\` when you need:
- How a service, API, or library works (e.g. "Lumin8 streaming API", "StakeRegistry")
- Architecture patterns, conventions, or rules for the active skill
- Implementation examples from the ingested codebase
- Documentation about a concept or component mentioned in the skill manifest

When to use: any time you would reach for \`read\` to look up documentation or
understand how something works that is part of this team's product context.

When NOT to use: reading a specific file you know exists locally for editing purposes
(use \`read\` for that). This tool is for knowledge retrieval, not file inspection.`,
  args: {
    query: tool.schema
      .string()
      .describe(
        "What you want to look up. Be specific: describe the concept, service name, " +
          "method, or pattern you need context about. " +
          'Examples: "Lumin8 buffered_stream API parameters", "StakeRegistry.create method signature", ' +
          '"error handling pattern for LLM gateway timeouts".',
      ),
    type_filter: tool.schema
      .string()
      .optional()
      .describe(
        'Optional: restrict results to "code" chunks (source files) or "doc" chunks ' +
          '(documentation/markdown). Omit or pass "any" for all types.',
      ),
    n_results: tool.schema
      .number()
      .optional()
      .describe("Number of results to return (default: 5). Increase to 8-10 for broad topics."),
  },
  async execute(args) {
    const skill = process.env._NEXUS_ACTIVE_SKILL ?? "staking"
    const n = args.n_results ?? 5

    const payload: Record<string, unknown> = { query: args.query, n_results: n }
    if (args.type_filter && args.type_filter !== "any") payload.type_filter = args.type_filter

    const resp = await fetch(`${NEXUS_BASE_URL}/api/kb/search`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Nexus-Skill": skill,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(20000),
    }).catch((err: unknown) =>
      `[nexus-search] Failed to reach Nexus backend: ${err}\nBackend URL: ${NEXUS_BASE_URL}\nEnsure the backend is running before using this tool.`,
    )

    if (typeof resp === "string") return resp
    if (!resp.ok) {
      const body = await resp.text().catch(() => "")
      return `[nexus-search] Backend returned HTTP ${resp.status}. ${body}`.trim()
    }

    const data = (await resp.json()) as {
      skill: string
      query: string
      results: Array<{
        id: string
        content: string
        score: number
        source: string
        chunk_type: string
      }>
      total: number
    }

    if (data.total === 0) return `[nexus-search] No results for: "${args.query}" (skill: ${skill})`

    const header = `Nexus KB — skill: ${data.skill} | query: "${data.query}" | ${data.total} result(s)\n${"─".repeat(60)}`
    const chunks = data.results.map(
      (r, i) =>
        `[${i + 1}] ${r.source} (${r.chunk_type}, score: ${r.score.toFixed(3)})\n${r.content.trim()}`,
    )

    return [header, ...chunks].join("\n\n")
  },
})
