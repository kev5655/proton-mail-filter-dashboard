import { useState } from 'react';

import { CATEGORY_IDS, CATEGORY_LABELS } from '@pms/grouping';

import { useMailbox } from '../mailbox.js';
import { useStore } from '../store.js';
import type { ListableMessage } from './MailList.js';

/**
 * Moving selected mail into one of Proton's categories.
 *
 * The only place in the dashboard that asks for mail to be moved, and it is worth being clear about
 * why it exists at all. A category is not a folder: no filter can file into one, so the ordinary
 * route — write a rule, let Proton sort — is closed. Proton's own client moves the mail and the
 * server draws its own conclusion about the sender, and this is the same gesture from here.
 *
 * It stages a change like everything else. There is no shortcut: the diff lists the messages, the
 * terminal asks, and only then does anything move. `weigh()` makes the terminal question
 * unconditional for this kind — including for a single mail — because this is the one change that
 * touches somebody's mail rather than the rules about it.
 *
 * What the screen does *not* say is as deliberate as what it does. Whether Proton then sorts future
 * mail from that sender the same way is the premise of the whole feature and has never been
 * watched happen; it is offered as an expectation, not stated as a result.
 */
export function CategoryMoveDialog({
    selection,
    onClose,
}: {
    selection: ListableMessage[];
    onClose: () => void;
}): React.JSX.Element {
    const { categoryCoverage, autoRuleFor } = useMailbox();
    const { stageCategoryMove } = useStore();
    const [chosen, setChosen] = useState<string | undefined>(undefined);

    const ids = selection.map((message) => message.ID);
    const coverage = categoryCoverage(ids);
    const senders = [...new Set(selection.map((message) => message.Sender.Address))];

    return (
        <div className="overlay" role="dialog" aria-modal="true" aria-label="In Kategorie verschieben">
            <div className="viewer">
                <header className="viewer-head">
                    <div className="stack">
                        <h2>
                            {selection.length} {selection.length === 1 ? 'Mail' : 'Mails'} in eine
                            Kategorie verschieben
                        </h2>
                        <span className="faint">
                            {senders.slice(0, 3).join(', ')}
                            {senders.length > 3 && ' …'}
                        </span>
                    </div>
                    <button type="button" className="button button-quiet" onClick={onClose}>
                        Abbrechen
                    </button>
                </header>

                <p className="faint">
                    Kategorien sind Protons eigene Sortierung. Es gibt dafür keinen Filter — Proton
                    lernt aus dem Verschieben selbst, und dies ist derselbe Handgriff wie in Protons
                    App. Verschoben werden genau diese {selection.length}{' '}
                    {selection.length === 1 ? 'Mail' : 'Mails'} und keine weiteren.
                </p>

                {coverage.length > 0 && (
                    <p className="notice notice-info">
                        <strong>
                            Proton hat {coverage[0]?.count} davon schon in „{coverage[0]?.label}".
                        </strong>{' '}
                        {coverage[0]?.stable
                            ? 'Bei diesen Absendern jedes Mal, seit wir hinsehen — dorthin verschieben ändert nichts.'
                            : 'Bisher einmal beobachtet.'}
                    </p>
                )}

                <h3 style={{ marginTop: 16 }}>Wohin</h3>
                <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
                    {CATEGORY_IDS.map((id) => (
                        <button
                            key={id}
                            type="button"
                            className={chosen === id ? 'button' : 'button button-quiet'}
                            aria-pressed={chosen === id}
                            onClick={() => setChosen(id)}
                        >
                            {CATEGORY_LABELS[id]}
                        </button>
                    ))}
                </div>

                {/*
                 * The two things we cannot answer, said here rather than discovered afterwards.
                 * Proton's own client sends one request and no `unlabel`, which suggests the old
                 * category falls away — suggests. Nothing in this project has watched it happen.
                 */}
                <p className="notice notice-warning" style={{ marginTop: 16 }}>
                    <strong>Zwei Dinge sind ungeprüft.</strong> Ob die bisherige Kategorie dabei von
                    selbst wegfällt, und ob Proton danach künftige Mail dieser Absender gleich
                    einsortiert. Das Zweite ist der Sinn der Sache und lässt sich nur über mehrere
                    Tage und mehrere Synchronisationen beobachten — auf „Auto-Regeln".
                </p>

                {chosen !== undefined && senderNotice(chosen, senders, autoRuleFor)}

                <div className="row" style={{ marginTop: 18 }}>
                    <button
                        type="button"
                        className="button"
                        disabled={chosen === undefined}
                        onClick={() => {
                            if (chosen === undefined) {
                                return;
                            }
                            stageCategoryMove(chosen, ids);
                            onClose();
                        }}
                    >
                        {chosen === undefined
                            ? 'Kategorie wählen'
                            : `Nach „${CATEGORY_LABELS[chosen]}" vormerken`}
                    </button>
                    <button type="button" className="button button-secondary" onClick={onClose}>
                        Abbrechen
                    </button>
                </div>

                <p className="faint" style={{ marginTop: 8 }}>
                    Vormerken schreibt nichts. Danach kommt der Diff, und die Rückfrage im Terminal —
                    bei dieser Art Änderung immer, auch bei einer einzelnen Mail.
                </p>
            </div>
        </div>
    );
}

/**
 * Where the chosen category contradicts what Proton has been observed doing.
 *
 * Not a warning against the move — a person re-sorting their own mail is exactly the mechanism this
 * dialog exists to use. It is there so the disagreement is visible before the fact rather than
 * puzzling afterwards, when the mail lands somewhere and the „Auto-Regeln" screen says something
 * else.
 */
function senderNotice(
    categoryId: string,
    senders: string[],
    autoRuleFor: (address: string) => { verdict: { kind: string; categoryId?: string } } | undefined
): React.JSX.Element | null {
    const contradicting = senders.filter((address) => {
        const verdict = autoRuleFor(address)?.verdict;
        return verdict?.kind === 'stable' && verdict.categoryId !== categoryId;
    });

    if (contradicting.length === 0) {
        return null;
    }

    return (
        <p className="notice notice-info">
            Bei {contradicting.length}{' '}
            {contradicting.length === 1 ? 'Absender' : 'Absendern'} sortiert Proton bisher
            durchgehend anders. Genau dafür ist das Verschieben da — es ist der einzige Weg, Proton
            etwas anderes beizubringen.
        </p>
    );
}
