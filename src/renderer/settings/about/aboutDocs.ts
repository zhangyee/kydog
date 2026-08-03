import { parseAboutDoc, sortAboutDocs, type AboutDoc } from './aboutDoc';

const LICENSES_SLUG = 'licenses';

// 相对路径 glob：本文件在 src/renderer/settings/about/，向上三层即 src/。
// vite 与 vitest 都按同一套规则解析，不依赖 root 配置。
const RAW = import.meta.glob('../../../about/*.md', {
  query: '?raw',
  eager: true,
  import: 'default',
}) as Record<string, string>;

function slugOf(key: string): string {
  return key.slice(key.lastIndexOf('/') + 1).replace(/\.md$/, '');
}

const docs: AboutDoc[] = [];
let licenses = '';

for (const [key, raw] of Object.entries(RAW)) {
  const slug = slugOf(key);
  if (slug === LICENSES_SLUG) {
    licenses = raw;
    continue;
  }
  const parsed = parseAboutDoc(slug, raw);
  if (parsed.ok) docs.push(parsed.doc);
  else console.warn(`[about] 跳过 ${key}：${parsed.reason}`);
}

/** 已按 date 降序排好；[0] 即当前的关于页。解析失败的篇已被跳过。 */
export const ABOUT_DOCS: AboutDoc[] = sortAboutDocs(docs);

/** licenses.md 原文；文件缺失则为空串。 */
export const ABOUT_LICENSES: string = licenses;
