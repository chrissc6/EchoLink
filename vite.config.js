import { defineConfig } from 'vite';
export default defineConfig({
  base: './', publicDir: 'public',
  build: { target: 'es2022', assetsInlineLimit: 0, sourcemap: false },
  worker: { format: 'es' },
  optimizeDeps: { exclude: ['kokoro-js', 'phonemizer'] },
});
