import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const target = process.env.NIO_API ?? 'http://127.0.0.1:8787';

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/v1/events': { target: target.replace(/^http/, 'ws'), ws: true },
      '/v1': target,
      '/healthz': target,
    },
  },
  build: { outDir: 'dist', sourcemap: true },
});
