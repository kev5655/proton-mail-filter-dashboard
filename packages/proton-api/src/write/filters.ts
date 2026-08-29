import { AppError } from '@pms/core/errors';
import { getLogger } from '@pms/core/logger';
import { z } from 'zod';

import type { ProtonHttp } from '../http.js';
import { filterSchema, type ProtonFilter } from '../schemas.js';

/**
 * Writing filters to Proton.
 *
 * This file and its siblings are the only place in the project that issues a non-GET request, and
 * `write-isolation.test.ts` enforces that rather than trusting it. Everything here assumes it will
 * be called on a real account with real mail behind it.
 *
 * Two rules hold throughout. Nothing is written without the caller having shown the user a diff and
 * received a click — enforced by the interface, not by this layer, but stated here because this is
 * where it would be violated. And `checkSieve` runs before anything containing Sieve is stored: a
 * filter Proton rejects is an error, but a filter Proton accepts and misreads is a mailbox problem.
 */

const log = getLogger('proton-write');

const filterResponseSchema = z.object({ Code: z.number(), Filter: filterSchema });
const envelopeSchema = z.object({ Code: z.number() });

export interface FilterPayload {
    Name: string;
    /** 0 disabled, 1 enabled. New rules can be created disabled to be checked first. */
    Status: number;
    Version: 1 | 2;
    Simple?: unknown;
    Tree?: unknown;
    Sieve?: string;
}

export async function createFilter(http: ProtonHttp, payload: FilterPayload): Promise<ProtonFilter> {
    await assertSieveAccepted(http, payload);

    const response = await http.request(
        { method: 'POST', path: 'mail/v4/filters', body: payload },
        filterResponseSchema
    );
    log.info({ name: payload.Name, status: payload.Status }, 'filter created');
    return response.Filter;
}

export async function updateFilter(
    http: ProtonHttp,
    filterId: string,
    payload: FilterPayload
): Promise<ProtonFilter> {
    await assertSieveAccepted(http, payload);

    const response = await http.request(
        { method: 'PUT', path: `mail/v4/filters/${filterId}`, body: payload },
        filterResponseSchema
    );
    log.info({ filterId, name: payload.Name }, 'filter updated');
    return response.Filter;
}

export async function deleteFilter(http: ProtonHttp, filterId: string): Promise<void> {
    await http.request({ method: 'DELETE', path: `mail/v4/filters/${filterId}` }, envelopeSchema);
    log.info({ filterId }, 'filter deleted');
}

export async function setFilterEnabled(
    http: ProtonHttp,
    filterId: string,
    enabled: boolean
): Promise<void> {
    await http.request(
        { method: 'PUT', path: `mail/v4/filters/${filterId}/${enabled ? 'enable' : 'disable'}` },
        envelopeSchema
    );
    log.info({ filterId, enabled }, 'filter toggled');
}

/**
 * Reorder filters.
 *
 * Order is not cosmetic: with filters it decides the outcome, because the last rule to file a
 * message wins. Sending a partial list would silently reprioritise everything omitted, so the
 * caller must pass every filter id.
 */
export async function reorderFilters(http: ProtonHttp, filterIds: string[]): Promise<void> {
    await http.request(
        { method: 'PUT', path: 'mail/v4/filters/order', body: { FilterIDs: filterIds } },
        envelopeSchema
    );
    log.info({ count: filterIds.length }, 'filters reordered');
}

/**
 * Apply filters to mail that already arrived.
 *
 * The reason a new rule can tidy up the backlog instead of only affecting future mail. Proton does
 * the moving, which keeps the project's core rule intact — the tool still never moves a message
 * itself, it asks Proton to run its own filters.
 */
export async function applyFiltersToExisting(http: ProtonHttp, messageIds: string[]): Promise<void> {
    await http.request(
        { method: 'POST', path: 'mail/v4/messages/apply-filters', body: { IDs: messageIds } },
        envelopeSchema
    );
    log.info({ count: messageIds.length }, 'filters applied to existing mail');
}

/**
 * Ask Proton to validate a Sieve script before storing it.
 *
 * Cheap, and it moves a class of failure from "a broken filter is live" to "the write did not
 * happen". Proton is the authority on its own dialect; our compiler agreeing is not the same thing.
 */
async function assertSieveAccepted(http: ProtonHttp, payload: FilterPayload): Promise<void> {
    if (payload.Sieve === undefined || payload.Sieve === '') {
        return;
    }

    try {
        await http.request(
            {
                method: 'PUT',
                path: 'mail/v4/filters/check',
                body: { Sieve: payload.Sieve, Version: payload.Version },
            },
            envelopeSchema
        );
    } catch (cause) {
        throw new AppError('RULE_SIEVE_REJECTED', {
            message: `Proton hat das Sieve-Skript für „${payload.Name}" abgelehnt.`,
            hint: 'Es wurde nichts gespeichert. Die Regel ist unverändert.',
            context: { name: payload.Name },
            cause,
        });
    }
}
