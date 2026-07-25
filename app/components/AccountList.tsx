'use client';

import { useCallback, useEffect, useState } from 'react';
import { OnboardingDialog } from './OnboardingDialog';

interface Account {
  id: string;
  name: string;
  platform: string;
  status: string;
  sessionState: 'NONE' | 'ONBOARDING' | 'VERIFIED' | 'EXPIRED';
  sessionVerifiedAt: string | null;
}

const SESSION_COPY: Record<Account['sessionState'], { label: string; tone: string; hint: string }> = {
  NONE: { label: 'Not linked', tone: 'warn', hint: 'Nobody has logged in on the phone yet.' },
  ONBOARDING: { label: 'Linking…', tone: 'warn', hint: 'A login is in progress right now.' },
  VERIFIED: { label: 'Linked', tone: 'ok', hint: 'Logged in and confirmed.' },
  EXPIRED: { label: 'Session expired', tone: 'bad', hint: 'The login stopped working; link it again.' },
};

export function AccountList() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [linking, setLinking] = useState<Account | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await fetch('/api/accounts');

      if (!response.ok) {
        setError('Could not load accounts');
        return;
      }

      setAccounts((await response.json()) as Account[]);
      setError(null);
    } catch {
      setError('Could not load accounts');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <section className="card accounts">
      <header className="queue-header">
        <h2>Accounts</h2>
      </header>

      {error ? <p className="error">{error}</p> : null}

      {accounts.length === 0 ? (
        <p className="hint">
          No accounts yet. Add one with <code>npm run account:add</code>.
        </p>
      ) : (
        <ul className="account-list">
          {accounts.map((account) => {
            const session = SESSION_COPY[account.sessionState] ?? SESSION_COPY.NONE;

            return (
              <li key={account.id} className="account-row">
                <div className="account-main">
                  <span className="account-name">{account.name}</span>
                  <span className="account-meta">
                    {account.platform} · {account.status.toLowerCase()}
                  </span>
                </div>

                <div className="account-session">
                  <span className={`pill pill-${session.tone}`}>{session.label}</span>
                  <span className="hint">{session.hint}</span>
                </div>

                <button
                  type="button"
                  className={account.sessionState === 'VERIFIED' ? 'ghost' : 'primary'}
                  onClick={() => setLinking(account)}
                  disabled={account.sessionState === 'ONBOARDING'}
                >
                  {account.sessionState === 'VERIFIED' ? 'Re-link' : 'Link account'}
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {linking ? (
        <OnboardingDialog
          accountId={linking.id}
          accountName={linking.name}
          onClose={() => {
            setLinking(null);
            // The session state almost certainly changed; the account list is a
            // plain fetch, so it needs a nudge that the SSE stream does not give.
            void load();
          }}
        />
      ) : null}
    </section>
  );
}
