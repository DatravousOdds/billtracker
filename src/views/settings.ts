import type { WeeklyMode } from '../types';
import { getState, updateHousehold, updateMember } from '../store';
import { supabase } from '../supabase';
import { busy, esc, html, on, toast } from '../ui/dom';

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

      <button class="btn danger-ghost block" data-action="signout">Sign out</button>
    </section>`);

  on(el, {
    copy: async () => {
      try {
        await navigator.clipboard.writeText(h.invite_code);
        toast('Invite code copied');
      } catch {
        toast(`Code: ${h.invite_code}`);
      }
    },
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
