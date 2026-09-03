import { useEffect, useState } from 'react';

import { createDemoProvider, type SieveExplanation } from '@pms/llm';

import { MailList } from '../components/MailList.js';
import { RuleConditions } from '../components/RuleConditions.js';
import { log } from '../log.js';
import { useMailbox, useMailboxStatus } from '../mailbox.js';
import { protonMailUrl } from '../proton-link.js';
import { useAppState } from '../state.js';
import { useStore } from '../store.js';

/**
 * Every filter in execution order, and for each one the three things Proton's own list withholds:
 * what the rule actually says, which messages it catches, and whether it decides anything at all.
 *
 * Order is a number rather than an implication, because with filters the order *is* the outcome.
 */
export function RulesPage(): React.JSX.Element {
    const { analysisFor, matchedBy, shadowFolders } = useMailbox();
    const { source } = useMailboxStatus();
    const { nav, goTo, setOpen } = useAppState();

    const linkFor =
        source === 'proton' ? (message: { ID: string; Subject: string }) => protonMailUrl(message) : undefined;
    const { rules, stage } = useStore();
    const [openId, setOpenId] = useState<string | undefined>(nav.focusRuleId);

    // Arriving from a folder should land on the rule that folder pointed at, opened.
    useEffect(() => {
        if (nav.focusRuleId !== undefined) {
            setOpenId(nav.focusRuleId);
        }
    }, [nav.focusRuleId]);

    const shadowNames = new Set(shadowFolders.map((folder) => folder.Name));

    return (
        <>
            <header className="page-head">
                <h1>Regeln</h1>
                <p>
                    In der Reihenfolge, in der Proton sie ausführt. Eine Regel anklicken zeigt, was sie
                    prüft und welche Mails sie trifft — lokal berechnet, weil Proton das nicht verrät.
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
                                    <FilterKind kind={entry.authoredAs} />
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
                                        landet, liegt nicht dort, wo Proton sie erwartet.
                                    </p>
                                )}

                                <h3>Was die Regel prüft</h3>
                                <RuleConditions
                                    rule={entry.rule}
                                    onFolderClick={(folder) => goTo({ page: 'folders', focusFolder: folder })}
                                />

                                {entry.authoredAs === 'sieve' && <SieveDetail ruleId={entry.id} />}

                                <h3 style={{ marginTop: 16 }}>Getroffene Mails</h3>
                                <p className="faint">
                                    Lokal berechnet und bis zur Verifikation gegen das echte Verhalten
                                    eine Schätzung.
                                </p>
                                <MailList
                                    messages={matchedBy(entry.id)}
                                    onOpen={setOpen}
                                    search
                                    selectAll
                                    pageSize={10}
                                    emptyText="Diese Regel trifft im erfassten Zeitraum keine Mail."
                                    {...(linkFor === undefined ? {} : { linkFor })}
                                />

                                <div className="row" style={{ marginTop: 16 }}>
                                    <button
                                        type="button"
                                        className="button button-secondary"
                                        onClick={() => {
                                            log('info', 'rule.stage-disable', { ruleId: entry.id });
                                            stage({
                                                id: `disable-${entry.id}`,
                                                kind: 'disable-rule',
                                                summary: `Regel „${entry.name}" deaktivieren`,
                                                before: entry,
                                            });
                                        }}
                                    >
                                        Deaktivieren
                                    </button>
                                    <button
                                        type="button"
                                        className="button button-quiet"
                                        onClick={() => {
                                            log('info', 'rule.stage-delete', { ruleId: entry.id });
                                            stage({
                                                id: `delete-${entry.id}`,
                                                kind: 'delete-rule',
                                                summary: `Regel „${entry.name}" löschen`,
                                                before: entry,
                                            });
                                        }}
                                    >
                                        Löschen
                                    </button>
                                </div>
                            </div>
                        )}
                    </div>
                );
            })}
        </>
    );
}

/**
 * Which kind of filter this is, because it changes what the user can do with it.
 *
 * A Proton filter is the clickable kind and can be edited in their own interface. A script filter is
 * Sieve and appears there only as code — everything readable about it here is derived from the rule
 * tree Proton returns alongside it.
 */
function FilterKind({ kind }: { kind: 'tree' | 'sieve' }): React.JSX.Element {
    return kind === 'sieve' ? (
        <span className="badge badge-neutral" title="Als Sieve-Skript geschrieben">
            Script-Filter
        </span>
    ) : (
        <span className="badge badge-accent" title="In Protons Oberfläche editierbar">
            Proton-Filter
        </span>
    );
}

const provider = createDemoProvider();

/**
 * The script itself, plus an explanation in prose.
 *
 * The structural rendering above is authoritative — it comes from Proton's own parser. This is a
 * language model's reading of the same script, and it is labelled as such rather than blended in.
 * The two are shown in that order deliberately: prose is easier to read and easier to be wrong
 * about, and a plausible-sounding wrong summary of what moves someone's mail is worse than none.
 */
function SieveDetail({ ruleId }: { ruleId: string }): React.JSX.Element {
    const { sieveTextFor } = useMailbox();
    const sieve = sieveTextFor(ruleId);
    const [explanation, setExplanation] = useState<SieveExplanation | undefined>(undefined);
    const [failed, setFailed] = useState(false);

    useEffect(() => {
        let cancelled = false;
        provider
            .explainSieve(sieve)
            .then((result) => {
                if (!cancelled) {
                    setExplanation(result);
                }
            })
            .catch(() => {
                if (!cancelled) {
                    setFailed(true);
                }
            });
        return () => {
            cancelled = true;
        };
    }, [sieve]);

    return (
        <>
            <h3 style={{ marginTop: 16 }}>Script-Filter</h3>
            <p className="faint">
                In Protons Oberfläche nur als Code sichtbar. Die Struktur oben ist aus dem Regelbaum
                abgeleitet, den Proton mitliefert — sie ist massgeblich.
            </p>
            <code className="sieve-code">{sieve}</code>

            {failed && (
                <p className="notice notice-warning">
                    Kein Sprachmodell erreichbar — ohne Erklärung. Die Struktur oben gilt trotzdem.
                </p>
            )}

            {explanation !== undefined && (
                <div className="generated">
                    <div className="row">
                        <strong>Erklärung</strong>
                        <span className="badge badge-neutral">vom Modell erzeugt</span>
                    </div>
                    <p className="muted" style={{ margin: '4px 0 0' }}>
                        {explanation.summary}
                    </p>
                    <ol>
                        {explanation.steps.map((step) => (
                            <li key={step}>{step}</li>
                        ))}
                    </ol>
                    <p className="faint">
                        Erzeugter Text, kann falsch sein. Im Zweifel gilt die abgeleitete Struktur.
                    </p>
                </div>
            )}
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
