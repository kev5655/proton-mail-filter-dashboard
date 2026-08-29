import { ProtonSchemaError } from '@pms/core/errors';
import type { z } from 'zod';

/**
 * Validate a Proton response against the shape we expect.
 *
 * This is the single choke point of the fail-fast design. Everything that comes back from Proton
 * passes through here, so a changed field surfaces as a named error at the boundary instead of an
 * `undefined` that only misbehaves three layers later.
 */
export function parseResponse<S extends z.ZodType>(schema: S, data: unknown, endpoint: string): z.output<S> {
    const result = schema.safeParse(data);
    if (result.success) {
        return result.data;
    }

    const issues = result.error.issues.map((issue) => ({
        path: issue.path.length > 0 ? issue.path.join('.') : '(root)',
        expected: 'expected' in issue && typeof issue.expected === 'string' ? issue.expected : issue.code,
        received: describe(getAtPath(data, issue.path)),
    }));

    throw new ProtonSchemaError({ endpoint, issues, cause: result.error });
}

function getAtPath(value: unknown, path: ReadonlyArray<PropertyKey>): unknown {
    let current = value;
    for (const key of path) {
        if (current === null || typeof current !== 'object') {
            return undefined;
        }
        current = (current as Record<PropertyKey, unknown>)[key];
    }
    return current;
}

/**
 * A short description of what actually arrived.
 *
 * Deliberately a *description*, not the value: this text ends up in logs and exported incident
 * reports, and mail metadata must not ride along.
 */
function describe(value: unknown): string {
    if (value === undefined) {
        return 'missing';
    }
    if (value === null) {
        return 'null';
    }
    if (Array.isArray(value)) {
        return `array(${value.length})`;
    }
    if (typeof value === 'object') {
        return `object{${Object.keys(value).slice(0, 8).join(',')}}`;
    }
    if (typeof value === 'string') {
        return `string(length ${value.length})`;
    }
    return typeof value;
}
