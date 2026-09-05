import { useEffect, useState } from 'react';

import type { SieveExplanation } from '@pms/llm';

import { useModel } from '../llm.js';
import { useMailbox } from '../mailbox.js';
import { ModelStatus } from './ModelStatus.js';

/**
 * The script itself, plus an explanation in prose.
 *
 * The structural rendering above is authoritative — it comes from Proton's own parser. This is a
 * language model's reading of the same script, and it is labelled as such rather than blended in.
 * The two are shown in that order deliberately: prose is easier to read and easier to be wrong
 * about, and a plausible-sounding wrong summary of what moves someone's mail is worse than none.
 */
export function SieveDetail({ ruleId }: { ruleId: string }): React.JSX.Element {
    const { sieveTextFor } = useMailbox();
    const { provider, state } = useModel();
    const sieve = sieveTextFor(ruleId);
    const [explanation, setExplanation] = useState<SieveExplanation | undefined>(undefined);
    const [failed, setFailed] = useState(false);

    useEffect(() => {
        if (state !== 'available') {
            // No model, no request. `ModelStatus` says so where the explanation would have been.
            setExplanation(undefined);
            setFailed(false);
            return;
        }

        let cancelled = false;
        provider
            .explainSieve(sieve)
            .then((result) => {
                if (!cancelled) {
                    setExplanation(result);
                }
            })
            .catch(() => {
                if (!cancelled) {
                    setFailed(true);
                }
            });
        return () => {
            cancelled = true;
        };
    }, [sieve, provider, state]);

    return (
        <>
            <h3 style={{ marginTop: 16 }}>Script-Filter</h3>
            <p className="faint">
                In Protons Oberfläche nur als Code sichtbar. Die Struktur oben ist aus dem Regelbaum
                abgeleitet, den Proton mitliefert — sie ist massgeblich.
            </p>
            <code className="sieve-code">{sieve}</code>

            <ModelStatus what="steht hier keine Erklärung in Prosa" />

            {failed && state === 'available' && (
                <p className="notice notice-warning">
                    Das Sprachmodell hat nicht geantwortet — ohne Erklärung. Die Struktur oben gilt
                    trotzdem.
                </p>
            )}

            {explanation !== undefined && (
                <div className="generated">
                    <div className="row">
                        <strong>Erklärung</strong>
                        <span className="badge badge-neutral">vom Modell erzeugt</span>
                    </div>
                    <p className="muted" style={{ margin: '4px 0 0' }}>
                        {explanation.summary}
                    </p>
                    <ol>
                        {explanation.steps.map((step) => (
                            <li key={step}>{step}</li>
                        ))}
                    </ol>
                    <p className="faint">
                        Erzeugter Text, kann falsch sein. Im Zweifel gilt die abgeleitete Struktur.
                    </p>
                </div>
            )}
        </>
    );
}
