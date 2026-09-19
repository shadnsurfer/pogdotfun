import { useSyncExternalStore } from 'react';

const query = '(prefers-reduced-motion: reduce)';
const subscribers = new Set<() => void>();
let preference: MediaQueryList | undefined;

function currentPreference() {
  if (!preference && typeof window !== 'undefined') preference = window.matchMedia(query);
  return preference;
}

function notifySubscribers() {
  for (const notify of subscribers) notify();
}

function subscribe(notify: () => void) {
  const media = currentPreference();
  if (subscribers.size === 0) media?.addEventListener('change', notifySubscribers);
  subscribers.add(notify);
  return () => {
    subscribers.delete(notify);
    if (subscribers.size === 0) media?.removeEventListener('change', notifySubscribers);
  };
}

function getSnapshot() {
  return currentPreference()?.matches ?? true;
}

export function useReducedMotionPreference(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, () => true);
}
