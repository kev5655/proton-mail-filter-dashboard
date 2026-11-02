import { describe, expect, it } from 'vitest';

import { protonMailUrl, protonSearchUrl } from '../src/proton-link.js';

/**
 * Links into Proton's own interface.
 *
 * The URL shape is a guess — nothing in this repository or in Proton's vendored code documents it,
 * and it was read off a browser's address bar. These tests therefore pin the *properties* that
 * matter whatever the shape turns out to be: the account index is respected, values are escaped,
 * and a message we cannot address directly falls back to something that still lands somewhere real
 * rather than to a confidently malformed link.
 */

describe('a link to one message', () => {
    it('prefers the conversation, because that is what Proton displays', () => {
        const url = protonMailUrl({ ID: 'msg-1', Subject: 'Rechnung', ConversationID: 'conv-9' });

        expect(url).toContain('conv-9');
        expect(url).not.toContain('msg-1');
    });

    it('falls back to the message id when there is no conversation', () => {
        expect(protonMailUrl({ ID: 'msg-1', Subject: 'Rechnung' })).toContain('msg-1');
    });

    it('honours the account index, which is the browser’s ordinal and not ours to assume', () => {
        expect(protonMailUrl({ ID: 'a', Subject: 'b' }, { host: 'mail.proton.me', account: 2 })).toContain('/u/2/');
    });

    it('never emits a negative or fractional account index', () => {
        expect(protonMailUrl({ ID: 'a', Subject: 'b' }, { host: 'h', account: -3 })).toContain('/u/0/');
        expect(protonMailUrl({ ID: 'a', Subject: 'b' }, { host: 'h', account: 1.7 })).toContain('/u/1/');
    });

    it('escapes an id, so a strange one cannot reshape the path', () => {
        const url = protonMailUrl({ ID: 'a/b?c#d', Subject: 'x' });

        expect(url).toContain('a%2Fb%3Fc%23d');
    });

    it('searches for the subject when there is nothing to address', () => {
        // Better a link that lands in the right mailbox than one that is precisely wrong.
        const url = protonMailUrl({ ID: '', Subject: 'Rechnung März' });

        expect(url).toContain('keyword=Rechnung%20M%C3%A4rz');
    });
});

describe('the search fallback', () => {
    it('escapes the subject', () => {
        expect(protonSearchUrl('a&b=c')).toContain('keyword=a%26b%3Dc');
    });

    it('is https, always', () => {
        expect(protonSearchUrl('x')).toMatch(/^https:\/\//);
    });
});
