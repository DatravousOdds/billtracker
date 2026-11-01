let toastTimer: number | undefined;

/** A short message at the bottom of the screen. Outside React so any code can call it. */
export function toast(message: string, kind: 'ok' | 'error' = 'ok'): void {
  let el = document.getElementById('toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
  }
  // showModal's top layer hides body, so errors go in the open sheet (blurred so the keyboard can't cover them). A success's sheet is about to unmount, so it stays on body.
  const sheet = kind === 'error' ? [...document.querySelectorAll('dialog[open]')].pop() : null;
  (sheet ?? document.body).append(el);
  if (sheet && document.activeElement instanceof HTMLElement) document.activeElement.blur();
  el.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  el.textContent = message;
  el.className = `show ${kind}`;
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (el!.className = ''), 3200);
}

export function errorMessage(err: unknown): string {
  if (err && typeof err === 'object' && 'message' in err) return String((err as { message: unknown }).message);
  return String(err);
}
