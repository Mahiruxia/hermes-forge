import type { PersistStorage, StateStorage } from "zustand/middleware";

/** Browser storage is a preference cache; losing access must not break a chat. */
export function createResilientStorage<T>(getStorage: () => Storage = () => localStorage): PersistStorage<T> {
  const storage = createResilientTextStorage(getStorage);
  return {
    getItem(name) {
      const raw = storage.getItem(name);
      if (!raw) return null;
      try { return JSON.parse(raw); } catch { return null; }
    },
    setItem(name, value) { storage.setItem(name, JSON.stringify(value)); },
    removeItem(name) { storage.removeItem(name); },
  };
}

export function createResilientTextStorage(getStorage: () => Storage = () => localStorage) {
  const fallback = new Map<string, string | null>();
  return {
    getItem(name: string): string | null {
      if (fallback.has(name)) return fallback.get(name) ?? null;
      try { return getStorage().getItem(name); } catch { return null; }
    },
    setItem(name: string, value: string) {
      try {
        getStorage().setItem(name, value);
        fallback.delete(name);
      } catch { fallback.set(name, value); }
    },
    removeItem(name: string) {
      try {
        getStorage().removeItem(name);
        fallback.delete(name);
      } catch { fallback.set(name, null); }
    },
  } satisfies StateStorage;
}

export const preferenceStorage = createResilientTextStorage();
