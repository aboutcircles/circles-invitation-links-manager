import { defineConfig } from 'vite';

export default defineConfig({
  base: '/circles-invitation-links-manager/',
  server: {
    port: 5173,
  },
  define: {
    global: 'globalThis',
  },
  build: {
    rollupOptions: {
      input: {
        main: 'index.html',
      },
    },
  },
  optimizeDeps: {
    include: ['buffer'],
  },
  resolve: {
    alias: {
      buffer: 'buffer',
    },
  },
});
