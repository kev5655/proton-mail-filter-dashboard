import { useState } from 'react';

import { MailViewer } from './components/MailViewer.js';
import { SelectionDialog } from './components/SelectionDialog.js';
import { FoldersPage } from './pages/FoldersPage.js';
import { RulesPage } from './pages/RulesPage.js';
import { TriagePage } from './pages/TriagePage.js';
import { folders, groups, rules } from './data.js';
import { AppStateProvider, useAppState, type Page } from './state.js';

const NAV: Array<{ id: Page; label: string; count: number }> = [
    { id: 'triage', label: 'Vorschläge', count: groups.length },
    { id: 'rules', label: 'Regeln', count: rules.length },
    { id: 'folders', label: 'Ordner', count: folders.length },
];

export function App(): React.JSX.Element {
    return (
        <AppStateProvider>
            <Shell />
        </AppStateProvider>
    );
}

function Shell(): React.JSX.Element {
    const { nav, goTo, selected, clearSelection, open, setOpen } = useAppState();
    const [buildingRule, setBuildingRule] = useState(false);

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
                        aria-current={nav.page === entry.id ? 'page' : undefined}
                        onClick={() => goTo({ page: entry.id })}
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
                {nav.page === 'rules' && <RulesPage />}
                {nav.page === 'triage' && <TriagePage />}
                {nav.page === 'folders' && <FoldersPage />}

                {/*
                 * The manual path. Grouping will not find every rule worth having — a set of mails
                 * that belong together for a reason only the user knows has no pattern to detect —
                 * so picking them by hand has to be a first-class way in, not a fallback.
                 */}
                {selected.length > 0 && (
                    <div className="selection-bar">
                        <strong>
                            {selected.length} {selected.length === 1 ? 'Mail' : 'Mails'} ausgewählt
                        </strong>
                        <span className="faint">
                            {[...new Set(selected.map((message) => message.Sender.Address))].length}{' '}
                            verschiedene Absender
                        </span>
                        <span style={{ flex: 1 }} />
                        <button type="button" className="button" onClick={() => setBuildingRule(true)}>
                            Regel daraus bauen
                        </button>
                        <button type="button" className="button button-quiet" onClick={clearSelection}>
                            Auswahl aufheben
                        </button>
                    </div>
                )}
            </main>

            {open !== undefined && <MailViewer message={open} onClose={() => setOpen(undefined)} />}

            {buildingRule && (
                <SelectionDialog
                    selection={selected}
                    onClose={() => setBuildingRule(false)}
                    onOpenMail={setOpen}
                />
            )}
        </div>
    );
}
