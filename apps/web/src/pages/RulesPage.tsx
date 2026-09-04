import { useEffect, useMemo, useState } from 'react';

import type { MailboxRule } from '@pms/server/types';

import { RuleEditor } from '../components/RuleEditor.js';
import { log } from '../log.js';
import { useMailbox } from '../mailbox.js';
import { fromRule, isDirty, newDraft, toSimpleObject, type RuleDraft } from '../rules/draft.js';
import { useAppState } from '../state.js';
import { useStore } from '../store.js';

/**
 * Every filter in execution order, and the one being edited beside them.
 *
 * Two panes rather than an expanding row: the rule and its consequences are what the screen is for,
 * and an accordion that pushes the list down every time it opens makes comparing two rules a matter
 * of scrolling. Order stays a number on the left, because with filters the order *is* the outcome —
 * the last rule to file a message wins.
 *
 * The editor is in the page, not in a dialog. A dialog would be the natural place for a form, but
 * this form's whole value is the live preview beside it, and a preview in a modal is a preview
 * nobody can compare against anything.
 */
export function RulesPage(): React.JSX.Element {
    const { analysisFor, shadowFolders } = useMailbox();
    const { nav, goTo, setOpen } = useAppState();
    const { rules, stage } = useStore();

    const [editing, setEditing] = useState<string | undefined>(nav.focusRuleId);
    const [draft, setDraft] = useState<RuleDraft | undefined>(undefined);

    const selected = useMemo(
        () => (editing === undefined ? undefined : rules.find((entry) => entry.id === editing)),
        [editing, rules]
    );

    const original = useMemo(
        () => (selected === undefined ? undefined : fromRule(selected)),
        [selected]
    );

    // Arriving from a folder or a category should land on the rule that pointed here, open.
    useEffect(() => {
        if (nav.focusRuleId !== undefined) {
            setEditing(nav.focusRuleId);
            setDraft(undefined);
        }
    }, [nav.focusRuleId]);

    const activeDraft = draft ?? original;
    const dirty = original !== undefined && activeDraft !== undefined && isDirty(original, activeDraft);

    /** Leaving an edited rule without saying so would lose the edit silently. */
    const leaveEditor = (next: string | undefined): void => {
        if (dirty && !window.confirm('Die Änderung ist nicht vorgemerkt. Verwerfen?')) {
            return;
        }
        setEditing(next);
        setDraft(undefined);
    };

    const shadowNames = new Set(shadowFolders.map((folder) => folder.Name));

    const startNew = (): void => {
        if (dirty && !window.confirm('Die Änderung ist nicht vorgemerkt. Verwerfen?')) {
            return;
        }
        setEditing(undefined);
        setDraft(newDraft());
    };

    const save = (): void => {
        if (activeDraft === undefined) {
            return;
        }
        const compiled = toSimpleObject(activeDraft);
        const rule: MailboxRule = {
            id: activeDraft.ruleId ?? `r-neu-${String(Date.now())}`,
            name: activeDraft.name.trim(),
            priority: selected?.priority ?? rules.length + 1,
            enabled: activeDraft.enabled,
            authoredAs: 'tree',
            rule: compiled,
        };

        log('info', activeDraft.ruleId === undefined ? 'rule.stage-create' : 'rule.stage-update', {
            conditions: compiled.Conditions.length,
        });

        stage(
            activeDraft.ruleId === undefined
                ? {
                      id: `create-${rule.id}`,
                      kind: 'create-rule',
                      summary: `Regel „${rule.name}" anlegen`,
                      after: rule,
                  }
                : {
                      id: `update-${rule.id}`,
                      kind: 'update-rule',
                      summary: `Regel „${rule.name}" ändern`,
                      before: selected,
                      after: rule,
                  }
        );
    };

    return (
        <>
            <header className="page-head">
                <h1>Regeln</h1>
                <p>
                    In der Reihenfolge, in der Proton sie ausführt. Links auswählen, rechts bearbeiten
                    — mit der Wirkung daneben, lokal berechnet, weil Proton sie nicht verrät.
                </p>
            </header>

            <div className="rules-layout">
                <div className="rule-list">
                    <button type="button" className="button" onClick={startNew} style={{ marginBottom: 10 }}>
                        Neue Regel
                    </button>

                    {rules.map((entry, index) => {
                        const report = analysisFor(entry.id);
                        const target = entry.rule.Actions.FileInto.at(-1) ?? '—';

                        return (
                            <button
                                key={entry.id}
                                type="button"
                                className="rule-row"
                                aria-current={editing === entry.id ? 'true' : undefined}
                                aria-expanded={editing === entry.id}
                                onClick={() => leaveEditor(entry.id)}
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
                        );
                    })}
                </div>

                <div className="rule-detail">
                    {activeDraft === undefined && (
                        <p className="muted">
                            Links eine Regel auswählen, um sie zu bearbeiten — oder eine neue anlegen.
                        </p>
                    )}

                    {activeDraft !== undefined && (
                        <>
                            {selected !== undefined && (
                                <RuleNotices
                                    report={analysisFor(selected.id)}
                                    shadowed={shadowNames.has(selected.rule.Actions.FileInto.at(-1) ?? '')}
                                    target={selected.rule.Actions.FileInto.at(-1) ?? ''}
                                    onFolderClick={(folder) => goTo({ page: 'folders', focusFolder: folder })}
                                />
                            )}

                            <RuleEditor
                                draft={activeDraft}
                                original={original ?? activeDraft}
                                savedRule={selected}
                                onChange={setDraft}
                                onSave={save}
                                onCancel={() => leaveEditor(undefined)}
                                onOpenMail={setOpen as (message: { ID: string }) => void}
                            />

                            {selected !== undefined && (
                                <div className="row" style={{ marginTop: 16 }}>
                                    <button
                                        type="button"
                                        className="button button-secondary"
                                        onClick={() => {
                                            log('info', 'rule.stage-disable', { ruleId: selected.id });
                                            stage({
                                                id: `disable-${selected.id}`,
                                                kind: 'disable-rule',
                                                summary: `Regel „${selected.name}" deaktivieren`,
                                                before: selected,
                                            });
                                        }}
                                    >
                                        Deaktivieren
                                    </button>
                                    <button
                                        type="button"
                                        className="button button-quiet"
                                        onClick={() => {
                                            log('info', 'rule.stage-delete', { ruleId: selected.id });
                                            stage({
                                                id: `delete-${selected.id}`,
                                                kind: 'delete-rule',
                                                summary: `Regel „${selected.name}" löschen`,
                                                before: selected,
                                            });
                                        }}
                                    >
                                        Löschen
                                    </button>
                                </div>
                            )}
                        </>
                    )}
                </div>
            </div>
        </>
    );
}

/**
 * The findings about a stored rule, above its editor.
 *
 * Kept out of the editor itself because they are about the rule *as saved* — a verdict of
 * "wirkungslos" describes what is running at Proton right now, not what the draft would do.
 */
function RuleNotices({
    report,
    shadowed,
    target,
    onFolderClick,
}: {
    report: { verdict: string; explanation: string } | undefined;
    shadowed: boolean;
    target: string;
    onFolderClick: (folder: string) => void;
}): React.JSX.Element {
    return (
        <>
            {report !== undefined && report.verdict !== 'active' && (
                <p
                    className={
                        report.verdict === 'always-overridden' ? 'notice notice-danger' : 'notice notice-warning'
                    }
                >
                    {report.explanation}
                </p>
            )}

            {shadowed && (
                <p className="notice notice-warning">
                    „{target}" doppelt einen Proton-Systemordner. Mail, die hier landet, liegt nicht
                    dort, wo Proton sie erwartet.{' '}
                    <button type="button" className="value-chip value-chip-link" onClick={() => onFolderClick(target)}>
                        Ordner ansehen
                    </button>
                </p>
            )}
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

/**
 * How a rule is doing, in one word.
 *
 * „wirkungslos" is the finding Proton's own filter list cannot show: the rule matches plenty of
 * mail and never decides where any of it goes, because a later rule files it again.
 */
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
