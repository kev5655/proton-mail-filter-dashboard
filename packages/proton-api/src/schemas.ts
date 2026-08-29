import { z } from 'zod';

/**
 * What we expect back from Proton.
 *
 * These schemas are intentionally strict about the fields we actually use and permissive about
 * everything else: Proton adds fields all the time, and breaking on an *addition* would be noise.
 * Breaking on a *removal* or a changed type of something we depend on is the point.
 */

/** Every Proton response carries a numeric result code; 1000 means success. */
export const PROTON_SUCCESS = 1000;

const envelope = z.object({ Code: z.number() });

// ---------------------------------------------------------------------------- auth

export const infoResponseSchema = envelope.extend({
    Modulus: z.string(),
    ServerEphemeral: z.string(),
    Version: z.number(),
    Salt: z.string(),
    SRPSession: z.string(),
});
export type InfoResponse = z.output<typeof infoResponseSchema>;

/**
 * `POST auth/v4/sessions` — the unauthenticated session the login handshake runs inside.
 *
 * Same token shape as a real session, but with no user attached: it exists so Proton can see the
 * whole login as one client's conversation rather than a bare credential submission.
 */
export const sessionResponseSchema = envelope.extend({
    AccessToken: z.string(),
    RefreshToken: z.string(),
    UID: z.string(),
});
export type SessionResponse = z.output<typeof sessionResponseSchema>;

export const authResponseSchema = envelope.extend({
    AccessToken: z.string(),
    RefreshToken: z.string(),
    UID: z.string(),
    UserID: z.string(),
    Scope: z.string(),
    ExpiresIn: z.number(),
    /** Bitfield: 1 = TOTP, 2 = FIDO2. 0 means the login is already complete. */
    TwoFactor: z.number(),
    ServerProof: z.string(),
});
export type AuthResponse = z.output<typeof authResponseSchema>;

export const TWO_FACTOR_TOTP = 1;
export const TWO_FACTOR_FIDO2 = 2;

// ---------------------------------------------------------------------------- labels / folders

/** Proton's label types. Folders and labels are the same object with a different `Type`. */
export const LABEL_TYPE = {
    LABEL: 1,
    FOLDER: 3,
    CONTACT_GROUP: 2,
    SYSTEM: 4,
} as const;

export const labelSchema = z.object({
    ID: z.string(),
    Name: z.string(),
    Path: z.string().optional(),
    Type: z.number(),
    Color: z.string().optional(),
    /** Present on folders; empty string or absent at the top level. Drives the folder tree. */
    ParentID: z.string().nullable().optional(),
    Order: z.number().optional(),
    Notify: z.number().optional(),
    Expanded: z.number().optional(),
    Sticky: z.number().optional(),
});
export type ProtonLabel = z.output<typeof labelSchema>;

export const labelsResponseSchema = envelope.extend({
    Labels: z.array(labelSchema),
});

// ---------------------------------------------------------------------------- filters

const filterConditionSchema = z.object({
    Comparator: z.object({ value: z.string(), label: z.string() }),
    Type: z.object({ value: z.string(), label: z.string() }),
    Values: z.array(z.string()),
});

const filterSimpleSchema = z.object({
    Operator: z.object({ value: z.string(), label: z.string() }),
    Conditions: z.array(filterConditionSchema),
    Actions: z.object({
        FileInto: z.array(z.string()),
        Mark: z.object({ Read: z.boolean(), Starred: z.boolean() }),
        Vacation: z.string().nullable().optional(),
    }),
});

export const filterSchema = z.object({
    ID: z.string(),
    Name: z.string(),
    /** 0 = disabled, 1 = enabled. */
    Status: z.number(),
    Priority: z.number(),
    Version: z.number(),
    /** Present only for filters the Proton UI can render as a clickable rule. */
    Simple: filterSimpleSchema.optional(),
    Sieve: z.string().nullable().optional(),
    /**
     * The Sieve AST. Upstream types this as `any`; we keep it opaque here and let
     * `@proton/sieve` be the authority on its shape rather than duplicating that knowledge.
     */
    Tree: z.unknown().optional(),
});
export type ProtonFilter = z.output<typeof filterSchema>;

export const filtersResponseSchema = envelope.extend({
    Filters: z.array(filterSchema),
});

// ---------------------------------------------------------------------------- messages

const addressSchema = z.object({
    Address: z.string(),
    Name: z.string().optional(),
});

/**
 * Message metadata.
 *
 * Proton does not end-to-end encrypt subject, sender or recipients — only the body. That is why
 * grouping and rule suggestions can work entirely from this endpoint, with no PGP and no Bridge.
 */
export const messageMetadataSchema = z.object({
    ID: z.string(),
    Subject: z.string(),
    Sender: addressSchema,
    ToList: z.array(addressSchema),
    CCList: z.array(addressSchema).optional(),
    BCCList: z.array(addressSchema).optional(),
    Time: z.number(),
    LabelIDs: z.array(z.string()),
    Unread: z.number(),
    NumAttachments: z.number().optional(),
    Flags: z.number().optional(),
    AddressID: z.string().optional(),
    ConversationID: z.string().optional(),
});
export type MessageMetadata = z.output<typeof messageMetadataSchema>;

export const messagesResponseSchema = envelope.extend({
    Total: z.number(),
    Messages: z.array(messageMetadataSchema),
});

export const messageCountSchema = z.object({
    LabelID: z.string(),
    Total: z.number(),
    Unread: z.number(),
});

export const messageCountsResponseSchema = envelope.extend({
    Counts: z.array(messageCountSchema),
});
