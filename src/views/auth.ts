import { supabase } from '../supabase';
import { createHousehold, joinHousehold } from '../store';
import { busy, html, on, toast } from '../ui/dom';

export function authView(): HTMLElement {
  let mode: 'in' | 'up' = 'in';
  const el = html(`
    <section class="auth">
      <div class="brand"><span class="logo" aria-hidden="true">◐</span> Bill Split</div>
      <p class="muted">Shared bills, split fairly by income.</p>
      <form class="card form">
        <div class="seg full" role="tablist">
          <button type="button" class="on" data-action="mode" data-mode="in">Sign in</button>
          <button type="button" data-action="mode" data-mode="up">Create account</button>
        </div>
        <label>Email <input name="email" type="email" autocomplete="email" required></label>
        <label>Password <input name="password" type="password" autocomplete="current-password" minlength="6" required></label>
        <button class="btn primary block" type="submit">Sign in</button>
        <p class="muted small msg" hidden></p>
      </form>
    </section>`);
  const form = el.querySelector('form')!;
  const submit = form.querySelector('button[type=submit]') as HTMLButtonElement;
  const msg = form.querySelector('.msg') as HTMLElement;

  on(el, {
    mode: (b) => {
      mode = b.dataset.mode as 'in' | 'up';
      form.querySelectorAll('[data-action=mode]').forEach((x) => x.classList.toggle('on', x === b));
      submit.textContent = mode === 'in' ? 'Sign in' : 'Create account';
      (form.querySelector('[name=password]') as HTMLInputElement).autocomplete = mode === 'in' ? 'current-password' : 'new-password';
      msg.hidden = true;
    },
  });

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const f = new FormData(form);
    const email = String(f.get('email')).trim();
    const password = String(f.get('password'));
    busy(submit, async () => {
      // Send people back to this app (not Supabase's default Site URL) after they click the email link.
      const emailRedirectTo = location.origin + location.pathname;
      if (mode === 'in') {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error?.code === 'email_not_confirmed') {
          const { error: resendError } = await supabase.auth.resend({ type: 'signup', email, options: { emailRedirectTo } });
          if (resendError) throw resendError;
          msg.hidden = false;
          msg.textContent = `Confirm your email first. We sent a new link to ${email}.`;
          return;
        }
        if (error) throw error;
      } else {
        const { data, error } = await supabase.auth.signUp({ email, password, options: { emailRedirectTo } });
        if (error) throw error;
        if (!data.session) {
          msg.hidden = false;
          msg.textContent = `Check ${email} for a confirmation link, then sign in.`;
        }
      }
    });
  });
  return el;
}

export function onboardingView(onDone: () => void): HTMLElement {
  const el = html(`
    <section class="auth">
      <div class="brand"><span class="logo" aria-hidden="true">◐</span> Welcome</div>
      <p class="muted">One of you creates the household. The other joins with its invite code.</p>

      <form class="card form" data-form="create">
        <h2>Start a household</h2>
        <label>Your name <input name="display_name" required maxlength="40" placeholder="Alex"></label>
        <label>Household name <input name="name" maxlength="60" placeholder="Our household"></label>
        <button class="btn primary block" type="submit">Create</button>
      </form>

      <div class="or"><span>or</span></div>

      <form class="card form" data-form="join">
        <h2>Join your partner</h2>
        <label>Your name <input name="display_name" required maxlength="40" placeholder="Sam"></label>
        <label>Invite code <input name="code" required maxlength="6" autocapitalize="characters" placeholder="A1B2C3" class="code-input"></label>
        <button class="btn block" type="submit">Join</button>
      </form>

      <button class="btn ghost block" data-action="signout">Sign out</button>
    </section>`);

  on(el, { signout: () => supabase.auth.signOut() });

  el.addEventListener('submit', (e) => {
    e.preventDefault();
    const form = e.target as HTMLFormElement;
    const f = new FormData(form);
    const name = String(f.get('display_name')).trim();
    busy(form.querySelector('button[type=submit]'), async () => {
      if (form.dataset.form === 'create') await createHousehold(String(f.get('name') ?? ''), name);
      else await joinHousehold(String(f.get('code')), name);
      toast(`Welcome, ${name}!`);
      onDone();
    });
  });
  return el;
}
