import { defineConfig } from 'vite';

// Served from https://<user>.github.io/roboclaw-cardiac/ in production, so assets and the
// anatomy worker need that prefix; dev keeps the root.
export default defineConfig(({ command }) => ({
  base: command === 'build' ? '/roboclaw-cardiac/' : '/',
  server: { port: 5173, open: false },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 2000,
  },
}));
