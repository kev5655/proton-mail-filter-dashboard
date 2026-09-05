// @vitest-environment happy-dom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MailList, type ListableMessage } from '../src/components/MailList.js';
import { Providers } from './harness.js';

/**
 * The list every screen shows mail through.
 *
 * Worth testing interactively rather than as markup, because the things that were wrong were not
 * visual: a list showed eight of two hundred matches with no indication that it had stopped, and
 * a button labelled „Alle auswählen" selected the ten rows on screen. Both look perfectly fine in
 * a screenshot. What they need is a test that counts.
 */

interface TestMessage extends ListableMessage {
    Sender: { Address: string; Name?: string };
    ToList?: Array<{ Address: string }>;
}

function mail(index: number, over: Partial<TestMessage> = {}): TestMessage {
    return {
        ID: `m${index}`,
        Subject: `Betreff ${index}`,
        Sender: { Address: `absender${index}@beispiel.example` },
        Time: 1_700_000_000 + index,
        ...over,
    };
}

let container: HTMLDivElement;

beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
});

/*
 * Unmounted, not merely detached.
 *
 * Removing the container leaves the React root alive with work still scheduled against it. That
 * work runs after Vitest has torn the DOM environment down, and „ReferenceError: window is not
 * defined" then surfaces as an unhandled error attributed to whichever file happened to be running
 * — which is why the failure moved around and only appeared in the full suite.
 */
afterEach(() => {
    act(() => {
        root?.unmount();
    });
    root = undefined;
    container.remove();
});

let root: Root | undefined;

function render(element: React.JSX.Element): void {
    const next = createRoot(container);
    root = next;
    act(() => {
        next.render(<Providers>{element}</Providers>);
    });
}

function type(value: string): void {
    const input = container.querySelector<HTMLInputElement>('input[type="search"]');
    if (input === null) {
        throw new Error('no search box');
    }
    act(() => {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
        setter?.call(input, value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
    });
}

/** Rows carrying a message. Blank rows that only hold the list's height are not mail. */
function rows(): number {
    return container.querySelectorAll('.mail-list li:not(.mail-row-filler)').length;
}

/** Every row box, including the blank ones — this is what decides where the pager sits. */
function rowBoxes(): number {
    return container.querySelectorAll('.mail-list li').length;
}

function click(text: string): void {
    const button = [...container.querySelectorAll('button')].find((entry) =>
        (entry.textContent ?? '').includes(text)
    );
    if (button === undefined) {
        throw new Error(`no button matching ${text}`);
    }
    act(() => {
        button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
}

const many = Array.from({ length: 25 }, (_, index) => mail(index));

describe('paging', () => {
    it('shows one page and says how many there are', () => {
        render(<MailList messages={many} onOpen={() => {}} search pageSize={10} />);

        expect(rows()).toBe(10);
        expect(container.textContent).toContain('25 Mails');
        expect(container.textContent).toContain('Seite 1 von 3');
    });

    it('moves between pages, and the last one is short', () => {
        render(<MailList messages={many} onOpen={() => {}} search pageSize={10} />);

        click('Weiter');
        expect(container.textContent).toContain('Seite 2 von 3');
        click('Weiter');
        expect(rows()).toBe(5);

        click('Zurück');
        expect(container.textContent).toContain('Seite 2 von 3');
    });

    it('keeps the last page as tall as the others, so the pager stays put', () => {
        // The pager sits under the list, so a last page with five of ten rows pulled „Weiter" up
        // by five rows — out from under the cursor that had just been clicking it.
        render(<MailList messages={many} onOpen={() => {}} search pageSize={10} />);

        click('Weiter');
        click('Weiter');

        expect(rows()).toBe(5);
        expect(rowBoxes()).toBe(10);
    });

    it('does not pad a list that has only one page', () => {
        // Nothing to turn to, so nothing to hold still. A short list should end where it ends.
        render(<MailList messages={many.slice(0, 4)} onOpen={() => {}} search pageSize={10} />);

        expect(rowBoxes()).toBe(4);
    });

    it('goes back to the first page when the set of mail changes underneath it', () => {
        // Switching the editor's right column between „nur verwandte" und „alle übrigen" replaces
        // the list wholesale. Staying on page three of a different two hundred messages is not
        // continuity — it is a number that outlived its subject.
        //
        // The list has to stay mounted for this to mean anything: a fresh render starts at page one
        // whatever the hook does, which is how the first version of this test passed while the
        // behaviour it describes was absent.
        let swap = (): void => {};
        function Swappable(): React.JSX.Element {
            const [subset, setSubset] = useState(false);
            swap = () => {
                setSubset(true);
            };
            return (
                <MailList
                    messages={subset ? many.slice(0, 12) : many}
                    onOpen={() => {}}
                    search
                    pageSize={10}
                />
            );
        }

        render(<Swappable />);
        click('Weiter');
        expect(container.textContent).toContain('Seite 2 von 3');

        act(() => {
            swap();
        });

        expect(container.textContent).toContain('Seite 1 von 2');
    });

    it('renders everything when no page size is given', () => {
        render(<MailList messages={many} onOpen={() => {}} />);

        expect(rows()).toBe(25);
        expect(container.querySelector('.pager')).toBeNull();
    });
});

describe('searching', () => {
    it('matches the subject, the sender address and the recipient', () => {
        const messages = [
            mail(1, { Subject: 'Rechnung März' }),
            mail(2, { Sender: { Address: 'noreply@bahn.example' } }),
            mail(3, { ToList: [{ Address: 'team@firma.example' }] }),
        ];
        render(<MailList messages={messages} onOpen={() => {}} search />);

        type('rechnung');
        expect(rows()).toBe(1);

        type('bahn');
        expect(rows()).toBe(1);

        // Recipients are why this matters: a rule can filter on them, and until now the dashboard
        // could not even show them.
        type('team@firma');
        expect(rows()).toBe(1);
    });

    it('reports the filtered count against the total', () => {
        render(<MailList messages={many} onOpen={() => {}} search pageSize={10} />);

        type('Betreff 1');
        // 1, and 10 through 19.
        expect(container.textContent).toContain('11 von 25');
    });

    it('says so when nothing matches, instead of looking empty', () => {
        render(<MailList messages={many} onOpen={() => {}} search />);

        type('gibtesnicht');
        expect(rows()).toBe(0);
        expect(container.textContent).toContain('Nichts gefunden');
    });

    it('returns to the first page when the query changes', () => {
        render(<MailList messages={many} onOpen={() => {}} search pageSize={10} />);

        click('Weiter');
        type('Betreff 2');
        expect(container.textContent).not.toContain('Seite 2');
    });
});

describe('select all', () => {
    it('offers the full count, not the visible page', () => {
        render(<MailList messages={many} onOpen={() => {}} search selectAll pageSize={10} />);

        // The old bug in one assertion: ten rows on screen, twenty-five to select.
        expect(container.textContent).toContain('Alle 25 auswählen');
    });

    it('offers the filtered set once a query narrows it, and says it is a filtered set', () => {
        render(<MailList messages={many} onOpen={() => {}} search selectAll pageSize={10} />);

        type('Betreff 1');
        expect(container.textContent).toContain('Alle 11 Treffer auswählen');
    });

    it('actually selects every match, not the page', () => {
        render(<MailList messages={many} onOpen={() => {}} search selectAll pageSize={10} />);

        click('Alle 25 auswählen');
        expect(container.querySelectorAll('.mail-list li.selected').length).toBe(10);
        // Ten are visible; the selection covers all 25, which the checked page proves only in part.
        // The count in the tools line is the honest witness.
        click('Weiter');
        expect(container.querySelectorAll('.mail-list li.selected').length).toBe(10);
    });
});

describe('extras', () => {
    it('shows a note per row when one is given', () => {
        render(
            <MailList
                messages={[mail(1)]}
                onOpen={() => {}}
                annotate={() => ({ text: 'schon gefangen', tone: 'neutral', title: 'von „X"' })}
            />
        );

        expect(container.textContent).toContain('schon gefangen');
    });

    it('links to Proton only when a link is supplied', () => {
        render(<MailList messages={[mail(1)]} onOpen={() => {}} />);
        expect(container.querySelector('.mail-link')).toBeNull();

        container.replaceChildren();
        render(<MailList messages={[mail(1)]} onOpen={() => {}} linkFor={() => 'https://example.test/x'} />);

        const link = container.querySelector<HTMLAnchorElement>('.mail-link');
        expect(link?.getAttribute('href')).toBe('https://example.test/x');
        // Proton is not told that the reader came from a page on localhost.
        expect(link?.getAttribute('rel')).toContain('noreferrer');
    });

    it('uses the caller’s wording for an empty list', () => {
        render(<MailList messages={[]} onOpen={() => {}} emptyText="Diese Regel trifft nichts." />);

        expect(container.textContent).toContain('Diese Regel trifft nichts.');
    });
});
