// Tiny DOM helpers — no framework needed.

/** Escape text for safe use inside HTML strings. */
export function esc(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Build an element from an HTML string. */
export function html(markup: string): HTMLElement {
  const t = document.createElement('template');
  t.innerHTML = markup.trim();
  return t.content.firstElementChild as HTMLElement;
}

export function $(root: ParentNode, selector: string): HTMLElement {
  const el = root.querySelector(selector);
  if (!el) throw new Error(`Missing element ${selector}`);
  return el as HTMLElement;
}

/**
 * Click handling by data-action attribute:
 *   <button data-action="pay" data-id="123">
 *   on(root, { pay: (el) => ... })
 */
export function on(root: HTMLElement, handlers: Record<string, (el: HTMLElement, e: Event) => void>): void {
  root.addEventListener('click', (e) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>('[data-action]');
    if (!el || !root.contains(el)) return;
    const fn = handlers[el.dataset.action!];
    if (fn) {
      e.preventDefault();
      fn(el, e);
    }
  });
}

let toastTimer: number | undefined;
export function toast(message: string, kind: 'ok' | 'error' = 'ok'): void {
  let el = document.getElementById('toast');
  if (!el) {
    el = html('<div id="toast" role="status" aria-live="polite"></div>');
    document.body.append(el);
  }
  el.textContent = message;
  el.className = `show ${kind}`;
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (el!.className = ''), 3200);
}

/** Show a bottom-sheet dialog. Resolves when it closes. */
export function sheet(title: string, body: HTMLElement): { close: () => void; el: HTMLDialogElement } {
  const dialog = html(`
    <dialog class="sheet">
      <div class="sheet-head">
        <h2>${esc(title)}</h2>
        <button class="icon-btn" data-close aria-label="Close">✕</button>
      </div>
    </dialog>`) as HTMLDialogElement;
  dialog.append(body);
  document.body.append(dialog);
  const close = () => {
    dialog.close();
    dialog.remove();
    // The dialog's own 'close' event fires after it's removed, so it never reaches
    // document listeners. Announce it here instead.
    document.dispatchEvent(new Event('sheetclose'));
  };
  dialog.querySelector('[data-close]')!.addEventListener('click', close);
  dialog.addEventListener('click', (e) => {
    if (e.target === dialog) close(); // tap on backdrop
  });
  dialog.addEventListener('cancel', (e) => {
    e.preventDefault();
    close();
  });
  dialog.showModal();
  return { close, el: dialog };
}

export function confirmSheet(title: string, message: string, okLabel = 'Confirm', danger = false): Promise<boolean> {
  return new Promise((resolve) => {
    const body = html(`
      <div class="sheet-body">
        <p>${esc(message)}</p>
        <div class="row-actions">
          <button class="btn ghost" data-no>Cancel</button>
          <button class="btn ${danger ? 'danger' : 'primary'}" data-yes>${esc(okLabel)}</button>
        </div>
      </div>`);
    let answered = false;
    const s = sheet(title, body);
    const finish = (v: boolean) => {
      answered = true;
      s.close();
      resolve(v);
    };
    body.querySelector('[data-yes]')!.addEventListener('click', () => finish(true));
    body.querySelector('[data-no]')!.addEventListener('click', () => finish(false));
    s.el.addEventListener('close', () => !answered && resolve(false));
  });
}

/** Run an async action, disabling the button and showing errors as a toast. */
export async function busy<T>(button: HTMLElement | null, fn: () => Promise<T>): Promise<T | undefined> {
  if (button) button.setAttribute('disabled', '');
  try {
    return await fn();
  } catch (err) {
    toast(errorMessage(err), 'error');
    return undefined;
  } finally {
    if (button) button.removeAttribute('disabled');
  }
}

export function errorMessage(err: unknown): string {
  if (err && typeof err === 'object' && 'message' in err) return String((err as { message: unknown }).message);
  return String(err);
}
