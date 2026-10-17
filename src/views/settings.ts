import type { WeeklyMode } from '../types';
import { loadUsers, role, setRole, type AdminUser, type Role } from '../admin';
import { isDemo } from '../demo';
import { getState, leaveHousehold, updateHousehold, updateMember } from '../store';
import { supabase } from '../supabase';
import { busy, confirmSheet, errorMessage, esc, html, on, toast } from '../ui/dom';

export function settingsView(): HTMLElement {
  const s = getState();
  const me = s.members.find((m) => m.user_id === s.userId)!;
  const h = s.household;

  const el = html(`
    <section class="view">
      <div class="view-head"><h1>Settings</h1></div>

      <form class="card form" data-form="household">
        <h2>Household</h2>
        <label>Name <input name="name" value="${esc(h.name)}" maxlength="60"></label>

        <fieldset>
          <legend>Weekly amounts</legend>
          <label class="radio"><input type="radio" name="weekly_mode" value="smoothed" ${h.weekly_mode === 'smoothed' ? 'checked' : ''}>
            <span><strong>Smoothed</strong><br><span class="muted small">Same amount every week (monthly bills × 12 ÷ 52) into a shared bill account.</span></span></label>
          <label class="radio"><input type="radio" name="weekly_mode" value="due" ${h.weekly_mode === 'due' ? 'checked' : ''}>
            <span><strong>Pay as due</strong><br><span class="muted small">Split only the bills due that week.</span></span></label>
        </fieldset>

        <label>Rolling income window (for "log each paycheck")
          <select name="window">
            ${[1, 2, 3, 4, 6, 12].map((n) => `<option value="${n}" ${h.income_window_months === n ? 'selected' : ''}>Last ${n} month${n > 1 ? 's' : ''}</option>`).join('')}
          </select>
        </label>
        <button class="btn primary" type="submit">Save household</button>
      </form>

      <div class="card">
        <h2>Invite your partner</h2>
        <p class="muted small">They create an account, choose "Join," and enter this code.</p>
        <div class="invite">
          <code>${esc(h.invite_code)}</code>
          <button class="btn ghost sm" data-action="copy">Copy</button>
        </div>
        <p class="muted small">${s.members.length}/2 partners joined.</p>
      </div>

      <form class="card form" data-form="me">
        <h2>You</h2>
        <label>Your name <input name="display_name" value="${esc(me.display_name)}" maxlength="40" required></label>
        <button class="btn ghost" type="submit">Save name</button>
      </form>

      ${role === 'admin' ? '<div class="card form" data-roles><h2>Account roles</h2><p class="muted small">Loading…</p></div>' : ''}
      ${role ? `<a href="#/admin" class="btn ghost block">Open ${role === 'admin' ? 'admin' : 'support'}</a>` : ''}

      ${isDemo ? '' : '<button class="btn danger-ghost block" data-action="leave">Leave household</button>'}
      <button class="btn danger-ghost block" data-action="signout">Sign out</button>
    </section>`);

  const rolesCard = el.querySelector<HTMLElement>('[data-roles]');
  if (rolesCard) fillRoles(rolesCard, s.userId);

  on(el, {
    copy: async () => {
      try {
        await navigator.clipboard.writeText(h.invite_code);
        toast('Invite code copied');
      } catch {
        toast(`Code: ${h.invite_code}`);
      }
    },
    leave: (b) => busy(b, async () => {
      const alone = s.members.length === 1;
      const ok = await confirmSheet('Leave household?', alone
        ? `You're the only partner, so this deletes ${h.name} and all its bills and history. It can't be undone.`
        : 'You stop splitting bills. Your deposits and paychecks are deleted and your personal bills become shared. You can start or join a household again.',
      'Leave', true);
      if (!ok) return;
      await leaveHousehold();
      location.hash = '';
      location.reload(); // boot finds no household and shows onboarding
    }),
    signout: async () => {
      await supabase.auth.signOut();
    },
  });

  el.addEventListener('submit', (e) => {
    e.preventDefault();
    const form = e.target as HTMLFormElement;
    const f = new FormData(form);
    const btn = form.querySelector('button[type=submit]') as HTMLElement;
    if (form.dataset.form === 'household') {
      busy(btn, async () => {
        await updateHousehold({
          name: String(f.get('name')).trim() || 'Our household',
          weekly_mode: f.get('weekly_mode') as WeeklyMode,
          income_window_months: Number(f.get('window')),
        });
        toast('Household saved');
      });
    } else {
      busy(btn, async () => {
        await updateMember(s.userId, { display_name: String(f.get('display_name')).trim() });
        toast('Name saved');
      });
    }
  });
  return el;
}

const ROLE_LABEL: Record<Role | 'user', string> = { user: 'User', support: 'Support', admin: 'Admin' };

// Settings redraws on every partner change, so keep the account list and search text between redraws.
let rolesCache: { users: AdminUser[]; at: number } | null = null;
let rolesQuery = '';

/** Admin-only card: pick each account's role. The database re-checks every change (admin_set_role). */
async function fillRoles(card: HTMLElement, myId: string) {
  try {
    if (!rolesCache || Date.now() - rolesCache.at > 30_000) rolesCache = { users: await loadUsers(), at: Date.now() };
    const { users } = rolesCache;
    card.innerHTML = `
      <h2>Account roles</h2>
      <p class="muted small">Admin: full access, including roles. Support: can view every household and reset invite codes, no edits. User: their own household only.</p>
      <label>Find an account <input type="search" data-role-search placeholder="Email or name" autocomplete="off" value="${esc(rolesQuery)}"></label>
      <ul class="list">${users.map((u) => {
        const current = u.role ?? 'user';
        return `
        <li class="occ" data-match="${esc(`${u.email} ${u.display_name ?? ''}`.toLowerCase())}" ${matches(u, rolesQuery) ? '' : 'style="display:none"'}>
          <div class="occ-main">
            <div class="occ-name">${esc(u.email)}</div>
            <div class="occ-sub">${esc(u.display_name ?? 'No household')}</div>
          </div>
          ${u.user_id === myId
            ? `<span class="muted small">${ROLE_LABEL[current]} (you)</span>`
            : `<select data-role-user="${esc(u.user_id)}" data-current="${current}" aria-label="Role for ${esc(u.email)}">
                ${(['user', 'support', 'admin'] as const).map((r) => `<option value="${r}" ${r === current ? 'selected' : ''}>${ROLE_LABEL[r]}</option>`).join('')}
              </select>`}
        </li>`;
      }).join('')}</ul>`;
  } catch (err) {
    card.innerHTML = `<h2>Account roles</h2><p class="empty">Couldn't load accounts: ${esc(errorMessage(err))}</p>`;
    return;
  }

  // Filter without re-rendering, so the search box keeps focus.
  card.addEventListener('input', (e) => {
    const input = e.target as HTMLInputElement;
    if (!input.matches('[data-role-search]')) return;
    rolesQuery = input.value;
    const q = rolesQuery.trim().toLowerCase();
    card.querySelectorAll<HTMLElement>('[data-match]').forEach((li) => { li.style.display = li.dataset.match!.includes(q) ? '' : 'none'; });
  });

  card.addEventListener('change', async (e) => {
    const select = e.target as HTMLSelectElement;
    if (!select.dataset.roleUser) return;
    const next = select.value as Role | 'user';
    const email = select.closest('li')!.querySelector('.occ-name')!.textContent;
    if (next === 'admin' && !await confirmSheet('Make admin?',
      `${email} will be able to see, edit and delete every household's data, delete accounts, and change roles.`, 'Make admin', true)) {
      select.value = select.dataset.current!;
      return;
    }
    const saved = await busy(select, async () => {
      await setRole(select.dataset.roleUser!, next);
      return true;
    });
    if (saved) {
      select.dataset.current = next;
      const u = rolesCache?.users.find((x) => x.user_id === select.dataset.roleUser);
      if (u) u.role = next === 'user' ? null : next;
      toast(`${email} is now ${ROLE_LABEL[next]}`);
    } else {
      select.value = select.dataset.current!;
    }
  });
}

function matches(u: AdminUser, query: string): boolean {
  return `${u.email} ${u.display_name ?? ''}`.toLowerCase().includes(query.trim().toLowerCase());
}
