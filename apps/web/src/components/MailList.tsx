import { useAppState } from '../state.js';

/**
 * A compact list of messages: enough to recognise them, not enough to read them.
 *
 * Typed by what it reads rather than by any one message type, so it works for both a grouped
 * message and a full one without either side widening to accommodate the component.
 *
 * Every list is both a way into a message and a way to select it. Selection is global, so mail
 * picked here can be combined with mail picked on another screen — the manual path exists precisely
 * for cases the grouping did not catch, and those rarely sit in one place.
 */
export interface ListableMessage {
    ID: string;
    Subject: string;
    Sender: { Address: string };
    Time: number;
}

export function MailList({
    messages,
    onOpen,
    selectable = true,
}: {
    messages: ListableMessage[];
    onOpen: (message: ListableMessage) => void;
    selectable?: boolean;
}): React.JSX.Element {
    const { isSelected, toggleSelection } = useAppState();

    if (messages.length === 0) {
        return <p className="faint">Keine Mails im erfassten Zeitraum.</p>;
    }

    return (
        <ul className="mail-list">
            {messages.map((message) => (
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
                    <span className="faint">{formatDate(message.Time)}</span>
                </li>
            ))}
        </ul>
    );
}

const FORMATTER = new Intl.DateTimeFormat('de-CH', { day: '2-digit', month: 'short', year: 'numeric' });

function formatDate(unixSeconds: number): string {
    return FORMATTER.format(new Date(unixSeconds * 1000));
}
