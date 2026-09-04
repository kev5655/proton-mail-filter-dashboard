import { useState } from 'react';

import { CategoryMoveDialog } from './components/CategoryMoveDialog.js';
import { DiffDialog } from './components/DiffDialog.js';
import { ErrorBoundary } from './components/ErrorBoundary.js';
import { MailViewer } from './components/MailViewer.js';
import { SelectionDialog } from './components/SelectionDialog.js';
import { AutoRulesPage } from './pages/AutoRulesPage.js';
import { CategoriesPage } from './pages/CategoriesPage.js';
import { ChangesPage } from './pages/ChangesPage.js';
import { FoldersPage } from './pages/FoldersPage.js';
import { HistoryPage } from './pages/HistoryPage.js';
import { RulesPage } from './pages/RulesPage.js';
import { SettingsPage } from './pages/SettingsPage.js';
import { TriagePage } from './pages/TriagePage.js';
import { ApplyProvider, useApply } from './apply.js';
import { ModelProvider } from './llm.js';
import { MailboxProvider, useMailbox, useMailboxStatus, useReloadMailbox } from './mailbox.js';
import { SyncPanel } from './components/SyncPanel.js';
import { SyncProvider } from './sync.js';
import { AppStateProvider, useAppState, type Page } from './state.js';
import { StoreProvider, useStore } from './store.js';

export function App(): React.JSX.Element {
    return (
        <MailboxProvider>
            <AppStateProvider>
                <ModelProvider>
                    <Sources />
                </ModelProvider>
            </AppStateProvider>
        </MailboxProvider>
    );
}

/**
 * Remount the store when the mailbox underneath it changes.
 *
 * The dashboard renders the demo while it asks the local server, so the source can change once,
 * shortly after startup. `key` makes that a fresh store rather than a merge: staged changes,
 * journal and drift all belong to one mailbox, and carrying them into another would show the user
 * a history of things that never happened to the account they are now looking at.
 */
function Sources(): React.JSX.Element {
    const { source, syncedAt, version } = useMailboxStatus();
    const reload = useReloadMailbox();

    return (
        <SyncProvider onFinished={reload}>
            <ApplyProvider onApplied={reload}>
            {/*
             * Keyed on the source, the sync time *and* the account fingerprint.
             *
             * The first two cover a finished sync: it replaces the mailbox under the store, and
             * rules seeded from the previous copy would otherwise be edited against data that has
             * moved on.
             *
             * The fingerprint covers a write, and it had to be added because a folder created from
             * the dashboard did not appear until the next sync. The reload after an apply does
             * fetch a fresh snapshot — the server re-reads folders and filters straight after
             * writing — but `folders` is seeded once with `useState`, and without a remount the
             * store kept showing the list from before. `syncedAt` cannot stand in for this: a write
             * is not a sync and leaves it untouched.
             */}
            <StoreProvider key={`${source}:${String(syncedAt ?? 'none')}:${version ?? 'none'}`}>
                <Shell />
            </StoreProvider>
            </ApplyProvider>
        </SyncProvider>
    );
}

/**
 * What the last change left behind, after its dialog has gone.
 *
 * The dialog closes when the change lands, because a finished job should not need dismissing. Two
 * things outlive it and are worth reading afterwards: where the backup went, and whether the result
 * was only partial. A partial result is stated as one — never rounded up to a success.
 */
function AppliedBanner(): React.JSX.Element | null {
    const { result, dismissResult } = useApply();
    if (result === undefined) {
        return null;
    }

    return (
        <div
            className={result.partial === undefined ? 'notice notice-info apply-result' : 'notice notice-warning apply-result'}
        >
            <div className="stack">
                <strong>
                    {result.partial === undefined ? 'Bei Proton gespeichert:' : 'Nur teilweise geschrieben:'}{' '}
                    {result.summary}
                </strong>
                {result.partial !== undefined && <span>{result.partial}</span>}
                <span className="faint">
                    Sicherung aller Filter und Ordner: <code>{result.backupPath}</code>
                </span>
            </div>
            <button type="button" className="button button-quiet" onClick={dismissResult}>
                Verstanden
            </button>
        </div>
    );
}

/** One name per screen, used by the navigation and by the selection bar so the two agree. */
const PAGE_LABELS: Record<Page, string> = {
    triage: 'Vorschläge',
    rules: 'Regeln',
    categories: 'Kategorien',
    'auto-rules': 'Auto-Regeln',
    folders: 'Ordner',
    changes: 'Änderungen',
    history: 'Verlauf',
    settings: 'Einstellungen',
};

function Shell(): React.JSX.Element {
    const { nav, goTo, selected, selectedFrom, clearSelection, open, setOpen } = useAppState();
    const { groups, categories, autoRules } = useMailbox();
    const status = useMailboxStatus();
    const { rules, folders, drift, journal } = useStore();
    // What actually reached the account, or the demo's local record when there is no account.
    const historyCount = status.source === 'demo' ? journal.length : status.history.length;
    const [buildingRule, setBuildingRule] = useState(false);
    const [movingToCategory, setMovingToCategory] = useState(false);

    // Only screens other than this one. Saying "aus Regeln" while standing on Regeln is noise.
    const elsewhere = selectedFrom.filter((entry) => entry !== nav.page);

    const nav_: Array<{ id: Page; label: string; count: number }> = [
        { id: 'triage', label: PAGE_LABELS.triage, count: groups.length },
        { id: 'rules', label: PAGE_LABELS.rules, count: rules.length },
        { id: 'categories', label: PAGE_LABELS.categories, count: categories.length },
        {
            id: 'auto-rules',
            label: PAGE_LABELS['auto-rules'],
            // Only the senders we can actually say something about. Counting the undecided ones
            // would put a number on the tab that promises more than the screen delivers.
            count: autoRules.filter(
                (rule) => rule.scope.kind === 'sender' && rule.verdict.kind !== 'too-few'
            ).length,
        },
        { id: 'folders', label: PAGE_LABELS.folders, count: folders.length },
        { id: 'changes', label: PAGE_LABELS.changes, count: drift.filter((item) => item.resolved === undefined).length },
        // „Protokoll" is gone as a tab: it is now the lower half of „Verlauf", where the two
        // questions it kept being confused with sit next to each other and say how they differ.
        { id: 'history', label: PAGE_LABELS.history, count: historyCount },
        { id: 'settings', label: PAGE_LABELS.settings, count: 0 },
    ];

    return (
        <div className="shell">
            <nav className="sidebar">
                <div className="brand">
                    <img className="brand-mark" src="/logo.svg" alt="" width={28} height={28} />
                    <div className="stack">
                        <strong>Proton Mail Sorter</strong>
                        <span>Regeln und Ordner verwalten</span>
                    </div>
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
                <SourceBanner status={status} />

                <SyncPanel />
            </nav>

            <main className="main">
                <AppliedBanner />

                {/*
                 * The boundary that matters. A screen that throws used to unmount the root and
                 * take the sidebar with it, leaving no way back; keyed on the page, so switching
                 * away clears the error by itself.
                 */}
                <ErrorBoundary area={PAGE_LABELS[nav.page]} resetKey={nav.page}>
                    {nav.page === 'rules' && <RulesPage />}
                    {nav.page === 'triage' && <TriagePage />}
                    {nav.page === 'categories' && <CategoriesPage />}
                    {nav.page === 'auto-rules' && <AutoRulesPage />}
                    {nav.page === 'folders' && <FoldersPage />}
                    {nav.page === 'changes' && <ChangesPage />}
                    {nav.page === 'history' && <HistoryPage />}
                    {nav.page === 'settings' && <SettingsPage />}
                </ErrorBoundary>

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
                        {/*
                         * Where the mail was picked. Without this the bar follows you to a screen
                         * you never selected anything on and looks like something left behind by
                         * mistake, rather than a selection you are still carrying on purpose.
                         */}
                        {elsewhere.length > 0 && (
                            <span className="faint">
                                aus {elsewhere.map((entry) => PAGE_LABELS[entry]).join(', ')}
                            </span>
                        )}
                        <span style={{ flex: 1 }} />
                        <button type="button" className="button" onClick={() => setBuildingRule(true)}>
                            Regel daraus bauen
                        </button>
                        {/*
                         * The other thing a selection is for. A category cannot be a filter's
                         * destination, so this is the only route to Proton's own sorting — and it
                         * is the one action here that moves mail, which is why it goes the full
                         * way round: diff, then a typed „ja" in the terminal, every time.
                         */}
                        <button
                            type="button"
                            className="button button-secondary"
                            onClick={() => setMovingToCategory(true)}
                        >
                            In Kategorie verschieben
                        </button>
                        <button type="button" className="button button-quiet" onClick={clearSelection}>
                            Auswahl aufheben
                        </button>
                    </div>
                )}
            </main>

            {open !== undefined && (
                <ErrorBoundary area="Mailansicht" resetKey={open.ID}>
                    <MailViewer message={open} onClose={() => setOpen(undefined)} />
                </ErrorBoundary>
            )}

            {/* The last step of every change, without exception — including the ones the tool
                itself proposed. A dialog that appears only for hand-written rules teaches people
                to click through it. */}
            <DiffDialog onOpenMail={setOpen as never} />

            {movingToCategory && (
                <CategoryMoveDialog selection={selected} onClose={() => setMovingToCategory(false)} />
            )}

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

/**
 * Which mailbox is on screen, said plainly and on every screen.
 *
 * The demo half of this was already load-bearing: someone looking at a plausible list of folder
 * names must never have to wonder whether it is theirs. The real half is load-bearing for the
 * opposite reason — once the names *are* theirs, the questions become "how old is this" and "is it
 * all of it", and both have to be answered where the data is, not in a settings page.
 *
 * Nothing here claims a live connection. The dashboard reads a copy; the copy is as old as the last
 * sync, and saying so is the difference between a stale screen and a lying one.
 */
export function SourceBanner({ status }: { status: ReturnType<typeof useMailboxStatus> }): React.JSX.Element {
    if (status.source === 'demo') {
        return (
            <p className="demo-banner">
                <strong>Demo-Daten.</strong> Kein Proton-Konto verbunden. Alle Mails, Regeln und
                Ordner sind erfunden — es wird nichts gelesen und nichts verändert.
                {status.problem !== undefined && (
                    <>
                        <br />
                        <br />
                        <strong>Der lokale Server hat geantwortet, aber unbrauchbar:</strong>{' '}
                        {status.problem}
                    </>
                )}
                {status.problem === undefined && !status.loading && (
                    <>
                        <br />
                        <br />
                        Für das echte Postfach: <code>pnpm sync</code>, dann <code>pnpm serve</code>.
                    </>
                )}
            </p>
        );
    }

    return (
        <p className="demo-banner">
            <strong>Echtes Postfach.</strong> Gelesen aus der lokalen, verschlüsselten Kopie. Es
            werden keine Mails verschoben und nichts an Proton gesendet.
            <br />
            <br />
            Stand: {status.syncedAt === undefined ? 'unbekannt' : formatSyncTime(status.syncedAt)}.
            {status.truncated && ' Die Kopie ist unvollständig — der letzte Sync hat seine Obergrenze erreicht.'}
            {status.unreadable.length > 0 && (
                <>
                    <br />
                    <br />
                    <strong>
                        {status.unreadable.length}{' '}
                        {status.unreadable.length === 1 ? 'Filter' : 'Filter'} nicht lesbar:
                    </strong>{' '}
                    {status.unreadable.map((entry) => entry.name).join(', ')}. Sie laufen bei Proton
                    weiter, tauchen hier aber nicht auf.
                </>
            )}
        </p>
    );
}

/** Absolute, not "vor 3 Stunden": how stale the copy is, is exactly what the user has to judge. */
function formatSyncTime(unixSeconds: number): string {
    return new Date(unixSeconds * 1000).toLocaleString('de-CH', {
        dateStyle: 'medium',
        timeStyle: 'short',
    });
}
