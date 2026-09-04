import { useEffect, useRef, useState } from 'react';

import type { MailboxFolder } from '@pms/server/types';

import { useMailbox } from '../mailbox.js';

/**
 * Renaming a folder, in the application rather than in a browser prompt.
 *
 * `window.prompt` was doing this before, and it was the wrong tool twice over. It cannot show what
 * the rename will drag along — Proton stores a filter's destination as a *name*, so every rule
 * pointing at this folder has to be rewritten or it files into nothing — and it is a modal the page
 * cannot style, cannot explain and cannot put a warning in.
 *
 * The consequences are shown here rather than only in the diff afterwards, because this is where
 * the name is still being chosen. The diff is the last chance to notice; this is the first.
 */
export function FolderRenameDialog({
    folder,
    onRename,
    onClose,
}: {
    folder: MailboxFolder;
    onRename: (nextName: string) => void;
    onClose: () => void;
}): React.JSX.Element {
    const { folders, rulesTargeting, messageCountIn } = useMailbox();
    const [name, setName] = useState(folder.Name);
    const input = useRef<HTMLInputElement>(null);

    useEffect(() => {
        input.current?.focus();
        input.current?.select();
    }, []);

    // Escape closes, like every other overlay in the app. A dialog that traps you is worse than
    // the prompt it replaced.
    useEffect(() => {
        const onKey = (event: KeyboardEvent): void => {
            if (event.key === 'Escape') {
                onClose();
            }
        };
        window.addEventListener('keydown', onKey);
        return () => {
            window.removeEventListener('keydown', onKey);
        };
    }, [onClose]);

    const trimmed = name.trim();
    const referencing = rulesTargeting(folder.Name);
    const mails = messageCountIn(folder.Name);
    const taken = folders.some(
        (entry) => entry.ID !== folder.ID && entry.Name.toLowerCase() === trimmed.toLowerCase()
    );
    const unchanged = trimmed === folder.Name;
    const blocked = trimmed === '' || taken || unchanged;

    return (
        <div className="overlay" role="dialog" aria-modal="true" aria-label="Ordner umbenennen">
            <div className="viewer">
                <header className="viewer-head">
                    <div className="stack">
                        <h2>Ordner „{folder.Name}" umbenennen</h2>
                        <span className="faint">
                            {mails} {mails === 1 ? 'Mail' : 'Mails'} liegen darin.
                        </span>
                    </div>
                    <button type="button" className="button button-quiet" onClick={onClose}>
                        Abbrechen
                    </button>
                </header>

                <label className="field">
                    <span>Neuer Name</span>
                    <input
                        ref={input}
                        type="text"
                        className="text-input"
                        value={name}
                        onChange={(event) => setName(event.target.value)}
                        onKeyDown={(event) => {
                            if (event.key === 'Enter' && !blocked) {
                                onRename(trimmed);
                            }
                        }}
                    />
                </label>

                {taken && (
                    <p className="notice notice-danger">
                        Einen Ordner „{trimmed}" gibt es schon. Zwei gleich benannte Ordner wären in
                        jeder Regel nicht auseinanderzuhalten.
                    </p>
                )}

                {/*
                 * The part the prompt could never say. Proton keeps a filter's destination as a
                 * name, so a rename that does not carry the rules along leaves each of them filing
                 * into a folder that no longer exists — the rule still runs, the mail still leaves
                 * the inbox, and it arrives nowhere. Proton neither checks this nor warns about it.
                 */}
                {referencing.length > 0 && (
                    <div className="notice notice-warning">
                        <strong>
                            {referencing.length}{' '}
                            {referencing.length === 1 ? 'Regel zeigt' : 'Regeln zeigen'} auf diesen
                            Ordner.
                        </strong>{' '}
                        Sie {referencing.length === 1 ? 'wird' : 'werden'} beim Umbenennen
                        mitgezogen — sonst sortieren sie danach ins Leere.
                        <ul style={{ margin: '8px 0 0', paddingLeft: 18 }}>
                            {referencing.slice(0, 6).map((rule) => (
                                <li key={rule.id}>{rule.name}</li>
                            ))}
                        </ul>
                    </div>
                )}

                <div className="row" style={{ marginTop: 18 }}>
                    <button
                        type="button"
                        className="button"
                        disabled={blocked}
                        onClick={() => {
                            onRename(trimmed);
                        }}
                    >
                        {unchanged ? 'Neuen Namen eingeben' : `In „${trimmed}" umbenennen`}
                    </button>
                    <button type="button" className="button button-secondary" onClick={onClose}>
                        Abbrechen
                    </button>
                </div>

                <p className="faint" style={{ marginTop: 8 }}>
                    Vormerken schreibt nichts. Danach kommt der Diff mit allem, was sich dadurch
                    ändert.
                </p>
            </div>
        </div>
    );
}
