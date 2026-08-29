/** How strongly a group was ranked, shown as a bar so the ordering is visibly reasoned rather than arbitrary. */
export function ScoreBar({ score }: { score: number }): React.JSX.Element {
    return (
        <span className="score" title={`Score ${score.toFixed(2)}`}>
            <span className="score-track">
                <span className="score-fill" style={{ width: `${Math.round(score * 100)}%` }} />
            </span>
            <span className="score-value">{score.toFixed(2)}</span>
        </span>
    );
}
