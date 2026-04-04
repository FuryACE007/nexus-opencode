import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { serve } from "bun"
import type { Server } from "bun"
import { execSync } from "child_process"
import fs from "fs/promises"
import path from "path"
import { pathToFileURL } from "url"
import { tmpdir } from "../fixture/fixture"
import { Instance } from "../../src/project/instance"
import { Plugin } from "../../src/plugin/index"

describe("plugin.nexus", () => {
  let server: Server<any>

  beforeEach(() => {
    // Start a mocked Nexus backend
    server = serve({
      port: 8000,
      fetch(req) {
        const url = new URL(req.url)
        if (url.pathname === "/v1/models") {
          return Response.json({ data: [] })
        }
        if (url.pathname === "/api/skills") {
          return Response.json([{ name: "tested-skill" }])
        }
        if (url.pathname.startsWith("/api/skills/")) {
          return new Response("ok")
        }
        return new Response("ok")
      },
    })
  })

  afterEach(async () => {
    server.stop()
    await Instance.disposeAll()
  })

  test("nexus plugin loads correctly when backend is reachable", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        // Read the actual nexus plugin from the workspace root
        const workspaceRoot = path.resolve(__dirname, "../../../../")
        const pluginPath = path.join(workspaceRoot, ".opencode", "plugins", "nexus.ts")
        const pluginDest = path.join(dir, "nexus.ts")
        
        await fs.copyFile(pluginPath, pluginDest)

        // Mock the Git repository logic using a real git init
        // to pass the skill detection metadata fetch without crashing or stderr
        execSync("git init", { cwd: dir })

        // Add opencode.jsonc to load the nexus plugin
        await Bun.write(
          path.join(dir, "opencode.json"),
          JSON.stringify({ plugin: [pathToFileURL(pluginDest).href] }, null, 2),
        )

        return { pluginDest }
      },
    })

    // NEXUS_BASE_URL handles hard-fail check in nexus plugin
    const originalUrl = process.env.NEXUS_BASE_URL
    process.env.NEXUS_BASE_URL = `http://localhost:${server.port}`

    try {
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          // If plugin loading throws or exits, this will fail
          const plugins = await Plugin.list()
          expect(plugins.length).toBeGreaterThan(0)
        },
      })
    } finally {
      process.env.NEXUS_BASE_URL = originalUrl
    }
  })
})
