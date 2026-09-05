import { useState } from 'react';

import type { DemoRule } from '@pms/demo';
import { explainScore } from '@pms/grouping';

import { MailList } from '../components/MailList.js';
import { ScoreBar } from '../components/ScoreBar.js';
import { log } from '../log.js';
import { useMailbox, useMailboxStatus, useReloadMailbox } from '../mailbox.js';
import { useSettings } from '../llm.js';
import { ModelStatus } from '../components/ModelStatus.js';
import { protonMailUrl } from '../proton-link.js';
import { useAppState } from '../state.js';
import { useStore } from '../store.js';

/**
 * The screen where inbox clutter turns into rules.
 *
 * Two things are load-bearing here. Every suggestion states *why* the group exists, because a rule
 * the user cannot judge is a rule they should not accept. And nothing is written without a click —
 * accepting only stages the change; the diff and the confirmation come after.
 */
export function TriagePage(): React.JSX.Element {
    const { inboxMessages, suggestions, messagesInGroup, caughtBy } = useMailbox();
    const settings = useSettings();
    const { source } = useMailboxStatus();
    const { setOpen } = useAppState();

    // Only for the real mailbox: a demo message id points at nothing in anyone's account.
    const linkFor =
        source === 'proton'
            ? (message: { ID: string; Subject: string }) => protonMailUrl(message, settings.proton)
            : undefined;
    const { stage, rules } = useStore();
    const reload = useReloadMailbox();
    const { hiddenSuggestions } = useMailboxStatus();
    const [decisions, setDecisions] = useState<Record<string, 'accepted'>>({});
    /*
     * Hiding, kept where it survives.
     *
     * „Nicht vorschlagen" was a React state and nothing else, so every hidden suggestion came back
     * on the next reload — the button meant „until you look away". It goes to the local database
     * now, which is also what lets a second device see the same list.
     *
     * The demo has no database, so it keeps its own set in memory and says so by simply working:
     * the screens must be interchangeable, and one that offers a button the demo cannot honour
     * would make the demo stop being a test of anything.
     */
    const [demoHidden, setDemoHidden] = useState<Record<string, number>>({});
    const [hideError, setHideError] = useState<string | undefined>(undefined);
    const [openKey, setOpenKey] = useState<string | undefined>(undefined);
    const [query, setQuery] = useState('');
    // Sections start open: the page's job is to show what there is. Collapsing is for putting a
    // section aside once it has been dealt with, not a state to have to undo on arrival.
    const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
    // The one section that starts closed, and for the opposite reason to the others: this is an
    // archive, not a list of work.
    const [showHidden, setShowHidden] = useState(false);

    const hiddenAt = new Map<string, number>(
        source === 'demo'
            ? Object.entries(demoHidden)
            : hiddenSuggestions.map((entry) => [entry.groupKey, entry.atSeconds])
    );

    const open = suggestions.filter(
        (entry) => decisions[entry.group.key] === undefined && !hiddenAt.has(entry.group.key)
    );
    const hidden = suggestions.filter((entry) => hiddenAt.has(entry.group.key));
    const grouped = suggestions.reduce((total, entry) => total + entry.group.size, 0);

    /*
     * Putting one away, and taking it back, through one function.
     *
     * Two would let the halves drift, and this is a toggle in the interface as well: the same card
     * carries „Ausblenden" in one list and „Wieder einblenden" in the other.
     */
    const setHidden = (groupKey: string, next: boolean): void => {
        setHideError(undefined);
        if (source === 'demo') {
            setDemoHidden((current) => {
                const copy = { ...current };
                if (next) {
                    copy[groupKey] = Math.floor(Date.now() / 1000);
                } else {
                    delete copy[groupKey];
                }
                return copy;
            });
            return;
        }
        void (async () => {
            try {
                const response = await fetch('/api/suggestions/hidden', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ groupKey, hidden: next }),
                });
                if (!response.ok) {
                    const problem = (await response.json()) as { error?: string };
                    setHideError(problem.error ?? `Der Server antwortete mit ${String(response.status)}.`);
                    return;
                }
                // The list on screen comes from the snapshot, so it has to be fetched again —
                // otherwise the card stays put and the click reads as having failed.
                reload();
            } catch {
                setHideError('Der lokale Server ist nicht erreichbar. Läuft `pnpm serve`?');
            }
        })();
    };

    /*
     * Sections by how the group was found.
     *
     * `kind` already carries this: a sender group is one address, `sender-subject` is one address
     * split because its mail falls into distinct kinds — the security-alert-versus-announcement
     * case — and `domain` is several senders too small individually, rolled up by organisation.
     *
     * There is deliberately no "nach Inhalt" section. Grouping has no content kind, and a heading
     * promising clustering that does not exist would be a label doing the work the code has not
     * done. It becomes possible once mail bodies are available locally.
     */
    /*
     * One filter across every section, applied before the sections are cut.
     *
     * The list runs to dozens of suggestions and they are grouped by *how* a group was found, not
     * by what is in it — so looking for everything from one shop means reading all three sections.
     * Filtering here rather than per section means one query answers the whole page, and each
     * heading can then say how much of it survived.
     *
     * It matches what the card actually shows — the reason, the proposed folder, the sender and
     * domain behind the group — because a filter that matches on something invisible reads as
     * broken.
     */
    const needle = query.trim().toLowerCase();
    const matches = (entry: (typeof open)[number]): boolean =>
        needle === '' ||
        [
            entry.group.reason,
            entry.folder,
            entry.group.match.sender,
            entry.group.match.domain,
            entry.group.match.subjectTemplate,
        ].some((value) => value !== undefined && value.toLowerCase().includes(needle));

    const sections = SECTIONS.map((section) => {
        const all = open.filter((entry) => entry.group.kind === section.kind);
        return { ...section, all, entries: all.filter(matches) };
    }).filter((section) => section.all.length > 0);

    const shown = sections.reduce((total, section) => total + section.entries.length, 0);

    return (
        <>
            <header className="page-head">
                <h1>Vorschläge</h1>
                <p>
                    {inboxMessages.length} Mails im Posteingang, {grouped} davon in {suggestions.length}{' '}
                    Gruppen. Der Rest sind Einzelfälle und bleibt bewusst ungruppiert — dafür lohnt
                    sich keine Regel.
                </p>
            </header>

            {/*
             * Where a model would help, said on the screen where it would help.
             *
             * The folder names below are derived — from the group's own senders and subjects — and
             * they stay that way with or without a model. What a model adds here is a better *name*,
             * which is the one thing it is allowed to decide: a wrong name costs a rename, and that
             * is a different order of mistake from a wrongly trusted filter.
             */}
            <ModelStatus what="werden die Ordnernamen unten nur abgeleitet und nicht formuliert" />

            {open.length === 0 && <p className="muted">Alle Vorschläge bearbeitet.</p>}

            {open.length > 0 && (
                <div className="mail-list-tools" style={{ marginBottom: 12 }}>
                    <input
                        type="search"
                        className="text-input mail-search"
                        value={query}
                        placeholder="Absender, Organisation, Betreff oder Zielordner"
                        onChange={(event) => setQuery(event.target.value)}
                        aria-label="Vorschläge filtern"
                    />
                    <span className="faint">
                        {needle === ''
                            ? `${open.length} ${open.length === 1 ? 'Vorschlag' : 'Vorschläge'}`
                            : `${shown} von ${open.length}`}
                    </span>
                </div>
            )}

            {open.length > 0 && needle !== '' && shown === 0 && (
                <p className="muted">
                    Kein Vorschlag passt auf „{query.trim()}". Gesucht wird in Absender, Organisation,
                    Betreffmuster und vorgeschlagenem Ordner — nicht im Mailinhalt, den es hier noch
                    nicht gibt.
                </p>
            )}

            {sections.map((section) => {
                const isCollapsed = collapsed[section.kind] === true;
                return (
                    <section key={section.kind} className="suggestion-section">
                        <h2>
                            <button
                                type="button"
                                className="section-toggle"
                                aria-expanded={!isCollapsed}
                                onClick={() =>
                                    setCollapsed((current) => ({ ...current, [section.kind]: !isCollapsed }))
                                }
                            >
                                <span aria-hidden="true">{isCollapsed ? '▸' : '▾'}</span> {section.label}
                            </button>{' '}
                            <span className="faint">
                                {needle === ''
                                    ? `(${section.entries.length} ${
                                          section.entries.length === 1 ? 'Vorschlag' : 'Vorschläge'
                                      })`
                                    : `(${section.entries.length} von ${section.all.length})`}
                            </span>
                        </h2>
                        {!isCollapsed && (
                            <>
                                <p className="faint">{section.hint}</p>
                                {section.entries.length === 0 ? (
                                    <p className="muted">Hier passt nichts auf den Filter.</p>
                                ) : (
                                    /*
                                     * Two columns where there is room for two.
                                     *
                                     * A suggestion card is a fixed, small thing — a name, a folder
                                     * and two buttons — so one per line on a wide screen means
                                     * scrolling past a column of whitespace. The card that is
                                     * opened takes the full width back, because what unfolds under
                                     * it is a mail list, and a mail list in half a column is worse
                                     * than a second column is good.
                                     */
                                    <div className="column-grid">{renderEntries(section.entries)}</div>
                                )}
                            </>
                        )}
                    </section>
                );
            })}

            {/*
             * Where the put-away ones live.
             *
             * A section rather than a screen, and collapsed to start with: it is the one list here
             * nobody opens the page to read. But it has to exist and be reachable, because
             * „Ausblenden" without a way back is „verlieren" — and the old button, which forgot
             * everything on reload, was somehow both at once.
             */}
            {hidden.length > 0 && (
                <section className="suggestion-section">
                    <h2>
                        <button
                            type="button"
                            className="section-toggle"
                            aria-expanded={showHidden}
                            onClick={() => setShowHidden(!showHidden)}
                        >
                            <span aria-hidden="true">{showHidden ? '▾' : '▸'}</span> Ausgeblendet
                        </button>{' '}
                        <span className="faint">({hidden.length})</span>
                    </h2>
                    {showHidden && (
                        <>
                            <p className="faint">
                                Diese Vorschläge stehen nicht mehr oben. Sie sind nicht weg —
                                „Wieder einblenden" holt einen zurück, und ausgeblendet zu sein
                                ändert nichts an deinem Konto.
                            </p>
                            <div className="column-grid">{renderEntries(hidden)}</div>
                        </>
                    )}
                </section>
            )}

            {hideError !== undefined && <p className="notice notice-danger">{hideError}</p>}

            {Object.keys(decisions).length > 0 && (
                <p className="notice notice-info">
                    {Object.values(decisions).filter((value) => value === 'accepted').length} Regeln
                    vorgemerkt. Geschrieben wird erst nach dem Diff und deiner Bestätigung.
                </p>
            )}
        </>
    );

    function renderEntries(entries: typeof open): React.JSX.Element[] {
        return entries.map((entry) => {
                const isOpen = openKey === entry.group.key;
                const members = messagesInGroup(entry.group);
                const alreadyCaught = members.filter((message) => caughtBy(message.ID) !== undefined).length;

                /**
                 * What an existing rule already does with this message.
                 *
                 * Two different facts wearing the same badge: filing it where this suggestion
                 * would (neutral — the suggestion is redundant) and filing it somewhere else
                 * (warning — accepting this would change where the mail lands, which is the part
                 * nobody expects).
                 */
                const noteFor = (message: { ID: string }): { text: string; tone: 'neutral' | 'warning'; title: string } | undefined => {
                    const owner = caughtBy(message.ID);
                    if (owner === undefined) {
                        return undefined;
                    }
                    const sameTarget = owner.destination === entry.folder;
                    return {
                        text: sameTarget ? 'schon gefangen' : `→ ${owner.destination}`,
                        tone: sameTarget ? 'neutral' : 'warning',
                        title: sameTarget
                            ? `„${owner.ruleName}" sortiert diese Mail bereits nach „${owner.destination}".`
                            : `„${owner.ruleName}" sortiert diese Mail heute nach „${owner.destination}" — diese Regel würde sie nach „${entry.folder}" umleiten.`,
                    };
                };

                return (
                    <div
                        className={isOpen ? 'card column-span' : 'card'}
                        key={entry.group.key}
                    >
                        <div className="card-head">
                            <div className="stack">
                                <div className="row">
                                    <strong>{entry.group.reason}</strong>
                                    {entry.group.categories.map((category) => (
                                        <span className="badge badge-neutral" key={category}>
                                            {category}
                                        </span>
                                    ))}
                                </div>
                                <span className="faint">{explainScore(entry.group)}</span>
                            </div>
                            <ScoreBar score={entry.group.score} />
                        </div>

                        <p className="notice notice-info" style={{ marginTop: 12 }}>
                            {entry.explanation}
                        </p>

                        {alreadyCaught > 0 && (
                            // The point of this line: a second rule for mail a first one already
                            // files is not an improvement, it is two rules to keep in step. Said
                            // per card as a count, and per row below as a badge.
                            <p className="notice notice-warning">
                                {alreadyCaught === entry.group.size
                                    ? 'Diese Mails fängt bereits eine bestehende Regel.'
                                    : `${alreadyCaught} der ${entry.group.size} Mails fängt bereits eine bestehende Regel.`}{' '}
                                Dafür braucht es keine zweite.
                            </p>
                        )}

                        {entry.covered < entry.group.size && (
                            <p className="notice notice-warning">
                                Die Regel trifft {entry.covered} der {entry.group.size} Mails dieser
                                Gruppe. Der Rest bleibt liegen.
                            </p>
                        )}

                        {entry.warnings.map((warning) => (
                            <p className="notice notice-danger" key={warning}>
                                {warning}
                            </p>
                        ))}

                        <div className="row" style={{ marginTop: 14 }}>
                            <button
                                type="button"
                                className="button"
                                onClick={() => {
                                    log('info', 'suggestion.stage', {
                                        group: entry.group.kind,
                                        size: entry.group.size,
                                    });
                                    // Built as a named value rather than inline: a rule literal
                                    // passed straight into the change would be checked against the
                                    // narrower OrderedRule and lose `authoredAs`.
                                    const created: DemoRule = {
                                        id: `r-${entry.group.key}`,
                                        name: entry.folder,
                                        priority: rules.length + 1,
                                        enabled: true,
                                        rule: entry.rule,
                                        // Suggested rules are always the clickable kind, so they
                                        // stay editable in Proton's own interface.
                                        authoredAs: 'tree',
                                    };
                                    // Suggested rules go through the same diff as hand-written
                                    // ones. Skipping it for the tool's own proposals would be the
                                    // fastest way to teach someone to click past it.
                                    stage({
                                        id: `create-${entry.group.key}`,
                                        kind: 'create-rule',
                                        after: created,
                                    });
                                    setDecisions((current) => ({
                                        ...current,
                                        [entry.group.key]: 'accepted',
                                    }));
                                }}
                            >
                                Regel anlegen
                            </button>
                            <button
                                type="button"
                                className="button button-secondary"
                                onClick={() => setOpenKey(isOpen ? undefined : entry.group.key)}
                            >
                                {isOpen ? 'Mails ausblenden' : `${entry.group.size} Mails ansehen`}
                            </button>
                            <button
                                type="button"
                                className="button button-quiet"
                                onClick={() => setHidden(entry.group.key, !hiddenAt.has(entry.group.key))}
                            >
                                {hiddenAt.has(entry.group.key) ? 'Wieder einblenden' : 'Ausblenden'}
                            </button>
                        </div>

                        {isOpen && (
                            // The whole group, not `group.samples` — that holds five, so the
                            // button saying "17 Mails ansehen" showed five of them, and "alle
                            // auswählen" selected five. Both were wrong in the same place.
                            <MailList
                                messages={members}
                                onOpen={setOpen}
                                search
                                selectAll
                                pageSize={settings.display.pageSize}
                                annotate={noteFor}
                                {...(linkFor === undefined ? {} : { linkFor })}
                            />
                        )}
                    </div>
                );
        });
    }
}

/**
 * The three ways a group is found, in the order they are worth looking at.
 *
 * One sender is the clearest case and the easiest to judge. A sender split by subject is the
 * interesting one: it is where a single address needs two rules, because its mail falls into
 * distinct kinds — the security-alert-versus-announcement case. A domain group is the loosest and
 * belongs last.
 *
 * There is deliberately no „Nach Inhalt". Grouping has no content kind, and a heading promising
 * clustering that does not exist would be a label doing work the code has not done. It becomes
 * possible once mail bodies are available locally.
 */
const SECTIONS: Array<{ kind: 'sender' | 'sender-subject' | 'domain'; label: string; hint: string }> = [
    {
        kind: 'sender',
        label: 'Nach Absender',
        hint: 'Eine Adresse, deren Mail durchgehend zusammengehört.',
    },
    {
        kind: 'sender-subject',
        label: 'Nach Betreff',
        hint: 'Eine Adresse, deren Mail in klar verschiedene Sorten zerfällt — die brauchen je eine eigene Regel.',
    },
    {
        kind: 'domain',
        label: 'Nach Organisation',
        hint: 'Mehrere Absender derselben Domäne, einzeln je zu wenig für eine eigene Regel.',
    },
];
