import { useState } from 'react';

import type { MailboxFolder } from '@pms/server/types';

import { FolderRenameDialog } from '../components/FolderRenameDialog.js';
import { log } from '../log.js';
import { useMailbox } from '../mailbox.js';
import { useAppState } from '../state.js';
import { useStore } from '../store.js';

/**
 * The folder tree, with the two facts that make deleting one safe to decide: how much mail lands
 * there, and which rules point at it. Removing a folder that a rule targets leaves the rule
 * pointing at nothing, and Proton will not warn about it.
 */
export function FoldersPage(): React.JSX.Element {
    const { nav } = useAppState();
    const { folders, stage } = useStore();
    const [newName, setNewName] = useState('');
    const [newParent, setNewParent] = useState('');

    const shadowFolders = folders.filter((folder) => folder.shadowsSystemFolder !== undefined);
    const roots = folders.filter((folder) => folder.ParentID === null);
    const childrenOf = (id: string): MailboxFolder[] => folders.filter((folder) => folder.ParentID === id);

    return (
        <>
            <header className="page-head">
                <h1>Ordner</h1>
                <p>
                    {folders.length} Ordner. Vor dem Löschen zeigt das Tool, wie viel Mail dort landet
                    und welche Regeln darauf zeigen — sonst hinterlässt ein Löschen eine Regel, die ins
                    Leere läuft.
                </p>
            </header>

            {shadowFolders.length > 0 && (
                <p className="notice notice-warning">
                    <strong>{shadowFolders.length} Ordner doppeln Proton-Systemordner:</strong>{' '}
                    {shadowFolders.map((folder) => folder.Name).join(', ')}. Typische Überbleibsel einer
                    IMAP-Migration. Mail, die dort landet, liegt nicht dort, wo Proton sie erwartet.
                </p>
            )}

            <div className="card">
                <div className="row" style={{ marginBottom: 12 }}>
                    <input
                        className="text-input"
                        value={newName}
                        placeholder="Neuer Ordner"
                        onChange={(event) => setNewName(event.target.value)}
                    />
                    <select
                        className="text-input"
                        value={newParent}
                        onChange={(event) => setNewParent(event.target.value)}
                    >
                        <option value="">auf oberster Ebene</option>
                        {roots.map((folder) => (
                            <option key={folder.ID} value={folder.ID}>
                                unter „{folder.Name}"
                            </option>
                        ))}
                    </select>
                    <button
                        type="button"
                        className="button"
                        disabled={newName.trim() === ''}
                        onClick={() => {
                            log('info', 'folder.stage-create', { nested: newParent !== '' });
                            stage({
                                id: `create-folder-${newName}`,
                                kind: 'create-folder',
                                folder: {
                                    name: newName.trim(),
                                    parent: newParent === '' ? undefined : newParent,
                                },
                            });
                            setNewName('');
                        }}
                    >
                        Anlegen
                    </button>
                </div>

                <ul className="folder-tree">
                    {roots.map((folder) => (
                        <FolderNode
                            key={folder.ID}
                            folder={folder}
                            childrenOf={childrenOf}
                            highlight={nav.focusFolder}
                        />
                    ))}
                </ul>
            </div>
        </>
    );
}

function FolderNode({
    folder,
    childrenOf,
    highlight,
}: {
    folder: MailboxFolder;
    childrenOf: (id: string) => MailboxFolder[];
    highlight: string | undefined;
}): React.JSX.Element {
    const { messageCountIn, rulesTargeting } = useMailbox();
    const { goTo } = useAppState();
    const { stage } = useStore();
    const children = childrenOf(folder.ID);
    const count = messageCountIn(folder.Name);
    const referencing = rulesTargeting(folder.Name);
    const isHighlighted = highlight === folder.Name || highlight?.endsWith(`/${folder.Name}`) === true;
    const [renaming, setRenaming] = useState(false);

    return (
        <li>
            <div className={isHighlighted ? 'folder-row highlighted' : 'folder-row'}>
                <span className="folder-name">{folder.Name}</span>

                {folder.shadowsSystemFolder !== undefined && (
                    <span className="badge badge-warning">doppelt „{folder.shadowsSystemFolder}"</span>
                )}
                {count > 0 && <span className="nav-count">{count} Mails</span>}

                <button
                    type="button"
                    className="button button-quiet"
                    onClick={() => {
                        setRenaming(true);
                    }}
                >
                    Umbenennen
                </button>
                <button
                    type="button"
                    className="button button-quiet"
                    onClick={() => {
                        log('warn', 'folder.stage-delete', {
                            rules: referencing.length,
                            mails: count,
                        });
                        stage({
                            id: `delete-${folder.ID}`,
                            kind: 'delete-folder',
                            folder: { name: folder.Name },
                        });
                    }}
                >
                    Löschen
                </button>
            </div>

            {renaming && (
                <FolderRenameDialog
                    folder={folder}
                    onClose={() => {
                        setRenaming(false);
                    }}
                    onRename={(nextName) => {
                        setRenaming(false);
                        log('info', 'folder.stage-rename', { rules: referencing.length });
                        // Renaming rewrites every rule that points at the folder. Leaving them
                        // behind would be silent breakage: the rule keeps running and files into a
                        // folder that no longer exists.
                        stage({
                            id: `rename-${folder.ID}`,
                            kind: 'rename-folder',
                            folder: { name: folder.Name, newName: nextName },
                        });
                    }}
                />
            )}

            {/*
             * The rules pointing here, named and clickable. A folder is only safe to delete or
             * rename once you can see what depends on it — Proton will not tell you, and a rule left
             * pointing at a folder that no longer exists fails silently.
             */}
            {referencing.length > 0 && (
                <div className="folder-rules">
                    <span className="faint">Regeln, die hierher sortieren:</span>
                    {referencing.map((entry) => (
                        <button
                            type="button"
                            key={entry.id}
                            className="value-chip value-chip-link"
                            onClick={() => goTo({ page: 'rules', focusRuleId: entry.id })}
                        >
                            {entry.name}
                        </button>
                    ))}
                </div>
            )}

            {children.length > 0 && (
                <ul>
                    {children.map((child) => (
                        <FolderNode
                            key={child.ID}
                            folder={child}
                            childrenOf={childrenOf}
                            highlight={highlight}
                        />
                    ))}
                </ul>
            )}
        </li>
    );
}
