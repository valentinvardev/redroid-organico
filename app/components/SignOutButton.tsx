'use client';

import { useState } from 'react';

export function SignOutButton() {
  const [busy, setBusy] = useState(false);

  async function signOut() {
    setBusy(true);

    try {
      await fetch('/api/auth/logout', { method: 'POST' });
    } finally {
      // Full navigation so server components re-render without the session.
      window.location.assign('/login');
    }
  }

  return (
    <button type="button" className="ghost" disabled={busy} onClick={() => void signOut()}>
      {busy ? 'Signing out…' : 'Sign out'}
    </button>
  );
}
