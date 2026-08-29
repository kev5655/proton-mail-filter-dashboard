import type { DemoFolder } from '@pms/demo';

import { folders, messageCountIn, rulesTargeting, shadowFolders } from '../data.js';
import { useAppState } from '../state.js';

/**
 * The folder tree, with the two facts that make deleting one safe to decide: how much mail lands
 * there, and which rules point at it. Removing a folder that a rule targets leaves the rule
 * pointing at nothing, and Proton will not warn about it.
 */
export function FoldersPage(): React.JSX.Element {
    const { nav } = useAppState();
    const roots = folders.filter((folder) => folder.ParentID === null);
    const childrenOf = (id: string): DemoFolder[] => folders.filter((folder) => folder.ParentID === id);

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
    folder: DemoFolder;
    childrenOf: (id: string) => DemoFolder[];
    highlight: string | undefined;
}): React.JSX.Element {
    const { goTo } = useAppState();
    const children = childrenOf(folder.ID);
    const count = messageCountIn(folder.Name);
    const referencing = rulesTargeting(folder.Name);
    const isHighlighted = highlight === folder.Name || highlight?.endsWith(`/${folder.Name}`) === true;

    return (
        <li>
            <div className={isHighlighted ? 'folder-row highlighted' : 'folder-row'}>
                <span className="folder-name">{folder.Name}</span>

                {folder.shadowsSystemFolder !== undefined && (
                    <span className="badge badge-warning">doppelt „{folder.shadowsSystemFolder}"</span>
                )}
                {count > 0 && <span className="nav-count">{count} Mails</span>}

                <button type="button" className="button button-quiet">
                    Umbenennen
                </button>
                <button type="button" className="button button-quiet">
                    Löschen
                </button>
            </div>

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
