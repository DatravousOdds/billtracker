import { useEffect, useRef, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';

/** A bottom-sheet dialog. Render it to open it; onClose fires on ✕, backdrop tap or Escape. */
export function Sheet({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (!ref.current?.open) ref.current?.showModal();
  }, []);
  return (
    <dialog
      ref={ref}
      className="sheet"
      onClick={(e) => e.target === e.currentTarget && onClose()} // tap on backdrop
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      <div className="sheet-head">
        <h2>{title}</h2>
        <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>✕</button>
      </div>
      {children}
    </dialog>
  );
}

/** Ask a yes/no question in a sheet. Resolves true only if the user confirms. */
export function confirmSheet(title: string, message: string, okLabel = 'Confirm', danger = false): Promise<boolean> {
  return new Promise((resolve) => {
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      resolve(ok);
      // Unmount after this click finishes; React can't unmount a root from inside its own event.
      setTimeout(() => {
        root.unmount();
        host.remove();
      });
    };
    root.render(
      <Sheet title={title} onClose={() => finish(false)}>
        <div className="sheet-body">
          <p>{message}</p>
          <div className="row-actions">
            <button type="button" className="btn ghost" onClick={() => finish(false)}>Cancel</button>
            <button type="button" className={`btn ${danger ? 'danger' : 'primary'}`} onClick={() => finish(true)}>{okLabel}</button>
          </div>
        </div>
      </Sheet>,
    );
  });
}
