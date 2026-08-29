import { ProtonSchemaError } from '@pms/core/errors';
import { describe, expect, it } from 'vitest';

import { filtersResponseSchema, labelsResponseSchema, messagesResponseSchema } from '../src/schemas.js';
import { parseResponse } from '../src/validate.js';

/**
 * Fail-fast, tested.
 *
 * The whole point of validating Proton's responses is that a change on their side stops us at the
 * boundary with a named field, rather than travelling inward as an `undefined`. These tests
 * deliberately corrupt otherwise-valid responses to prove that actually happens — and that the
 * error names the right field, because an error that only says "something changed" is barely
 * better than the crash it replaced.
 */

const validFilters = {
    Code: 1000,
    Filters: [
        {
            ID: 'abc',
            Name: 'Security',
            Status: 1,
            Priority: 1,
            Version: 2,
            Sieve: 'require ["fileinto"];',
            Tree: [],
        },
    ],
};

const validMessages = {
    Code: 1000,
    Total: 1,
    Messages: [
        {
            ID: 'msg1',
            Subject: 'Neue Anmeldung',
            Sender: { Address: 'no-reply@accounts.google.com', Name: 'Google' },
            ToList: [{ Address: 'me@example.com' }],
            Time: 1_700_000_000,
            LabelIDs: ['0'],
            Unread: 1,
        },
    ],
};

describe('response validation', () => {
    it('accepts a well-formed response', () => {
        expect(() => parseResponse(filtersResponseSchema, validFilters, 'GET mail/v4/filters')).not.toThrow();
        expect(() => parseResponse(messagesResponseSchema, validMessages, 'GET mail/v4/messages')).not.toThrow();
    });

    it('tolerates fields Proton adds', () => {
        const withExtra = {
            ...validFilters,
            SomethingNew: true,
            Filters: [{ ...validFilters.Filters[0], AlsoNew: 'x' }],
        };
        expect(() => parseResponse(filtersResponseSchema, withExtra, 'GET mail/v4/filters')).not.toThrow();
    });

    it('refuses a response that lost a field we depend on', () => {
        const { Status: _removed, ...withoutStatus } = validFilters.Filters[0]!;
        const corrupted = { ...validFilters, Filters: [withoutStatus] };

        expect(() => parseResponse(filtersResponseSchema, corrupted, 'GET mail/v4/filters')).toThrow(
            ProtonSchemaError
        );
    });

    it('names the endpoint and the exact path that changed', () => {
        const corrupted = { ...validFilters, Filters: [{ ...validFilters.Filters[0], Status: 'enabled' }] };

        try {
            parseResponse(filtersResponseSchema, corrupted, 'GET mail/v4/filters');
            expect.unreachable('should have thrown');
        } catch (error) {
            expect(error).toBeInstanceOf(ProtonSchemaError);
            const detail = (error as ProtonSchemaError).toJSON();
            expect(detail.code).toBe('PROTON_SCHEMA_MISMATCH');
            expect(detail.message).toContain('mail/v4/filters');
            expect(detail.context['issues']).toEqual([
                { path: 'Filters.0.Status', expected: 'number', received: 'string(length 7)' },
            ]);
        }
    });

    it('describes what arrived without quoting it, so mail data stays out of the logs', () => {
        const corrupted = {
            ...validMessages,
            Messages: [{ ...validMessages.Messages[0], Time: 'Betreff der privaten Mail' }],
        };

        try {
            parseResponse(messagesResponseSchema, corrupted, 'GET mail/v4/messages');
            expect.unreachable('should have thrown');
        } catch (error) {
            const serialised = JSON.stringify((error as ProtonSchemaError).toJSON());
            expect(serialised).not.toContain('privaten Mail');
            expect(serialised).toContain('string(length 25)');
        }
    });

    it('reports a changed container type rather than silently yielding nothing', () => {
        const corrupted = { Code: 1000, Labels: { '0': { ID: 'a', Name: 'x', Type: 3 } } };

        try {
            parseResponse(labelsResponseSchema, corrupted, 'GET core/v4/labels');
            expect.unreachable('should have thrown');
        } catch (error) {
            const issues = (error as ProtonSchemaError).toJSON().context['issues'] as Array<{ path: string }>;
            expect(issues[0]?.path).toBe('Labels');
        }
    });
});
