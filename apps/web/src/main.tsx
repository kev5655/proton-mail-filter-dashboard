import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App.js';
import { ErrorBoundary } from './components/ErrorBoundary.js';
import './theme.css';
import './app.css';

const container = document.getElementById('root');
if (container === null) {
    throw new Error('#root not found');
}

createRoot(container).render(
    <StrictMode>
        {/* Last resort. The useful boundary is the one around the page switch in `Shell`; this one
            only catches something breaking above it, and exists so that even then there is a
            message rather than a white page. */}
        <ErrorBoundary area="Dashboard">
            <App />
        </ErrorBoundary>
    </StrictMode>
);
