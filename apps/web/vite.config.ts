import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * The web app has its own config because it is the only part that needs the React plugin and a
 * browser target. It still has to inline the workspace packages, which ship TypeScript source.
 */
export default defineConfig({
    plugins: [react()],
    server: {
        port: 5173,
        strictPort: true,
        /*
         * The local server, reachable under the dashboard's own origin.
         *
         * A proxy rather than a cross-origin fetch: the answer is one account's mailbox, and CORS
         * would mean deciding which origins may read it. Same-origin means the question does not
         * arise. `PMS_SERVER_PORT` keeps the two ends in step when the default port is taken.
         */
        proxy: {
            '/api': {
                target: `http://127.0.0.1:${process.env['PMS_SERVER_PORT'] ?? 5174}`,
                changeOrigin: false,
            },
        },
    },
    optimizeDeps: { include: [] },
    resolve: { preserveSymlinks: false },
});
