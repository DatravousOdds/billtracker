import './style.css';
import { isConfigured, supabase } from './supabase';
import { demoSwitchUser, findMyHousehold, getState, load, loadDemo, stopRealtime, subscribe } from './store';
import { todayISO } from './logic/dates';
import { needsConfirming } from './logic/split';
import { isDemo } from './demo';
import { esc, html } from './ui/dom';
import { authView, onboardingView } from './views/auth';
import { billsView } from './views/bills';
import { dashboardView } from './views/dashboard';
import { historyView } from './views/history';
import { incomeView } from './views/income';
import { settingsView } from './views/settings';
import { upcomingView } from './views/upcoming';

const app = document.getElementById('app')!;

const routes: Record<string, { label: string; icon: string; view: () => HTMLElement; nav: boolean }> = {
  '': { label: 'This week', icon: '◷', view: dashboardView, nav: true },
  bills: { label: 'Bills', icon: '☰', view: billsView, nav: true },
  upcoming: { label: 'Upcoming', icon: '▦', view: upcomingView, nav: true },
  income: { label: 'Income', icon: '$', view: incomeView, nav: true },
  history: { label: 'History', icon: '↺', view: historyView, nav: true },
  settings: { label: 'Settings', icon: '⚙', view: settingsView, nav: false },
};

function currentRoute(): string {
  const r = location.hash.replace(/^#\/?/, '');
  return r in routes ? r : '';
}

let unsubscribe: (() => void) | null = null;

function renderShell() {
  const s = getState();
  const route = currentRoute();
  const pending = s.requests.filter((r) => r.status === 'pending' && r.requested_by !== s.userId).length;
  const toConfirm = needsConfirming(s.bills, s.payments, todayISO()).length;
  const waiting = pending + toConfirm;
  document.title = waiting ? `(${waiting}) Bill Split` : 'Bill Split';

  // Keep scroll position and any open sheet when your partner's change triggers a re-render.
  const scrollY = window.scrollY;
  const shell = html(`
    <div class="shell">
      ${isDemo ? `
        <div class="demo-bar">
          <span>Demo · viewing as <strong>${esc(s.members.find((m) => m.user_id === s.userId)!.display_name)}</strong></span>
          <button class="btn sm" data-demo-switch>Switch to ${esc(s.members.find((m) => m.user_id !== s.userId)!.display_name)}'s phone</button>
        </div>` : ''}
      <header class="top">
        <span class="top-title">${esc(s.household.name)}</span>
        <a href="#/settings" class="icon-btn ${route === 'settings' ? 'on' : ''}" aria-label="Settings">⚙</a>
      </header>
      <main id="main"></main>
      <nav class="tabs" aria-label="Main">
        ${Object.entries(routes).filter(([, r]) => r.nav).map(([key, r]) => `
          <a href="#/${key}" class="${route === key ? 'on' : ''}" ${route === key ? 'aria-current="page"' : ''}>
            <span class="tab-icon" aria-hidden="true">${r.icon}</span>
            <span>${r.label}</span>
            ${key === '' && waiting ? `<span class="dot" aria-label="${waiting} waiting for you">${waiting}</span>` : ''}
          </a>`).join('')}
      </nav>
    </div>`);
  shell.querySelector('#main')!.append(routes[route].view());
  shell.querySelector('[data-demo-switch]')?.addEventListener('click', demoSwitchUser);
  app.replaceChildren(shell);
  window.scrollTo(0, scrollY);
}

async function boot() {
  if (isDemo) {
    unsubscribe = subscribe(() => {
      if (document.querySelector('dialog[open]')) return;
      renderShell();
    });
    loadDemo();
    return;
  }
  if (!isConfigured) {
    app.replaceChildren(html(`
      <section class="auth">
        <div class="brand">Setup needed</div>
        <div class="card">
          <p>Create a <code>.env</code> file with your Supabase project URL and anon key, then restart:</p>
          <pre>VITE_SUPABASE_URL=https://xxxx.supabase.co
VITE_SUPABASE_ANON_KEY=eyJ...</pre>
          <p class="muted small">See README.md for the full steps.</p>
        </div>
      </section>`));
    return;
  }

  const { data } = await supabase.auth.getSession();
  await route(data.session?.user.id ?? null);

  supabase.auth.onAuthStateChange((event, session) => {
    if (event === 'SIGNED_IN' || event === 'SIGNED_OUT') route(session?.user.id ?? null);
  });
}

let activeUser: string | null | undefined;

async function route(userId: string | null) {
  if (userId === activeUser) return;
  activeUser = userId;
  unsubscribe?.();
  unsubscribe = null;
  await stopRealtime();

  if (!userId) {
    app.replaceChildren(authView());
    return;
  }

  app.replaceChildren(html('<div class="loading">Loading…</div>'));
  try {
    const householdId = await findMyHousehold(userId);
    if (!householdId) {
      app.replaceChildren(onboardingView(() => {
        activeUser = undefined;
        // The split depends on income, so new members set theirs first.
        location.hash = '#/income';
        route(userId);
      }));
      return;
    }
    unsubscribe = subscribe(() => {
      // Don't yank the screen out from under an open form sheet; it re-renders when closed.
      if (document.querySelector('dialog[open]')) return;
      renderShell();
    });
    await load(userId, householdId);
  } catch (err) {
    app.replaceChildren(html(`<div class="loading">Couldn't load: ${esc((err as Error).message)}</div>`));
  }
}

window.addEventListener('hashchange', () => {
  if (unsubscribe) renderShell();
});

// When a sheet closes, catch up on anything that changed while it was open.
document.addEventListener('sheetclose', () => {
  if (unsubscribe) setTimeout(renderShell, 0);
});

boot();
