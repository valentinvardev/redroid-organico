'use client';

import { useCallback, useEffect, useState } from 'react';
import { OnboardingDialog } from './OnboardingDialog';
import { ProxyDialog, type ProxySummary } from './ProxyDialog';

interface Account {
  id: string;
  name: string;
  platform: string;
  status: string;
  sessionState: 'NONE' | 'ONBOARDING' | 'VERIFIED' | 'EXPIRED';
  sessionVerifiedAt: string | null;
  proxyId: string | null;
  proxy: ProxySummary | null;
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
  const [routing, setRouting] = useState<Account | null>(null);
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

                {/*
                  The egress is shown on the row rather than behind the dialog:
                  an account publishing from the server's own datacentre address
                  is the kind of thing that has to be visible without clicking.
                */}
                <button
                  type="button"
                  className="ghost account-proxy"
                  onClick={() => setRouting(account)}
                  title={
                    account.proxy
                      ? `${account.proxy.host}:${account.proxy.port}`
                      : 'No proxy: traffic leaves through this server'
                  }
                >
                  {account.proxy ? `via ${account.proxy.label}` : 'No proxy'}
                </button>

                {/*
                  Never disabled on ONBOARDING. That state can be a leftover
                  from a run that died, and the recovery for it runs when this
                  button is pressed — disabling it here made the account
                  permanently unlinkable. Pressing it during a genuinely live
                  run is safe too: the dialog reattaches to that run instead of
                  starting a second one.
                */}
                <button
                  type="button"
                  className={account.sessionState === 'VERIFIED' ? 'ghost' : 'primary'}
                  onClick={() => setLinking(account)}
                >
                  {account.sessionState === 'VERIFIED'
                    ? 'Re-link'
                    : account.sessionState === 'ONBOARDING'
                      ? 'Resume linking'
                      : 'Link account'}
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

      {routing ? (
        <ProxyDialog
          accountId={routing.id}
          accountName={routing.name}
          currentProxyId={routing.proxyId}
          onSaved={() => void load()}
          onClose={() => setRouting(null)}
        />
      ) : null}
    </section>
  );
}
