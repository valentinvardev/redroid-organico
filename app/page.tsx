import { getOptionalUser } from '@/lib/auth/currentUser';
import { AccountList } from './components/AccountList';
import { ComposeForm } from './components/ComposeForm';
import { JobQueue } from './components/JobQueue';
import { SignOutButton } from './components/SignOutButton';

export const dynamic = 'force-dynamic';

export default async function DashboardPage() {
  const user = await getOptionalUser();

  return (
    <main className="shell">
      <header className="masthead">
        <div>
          <p className="eyebrow">Publishing pipeline</p>
          <h1>Dashboard</h1>
        </div>
        <div className="masthead-user">
          <span>{user?.email ?? 'guest'}</span>
          <SignOutButton />
        </div>
      </header>

      <AccountList />

      <div className="grid">
        <ComposeForm />
        <JobQueue />
      </div>
    </main>
  );
}
