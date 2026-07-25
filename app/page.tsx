import { redirect } from 'next/navigation';
import { getOptionalUser } from '@/lib/auth/currentUser';
import { ComposeForm } from './components/ComposeForm';
import { JobQueue } from './components/JobQueue';
import { SignOutButton } from './components/SignOutButton';

export const dynamic = 'force-dynamic';

export default async function DashboardPage() {
  const user = await getOptionalUser();

  if (!user) {
    redirect('/login');
  }

  return (
    <main className="shell">
      <header className="masthead">
        <div>
          <p className="eyebrow">Publishing pipeline</p>
          <h1>Dashboard</h1>
        </div>
        <div className="masthead-user">
          <span>{user.email}</span>
          <SignOutButton />
        </div>
      </header>

      <div className="grid">
        <ComposeForm />
        <JobQueue />
      </div>
    </main>
  );
}
