import { useState } from 'react';

import { DiffDialog } from './components/DiffDialog.js';
import { MailViewer } from './components/MailViewer.js';
import { SelectionDialog } from './components/SelectionDialog.js';
import { ChangesPage } from './pages/ChangesPage.js';
import { FoldersPage } from './pages/FoldersPage.js';
import { HistoryPage } from './pages/HistoryPage.js';
import { LogPage } from './pages/LogPage.js';
import { RulesPage } from './pages/RulesPage.js';
import { TriagePage } from './pages/TriagePage.js';
import { groups } from './data.js';
import { AppStateProvider, useAppState, type Page } from './state.js';
import { StoreProvider, useStore } from './store.js';

export function App(): React.JSX.Element {
    return (
        <AppStateProvider>
            <StoreProvider>
                <Shell />
            </StoreProvider>
        </AppStateProvider>
    );
}

function Shell(): React.JSX.Element {
    const { nav, goTo, selected, clearSelection, open, setOpen } = useAppState();
    const { rules, folders, drift, journal } = useStore();
    const [buildingRule, setBuildingRule] = useState(false);

    const nav_: Array<{ id: Page; label: string; count: number }> = [
        { id: 'triage', label: 'Vorschläge', count: groups.length },
        { id: 'rules', label: 'Regeln', count: rules.length },
        { id: 'folders', label: 'Ordner', count: folders.length },
        { id: 'changes', label: 'Änderungen', count: drift.filter((item) => item.resolved === undefined).length },
        { id: 'history', label: 'Verlauf', count: journal.length },
        { id: 'log', label: 'Protokoll', count: 0 },
    ];

    return (
        <div className="shell">
            <nav className="sidebar">
                <div className="brand">
                    <strong>Proton Mail Sorter</strong>
                    <span>Regeln und Ordner verwalten</span>
                </div>

                {nav_.map((entry) => (
                    <button
                        key={entry.id}
                        type="button"
                        className="nav-item"
                        aria-current={nav.page === entry.id ? 'page' : undefined}
                        onClick={() => goTo({ page: entry.id })}
                    >
                        <span>{entry.label}</span>
                        {entry.count > 0 && <span className="nav-count">{entry.count}</span>}
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
                {nav.page === 'changes' && <ChangesPage />}
                {nav.page === 'history' && <HistoryPage />}
                {nav.page === 'log' && <LogPage />}

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

            {/* The last step of every change, without exception — including the ones the tool
                itself proposed. A dialog that appears only for hand-written rules teaches people
                to click through it. */}
            <DiffDialog onOpenMail={setOpen as never} />

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
