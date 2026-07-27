'use client';

import { useCallback, useEffect, useState } from 'react';
import { accountFlowsSchema } from '@/lib/accounts/flowsSchema';

interface Props {
  accountId: string;
  accountName: string;
  onClose(): void;
}

type Feedback = { kind: 'ok' | 'error'; text: string } | null;

/**
 * Edits an account's automations without an SSH session.
 *
 * A textarea rather than a step builder, on purpose: the flows are already JSON
 * in the credentials, the selectors are copied from `dump-ui.sh`, and a builder
 * that only exposes the steps it knows about would be a worse editor than the
 * format it wraps. What matters is that a broken flow is caught here.
 */
export function FlowsDialog({ accountId, accountName, onClose }: Props) {
  const [text, setText] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [issues, setIssues] = useState<string[]>([]);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const response = await fetch(`/api/accounts/${accountId}/flows`);
      const data = await response.json();

      if (!response.ok) {
        setFeedback({ kind: 'error', text: data.message ?? 'No se pudieron leer las automatizaciones' });
        return;
      }

      setText(JSON.stringify(data, null, 2));
      setLoaded(true);
    } catch {
      setFeedback({ kind: 'error', text: 'No se pudieron leer las automatizaciones' });
    }
  }, [accountId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function save() {
    setFeedback(null);
    setIssues([]);

    let parsed: unknown;

    try {
      parsed = JSON.parse(text);
    } catch (error) {
      // A JSON error names a position, which is useless without the position.
      setIssues([`No es JSON válido: ${error instanceof Error ? error.message : String(error)}`]);
      return;
    }

    // The same schema the worker parses, so a flow that could never pass — no
    // assertion, a locator strategy that does not exist — is rejected here
    // instead of at three in the morning inside a job.
    const checked = accountFlowsSchema.safeParse(parsed);

    if (!checked.success) {
      setIssues(checked.error.issues.map((issue) => `${issue.path.join('.') || '(raíz)'}: ${issue.message}`));
      return;
    }

    setBusy(true);

    try {
      const response = await fetch(`/api/accounts/${accountId}/flows`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(parsed),
      });

      const data = await response.json();

      if (!response.ok) {
        setFeedback({ kind: 'error', text: data.message ?? 'No se pudo guardar' });
        return;
      }

      // Re-rendered from what came back, so what is on screen is what is stored
      // — defaults filled in and all.
      setText(JSON.stringify(data, null, 2));
      setFeedback({ kind: 'ok', text: 'Guardado. Se aplica en el próximo job.' });
    } catch {
      setFeedback({ kind: 'error', text: 'No se pudo guardar' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="onboarding-backdrop" role="dialog" aria-modal="true" aria-label={`Automatizaciones de ${accountName}`}>
      <div className="onboarding-panel flows-panel">
        <header className="onboarding-header">
          <div>
            <p className="eyebrow">Automatizaciones</p>
            <h2>{accountName}</h2>
          </div>
          <button type="button" className="ghost" onClick={onClose} disabled={busy}>
            Cerrar
          </button>
        </header>

        <div className="proxy-body">
          {feedback ? (
            <p className={feedback.kind === 'ok' ? 'hint' : 'error'}>{feedback.text}</p>
          ) : null}

          {issues.length > 0 ? (
            <ul className="proxy-issues">
              {issues.map((issue) => (
                <li key={issue} className="error">
                  {issue}
                </li>
              ))}
            </ul>
          ) : null}

          <p className="hint">
            <code>flow</code> es el de publicación, <code>verifyFlow</code> el que confirma un login, y{' '}
            <code>flows</code> los que un job elige por nombre. Los selectores salen de{' '}
            <code>./scripts/dump-ui.sh</code>. Un flujo sin ninguna aserción se rechaza: sin ella
            solo puede reportar éxito.
          </p>

          <textarea
            className="flows-editor"
            value={text}
            spellCheck={false}
            onChange={(event) => setText(event.target.value)}
            disabled={!loaded || busy}
          />

          <div className="actions">
            <button type="button" className="primary" onClick={() => void save()} disabled={!loaded || busy}>
              Guardar
            </button>
            <button type="button" className="ghost" onClick={() => void load()} disabled={busy}>
              Descartar cambios
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
