import { useEffect, useRef, useState, type ReactNode } from 'react';
import { isConfigured, supabase } from './supabase';
import { demoSwitchUser, findMyHousehold, load, loadDemo, stopRealtime } from './store';
import { todayISO } from './logic/dates';
import { needsConfirming } from './logic/split';
import { isDemo } from './demo';
import { checkRole, role } from './admin';
import { usePeekState, useRoute } from './ui/hooks';
import { errorMessage } from './ui/toast';
import { AdminPage } from './views/Admin';
import { AuthView, OnboardingView } from './views/Auth';
import { BillsView } from './views/Bills';
import { DashboardView } from './views/Dashboard';
import { HistoryView } from './views/History';
import { IncomeView } from './views/Income';
import { SettingsView } from './views/Settings';
import { SetupView } from './views/Setup';
import { UpcomingView } from './views/Upcoming';

const ROUTES: Record<string, { label: string; icon: string; View: () => ReactNode; nav: boolean }> = {
  '': { label: 'This week', icon: '◷', View: DashboardView, nav: true },
  bills: { label: 'Bills', icon: '☰', View: BillsView, nav: true },
  upcoming: { label: 'Upcoming', icon: '▦', View: UpcomingView, nav: true },
  income: { label: 'Income', icon: '$', View: IncomeView, nav: true },
  history: { label: 'History', icon: '↺', View: HistoryView, nav: true },
  settings: { label: 'Settings', icon: '⚙', View: SettingsView, nav: false },
};

type Screen =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'setup' }
  | { kind: 'auth' }
  | { kind: 'onboarding'; userId: string }
  | { kind: 'staff'; userId: string } // admin or support with no household of their own
  | { kind: 'app' };

export function App() {
  const [screen, setScreen] = useState<Screen>({ kind: 'loading' });
  const reroute = useRef<(userId: string) => void>(() => {});

  useEffect(() => {
    if (isDemo) {
      loadDemo();
      setScreen({ kind: 'app' });
      return;
    }
    if (!isConfigured) {
      setScreen({ kind: 'setup' });
      return;
    }

    let cancelled = false;
    let activeUser: string | null | undefined;

    async function route(userId: string | null, force = false) {
      if (cancelled || (!force && userId === activeUser)) return;
      activeUser = userId;
      setScreen({ kind: 'loading' });
      await stopRealtime();
      if (!userId) return setScreen({ kind: 'auth' });
      try {
        const [householdId] = await Promise.all([findMyHousehold(userId), checkRole()]);
        if (!householdId && role) {
          location.hash = '#/admin';
          return setScreen({ kind: 'staff', userId });
        }
        if (!householdId) return setScreen({ kind: 'onboarding', userId });
        await load(userId, householdId);
        setScreen({ kind: 'app' });
      } catch (err) {
        setScreen({ kind: 'error', message: errorMessage(err) });
      }
    }
    reroute.current = (userId) => route(userId, true);

    supabase.auth.getSession().then(({ data }) => route(data.session?.user.id ?? null));
    const { data: auth } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === 'SIGNED_IN' || event === 'SIGNED_OUT') route(session?.user.id ?? null);
    });
    return () => {
      cancelled = true;
      auth.subscription.unsubscribe();
    };
  }, []);

  switch (screen.kind) {
    case 'loading': return <div className="loading">Loading…</div>;
    case 'error': return <div className="loading">Couldn't load: {screen.message}</div>;
    case 'auth': return <AuthView />;
    case 'staff': return <AdminPage me={{ userId: screen.userId, householdId: null }} />;
    case 'app': return <Shell />;
    case 'onboarding':
      return (
        <OnboardingView onDone={() => {
          // The split depends on income, so new members set theirs first.
          location.hash = '#/setup';
          reroute.current(screen.userId);
        }} />
      );
    case 'setup':
      return (
        <section className="auth">
          <div className="brand">Setup needed</div>
          <div className="card">
            <p>Create a <code>.env</code> file with your Supabase project URL and anon key, then restart:</p>
            <pre>{'VITE_SUPABASE_URL=https://xxxx.supabase.co\nVITE_SUPABASE_ANON_KEY=eyJ...'}</pre>
            <p className="muted small">See README.md for the full steps.</p>
          </div>
        </section>
      );
  }
}

function Shell() {
  const s = usePeekState();
  const hash = useRoute();
  const waiting = s
    ? s.requests.filter((r) => r.status === 'pending' && r.requested_by !== s.userId).length
      + (s.household.split_proposed_by && s.household.split_proposed_by !== s.userId ? 1 : 0)
      + needsConfirming(s.bills, s.payments, todayISO()).length
    : 0;
  useEffect(() => {
    document.title = waiting ? `(${waiting}) Bill Split` : 'Bill Split';
  }, [waiting]);

  // Null for a moment while switching accounts.
  if (!s) return <div className="loading">Loading…</div>;
  if (role !== null && hash === 'admin') return <AdminPage me={{ userId: s.userId, householdId: s.household.id }} />;
  // Full screen, without the tabs, so a new member only sees one question at a time.
  if (hash === 'setup') return <main id="main" key={s.userId}><SetupView /></main>;

  const route = hash in ROUTES ? hash : '';
  const { View } = ROUTES[route];
  const me = s.members.find((m) => m.user_id === s.userId);
  const other = s.members.find((m) => m.user_id !== s.userId);

  return (
    <div className="shell">
      {isDemo && (
        <div className="demo-bar">
          <span>Demo · viewing as <strong>{me?.display_name}</strong></span>
          <button type="button" className="btn sm" onClick={demoSwitchUser}>Switch to {other?.display_name}'s phone</button>
        </div>
      )}
      <header className="top">
        <span className="top-title">{s.household.name}</span>
        <a href="#/settings" className={`icon-btn ${route === 'settings' ? 'on' : ''}`} aria-label="Settings">⚙</a>
      </header>
      {/* Keyed by user so the demo's "switch phone" starts each screen fresh. */}
      <main id="main" key={s.userId}><View /></main>
      <nav className="tabs" aria-label="Main">
        {Object.entries(ROUTES).filter(([, r]) => r.nav).map(([key, r]) => (
          <a key={key} href={`#/${key}`} className={route === key ? 'on' : ''} aria-current={route === key ? 'page' : undefined}>
            <span className="tab-icon" aria-hidden="true">{r.icon}</span>
            <span>{r.label}</span>
            {key === '' && waiting > 0 && <span className="dot" aria-label={`${waiting} waiting for you`}>{waiting}</span>}
          </a>
        ))}
      </nav>
    </div>
  );
}
