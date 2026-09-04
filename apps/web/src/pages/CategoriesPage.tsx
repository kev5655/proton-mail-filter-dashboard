import { useState } from 'react';

import { MailList } from '../components/MailList.js';
import { useMailbox, useMailboxStatus } from '../mailbox.js';
import { useSettings } from '../llm.js';
import { protonMailUrl } from '../proton-link.js';
import { useAppState } from '../state.js';

/**
 * Proton's own categories — the sorting nobody here has to build.
 *
 * Proton files mail into „Soziale Medien", „Werbung", „Newsletter", „Transaktionen" and
 * „Aktualisierungen" by itself, and keeps doing it once a message has been put there. So the useful
 * thing this screen can do is not to offer rules for them. It is to show what Proton is already
 * handling, and then the one fact that *is* actionable: where a rule of the user's own is doing the
 * same work twice.
 *
 * The category ids are unverified — see `CATEGORY_LABELS` in `@pms/grouping`. A label that looks
 * like a category but is not in that map appears here marked unknown rather than being dropped,
 * because the mailbox is the only evidence available for correcting the map.
 */
export function CategoriesPage(): React.JSX.Element {
    const { categories, inboxMessages } = useMailbox();
    const settings = useSettings();
    const { source } = useMailboxStatus();
    const { setOpen, goTo } = useAppState();
    const [openId, setOpenId] = useState<string | undefined>(undefined);

    const linkFor =
        source === 'proton'
            ? (message: { ID: string; Subject: string }) => protonMailUrl(message, settings.proton)
            : undefined;

    const categorised = categories.reduce((total, entry) => total + entry.messages.length, 0);

    return (
        <>
            <header className="page-head">
                <h1>Kategorien</h1>
                <p>
                    Proton sortiert diese Mail selbst — einmal von Hand einsortiert, macht es der
                    Dienst danach automatisch weiter. Dafür braucht es hier keine Regel. Interessant
                    ist die Gegenrichtung: wo eine deiner eigenen Regeln dieselbe Arbeit ein zweites
                    Mal macht.
                </p>
            </header>

            {categories.length === 0 && (
                <p className="muted">
                    In der lokalen Kopie trägt keine Mail eine von Protons Kategorien. Entweder nutzt
                    dein Konto sie nicht, oder sie kommen bei der Synchronisation nicht mit.
                </p>
            )}

            {categories.length > 0 && (
                <p className="faint" style={{ marginBottom: 16 }}>
                    {categorised} Mails in {categories.length}{' '}
                    {categories.length === 1 ? 'Kategorie' : 'Kategorien'}, davon{' '}
                    {categories.reduce((total, entry) => total + entry.inInbox, 0)} noch im
                    Posteingang ({inboxMessages.length} insgesamt).
                </p>
            )}

            {categories.map((entry) => {
                const isOpen = openId === entry.id;
                return (
                    <div className="card" key={entry.id}>
                        <div className="card-head">
                            <div className="stack">
                                <h2>
                                    {entry.label}{' '}
                                    {entry.unknown && (
                                        <span className="badge badge-warning" title={`Label-ID ${entry.id}`}>
                                            unbekannte ID
                                        </span>
                                    )}
                                </h2>
                                <span className="faint">
                                    {entry.messages.length} Mails · {entry.inInbox} noch im Posteingang
                                </span>
                            </div>
                        </div>

                        {entry.unknown && (
                            <p className="notice notice-warning">
                                Diese Mails tragen das Label <code>{entry.id}</code>, das wir nicht
                                zuordnen können. Es wird trotzdem angezeigt — eine Kategorie zu
                                verschweigen wäre schlimmer, als sie unbenannt zu zeigen. Wenn du in
                                Protons Oberfläche siehst, wie sie heisst, sag es mir.
                            </p>
                        )}

                        {entry.alsoMovedByRules.length > 0 && (
                            <div className="notice notice-info">
                                <strong>Hier arbeitet zusätzlich eine eigene Regel.</strong>
                                <ul style={{ margin: '8px 0 0', paddingLeft: 18 }}>
                                    {entry.alsoMovedByRules.map((rule) => (
                                        <li key={rule.ruleId}>
                                            <button
                                                type="button"
                                                className="value-chip value-chip-link"
                                                onClick={() => goTo({ page: 'rules', focusRuleId: rule.ruleId })}
                                            >
                                                {rule.ruleName}
                                            </button>{' '}
                                            verschiebt {rule.count} davon nach „{rule.destination}".
                                        </li>
                                    ))}
                                </ul>
                            </div>
                        )}

                        {entry.topSenders.length > 0 && (
                            <p className="faint" style={{ marginTop: 12 }}>
                                Häufigste Absender:{' '}
                                {entry.topSenders
                                    .map((sender) => `${sender.address} (${String(sender.count)})`)
                                    .join(', ')}
                            </p>
                        )}

                        <div className="row" style={{ marginTop: 12 }}>
                            <button
                                type="button"
                                className="button button-quiet"
                                onClick={() => setOpenId(isOpen ? undefined : entry.id)}
                            >
                                {isOpen ? 'Mails ausblenden' : `${entry.messages.length} Mails ansehen`}
                            </button>
                        </div>

                        {isOpen && (
                            <MailList
                                messages={entry.messages}
                                onOpen={setOpen}
                                search
                                selectAll
                                pageSize={settings.display.pageSize}
                                {...(linkFor === undefined ? {} : { linkFor })}
                            />
                        )}
                    </div>
                );
            })}
        </>
    );
}
