import { defineConfig } from 'vite';

// Relative base so the build works from any host or sub-path (GitHub Pages, S3, etc.)
export default defineConfig({
  base: './',
  worker: { format: 'es' },
  build: { target: 'es2022' },
});
