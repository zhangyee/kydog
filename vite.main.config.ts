import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    rollupOptions: {
      external: ['@earendil-works/pi-coding-agent', 'electron'],
    },
  },
});
