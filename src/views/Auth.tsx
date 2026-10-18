import { useState, type FormEvent } from 'react';
import { supabase } from '../supabase';
import { createHousehold, joinHousehold } from '../store';
import { useBusy } from '../ui/hooks';
import { toast } from '../ui/toast';

export function AuthView() {
  const [mode, setMode] = useState<'in' | 'up'>('in');
  const [msg, setMsg] = useState('');
  const [busy, run] = useBusy();

  const pick = (m: 'in' | 'up') => {
    setMode(m);
    setMsg('');
  };

  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const email = String(f.get('email')).trim();
    const password = String(f.get('password'));
    run(async () => {
      // Send people back to this app (not Supabase's default Site URL) after they click the email link.
      const emailRedirectTo = location.origin + location.pathname;
      if (mode === 'in') {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error?.code === 'email_not_confirmed') {
          const { error: resendError } = await supabase.auth.resend({ type: 'signup', email, options: { emailRedirectTo } });
          if (resendError) throw resendError;
          setMsg(`Confirm your email first. We sent a new link to ${email}.`);
          return;
        }
        if (error) throw error;
      } else {
        const { data, error } = await supabase.auth.signUp({ email, password, options: { emailRedirectTo } });
        if (error) throw error;
        if (!data.session) setMsg(`Check ${email} for a confirmation link, then sign in.`);
      }
    });
  };

  return (
    <section className="auth">
      <div className="brand"><span className="logo" aria-hidden="true">◐</span> Bill Split</div>
      <p className="muted">Shared bills, split fairly by income.</p>
      <form className="card form" onSubmit={submit}>
        <div className="seg full" role="tablist">
          <button type="button" className={mode === 'in' ? 'on' : ''} onClick={() => pick('in')}>Sign in</button>
          <button type="button" className={mode === 'up' ? 'on' : ''} onClick={() => pick('up')}>Create account</button>
        </div>
        <label>Email <input name="email" type="email" autoComplete="email" required /></label>
        <label>Password <input name="password" type="password" autoComplete={mode === 'in' ? 'current-password' : 'new-password'} minLength={6} required /></label>
        <button className="btn primary block" type="submit" disabled={busy}>{mode === 'in' ? 'Sign in' : 'Create account'}</button>
        {msg && <p className="muted small msg">{msg}</p>}
      </form>
    </section>
  );
}

export function OnboardingView({ onDone }: { onDone: () => void }) {
  const [busy, run] = useBusy();

  const submit = (kind: 'create' | 'join') => (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const name = String(f.get('display_name')).trim();
    run(async () => {
      if (kind === 'create') await createHousehold(String(f.get('name') ?? ''), name);
      else await joinHousehold(String(f.get('code')), name);
      toast(`Welcome, ${name}!`);
      onDone();
    });
  };

  return (
    <section className="auth">
      <div className="brand"><span className="logo" aria-hidden="true">◐</span> Welcome</div>
      <p className="muted">One of you creates the household. The other joins with its invite code.</p>

      <form className="card form" onSubmit={submit('create')}>
        <h2>Start a household</h2>
        <label>Your name <input name="display_name" required maxLength={40} placeholder="Alex" /></label>
        <label>Household name <input name="name" maxLength={60} placeholder="Our household" /></label>
        <button className="btn primary block" type="submit" disabled={busy}>Create</button>
      </form>

      <div className="or"><span>or</span></div>

      <form className="card form" onSubmit={submit('join')}>
        <h2>Join your partner</h2>
        <label>Your name <input name="display_name" required maxLength={40} placeholder="Sam" /></label>
        <label>Invite code <input name="code" required maxLength={6} autoCapitalize="characters" placeholder="A1B2C3" className="code-input" /></label>
        <button className="btn block" type="submit" disabled={busy}>Join</button>
      </form>

      <button type="button" className="btn ghost block" onClick={() => supabase.auth.signOut()}>Sign out</button>
    </section>
  );
}
