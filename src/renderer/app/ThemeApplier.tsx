import { useEffect } from 'react';
import { useUiStore } from '../stores/uiStore';

export function ThemeApplier() {
  const theme = useUiStore((s) => s.theme);
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);
  return null;
}
