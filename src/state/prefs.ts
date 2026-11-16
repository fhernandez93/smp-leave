/** Per-viewer conveniences only (remembered tab, year, roster entry). Never shared state. */
const PREFIX = "smpleave:";

export function pref(key: string): string | null {
  try {
    return localStorage.getItem(PREFIX + key);
  } catch {
    return null;
  }
}

export function setPref(key: string, value: string): void {
  try {
    localStorage.setItem(PREFIX + key, value);
  } catch {
    /* storage unavailable: never fatal */
  }
}
