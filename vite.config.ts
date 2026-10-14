import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

// `npm run build:demo` produces one self-contained HTML file with sample data.
export default defineConfig(({ mode }) => ({
  plugins: mode === 'demo' ? [viteSingleFile()] : [],
  build: mode === 'demo' ? { outDir: 'dist-demo' } : {},
  test: { include: ['tests/**/*.test.ts'] },
}));
