import { defineConfig } from 'vite';

export default defineConfig({
  // Only VITE_-prefixed variables may reach the browser bundle. Server secrets
  // (FIREBASE_SERVICE_ACCOUNT_JSON, PHILOMARKET_*) must never use this prefix.
  envPrefix: 'VITE_',
  server: {
    port: 8000,
    strictPort: true,
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
  },
});
