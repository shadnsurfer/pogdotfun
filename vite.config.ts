import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const apiTarget = process.env.POG_API_TARGET ?? 'http://127.0.0.1:3001';
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: [
      {
        // MetaMask dynamically reads named exports; its CJS entry loses them in Vite prebundling.
        find: /^@metamask\/mobile-wallet-protocol-core$/,
        replacement: require.resolve('@metamask/mobile-wallet-protocol-core/dist/index.mjs'),
      },
    ],
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return;
          if (/node_modules\/(react|react-dom|react-router|react-router-dom|scheduler)\//.test(id))
            return 'react-vendor';
          if (/node_modules\/(motion|motion-dom|motion-utils|framer-motion)\//.test(id))
            return 'motion';
          if (id.includes('@radix-ui')) return 'primitives';
        },
      },
    },
  },
  server: { port: 5178, strictPort: true, proxy: { '/api': apiTarget } },
  preview: { proxy: { '/api': apiTarget } },
});
