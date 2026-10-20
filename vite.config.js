import { defineConfig } from 'vite';

// Relative base so the build works from any GitHub Pages sub-path
// (https://<user>.github.io/<repo>/) without configuration.
export default defineConfig({
  base: './',
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 900,
  },
});
