import { useAppState } from '../state.js';
import { useMailFilter, type SearchTerms } from './useMailFilter.js';

/**
 * A compact list of messages: enough to recognise them, not enough to read them.
 *
 * Typed by what it reads rather than by any one message type, so it works for both a grouped
 * message and a full one without either side widening to accommodate the component.
 *
 * Every list is both a way into a message and a way to select it. Selection is global, so mail
 * picked here can be combined with mail picked on another screen — the manual path exists precisely
 * for cases the grouping did not catch, and those rarely sit in one place.
 *
 * Searching and paging live here rather than in each caller. They had all been slicing — eight
 * matched messages on the rules page, five in a suggestion, twelve in the selection dialog — and a
 * truncated list with no count reads as the whole answer. The component that renders mail is the
 * one place where "there are more of these" can be said once and be true everywhere.
 */
export interface ListableMessage {
    ID: string;
    Subject: string;
    Sender: { Address: string };
    Time: number;
}

/** A short note per row: which rule already catches it, which one overrides it afterwards. */
export interface MailNote {
    text: string;
    tone: 'neutral' | 'accent' | 'warning';
    /** The full sentence, when the badge has to be short. */
    title?: string | undefined;
}

export function MailList({
    messages,
    onOpen,
    selectable = true,
    search = false,
    searchPlaceholder = 'Betreff, Absender, Empfänger …',
    pageSize,
    selectAll = false,
    emptyText = 'Keine Mails im erfassten Zeitraum.',
    annotate,
    terms,
    linkFor,
}: {
    messages: ListableMessage[];
    onOpen: (message: ListableMessage) => void;
    selectable?: boolean;
    search?: boolean;
    searchPlaceholder?: string;
    /** Undefined renders everything, which is right for a short list and wrong for a mailbox. */
    pageSize?: number | undefined;
    selectAll?: boolean;
    emptyText?: string;
    annotate?: ((message: ListableMessage) => MailNote | undefined) | undefined;
    /** Extra searchable text — the destination folder, Proton's category. */
    terms?: SearchTerms | undefined;
    /** A link that opens this message at Proton. Absent for the demo, whose mail does not exist. */
    linkFor?: ((message: ListableMessage) => string) | undefined;
}): React.JSX.Element {
    const { isSelected, toggleSelection, selectMany } = useAppState();
    const filter = useMailFilter(messages, { pageSize, terms });

    if (messages.length === 0) {
        return <p className="faint">{emptyText}</p>;
    }

    const showingRange =
        pageSize === undefined || filter.matches.length <= pageSize
            ? undefined
            : `${filter.page * pageSize + 1}–${Math.min((filter.page + 1) * pageSize, filter.matches.length)}`;

    return (
        <div className="mail-list-block">
            {(search || selectAll) && (
                <div className="mail-list-tools">
                    {search && (
                        <input
                            type="search"
                            className="text-input mail-search"
                            value={filter.query}
                            placeholder={searchPlaceholder}
                            onChange={(event) => filter.setQuery(event.target.value)}
                            aria-label="Mails durchsuchen"
                        />
                    )}
                    <span className="faint">
                        {filter.query === ''
                            ? `${filter.total} ${filter.total === 1 ? 'Mail' : 'Mails'}`
                            : `${filter.matches.length} von ${filter.total}`}
                        {showingRange === undefined ? '' : ` · zeigt ${showingRange}`}
                    </span>
                    <span style={{ flex: 1 }} />
                    {selectAll && filter.matches.length > 0 && (
                        // Selects the filtered set, and says so. "Alle auswählen" over a list
                        // showing ten of two hundred was the old lie in a different place.
                        <button
                            type="button"
                            className="button button-quiet"
                            onClick={() => selectMany(filter.matches)}
                        >
                            {filter.query === ''
                                ? `Alle ${filter.matches.length} auswählen`
                                : `Alle ${filter.matches.length} Treffer auswählen`}
                        </button>
                    )}
                </div>
            )}

            {filter.matches.length === 0 && <p className="faint">Nichts gefunden für „{filter.query}".</p>}

            <ul className="mail-list">
                {filter.visible.map((message) => {
                    const note = annotate?.(message);
                    const href = linkFor?.(message);
                    return (
                        <li key={message.ID} className={isSelected(message.ID) ? 'selected' : undefined}>
                            {selectable && (
                                <input
                                    type="checkbox"
                                    className="mail-check"
                                    checked={isSelected(message.ID)}
                                    onChange={() => toggleSelection(message)}
                                    aria-label={`${message.Subject} auswählen`}
                                />
                            )}
                            <button type="button" className="mail-open" onClick={() => onOpen(message)}>
                                <span className="mail-subject">{message.Subject}</span>
                                <span className="mail-sender">{message.Sender.Address}</span>
                            </button>
                            {note !== undefined && (
                                <span
                                    className={`badge badge-${note.tone}`}
                                    {...(note.title === undefined ? {} : { title: note.title })}
                                >
                                    {note.text}
                                </span>
                            )}
                            <span className="faint mail-date">{formatDate(message.Time)}</span>
                            {href !== undefined && (
                                // noreferrer as well as noopener: Proton should not be told that
                                // the reader arrived from a page on localhost.
                                <a
                                    className="mail-link"
                                    href={href}
                                    target="_blank"
                                    rel="noreferrer noopener"
                                    title="Bei Proton öffnen"
                                    aria-label={`„${message.Subject}" bei Proton öffnen`}
                                >
                                    ↗
                                </a>
                            )}
                        </li>
                    );
                })}
            </ul>

            {filter.pageCount > 1 && (
                <div className="pager">
                    <button
                        type="button"
                        className="button button-quiet"
                        disabled={filter.page === 0}
                        onClick={() => filter.setPage(filter.page - 1)}
                    >
                        ← Zurück
                    </button>
                    <span className="faint">
                        Seite {filter.page + 1} von {filter.pageCount}
                    </span>
                    <button
                        type="button"
                        className="button button-quiet"
                        disabled={filter.page >= filter.pageCount - 1}
                        onClick={() => filter.setPage(filter.page + 1)}
                    >
                        Weiter →
                    </button>
                </div>
            )}
        </div>
    );
}

const FORMATTER = new Intl.DateTimeFormat('de-CH', { day: '2-digit', month: 'short', year: 'numeric' });

function formatDate(unixSeconds: number): string {
    return FORMATTER.format(new Date(unixSeconds * 1000));
}
