import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * The web app has its own config because it is the only part that needs the React plugin and a
 * browser target. It still has to inline the workspace packages, which ship TypeScript source.
 */
export default defineConfig({
    plugins: [react()],
    server: { port: 5173, strictPort: true },
    optimizeDeps: { include: [] },
    resolve: { preserveSymlinks: false },
});
