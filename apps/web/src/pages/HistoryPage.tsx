import { useState } from 'react';

import { describeChange } from '@pms/changes';

import { useMailboxStatus, useReloadMailbox } from '../mailbox.js';
import { useStore } from '../store.js';
import { ActivityLog } from '../components/ActivityLog.js';
import { Info } from '../components/Info.js';

/**
 * What was changed at the account, and what the tool was doing.
 *
 * Two questions on one screen, in that order, because they were two screens and the second kept
 * being read as an answer to the first. „Verlauf" listed changes and „Protokoll" listed events, and
 * against a real mailbox the first was permanently empty — the write path built a correct entry and
 * the process that called it threw it away, so the only thing that ever filled up was the demo.
 *
 * They stay distinct sections rather than one merged list. The upper one is what happened *at
 * Proton*, read back from the local database and surviving a restart. The lower one is what
 * happened *in this tab* — the only trace there is when an offer never arrived at the server at
 * all, which is exactly the failure the upper list cannot describe.
 *
 * Undo here is the full one: it removes the rule *and* moves back exactly the messages that rule
 * moved — not everything currently in the folder, which would swallow mail filed there by hand
 * afterwards. That precision is why the record keeps a per-message snapshot instead of a
 * description of the change.
 */
export function HistoryPage(): React.JSX.Element {
    const { journal, undo, stageUndo, stageRewind } = useStore();
    const { source, history, historyLimit } = useMailboxStatus();
    const reload = useReloadMailbox();
    const [clearing, setClearing] = useState(false);
    const [clearError, setClearError] = useState<string | undefined>();

    // The demo has no account to have changed, so it shows its own local record; everything else
    // reads what actually reached Proton.
    const entries =
        source === 'demo'
            ? journal.map((entry) => ({
                  id: entry.id,
                  at: entry.atSeconds * 1000,
                  summary: describeChange(entry.change),
                  confirmed: entry.verification?.confirmed,
                  stragglers: entry.verification?.stragglers.length,
                  undoneAt: entry.undoneAtSeconds === undefined ? undefined : entry.undoneAtSeconds * 1000,
                  backupPath: undefined as string | undefined,
                  undoable: entry.undoneAtSeconds === undefined,
                  moved: entry.moved.length,
                  snapshot: entry.moved,
                  take: () => {
                      undo(entry.id);
                  },
              }))
            : history.map((entry) => ({
                  id: entry.id,
                  at: entry.atSeconds * 1000,
                  summary: entry.summary,
                  confirmed: entry.verification?.confirmed,
                  stragglers: entry.verification?.stragglers,
                  undoneAt: entry.undoneAtSeconds === undefined ? undefined : entry.undoneAtSeconds * 1000,
                  backupPath: entry.backupPath,
                  // An undo is not itself undoable. Redoing is a different act from reversing, it
                  // needs its own diff, and offering it here would let two entries in the record
                  // disagree about what the account looks like.
                  undoable: entry.undoneAtSeconds === undefined && entry.undoesId === undefined,
                  moved: entry.moved.length,
                  snapshot: entry.moved,
                  take: () => {
                      stageUndo({ id: entry.id, summary: entry.summary, moved: entry.moved });
                  },
              }));

    return (
        <>
            <header className="page-head">
                <h1>Verlauf</h1>
                <p>
                    Oben, was dieses Werkzeug am Konto geändert hat — aus der lokalen Kopie gelesen,
                    übersteht also einen Neustart. Jede Änderung lässt sich einzeln zurücknehmen,
                    inklusive der Mails, die sie verschoben hat, und vor jedem Schreibzugriff liegt
                    eine vollständige Sicherung aller Filter und Ordner. Unten, was das Werkzeug in
                    diesem Tab getan hat; das ist die einzige Spur, wenn eine Änderung den Server gar
                    nicht erst erreicht.
                </p>
            </header>

            <div className="head-row">
                <h2>Was geändert wurde</h2>

                {/*
                 * Forgetting the record, and what that costs.
                 *
                 * Undo works from this list, so an entry that is gone is a change this tool can no
                 * longer reverse. That is said on the confirmation rather than in a paragraph above
                 * it — it is one consequence, and it only matters at the moment of deciding.
                 *
                 * Not in a card of its own: a card is for a thing, and this is an action on the
                 * list below it.
                 */}
                {source !== 'demo' && history.length > 0 && !clearing && (
                    <div className="row">
                        <Info label="Was der Verlauf enthält">
                            {historyLimit === undefined
                                ? 'Der Verlauf liegt in der verschlüsselten lokalen Kopie.'
                                : `Der Verlauf behält die letzten ${String(historyLimit)} Änderungen; ältere fallen von selbst heraus.`}{' '}
                            Er enthält pro Änderung die Mail-IDs, die sie bewegt hat — genau so viel,
                            wie zum Zurücknehmen nötig ist, und keinen Betreff und keine Adresse.
                        </Info>
                        <button
                            type="button"
                            className="button button-danger-quiet"
                            onClick={() => {
                                setClearError(undefined);
                                setClearing(true);
                            }}
                        >
                            Verlauf löschen
                        </button>
                    </div>
                )}
            </div>

            {clearError !== undefined && <p className="notice notice-danger">{clearError}</p>}

            {clearing && (
                <>
                    <p className="notice notice-danger">
                        <strong>Verlauf löschen?</strong> Danach lässt sich keine dieser Änderungen
                        mehr rückgängig machen — dafür wird genau diese Liste gebraucht. Die
                        Sicherungen unter <code>data/backups</code> bleiben liegen.
                    </p>
                    <div className="row">
                        <button
                            type="button"
                            className="button button-danger"
                            onClick={() => {
                                void clear();
                            }}
                        >
                            Ja, Verlauf löschen
                        </button>
                        <button
                            type="button"
                            className="button button-quiet"
                            onClick={() => {
                                setClearing(false);
                            }}
                        >
                            Abbrechen
                        </button>
                    </div>
                </>
            )}

            {entries.length === 0 && (
                <p className="muted">
                    {source === 'demo'
                        ? 'Noch nichts geändert. Was du bestätigst, erscheint hier.'
                        : 'Noch nichts geändert — oder die Kopie stammt von vor der Einführung dieses Verlaufs. Ältere Änderungen wurden nicht aufgezeichnet und lassen sich deshalb auch nicht zurücknehmen; die Sicherungen unter data/backups liegen aber alle noch.'}
                </p>
            )}

            {entries.map((entry, index) => (
                <div className="card" key={entry.id}>
                    <div className="card-head">
                        <div className="stack">
                            <div className="row">
                                <strong>{entry.summary}</strong>
                                {entry.undoneAt !== undefined && (
                                    <span className="badge badge-neutral">rückgängig gemacht</span>
                                )}
                            </div>
                            <span className="faint">
                                {new Date(entry.at).toLocaleString('de-CH')}
                                {entry.moved > 0 && ` · ${String(entry.moved)} Mails betroffen`}
                            </span>
                        </div>

                        {entry.undoable && (
                            <div className="row">
                                <button type="button" className="button button-secondary" onClick={entry.take}>
                                    Rückgängig
                                </button>
                                {/*
                                 * Only where there is something above it to take back as well.
                                 * On the newest entry a rewind is the same act as the undo beside
                                 * it, and two buttons doing one thing is a choice nobody needs.
                                 */}
                                {index > 0 && source !== 'demo' && (
                                    <button
                                        type="button"
                                        className="button button-quiet"
                                        onClick={() => {
                                            stageRewind(
                                                entries
                                                    .slice(0, index + 1)
                                                    .filter((candidate) => candidate.undoable)
                                                    .map((candidate) => ({
                                                        id: candidate.id,
                                                        summary: candidate.summary,
                                                        moved: candidate.snapshot,
                                                    }))
                                            );
                                        }}
                                    >
                                        Bis hierhin zurück ({index + 1})
                                    </button>
                                )}
                            </div>
                        )}
                    </div>

                    {entry.undoable && entry.moved > 0 && (
                        <p className="faint">
                            Rückgängig nimmt die Regel zurück und holt genau diese {entry.moved} Mails
                            dorthin, wo sie vorher lagen — jede einzeln, keine anderen. Eine Mail, die
                            du seither von Hand einsortiert hast, bleibt liegen.
                        </p>
                    )}

                    {entry.confirmed !== undefined && entry.stragglers !== undefined && (
                        <p className={entry.stragglers === 0 ? 'notice notice-info' : 'notice notice-danger'}>
                            {entry.stragglers === 0
                                ? `Nachgeprüft: alle ${String(entry.confirmed)} Mails sind tatsächlich verschoben.`
                                : `Nachgeprüft: nur ${String(entry.confirmed)} von ${String(
                                      entry.confirmed + entry.stragglers
                                  )} Mails sind verschoben. ${String(entry.stragglers)} liegen noch, wo sie waren.`}
                        </p>
                    )}

                    {entry.backupPath !== undefined && (
                        <p className="faint">
                            Sicherung vor dieser Änderung: <code>{entry.backupPath}</code>
                        </p>
                    )}
                </div>
            ))}

            <h2 style={{ marginTop: 28 }}>Was das Werkzeug getan hat</h2>
            <ActivityLog />
        </>
    );

    async function clear(): Promise<void> {
        try {
            const response = await fetch('/api/history/clear', { method: 'POST' });
            if (!response.ok) {
                const body = (await response.json()) as { error?: string };
                setClearError(body.error ?? `Der Server antwortete mit ${String(response.status)}.`);
                return;
            }
            setClearing(false);
            // The list on screen comes from the snapshot, so it has to be fetched again — otherwise
            // the rows stay until something else happens to reload, which reads as a failed click.
            reload();
        } catch {
            setClearError('Der lokale Server ist nicht erreichbar. Läuft `pnpm serve`?');
        }
    }
}
