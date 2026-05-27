import { useEffect } from 'react';
import { useUiStore } from '../stores/uiStore';

export function ReadingFontSizeApplier() {
  const size = useUiStore((s) => s.readingFontSize);
  useEffect(() => {
    document.documentElement.setAttribute('data-reading-size', size);
  }, [size]);
  return null;
}
