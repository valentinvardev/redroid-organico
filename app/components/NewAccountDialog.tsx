'use client';

import { useState } from 'react';

interface ExistingAccount {
  id: string;
  name: string;
  hasCredentials: boolean;
}

interface Props {
  /** For the "start from an existing account" picker. */
  accounts: ExistingAccount[];
  onCreated(): void;
  onClose(): void;
}

const BLANK_TEMPLATE = `{
  "appiumUrl": "http://localhost:4723",
  "adbHost": "localhost",
  "adbPort": 5037,
  "packageName": "com.target.app",
  "apkPath": "/home/ubuntu/redroid-organico/sportreels.apk",
  "remoteVideoPath": "/sdcard/DCIM/upload.mp4",
  "bootTimeoutSeconds": 240,
  "appiumTimeoutSeconds": 180,
  "launchSettleMs": 4000,
  "redroid": {
    "image": "redroid/redroid:13.0.0-latest",
    "connectVia": "container-name",
    "network": "redroid-net",
    "memoryLimit": "4g",
    "gpuMode": "guest",
    "startTimeoutSeconds": 240
  },
  "flow": [
    { "action": "assertVisible", "name": "REPLACE ME", "using": "id", "value": "com.target.app:id/x", "timeoutMs": 15000 }
  ],
  "verifyFlow": [
    { "action": "assertVisible", "name": "REPLACE ME", "using": "id", "value": "com.target.app:id/x", "captureText": true, "timeoutMs": 15000 }
  ]
}
`;

export function NewAccountDialog({ accounts, onCreated, onClose }: Props) {
  const [name, setName] = useState('');
  const [config, setConfig] = useState(BLANK_TEMPLATE);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const cloneable = accounts.filter((a) => a.hasCredentials);

  async function startFrom(accountId: string) {
    if (!accountId) {
      setConfig(BLANK_TEMPLATE);
      return;
    }

    setError(null);
    try {
      const response = await fetch(`/api/accounts/${accountId}/config`);
      const body = await response.json();

      if (!response.ok) {
        setError(body.message ?? 'Could not load that account');
        return;
      }

      setConfig(JSON.stringify(body.config, null, 2));
    } catch {
      setError('Could not load that account');
    }
  }

  async function submit() {
    setError(null);

    // Parse locally first: a JSON typo should say "line 4" here, not come back
    // as a generic 422 from the server. The server still validates the shape.
    let parsed: unknown;
    try {
      parsed = JSON.parse(config);
    } catch (cause) {
      setError(`The config is not valid JSON: ${cause instanceof Error ? cause.message : cause}`);
      return;
    }

    setBusy(true);
    try {
      const response = await fetch('/api/accounts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, config: parsed }),
      });

      const body = await response.json();

      if (!response.ok) {
        setError(body.message ?? `Could not create the account (${response.status})`);
        return;
      }

      onCreated();
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Network error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="onboarding-backdrop" role="dialog" aria-modal="true" aria-label="New account">
      <div className="onboarding-panel account-form-panel">
        <header className="onboarding-header">
          <div>
            <p className="eyebrow">Accounts</p>
            <h2>New account</h2>
          </div>
          <button type="button" className="ghost" onClick={onClose}>
            Cancel
          </button>
        </header>

        <div className="onboarding-body">
          <label className="field">
            <span>Name</span>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="SportReels v4" />
          </label>

          {cloneable.length > 0 ? (
            <label className="field">
              <span>Start from</span>
              <select defaultValue="" onChange={(e) => void startFrom(e.target.value)}>
                <option value="">Blank template</option>
                {cloneable.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
            </label>
          ) : null}

          <label className="field">
            <span>Config (JSON)</span>
            <textarea
              className="account-config"
              value={config}
              onChange={(e) => setConfig(e.target.value)}
              spellCheck={false}
            />
          </label>

          <p className="hint">
            Same shape as <code>--credentials-file</code>. Validated against what the worker runs, so an accepted
            config is one a job can execute.
          </p>

          {error ? <pre className="account-config-error">{error}</pre> : null}

          <div className="onboarding-actions">
            <button type="button" className="primary" onClick={() => void submit()} disabled={busy || !name.trim()}>
              {busy ? 'Creating…' : 'Create account'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
