import { useState, useSyncExternalStore } from 'react';
import { getState, getVersion, peekState, subscribe, type State } from '../store';
import { errorMessage, toast } from './toast';

/** Household state; re-renders on every change, on this phone or your partner's. Only use once loaded. */
export function useAppState(): State {
  useSyncExternalStore(subscribe, getVersion);
  return getState();
}

/** Like useAppState, but null while signed out or loading. */
export function usePeekState(): State | null {
  useSyncExternalStore(subscribe, getVersion);
  return peekState();
}

const onHashChange = (fn: () => void) => {
  window.addEventListener('hashchange', fn);
  return () => window.removeEventListener('hashchange', fn);
};

/** The current route: '#/bills' → 'bills'. */
export function useRoute(): string {
  return useSyncExternalStore(onHashChange, () => location.hash.replace(/^#\/?/, ''));
}

/** Run an async action, tracking whether it's in flight and showing errors as a toast. */
export function useBusy() {
  const [busy, setBusy] = useState(false);
  async function run<T>(fn: () => Promise<T>): Promise<T | undefined> {
    setBusy(true);
    try {
      return await fn();
    } catch (err) {
      toast(errorMessage(err), 'error');
      return undefined;
    } finally {
      setBusy(false);
    }
  }
  return [busy, run] as const;
}
