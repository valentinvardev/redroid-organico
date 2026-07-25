import { redirect } from 'next/navigation';
import { getOptionalUser } from '@/lib/auth/currentUser';
import { LoginForm } from '@/app/components/LoginForm';

export const dynamic = 'force-dynamic';

export default async function LoginPage({
  searchParams,
}: {
  searchParams: { next?: string };
}) {
  if (await getOptionalUser()) {
    redirect('/');
  }

  // Only same-origin paths are accepted, so ?next= cannot be used to bounce a
  // freshly signed-in user to an attacker's site.
  const raw = searchParams.next ?? '/';
  const next = raw.startsWith('/') && !raw.startsWith('//') ? raw : '/';

  return (
    <main className="shell auth-shell">
      <div className="card auth-card">
        <p className="eyebrow">Publishing pipeline</p>
        <h1>Sign in</h1>
        <LoginForm next={next} />
      </div>
    </main>
  );
}
