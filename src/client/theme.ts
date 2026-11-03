export type ThemeMode = 'light' | 'dark' | 'system';

export const THEME_STORAGE_KEY = 'ptw_theme_mode';

export function resolveEffectiveTheme(
  mode: ThemeMode,
  systemPrefersDark: boolean,
): 'light' | 'dark' {
  if (mode === 'light' || mode === 'dark') {
    return mode;
  }
  return systemPrefersDark ? 'dark' : 'light';
}

export function loadThemeMode(storage: Pick<Storage, 'getItem'>): ThemeMode {
  const val = storage.getItem(THEME_STORAGE_KEY);
  if (val === 'light' || val === 'dark' || val === 'system') {
    return val;
  }
  return 'system';
}

export function saveThemeMode(storage: Pick<Storage, 'setItem'>, mode: ThemeMode): void {
  storage.setItem(THEME_STORAGE_KEY, mode);
}
