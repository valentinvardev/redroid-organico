'use client';

import { FormEvent, useCallback, useEffect, useState } from 'react';
import { parseProxyUrl, PROXY_TYPES, proxyInputSchema, proxyPatchSchema } from '@/lib/proxy/config';

export interface ProxySummary {
  id: string;
  label: string;
  type: 'HTTP' | 'SOCKS5';
  host: string;
  port: number;
  username: string | null;
  hasPassword: boolean;
  timezone: string | null;
  locale: string | null;
  accountCount?: number;
}

interface Props {
  accountId: string;
  accountName: string;
  /** Currently assigned proxy, or null for "leaves through the host". */
  currentProxyId: string | null;
  /** Called after the assignment changed, so the parent can reload its list. */
  onSaved(): void;
  onClose(): void;
}

interface FormState {
  label: string;
  type: 'HTTP' | 'SOCKS5';
  host: string;
  port: string;
  username: string;
  password: string;
  timezone: string;
  locale: string;
}

const EMPTY_FORM: FormState = {
  label: '',
  type: 'SOCKS5',
  host: '',
  port: '',
  username: '',
  password: '',
  timezone: '',
  locale: '',
};

/** Same shape the worker builds, minus the password: enough to recognise a proxy. */
function describe(proxy: ProxySummary): string {
  const scheme = proxy.type === 'HTTP' ? 'http' : 'socks5';
  const credentials = proxy.username ? `${proxy.username}${proxy.hasPassword ? ':•••' : ''}@` : '';

  return `${scheme}://${credentials}${proxy.host}:${proxy.port}`;
}

/**
 * Picks the egress for one account, and manages the pool of proxies it can be
 * picked from. Both live in one dialog because in practice they are one task:
 * an operator who wants to give an account a proxy is usually adding it as well.
 */
export function ProxyDialog({ accountId, accountName, currentProxyId, onSaved, onClose }: Props) {
  const [proxies, setProxies] = useState<ProxySummary[]>([]);
  const [selected, setSelected] = useState<string | null>(currentProxyId);
  const [editing, setEditing] = useState<{ id: string | null; form: FormState } | null>(null);
  const [issues, setIssues] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const response = await fetch('/api/proxies');

      if (!response.ok) {
        setError('Could not load proxies');
        return;
      }

      setProxies((await response.json()) as ProxySummary[]);
      setError(null);
    } catch {
      setError('Could not load proxies');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) {
        onClose();
      }
    };

    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, onClose]);

  async function assign() {
    setBusy(true);
    setError(null);

    try {
      const response = await fetch(`/api/accounts/${accountId}/proxy`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ proxyId: selected }),
      });

      if (!response.ok) {
        const data = (await response.json().catch(() => ({}))) as { message?: string };
        setError(data.message ?? 'Could not assign the proxy');
        return;
      }

      onSaved();
      onClose();
    } catch {
      setError('Could not assign the proxy');
    } finally {
      setBusy(false);
    }
  }

  async function submitForm(event: FormEvent) {
    event.preventDefault();

    if (!editing) {
      return;
    }

    const { id, form } = editing;

    // A blank password on an edit means "keep the stored one" — the API never
    // sends it back, so the form has nothing to resubmit. Blanking the username
    // is the one exception: a stored password with nobody to send it as would
    // be rejected, and the operator plainly meant to drop both.
    const keepsStoredPassword =
      id !== null && form.password.length === 0 && form.username.trim().length > 0;

    const payload = {
      label: form.label,
      type: form.type,
      host: form.host,
      port: form.port,
      username: form.username,
      timezone: form.timezone,
      locale: form.locale,
      ...(keepsStoredPassword ? {} : { password: form.password.length > 0 ? form.password : null }),
    };

    // Checked here as well as on the server so a typo comes back instantly
    // instead of after a round trip — same schema, so they cannot disagree.
    const parsed = (id === null ? proxyInputSchema : proxyPatchSchema).safeParse(payload);

    if (!parsed.success) {
      setIssues(parsed.error.issues.map((issue) => issue.message));
      return;
    }

    setIssues([]);
    setBusy(true);
    setError(null);

    try {
      const response = await fetch(id === null ? '/api/proxies' : `/api/proxies/${id}`, {
        method: id === null ? 'POST' : 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      const data = (await response.json().catch(() => ({}))) as ProxySummary & { message?: string };

      if (!response.ok) {
        setError(data.message ?? 'Could not save the proxy');
        return;
      }

      await load();
      // A proxy that was just typed in is almost certainly the one wanted.
      setSelected(data.id);
      setEditing(null);
    } catch {
      setError('Could not save the proxy');
    } finally {
      setBusy(false);
    }
  }

  async function remove(proxy: ProxySummary) {
    setBusy(true);
    setError(null);

    try {
      const response = await fetch(`/api/proxies/${proxy.id}`, { method: 'DELETE' });

      if (!response.ok) {
        const data = (await response.json().catch(() => ({}))) as { message?: string };
        setError(data.message ?? 'Could not delete the proxy');
        return;
      }

      if (selected === proxy.id) {
        setSelected(null);
      }

      await load();
    } catch {
      setError('Could not delete the proxy');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="onboarding-backdrop" role="dialog" aria-modal="true" aria-label={`Proxy for ${accountName}`}>
      <div className="onboarding-panel proxy-panel">
        <header className="onboarding-header">
          <div>
            <p className="eyebrow">Egress</p>
            <h2>{accountName}</h2>
          </div>
          <button type="button" className="ghost" onClick={onClose} disabled={busy}>
            Close
          </button>
        </header>

        <div className="proxy-body">
          {error ? <p className="error">{error}</p> : null}

          <p className="hint">
            Every phone started for this account runs inside a gateway container that forwards all of
            its traffic to the proxy below. Nothing on the phone can go around it.
          </p>

          <ul className="proxy-list">
            <li className="proxy-row">
              <label className="proxy-choice">
                <input
                  type="radio"
                  name="proxy"
                  checked={selected === null}
                  onChange={() => setSelected(null)}
                />
                <span>
                  <span className="proxy-label">No proxy</span>
                  <span className="hint">Traffic leaves through this server&apos;s own address.</span>
                </span>
              </label>
            </li>

            {proxies.map((proxy) => (
              <li key={proxy.id} className="proxy-row">
                <label className="proxy-choice">
                  <input
                    type="radio"
                    name="proxy"
                    checked={selected === proxy.id}
                    onChange={() => setSelected(proxy.id)}
                  />
                  <span>
                    <span className="proxy-label">{proxy.label}</span>
                    <code className="proxy-target">{describe(proxy)}</code>
                    {/* Guarded with a comparison, not `&&`: a count of 0 would
                        render as a literal "0" next to the proxy's name. */}
                    {(proxy.accountCount ?? 0) > 1 ? (
                      <span className="pill pill-warn">shared by {proxy.accountCount} accounts</span>
                    ) : null}
                  </span>
                </label>

                <div className="actions">
                  <button
                    type="button"
                    className="ghost"
                    disabled={busy}
                    onClick={() =>
                      setEditing({
                        id: proxy.id,
                        form: {
                          label: proxy.label,
                          type: proxy.type,
                          host: proxy.host,
                          port: String(proxy.port),
                          username: proxy.username ?? '',
                          password: '',
                          timezone: proxy.timezone ?? '',
                          locale: proxy.locale ?? '',
                        },
                      })
                    }
                  >
                    Edit
                  </button>
                  <button type="button" className="ghost" disabled={busy} onClick={() => void remove(proxy)}>
                    Delete
                  </button>
                </div>
              </li>
            ))}
          </ul>

          {editing ? (
            <ProxyForm
              form={editing.form}
              editingId={editing.id}
              isNew={editing.id === null}
              issues={issues}
              busy={busy}
              onChange={(form) => setEditing({ ...editing, form })}
              onSubmit={submitForm}
              onCancel={() => {
                setEditing(null);
                setIssues([]);
              }}
            />
          ) : (
            <button
              type="button"
              className="ghost"
              disabled={busy}
              onClick={() => {
                setEditing({ id: null, form: EMPTY_FORM });
                setIssues([]);
              }}
            >
              Add a proxy
            </button>
          )}

          <footer className="proxy-actions">
            <button type="button" className="primary" disabled={busy} onClick={() => void assign()}>
              {selected === null ? 'Use no proxy' : 'Use this proxy'}
            </button>
            <span className="hint">Applies to the next run; a phone that is already up keeps its gateway.</span>
          </footer>
        </div>
      </div>
    </div>
  );
}

type TestState =
  | { status: 'idle' }
  | { status: 'testing' }
  | {
      status: 'ok';
      exitIp: string;
      latencyMs?: number;
      country?: string;
      countryCode?: string;
      region?: string;
      city?: string;
    }
  | { status: 'fail'; error: string };

/** "Berlin, Berlin, Germany" — dropping empty and duplicated parts. */
function formatLocation(test: Extract<TestState, { status: 'ok' }>): string {
  const parts = [test.city, test.region, test.country].filter((p): p is string => !!p);
  // Providers often repeat the city as the region (Berlin/Berlin); collapse it.
  return parts.filter((part, i) => parts.indexOf(part) === i).join(', ');
}

function ProxyForm({
  form,
  editingId,
  isNew,
  issues,
  busy,
  onChange,
  onSubmit,
  onCancel,
}: {
  form: FormState;
  editingId: string | null;
  isNew: boolean;
  issues: string[];
  busy: boolean;
  onChange(form: FormState): void;
  onSubmit(event: FormEvent): void;
  onCancel(): void;
}) {
  const set = (patch: Partial<FormState>) => onChange({ ...form, ...patch });
  const [test, setTest] = useState<TestState>({ status: 'idle' });

  async function runTest() {
    setTest({ status: 'testing' });

    try {
      const response = await fetch('/api/proxies/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: form.type,
          host: form.host,
          port: form.port,
          username: form.username,
          password: form.password,
          // Lets the server fall back to the stored password when editing.
          proxyId: editingId,
        }),
      });

      const data = (await response.json()) as {
        ok: boolean;
        exitIp?: string;
        latencyMs?: number;
        country?: string;
        countryCode?: string;
        region?: string;
        city?: string;
        error?: string;
      };

      if (data.ok && data.exitIp) {
        setTest({
          status: 'ok',
          exitIp: data.exitIp,
          latencyMs: data.latencyMs,
          country: data.country,
          countryCode: data.countryCode,
          region: data.region,
          city: data.city,
        });
      } else {
        setTest({ status: 'fail', error: data.error ?? 'The proxy did not respond' });
      }
    } catch {
      setTest({ status: 'fail', error: 'Could not reach the server to run the test' });
    }
  }

  /**
   * Providers hand out `socks5://user:pass@host:1080` or `host:1080:user:pass`.
   * Recognising both saves retyping five fields, and retyping is where the
   * transcription errors come from.
   */
  const paste = (text: string) => {
    const parsed = parseProxyUrl(text);

    if (!parsed) {
      return;
    }

    set({
      host: parsed.host ?? form.host,
      port: parsed.port !== undefined ? String(parsed.port) : form.port,
      type: parsed.type ?? form.type,
      username: parsed.username ?? form.username,
      password: parsed.password ?? form.password,
    });
  };

  return (
    <form className="form proxy-form" onSubmit={onSubmit}>
      {issues.length > 0 ? (
        <ul className="proxy-issues">
          {issues.map((issue) => (
            <li key={issue} className="error">
              {issue}
            </li>
          ))}
        </ul>
      ) : null}

      <label className="field">
        <span>Name</span>
        <input
          value={form.label}
          onChange={(event) => set({ label: event.target.value })}
          placeholder="Residential ES — line 3"
          maxLength={60}
        />
      </label>

      {/*
        Uncontrolled and read only on paste or on leaving the field: parsing
        every keystroke would rewrite the fields below from half a URL while
        somebody is still typing it.
      */}
      <label className="field">
        <span>Paste a proxy</span>
        <input
          placeholder="socks5://user:pass@gate.example.com:1080"
          onPaste={(event) => paste(event.clipboardData.getData('text'))}
          onBlur={(event) => paste(event.target.value)}
        />
        <em>Fills in the fields below. Understands scheme://… and host:port:user:pass.</em>
      </label>

      <div className="proxy-grid">
        <label className="field">
          <span>Type</span>
          <select value={form.type} onChange={(event) => set({ type: event.target.value as FormState['type'] })}>
            {PROXY_TYPES.map((type) => (
              <option key={type} value={type}>
                {type === 'HTTP' ? 'HTTP' : 'SOCKS5'}
              </option>
            ))}
          </select>
        </label>

        <label className="field">
          <span>Host</span>
          <input
            value={form.host}
            onChange={(event) => set({ host: event.target.value })}
            placeholder="gate.example.com"
          />
        </label>

        <label className="field">
          <span>Port</span>
          <input
            value={form.port}
            onChange={(event) => set({ port: event.target.value })}
            inputMode="numeric"
            placeholder="1080"
          />
        </label>
      </div>

      <div className="proxy-grid">
        <label className="field">
          <span>Username</span>
          <input
            value={form.username}
            onChange={(event) => set({ username: event.target.value })}
            autoComplete="off"
            placeholder="optional"
          />
        </label>

        <label className="field">
          <span>Password</span>
          <input
            type="password"
            value={form.password}
            onChange={(event) => set({ password: event.target.value })}
            autoComplete="new-password"
            placeholder={isNew ? 'optional' : 'unchanged'}
          />
        </label>
      </div>

      <div className="proxy-grid">
        <label className="field">
          <span>Zona horaria</span>
          <input
            value={form.timezone}
            onChange={(event) => set({ timezone: event.target.value })}
            placeholder="America/Chicago"
          />
        </label>

        <label className="field">
          <span>Idioma</span>
          <input
            value={form.locale}
            onChange={(event) => set({ locale: event.target.value })}
            placeholder="en-US"
          />
        </label>
      </div>

      <p className="hint">
        Opcionales, y del proxy y no de la cuenta: la dirección de salida es la que decide
        dónde dice estar el teléfono. Un dispositivo que sale en Dallas con el reloj en
        GMT&#8209;3 se contradice solo. El idioma se aplica en el arranque siguiente.
      </p>

      {form.type === 'HTTP' ? (
        <p className="hint">
          An HTTP proxy relays TCP only. Anything the phone sends over UDP — DNS included — has
          nowhere to go, so prefer SOCKS5 when the provider offers both.
        </p>
      ) : null}

      {test.status === 'ok' ? (
        <p className="feedback feedback-ok">
          Working. Exits from <code>{test.exitIp}</code>
          {formatLocation(test) ? (
            <>
              {' '}
              — {test.countryCode ? `${test.countryCode} · ` : ''}
              {formatLocation(test)}
            </>
          ) : null}
          {test.latencyMs !== undefined ? ` · ${test.latencyMs}ms` : ''}
        </p>
      ) : null}
      {test.status === 'fail' ? <p className="feedback feedback-error">{test.error}</p> : null}

      <div className="actions">
        <button type="submit" className="primary" disabled={busy}>
          {isNew ? 'Add proxy' : 'Save changes'}
        </button>
        <button
          type="button"
          className="ghost"
          disabled={busy || test.status === 'testing' || !form.host || !form.port}
          onClick={() => void runTest()}
        >
          {test.status === 'testing' ? 'Testing…' : 'Test'}
        </button>
        <button type="button" className="ghost" disabled={busy} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
