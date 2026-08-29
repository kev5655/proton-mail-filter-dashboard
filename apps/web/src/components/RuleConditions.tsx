import { ConditionType, FilterStatement, type SimpleObject } from '@proton/sieve/filterModel';

/**
 * What a rule actually is, laid out rather than described in a sentence.
 *
 * A rule is the thing that moves someone's mail, and "Absender enthält X und Y → nach Z" packed
 * into one line is hard to check at a glance — which is exactly when it needs checking. Each
 * condition gets its own row: the field, the comparison, and every value it matches on.
 *
 * The values matter most. A condition with four addresses in it reads as one condition in prose and
 * as four separate things it can catch here, which is what someone deciding whether to keep the
 * rule needs to see.
 */

const FIELD_NAMES: Partial<Record<ConditionType, string>> = {
    [ConditionType.SENDER]: 'Absender',
    [ConditionType.SUBJECT]: 'Betreff',
    [ConditionType.RECIPIENT]: 'Empfänger',
    [ConditionType.ATTACHMENTS]: 'Anhang',
};

const COMPARATORS: Record<string, string> = {
    is: 'ist genau',
    contains: 'enthält',
    starts: 'beginnt mit',
    ends: 'endet mit',
    matches: 'passt auf',
    '!is': 'ist nicht',
    '!contains': 'enthält nicht',
    '!starts': 'beginnt nicht mit',
    '!ends': 'endet nicht mit',
    '!matches': 'passt nicht auf',
};

export function RuleConditions({
    rule,
    onFolderClick,
}: {
    rule: SimpleObject;
    onFolderClick?: (folder: string) => void;
}): React.JSX.Element {
    const joiner = rule.Operator.value === FilterStatement.ANY ? 'ODER' : 'UND';
    const folder = rule.Actions.FileInto.at(-1);

    return (
        <div className="conditions">
            {rule.Conditions.length === 0 && (
                <p className="notice notice-warning">
                    Diese Regel hat keine Bedingung — sie trifft jede Mail.
                </p>
            )}

            {rule.Conditions.map((entry, index) => (
                <div key={`${entry.Type.value}-${index}`}>
                    {index > 0 && <div className="condition-joiner">{joiner}</div>}
                    <div className="condition">
                        <span className="condition-field">
                            {FIELD_NAMES[entry.Type.value] ?? entry.Type.value}
                        </span>
                        <span className="condition-comparator">
                            {COMPARATORS[entry.Comparator.value] ?? entry.Comparator.value}
                        </span>
                        {entry.Type.value === ConditionType.ATTACHMENTS ? (
                            <span className="faint">(vorhanden / nicht vorhanden)</span>
                        ) : (
                            <span className="condition-values">
                                {entry.Values.map((value) => (
                                    <code className="value-chip" key={value}>
                                        {value}
                                    </code>
                                ))}
                            </span>
                        )}
                    </div>
                </div>
            ))}

            <div className="condition-action">
                <span className="condition-field">Dann</span>
                <span className="condition-comparator">verschieben nach</span>
                {folder === undefined || folder === '' ? (
                    <span className="faint">— kein Ordner, die Regel markiert nur</span>
                ) : onFolderClick === undefined ? (
                    <code className="value-chip">{folder}</code>
                ) : (
                    <button
                        type="button"
                        className="value-chip value-chip-link"
                        onClick={() => onFolderClick(folder)}
                    >
                        {folder}
                    </button>
                )}
            </div>

            {(rule.Actions.Mark.Read || rule.Actions.Mark.Starred) && (
                <div className="condition-action">
                    <span className="condition-field">Und</span>
                    <span className="condition-comparator">
                        {[rule.Actions.Mark.Read ? 'als gelesen markieren' : undefined,
                          rule.Actions.Mark.Starred ? 'mit Stern versehen' : undefined]
                            .filter((entry) => entry !== undefined)
                            .join(', ')}
                    </span>
                </div>
            )}
        </div>
    );
}
