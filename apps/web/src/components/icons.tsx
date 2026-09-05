/**
 * The two marks the folder rows need, drawn rather than fetched.
 *
 * Inline SVG because an icon font or a package would be a network request and a dependency for
 * twelve path commands, and because these have to inherit `currentColor` to work in both themes.
 *
 * They are decorative in the strict sense: every button that carries one also carries a label —
 * visible on a wide screen, `aria-label` on a phone where the text is hidden — so the icon never
 * has to be read by anybody.
 */

const COMMON = {
    width: 16,
    height: 16,
    viewBox: '0 0 16 16',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.5,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
    focusable: false,
};

export function PencilIcon(): React.JSX.Element {
    return (
        <svg {...COMMON}>
            <path d="M11.2 2.3a1.6 1.6 0 0 1 2.3 2.3L5.4 12.7l-3 .7.7-3z" />
        </svg>
    );
}

export function TrashIcon(): React.JSX.Element {
    return (
        <svg {...COMMON}>
            <path d="M2.75 4.25h10.5M6.25 4.25V3a.75.75 0 0 1 .75-.75h2a.75.75 0 0 1 .75.75v1.25" />
            <path d="M12 4.25 11.4 13a.75.75 0 0 1-.75.7H5.35a.75.75 0 0 1-.75-.7L4 4.25" />
            <path d="M6.75 6.75v4.5M9.25 6.75v4.5" />
        </svg>
    );
}
