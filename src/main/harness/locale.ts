export function mapSystemLocale(raw: string): 'zh' | 'en' {
  return raw.trim().toLowerCase().startsWith('zh') ? 'zh' : 'en';
}
