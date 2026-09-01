import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import agents from "agents/vite";

export default defineConfig({
  plugins: [
    // Required: transpiles the TC39 decorators used by @callable() in src/server.ts.
    agents(),
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      // Keep tests hermetic — never reach the real Workers AI endpoint.
      remoteBindings: false
    })
  ]
});
