import { useState } from 'react';

import { analysisFor, matchedBy, rules, shadowFolders } from '../data.js';
import { MailList } from '../components/MailList.js';

/**
 * Every filter in execution order, and for each one the two things Proton's own list will not tell
 * you: which messages it catches, and whether it decides anything at all.
 *
 * Order is shown as a number rather than left implicit, because with filters it is the order that
 * determines the outcome — a rule can be perfectly written and still never matter.
 */
export function RulesPage(): React.JSX.Element {
    const [openId, setOpenId] = useState<string | undefined>(undefined);

    const shadowNames = new Set(shadowFolders.map((folder) => folder.Name));

    return (
        <>
            <header className="page-head">
                <h1>Regeln</h1>
                <p>
                    In der Reihenfolge, in der Proton sie ausführt. Eine Regel anklicken zeigt, welche
                    Mails sie trifft — lokal berechnet, weil Proton das nicht verrät.
                </p>
            </header>

            {rules.map((entry, index) => {
                const report = analysisFor(entry.id);
                const isOpen = openId === entry.id;
                const target = entry.rule.Actions.FileInto.at(-1) ?? '—';

                return (
                    <div key={entry.id}>
                        <button
                            type="button"
                            className="rule-row"
                            aria-expanded={isOpen}
                            onClick={() => setOpenId(isOpen ? undefined : entry.id)}
                        >
                            <span className="rule-order">{index + 1}</span>

                            <span className="stack">
                                <span className="row">
                                    <strong>{entry.name}</strong>
                                    {entry.authoredAs === 'sieve' && (
                                        <span className="badge badge-neutral">Sieve</span>
                                    )}
                                    {shadowNames.has(target) && (
                                        <span className="badge badge-warning">Zielordner doppelt</span>
                                    )}
                                </span>
                                <span className="faint">
                                    → {target} · {report?.matchedCount ?? 0} Treffer ·{' '}
                                    {report?.decidedCount ?? 0}× entscheidend
                                </span>
                            </span>

                            <Verdict verdict={report?.verdict} />
                        </button>

                        {isOpen && (
                            <div className="detail">
                                {report !== undefined && report.verdict !== 'active' && (
                                    <p
                                        className={
                                            report.verdict === 'always-overridden'
                                                ? 'notice notice-danger'
                                                : 'notice notice-warning'
                                        }
                                    >
                                        {report.explanation}
                                    </p>
                                )}

                                {shadowNames.has(target) && (
                                    <p className="notice notice-warning">
                                        „{target}" doppelt einen Proton-Systemordner. Mail, die hier
                                        landet, liegt nicht dort, wo Proton sie erwartet — und wird
                                        leicht übersehen.
                                    </p>
                                )}

                                {entry.authoredAs === 'sieve' && (
                                    <p className="notice notice-info">
                                        Als Sieve geschrieben. In Protons Oberfläche nur als Code
                                        sichtbar — hier lesbar, weil Proton den Regelbaum mitliefert.
                                    </p>
                                )}

                                <h3 style={{ marginTop: 14 }}>Getroffene Mails</h3>
                                <p className="faint">
                                    Lokal berechnet und bis zur Verifikation gegen das echte Verhalten
                                    eine Schätzung.
                                </p>
                                <MailList messages={matchedBy(entry.id)} />
                            </div>
                        )}
                    </div>
                );
            })}
        </>
    );
}

function Verdict({ verdict }: { verdict: string | undefined }): React.JSX.Element {
    switch (verdict) {
        case 'never-matches':
            return <span className="badge badge-warning">trifft nichts</span>;
        case 'always-overridden':
            return <span className="badge badge-danger">wirkungslos</span>;
        default:
            return <span className="badge badge-success">aktiv</span>;
    }
}
