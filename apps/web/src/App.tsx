import { useState } from 'react';

import { FoldersPage } from './pages/FoldersPage.js';
import { RulesPage } from './pages/RulesPage.js';
import { TriagePage } from './pages/TriagePage.js';
import { folders, groups, rules } from './data.js';

type Page = 'rules' | 'triage' | 'folders';

const NAV: Array<{ id: Page; label: string; count: number }> = [
    { id: 'rules', label: 'Regeln', count: rules.length },
    { id: 'triage', label: 'Vorschläge', count: groups.length },
    { id: 'folders', label: 'Ordner', count: folders.length },
];

export function App(): React.JSX.Element {
    const [page, setPage] = useState<Page>('triage');

    return (
        <div className="shell">
            <nav className="sidebar">
                <div className="brand">
                    <strong>Proton Mail Sorter</strong>
                    <span>Regeln und Ordner verwalten</span>
                </div>

                {NAV.map((entry) => (
                    <button
                        key={entry.id}
                        type="button"
                        className="nav-item"
                        aria-current={page === entry.id ? 'page' : undefined}
                        onClick={() => setPage(entry.id)}
                    >
                        <span>{entry.label}</span>
                        <span className="nav-count">{entry.count}</span>
                    </button>
                ))}

                {/*
                 * Stated on every screen, not tucked into a settings page. Someone looking at a
                 * plausible list of their own folder names should never have to wonder whether they
                 * are looking at their real mailbox.
                 */}
                <p className="demo-banner">
                    <strong>Demo-Daten.</strong> Kein Proton-Konto verbunden. Alle Mails, Regeln und
                    Ordner sind erfunden — es wird nichts gelesen und nichts verändert.
                </p>
            </nav>

            <main className="main">
                {page === 'rules' && <RulesPage />}
                {page === 'triage' && <TriagePage />}
                {page === 'folders' && <FoldersPage />}
            </main>
        </div>
    );
}
