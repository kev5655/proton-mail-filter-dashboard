/**
 * A compact list of messages: enough to recognise them, not enough to read them.
 *
 * Typed by what it reads rather than by any one message type, so it works for both a grouped
 * message and a full one without either side widening to accommodate the component.
 */
export interface ListableMessage {
    ID: string;
    Subject: string;
    Sender: { Address: string };
    Time: number;
}

export function MailList({ messages }: { messages: ListableMessage[] }): React.JSX.Element {
    if (messages.length === 0) {
        return <p className="faint">Keine Mails im erfassten Zeitraum.</p>;
    }

    return (
        <ul className="mail-list">
            {messages.map((message) => (
                <li key={message.ID}>
                    <span className="stack">
                        <span className="mail-subject">{message.Subject}</span>
                        <span className="mail-sender">{message.Sender.Address}</span>
                    </span>
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
