/**
 * Reducing a subject line to the shape it shares with its siblings.
 *
 * "Ihre Rechnung 2024-8891 über CHF 42.10" and "Ihre Rechnung 2024-9034 über CHF 17.80" are the same
 * kind of mail; what differs is the part that changes every time. Masking those parts is what turns
 * a hundred unique subjects into three recognisable groups.
 *
 * The masking is deliberately conservative. Over-masking merges things that are genuinely different
 * — "Anmeldung von Chrome" and "Anmeldung von Firefox" should not collapse into one group just
 * because words differ — so only patterns that are obviously identifiers get replaced.
 */

/** Reply and forward prefixes, in the languages a Swiss mailbox actually sees. */
const REPLY_PREFIX = /^\s*(re|aw|fw|fwd|wg|antw|antwort|tr|rif|sv)\s*(\[\d+\])?\s*:\s*/i;

interface MaskRule {
    pattern: RegExp;
    placeholder: string;
}

/**
 * Order matters: the more specific patterns run first, so a date is not eaten by the plain-number
 * rule and an amount keeps its currency.
 */
const MASKS: MaskRule[] = [
    // ISO and European dates: 2024-08-29, 29.08.2024, 29/08/24
    { pattern: /\b\d{4}-\d{2}-\d{2}\b/g, placeholder: '{date}' },
    { pattern: /\b\d{1,2}[./]\d{1,2}[./]\d{2,4}\b/g, placeholder: '{date}' },
    // Times: 14:05, 14:05:33
    { pattern: /\b\d{1,2}:\d{2}(:\d{2})?\b/g, placeholder: '{time}' },
    // Amounts with a currency on either side
    { pattern: /\b(chf|eur|usd|gbp|€|\$|£)\s?-?\d[\d'.,]*\b/gi, placeholder: '{amount}' },
    { pattern: /\b\d[\d'.,]*\s?(chf|eur|usd|gbp|€|\$|£)\b/gi, placeholder: '{amount}' },
    // UUIDs and long hex — order ids, tracking tokens
    {
        pattern: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
        placeholder: '{id}',
    },
    { pattern: /\b[0-9a-f]{12,}\b/gi, placeholder: '{id}' },
    // Mixed letter/digit references: AB-12345, INV2024881, #4711
    { pattern: /#\s?\d+\b/g, placeholder: '{id}' },
    { pattern: /\b[A-Z]{2,}[-_ ]?\d{3,}\b/g, placeholder: '{id}' },
    // Anything left that is just digits
    { pattern: /\b\d[\d'.,]*\b/g, placeholder: '{n}' },
];

/** Strip every stacked reply/forward prefix, not only the outermost one. */
export function stripReplyPrefixes(subject: string): string {
    let result = subject;
    // Bounded: a subject with more than ten stacked prefixes is pathological, not interesting.
    for (let depth = 0; depth < 10; depth++) {
        const stripped = result.replace(REPLY_PREFIX, '');
        if (stripped === result) {
            break;
        }
        result = stripped;
    }
    return result;
}

/**
 * The template a subject belongs to. Empty when the subject carries no stable text at all — an
 * all-digits subject would otherwise produce the template "{n}", which groups unrelated mail.
 */
export function subjectTemplate(subject: string): string {
    let template = stripReplyPrefixes(subject);

    for (const { pattern, placeholder } of MASKS) {
        template = template.replace(pattern, placeholder);
    }

    template = template.replace(/\s+/g, ' ').trim();

    // A template made only of placeholders and punctuation says nothing about what the mail is.
    const withoutPlaceholders = template.replace(/\{(date|time|amount|id|n)\}/g, '').replace(/[^\p{L}]/gu, '');
    return withoutPlaceholders.length >= 3 ? template : '';
}

/** Case-insensitive key for the template, for use as a map key. */
export function subjectTemplateKey(subject: string): string {
    return subjectTemplate(subject).toLowerCase();
}

/**
 * The domain part of an address, lowercased. Empty for anything that is not an address.
 */
export function emailDomain(address: string): string {
    const at = address.lastIndexOf('@');
    if (at < 0 || at === address.length - 1) {
        return '';
    }
    return address.slice(at + 1).toLowerCase().trim();
}

/**
 * Two-label public suffixes common enough to matter here.
 *
 * A complete answer needs the Public Suffix List, which is a large and constantly changing
 * dependency. Getting this wrong is not dangerous — it only means `news.example.co.uk` groups as
 * `co.uk` instead of `example.co.uk`, which shows up as a group that is too broad and which the
 * user can simply not accept. That is a fair trade for not carrying the PSL; if grouping quality
 * suffers in practice, this is the place to add it.
 */
const TWO_LABEL_SUFFIXES = new Set([
    'co.uk',
    'org.uk',
    'ac.uk',
    'gov.uk',
    'co.jp',
    'com.au',
    'net.au',
    'org.au',
    'co.nz',
    'com.br',
    'co.za',
    'com.tr',
]);

/**
 * The registrable domain: `accounts.google.com` → `google.com`.
 *
 * This is what makes "everything from Google" a single group even though the mail arrives from
 * `accounts.`, `payments.` and `no-reply.mail.` subdomains.
 */
export function registrableDomain(domain: string): string {
    const labels = domain.toLowerCase().split('.').filter(Boolean);
    if (labels.length <= 2) {
        return labels.join('.');
    }

    const lastTwo = labels.slice(-2).join('.');
    if (TWO_LABEL_SUFFIXES.has(lastTwo)) {
        return labels.slice(-3).join('.');
    }
    return lastTwo;
}

/** The address with its display name removed and case folded, as Proton's filters see it. */
export function normalizeAddress(address: string): string {
    return address.trim().toLowerCase();
}
