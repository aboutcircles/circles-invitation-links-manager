import { defineConfig } from 'vite';

export default defineConfig({
  base: '/circles-invitation-links-manager/',
  server: {
    port: 5173,
  },
  build: {
    rollupOptions: {
      input: {
        main: 'index.html',
      },
    },
  },
});
