'use client';

import { useEffect, type ReactNode } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { useCopy } from '@getstet/stet/react';

import { LeaveGuardProvider, useLeaveGuard } from '@/components/LeaveGuard';
import { signOut, useSession } from '@/lib/session';

function NavLink({ href, children }: { href: string; children: ReactNode }) {
  const pathname = usePathname();
  const { leave } = useLeaveGuard();
  return (
    <a
      href={href}
      className="nav-link"
      aria-current={pathname === href ? 'page' : undefined}
      onClick={(event) => {
        event.preventDefault();
        leave(href);
      }}
    >
      {children}
    </a>
  );
}

function Header() {
  const copy = useCopy();
  const user = useSession();
  const router = useRouter();
  return (
    <header className="app-header">
      <div className="app-header-inner">
        <span className="app-name">{copy('app_name')}</span>
        <nav className="nav">
          <NavLink href="/dashboard">{copy('nav_dashboard')}</NavLink>
          <NavLink href="/settings">{copy('nav_settings')}</NavLink>
        </nav>
        <div className="app-user">
          <span className="app-user-name">{user?.name}</span>
          <button
            type="button"
            className="link-button"
            onClick={() => {
              signOut();
              router.push('/signup');
            }}
          >
            {copy('nav_sign_out')}
          </button>
        </div>
      </div>
    </header>
  );
}

/** The signed-in frame: header and navigation. Signed-out visitors go to sign-up. */
export function AppShell({ children }: { children: ReactNode }) {
  const user = useSession();
  const router = useRouter();
  useEffect(() => {
    if (user === null) router.replace('/signup');
  }, [user, router]);
  if (!user) return null;
  return (
    <LeaveGuardProvider>
      <Header />
      <main className="app-main">{children}</main>
    </LeaveGuardProvider>
  );
}
