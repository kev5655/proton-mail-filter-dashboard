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
import { LoginPanel } from './components/LoginPanel.js';
import { LockButton } from './components/LockButton.js';
import { StatusStrip } from './components/StatusStrip.js';
import { LoginProvider } from './login.js';
import { SyncProvider } from './sync.js';
import { AccountProvider, isLocked, useAccount } from './account.js';
import { PowerProvider, shouldOfferWake, usePower } from './power.js';
import { LockScreen } from './components/LockScreen.js';
import { NoServerScreen } from './components/NoServerScreen.js';
import { WakeScreen } from './components/WakeScreen.js';
import { PowerPanel } from './components/PowerPanel.js';
import { AppStateProvider, useAppState, type Page } from './state.js';
import { StoreProvider, useStore } from './store.js';

export function App(): React.JSX.Element {
    return (
        <AccountProvider>
            <PowerProvider>
                <Gate />
            </PowerProvider>
        </AccountProvider>
    );
}

/**
 * Nothing below this renders until it is known whether anything is locked.
 *
 * The wait is one request and it is worth it. Rendering the dashboard first would show a mailbox
 * for a moment and then replace it with a password field — which looks like the tool logging
 * somebody out, and teaches them to distrust a screen that is telling the truth.
 *
 * The providers underneath are mounted only once past the gate, so a locked server is never asked
 * for a mailbox it cannot open.
 */
function Gate(): React.JSX.Element {
    const { status, known, served, refresh } = useAccount();
    const power = usePower();

    if (!known) {
        return <div className="lock-screen" />;
    }
    /*
     * With no server answering, wait for the starter's answer too before deciding.
     *
     * Otherwise a machine whose service is merely stopped shows „kein Server" for as long as that
     * probe takes, and then replaces it with the wake button — which is the same flicker the
     * comment above rejects, arriving from the other direction. The probe gives up after three seconds, and it gives up
     * fast against a refused connection, which is the ordinary case for somebody who has no server
     * at all.
     */
    if (!served && !power.known) {
        return <div className="lock-screen" />;
    }
    if (shouldOfferWake(served, power.state, power.known)) {
        return <WakeScreen />;
    }
    if (!served) {
        return <NoServerScreen retry={refresh} />;
    }
    if (isLocked(status, known, served)) {
        return <LockScreen />;
    }

    return <Dashboard />;
}

/**
 * Everything past the gate.
 *
 * Its own export because the gate above it waits for a request, and a synchronous render therefore
 * never gets here — so a test about the shell would be a test about a placeholder. What the gate
 * itself decides is checked in `lock-screen.test.tsx`, against the states that decide it.
 */
export function Dashboard(): React.JSX.Element {
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
 * A finished sync or a landed write replaces the copy underneath. `key` makes that a fresh store
 * rather than a merge: staged changes and drift belong to one picture of the account, and carrying
 * them into another would show the user consequences worked out against data that has moved on.
 */
function Sources(): React.JSX.Element {
    const { syncedAt, version } = useMailboxStatus();
    const reload = useReloadMailbox();

    return (
        <SyncProvider onFinished={reload}>
            {/* A finished login means the server can reach Proton now, so the copy is worth asking
                for again. */}
            <LoginProvider onSignedIn={reload}>
            <ApplyProvider onApplied={reload}>
            {/*
             * Keyed on the sync time *and* the account fingerprint.
             *
             * The first covers a finished sync: it replaces the mailbox under the store, and
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
            <StoreProvider key={`${String(syncedAt ?? 'none')}:${version ?? 'none'}`}>
                <Shell />
            </StoreProvider>
            </ApplyProvider>
            </LoginProvider>
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

/**
 * The dashboard itself, once there is a mailbox to draw it from.
 *
 * Exported because the providers above it fetch, and a synchronous render never gets past that. A
 * test mounts this inside the same provider stack with a mailbox handed in — see `test/harness.tsx`.
 */
export function Shell(): React.JSX.Element {
    const { nav, goTo, selected, selectedFrom, clearSelection, open, setOpen } = useAppState();
    const { groups, categories, autoRules } = useMailbox();
    const status = useMailboxStatus();
    const { rules, folders, drift } = useStore();
    const historyCount = status.history.length;
    const [buildingRule, setBuildingRule] = useState(false);
    const [movingToCategory, setMovingToCategory] = useState(false);

    // Only screens other than this one. Saying "aus Regeln" while standing on Regeln is noise.
    const elsewhere = selectedFrom.filter((entry) => entry !== nav.page);

    const nav_: Array<{ id: Page; label: string; count: number }> = [
        { id: 'triage', label: PAGE_LABELS.triage, count: groups.length },
        {
            id: 'rules',
            label: PAGE_LABELS.rules,
            // Only the ones this tool manages. Counting a rule that is simultaneously asking to be
            // adopted on „Änderungen" would put a number on the tab that answers its own question.
            count: rules.filter((rule) => rule.adopted !== false).length,
        },
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

                {/*
                 * Wrapped, and the wrapper is `display: contents` on anything wider than a phone —
                 * so above that breakpoint the buttons are still direct children of the sidebar and
                 * nothing about the layout changes. On a phone the wrapper becomes a field of
                 * chips that wraps onto as many lines as it needs: eight full-width rows there
                 * filled the entire first screen, so every page began with a menu somebody had to
                 * scroll past to reach their own mail.
                 */}
                <div className="nav-items">
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
                </div>

                {/*
                 * Stated on every screen, not tucked into a settings page. Someone looking at a
                 * plausible list of their own folder names should never have to wonder whether they
                 * are looking at their real mailbox.
                 */}
                <SourceBanner status={status} />
            </nav>

            {/*
             * Connecting, syncing and locking — the three things that are about the dashboard
             * rather than about a page.
             *
             * A sibling of the bar rather than a child of it, because on a phone the bar sits
             * *above* the content and these belong after it: they are what somebody reaches for
             * once they are done reading, and every page started with them in the way.
             *
             * The source banner deliberately does not travel with them. It answers „whose mailbox
             * is this" and has to be legible *before* the list is, not underneath it.
             */}
            <div className="sidebar-tools">
                <LoginPanel />
                <SyncPanel />
                <PowerPanel />
                <LockButton />
            </div>

            <main className="main">
                {/*
                 * The corner, where a state can be read without being explained.
                 *
                 * Above the page's own content because it is about the whole dashboard rather than
                 * about whatever screen happens to be open, and it must not move as pages change.
                 */}
                <StatusStrip />

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
 * Which copy is on screen, said plainly and on every screen.
 *
 * It used to have a second half, announcing invented data whenever the local server was silent.
 * There is no such state any more — the dashboard renders nothing but the real mirror — so what is
 * left is the half that was always the harder one: once the names *are* yours, the questions become
 * "how old is this" and "is it all of it", and both have to be answered where the data is rather
 * than in a settings page.
 *
 * Nothing here claims a live connection. The dashboard reads a copy; the copy is as old as the last
 * sync, and saying so is the difference between a stale screen and a lying one.
 */
export function SourceBanner({ status }: { status: ReturnType<typeof useMailboxStatus> }): React.JSX.Element {
    return (
        <p className="source-banner">
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
