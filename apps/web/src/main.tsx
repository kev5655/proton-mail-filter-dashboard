import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App.js';
import './theme.css';
import './app.css';

const container = document.getElementById('root');
if (container === null) {
    throw new Error('#root not found');
}

createRoot(container).render(
    <StrictMode>
        <App />
    </StrictMode>
);
