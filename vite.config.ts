import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    // The worker is built once here; scripts/tenants/build-pwa.ts copies it into every studio's scope.
    VitePWA({
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.ts',
      injectRegister: false,
      manifest: false,
      injectManifest: { rollupFormat: 'iife', globPatterns: ['assets/**/*.{js,css,woff2}'], maximumFileSizeToCacheInBytes: 3_000_000 },
      devOptions: { enabled: false },
    }),
  ],
  resolve: { alias: { '@': new URL('./src', import.meta.url).pathname } },
  build: {
    target: 'es2022',
    sourcemap: false,
    chunkSizeWarningLimit: 600,
    rolldownOptions: {
      output: {
        // Stable vendor chunks: an app-code change does not invalidate the cached framework.
        codeSplitting: {
          groups: [
            { name: 'react', test: /node_modules[\\/](react|react-dom|react-router|react-router-dom|scheduler|@remix-run)[\\/]/ },
            { name: 'data', test: /node_modules[\\/](@supabase|@tanstack|zod|date-fns|date-fns-tz)[\\/]/ },
            { name: 'astryx', test: /node_modules[\\/](@astryxdesign|@stylexjs)[\\/]/ },
          ],
        },
      },
    },
  },
  server: { host: true, port: 5173 },
});
