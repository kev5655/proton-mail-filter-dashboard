import { useState } from 'react';

import { categoryName, type AutoRule } from '@pms/grouping';

import { useMailbox, useMailboxStatus } from '../mailbox.js';
import { useAppState } from '../state.js';

/**
 * Proton's own sorting, made visible.
 *
 * Proton files inbox mail into categories and keeps doing it for a sender once a message has been
 * put there by hand. That rule has no interface, no filter and no list — and it cannot be fetched:
 * Proton's own client sends nothing when it recategorises, and there is no endpoint that reads or
 * writes a per-sender preference. It exists on their servers and is visible only in its effects.
 *
 * So this screen shows effects. Every sentence on it is an observation with its basis attached, and
 * the wording is the point: *"every time we looked, this sender's mail was in Werbung"* is something
 * we can support, while *"Proton sorts this sender into Werbung"* is not. The difference is not
 * pedantry — a claim about a rule invites someone to rely on it, and this one could be wrong for
 * reasons we cannot see.
 *
 * The screen is deliberately thin on a young database. „Noch zu wenige Beobachtungen" is the honest
 * answer after one sync, and inventing a verdict from a single snapshot would make the one screen
 * about honesty the least honest thing here.
 */
export function AutoRulesPage(): React.JSX.Element {
    const { autoRules, categories } = useMailbox();
    const { source, syncedAt } = useMailboxStatus();
    const { goTo } = useAppState();
    const [showAll, setShowAll] = useState(false);

    const senders = autoRules.filter((rule) => rule.scope.kind === 'sender');
    const domains = autoRules.filter((rule) => rule.scope.kind === 'domain');

    const changed = senders.filter((rule) => rule.verdict.kind === 'changed');
    const stable = senders.filter((rule) => rule.verdict.kind === 'stable');
    const mixed = senders.filter((rule) => rule.verdict.kind === 'mixed');
    const tooFew = senders.filter((rule) => rule.verdict.kind === 'too-few');

    const syncs = new Set(autoRules.flatMap((rule) => rule.observedOver)).size;
    const duplicating = categories.filter((entry) => entry.alsoMovedByRules.length > 0);
    const unknown = categories.filter((entry) => entry.unknown);

    return (
        <>
            <header className="page-head">
                <h1>Auto-Regeln</h1>
                <p>
                    Proton sortiert Posteingangs-Mail selbst in Kategorien, und macht damit weiter,
                    sobald du eine Mail einmal von Hand woanders hin gelegt hast. Diese Regel hat
                    keine Oberfläche und lässt sich nicht abfragen — auch Protons eigene App
                    schickt nichts, was sie setzen oder lesen würde. Sichtbar ist nur, was sie tut.
                    Deshalb steht hier, was <em>beobachtet</em> wurde, nie was Proton „macht".
                </p>
            </header>

            {syncs < 2 && (
                <p className="notice notice-warning">
                    <strong>Noch zu wenig gesehen.</strong> Ein Verlauf entsteht erst durch mehrere
                    Synchronisationen — bisher {syncs === 0 ? 'keine' : 'eine'}. Bis dahin lässt sich
                    nicht unterscheiden, ob Proton etwas <em>immer</em> so macht oder ob es das heute
                    getan hat. Das ist keine Fehlfunktion; die Seite füllt sich mit der Zeit.
                </p>
            )}

            {/* 1 — what changed. The reason this screen exists, so it goes first. */}
            <section>
                <h2>Was sich geändert hat</h2>
                {changed.length === 0 ? (
                    <p className="muted">
                        Seit Beginn der Aufzeichnung hat Proton bei keinem Absender die Kategorie
                        gewechselt.
                    </p>
                ) : (
                    changed.map((rule) => <ChangedCard key={key(rule)} rule={rule} />)
                )}
            </section>

            {/* 2 — what Proton does per sender. */}
            <section style={{ marginTop: 28 }}>
                <h2>Was Proton pro Absender tut</h2>
                {stable.length === 0 && (
                    <p className="muted">
                        Noch kein Absender ist über genug Synchronisationen hinweg gleich einsortiert
                        worden.
                    </p>
                )}
                {stable.map((rule) => (
                    <StableRow key={key(rule)} rule={rule} />
                ))}

                {domains.length > 0 && (
                    <>
                        <h3 style={{ marginTop: 20 }}>Dieselbe Frage nach Domäne</h3>
                        <p className="faint">
                            Ob Proton nach Absender, nach Domäne oder nach etwas ganz anderem
                            entscheidet, wissen wir nicht. Beides nebeneinander zu zeigen ist
                            ehrlicher, als eines davon auszuwählen.
                        </p>
                        {domains
                            .filter((rule) => rule.verdict.kind === 'stable')
                            .map((rule) => (
                                <StableRow key={key(rule)} rule={rule} />
                            ))}
                    </>
                )}
            </section>

            {/* 3 — where Proton does not commit, and a user rule is the right answer. */}
            <section style={{ marginTop: 28 }}>
                <h2>Wo Proton sich nicht festlegt</h2>
                {mixed.length === 0 ? (
                    <p className="muted">Kein Absender wird uneinheitlich einsortiert.</p>
                ) : (
                    <>
                        <p className="faint">
                            Hier ist eine eigene Regel sinnvoll: Proton verteilt diese Mail auf
                            mehrere Kategorien, es gibt also nichts, was sie schon zuverlässig
                            erledigt.
                        </p>
                        {mixed.map((rule) => (
                            <MixedCard
                                key={key(rule)}
                                rule={rule}
                                onBuildRule={(address) => goTo({ page: 'rules', draftForSender: address })}
                            />
                        ))}
                    </>
                )}
            </section>

            {/* 4 — where the user's own rules duplicate the work. */}
            <section style={{ marginTop: 28 }}>
                <h2>Wo deine Regeln doppelt arbeiten</h2>
                {duplicating.length === 0 ? (
                    <p className="muted">
                        Keine deiner Regeln fasst Mail an, die Proton schon einsortiert hat.
                    </p>
                ) : (
                    duplicating.map((entry) => (
                        <div className="card" key={entry.id}>
                            <strong>{entry.label}</strong>
                            <ul className="plain-list">
                                {entry.alsoMovedByRules.map((rule) => (
                                    <li key={rule.ruleId}>
                                        <button
                                            type="button"
                                            className="value-chip value-chip-link"
                                            onClick={() => goTo({ page: 'rules', focusRuleId: rule.ruleId })}
                                        >
                                            {rule.ruleName}
                                        </button>{' '}
                                        verschiebt {rule.count} dieser Mails nach „{rule.destination}".
                                    </li>
                                ))}
                            </ul>
                        </div>
                    ))
                )}
            </section>

            {unknown.length > 0 && (
                <section style={{ marginTop: 28 }}>
                    <h2>Unbekannte Kategorien</h2>
                    <p className="notice notice-warning">
                        {unknown.map((entry) => `${entry.id} (${String(entry.messages.length)} Mails)`).join(', ')}
                        . Diese IDs sehen aus wie Kategorien, stehen aber nicht in Protons Liste.
                        Wenn du weisst, wie sie in Proton heissen, lässt sich die Zuordnung
                        korrigieren — sie zu verschlucken wäre der einzige Weg, das nie zu erfahren.
                    </p>
                </section>
            )}

            {tooFew.length > 0 && (
                <section style={{ marginTop: 28 }}>
                    <button
                        type="button"
                        className="button button-quiet"
                        onClick={() => setShowAll(!showAll)}
                    >
                        {showAll
                            ? 'Absender ohne Aussage ausblenden'
                            : `${tooFew.length} Absender, über die noch nichts zu sagen ist`}
                    </button>
                    {showAll && (
                        <ul className="plain-list" style={{ marginTop: 10 }}>
                            {tooFew.map((rule) => (
                                <li key={key(rule)} className="faint">
                                    {label(rule)} — {rule.observedOver.length}× beobachtet
                                </li>
                            ))}
                        </ul>
                    )}
                </section>
            )}

            {/*
             * The basis, stated rather than implied.
             *
             * The incremental sync is the real limitation and the easiest one to forget: it fetches
             * only new mail, so a message Proton re-sorted last month is never looked at again.
             * "Unchanged" on this screen means "not looked at", which is a weaker claim than it
             * appears, and the user is the only one who can decide whether to spend a full sync on it.
             */}
            <footer className="notice notice-info" style={{ marginTop: 32 }}>
                <strong>Woraus das gelesen ist.</strong> {syncs}{' '}
                {syncs === 1 ? 'Synchronisation' : 'Synchronisationen'}
                {syncedAt === undefined ? '' : `, zuletzt am ${new Date(syncedAt * 1000).toLocaleDateString('de-CH')}`}.
                Das zeigt, was Proton getan hat — nicht, warum.
                <br />
                <br />
                Zwei Dinge, die diese Seite nicht sehen kann: Ein normaler Sync holt nur{' '}
                <em>neue</em> Mail, also fällt es nicht auf, wenn Proton eine ältere Mail neu
                einsortiert — „unverändert" heisst hier genau genommen „nicht nachgesehen". Und wenn
                du selbst in Protons App etwas verschiebst, steht das hier genauso drin wie eine
                Entscheidung von Proton; auseinanderhalten lässt sich das nicht.
                {source === 'demo' && (
                    <>
                        <br />
                        <br />
                        <strong>Demo-Daten:</strong> dieser Verlauf ist erfunden, damit die Seite
                        ohne Konto etwas zeigt.
                    </>
                )}
            </footer>
        </>
    );
}

function key(rule: AutoRule): string {
    return rule.scope.kind === 'sender' ? `s:${rule.scope.address}` : `d:${rule.scope.domain}`;
}

function label(rule: AutoRule): string {
    return rule.scope.kind === 'sender' ? rule.scope.address : `alle @${rule.scope.domain}`;
}

function day(at: number): string {
    return new Date(at * 1000).toLocaleDateString('de-CH', { day: 'numeric', month: 'long', year: 'numeric' });
}

function ChangedCard({ rule }: { rule: AutoRule }): React.JSX.Element | null {
    if (rule.verdict.kind !== 'changed') {
        return null;
    }
    const { from, to, at, messages } = rule.verdict;

    return (
        <div className="card">
            <div className="row">
                <strong>{label(rule)}</strong>
                <span className="badge badge-warning">geändert</span>
            </div>
            <p style={{ marginTop: 8 }}>
                {from === undefined ? (
                    <>
                        Am {day(at)} hat Proton Mail von diesem Absender zum ersten Mal einsortiert:
                        nach <code className="value-chip">{categoryName(to)}</code>. Das ist kein
                        Sinneswandel, sondern der Anfang der Aufzeichnung für ihn.
                    </>
                ) : (
                    <>
                        Am {day(at)} hat Proton {messages}{' '}
                        {messages === 1 ? 'Mail' : 'Mails'} dieses Absenders neu einsortiert:{' '}
                        <code className="value-chip">{categoryName(from)}</code> →{' '}
                        <code className="value-chip">{categoryName(to)}</code>.
                    </>
                )}
            </p>
            <p className="faint">Beobachtet über {rule.observedOver.length} Synchronisationen.</p>
        </div>
    );
}

function StableRow({ rule }: { rule: AutoRule }): React.JSX.Element | null {
    if (rule.verdict.kind !== 'stable') {
        return null;
    }
    const { categoryId, since, syncs, messages } = rule.verdict;

    return (
        <div className="folder-row">
            <span className="folder-name">{label(rule)}</span>
            <code className="value-chip">{categoryName(categoryId)}</code>
            <span className="faint">
                {messages} Mails · {syncs}× beobachtet · seit {day(since)} unverändert
            </span>
        </div>
    );
}

function MixedCard({
    rule,
    onBuildRule,
}: {
    rule: AutoRule;
    onBuildRule: (address: string) => void;
}): React.JSX.Element | null {
    if (rule.verdict.kind !== 'mixed') {
        return null;
    }

    return (
        <div className="card">
            <div className="row">
                <strong>{label(rule)}</strong>
                <span className="badge badge-neutral">uneinheitlich</span>
            </div>
            <p style={{ marginTop: 8 }}>
                {rule.verdict.shares
                    .map((share) => `${categoryName(share.categoryId)}: ${String(share.count)}`)
                    .join(' · ')}
            </p>
            {rule.scope.kind === 'sender' && (
                <button
                    type="button"
                    className="button"
                    onClick={() => onBuildRule(rule.scope.kind === 'sender' ? rule.scope.address : '')}
                >
                    Eigene Regel für diesen Absender
                </button>
            )}
        </div>
    );
}
