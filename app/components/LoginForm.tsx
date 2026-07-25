'use client';

import { useRouter } from 'next/navigation';
import { FormEvent, useState } from 'react';

export function LoginForm({ next }: { next: string }) {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);

    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });

      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        setError(data.message ?? 'Could not sign in');
        return;
      }

      // A full navigation rather than router.push: the new session cookie has to
      // be picked up by the server components that render the dashboard.
      window.location.assign(next);
    } catch {
      setError('Could not reach the server');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="form" onSubmit={handleSubmit}>
      <label className="field">
        <span>Email</span>
        <input
          type="email"
          value={email}
          autoComplete="username"
          required
          onChange={(event) => setEmail(event.target.value)}
        />
      </label>

      <label className="field">
        <span>Password</span>
        <input
          type="password"
          value={password}
          autoComplete="current-password"
          required
          onChange={(event) => setPassword(event.target.value)}
        />
      </label>

      <button type="submit" disabled={busy || !email || !password}>
        {busy ? 'Signing in…' : 'Sign in'}
      </button>

      {error ? <div className="feedback feedback-error">{error}</div> : null}
    </form>
  );
}
