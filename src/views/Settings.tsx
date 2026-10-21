import { useEffect, useState, type FormEvent } from 'react';
import type { WeeklyMode } from '../types';
import { loadUsers, role, setRole, type AdminUser, type Role } from '../admin';
import { isDemo } from '../demo';
import { leaveHousehold, updateHousehold, updateMember } from '../store';
import { supabase } from '../supabase';
import { useAppState, useBusy } from '../ui/hooks';
import { AsyncButton } from '../ui/parts';
import { confirmSheet } from '../ui/Sheet';
import { errorMessage, toast } from '../ui/toast';

export function SettingsView() {
  const s = useAppState();
  const me = s.members.find((m) => m.user_id === s.userId)!;
  const h = s.household;
  const [savingHousehold, runHousehold] = useBusy();
  const [savingName, runName] = useBusy();

  const saveHousehold = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    runHousehold(async () => {
      await updateHousehold({
        name: String(f.get('name')).trim() || 'Our household',
        weekly_mode: f.get('weekly_mode') as WeeklyMode,
      });
      toast('Household saved');
    });
  };

  const saveName = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const name = String(new FormData(e.currentTarget).get('display_name')).trim();
    runName(async () => {
      await updateMember(s.userId, { display_name: name });
      toast('Name saved');
    });
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(h.invite_code);
      toast('Invite code copied');
    } catch {
      toast(`Code: ${h.invite_code}`);
    }
  };

  const leave = async () => {
    const alone = s.members.length === 1;
    const ok = await confirmSheet('Leave household?', alone
      ? `You're the only partner, so this deletes ${h.name} and all its bills and history. It can't be undone.`
      : 'You stop splitting bills. Your deposits and paychecks are deleted and your personal bills become shared. You can start or join a household again.',
    'Leave', true);
    if (!ok) return;
    await leaveHousehold();
    location.hash = '';
    location.reload(); // boot finds no household and shows onboarding
  };

  return (
    <section className="view">
      <div className="view-head"><h1>Settings</h1></div>

      {/* Keyed on the saved values so a partner's change shows up. */}
      <form className="card form" onSubmit={saveHousehold} key={`${h.name}|${h.weekly_mode}`}>
        <h2>Household</h2>
        <label>Name <input name="name" defaultValue={h.name} maxLength={60} /></label>

        <fieldset>
          <legend>Weekly amounts</legend>
          <label className="radio"><input type="radio" name="weekly_mode" value="smoothed" defaultChecked={h.weekly_mode === 'smoothed'} />
            <span><strong>Smoothed</strong><br /><span className="muted small">Same amount every week (monthly bills × 12 ÷ 52) into a shared bill account.</span></span></label>
          <label className="radio"><input type="radio" name="weekly_mode" value="due" defaultChecked={h.weekly_mode === 'due'} />
            <span><strong>Pay as due</strong><br /><span className="muted small">Split only the unpaid bills actually due, plus anything overdue. With a payday saved, you deposit on payday for the bills due until your next one.</span></span></label>
        </fieldset>

        <button className="btn primary" type="submit" disabled={savingHousehold}>Save household</button>
      </form>

      <div className="card">
        <h2>Invite your partner</h2>
        <p className="muted small">They create an account, choose "Join," and enter this code.</p>
        <div className="invite">
          <code>{h.invite_code}</code>
          <button type="button" className="btn ghost sm" onClick={copy}>Copy</button>
        </div>
        <p className="muted small">{s.members.length}/2 partners joined.</p>
      </div>

      <form className="card form" onSubmit={saveName} key={me.display_name}>
        <h2>You</h2>
        <label>Your name <input name="display_name" defaultValue={me.display_name} maxLength={40} required /></label>
        <button className="btn ghost" type="submit" disabled={savingName}>Save name</button>
      </form>

      {role === 'admin' && <RolesCard myId={s.userId} />}
      {role && <a href="#/admin" className="btn ghost block">Open {role === 'admin' ? 'admin' : 'support'}</a>}

      {!isDemo && <AsyncButton className="btn danger-ghost block" onClick={leave}>Leave household</AsyncButton>}
      <button type="button" className="btn danger-ghost block" onClick={() => supabase.auth.signOut()}>Sign out</button>
    </section>
  );
}

const ROLE_LABEL: Record<Role | 'user', string> = { user: 'User', support: 'Support', admin: 'Admin' };

// Kept between visits to Settings so the list doesn't reload every time.
let rolesCache: { users: AdminUser[]; at: number } | null = null;

/** Admin-only card: pick each account's role. The database re-checks every change (admin_set_role). */
function RolesCard({ myId }: { myId: string }) {
  const [users, setUsers] = useState<AdminUser[] | null>(rolesCache?.users ?? null);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [saving, setSaving] = useState<string | null>(null);

  useEffect(() => {
    if (rolesCache && Date.now() - rolesCache.at <= 30_000) return;
    loadUsers()
      .then((list) => {
        rolesCache = { users: list, at: Date.now() };
        setUsers(list);
      })
      .catch((err) => setError(errorMessage(err)));
  }, []);

  if (error) return <div className="card form"><h2>Account roles</h2><p className="empty">Couldn't load accounts: {error}</p></div>;
  if (!users) return <div className="card form"><h2>Account roles</h2><p className="muted small">Loading…</p></div>;

  const change = async (u: AdminUser, next: Role | 'user') => {
    if (next === 'admin' && !await confirmSheet('Make admin?',
      `${u.email} will be able to see, edit and delete every household's data, delete accounts, and change roles.`, 'Make admin', true)) return;
    setSaving(u.user_id);
    try {
      await setRole(u.user_id, next);
      const updated = users.map((x) => (x.user_id === u.user_id ? { ...x, role: next === 'user' ? null : next } : x));
      rolesCache = { users: updated, at: rolesCache?.at ?? Date.now() };
      setUsers(updated);
      toast(`${u.email} is now ${ROLE_LABEL[next]}`);
    } catch (err) {
      toast(errorMessage(err), 'error');
    } finally {
      setSaving(null);
    }
  };

  const q = query.trim().toLowerCase();
  return (
    <div className="card form">
      <h2>Account roles</h2>
      <p className="muted small">Admin: full access, including roles. Support: can view every household and reset invite codes, no edits. User: their own household only.</p>
      <label>Find an account <input type="search" placeholder="Email or name" autoComplete="off" value={query} onChange={(e) => setQuery(e.target.value)} /></label>
      <ul className="list">
        {users.filter((u) => `${u.email} ${u.display_name ?? ''}`.toLowerCase().includes(q)).map((u) => {
          const current = u.role ?? 'user';
          return (
            <li className="occ" key={u.user_id}>
              <div className="occ-main">
                <div className="occ-name">{u.email}</div>
                <div className="occ-sub">{u.display_name ?? 'No household'}</div>
              </div>
              {u.user_id === myId
                ? <span className="muted small">{ROLE_LABEL[current]} (you)</span>
                : (
                  // Controlled by the saved role, so a cancelled or failed change snaps back.
                  <select value={current} disabled={saving === u.user_id} aria-label={`Role for ${u.email}`}
                    onChange={(e) => change(u, e.target.value as Role | 'user')}>
                    {(['user', 'support', 'admin'] as const).map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
                  </select>
                )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
