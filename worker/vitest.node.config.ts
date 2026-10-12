// The server's tests on Node with SQLite (the Docker / self-hosted server): npm run test:node
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: { alias: { 'cloudflare:test': new URL('./test/node-env.ts', import.meta.url).pathname } },
  test: { setupFiles: ['./test/setup.ts'], environment: 'node' },
})
