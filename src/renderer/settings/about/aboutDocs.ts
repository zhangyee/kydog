import { parseAboutDoc, sortAboutDocs, type AboutDoc } from './aboutDoc';

const LICENSES_SLUG = 'licenses';
const PRIVACY_SLUG = 'privacy';

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
let privacy = '';

for (const [key, raw] of Object.entries(RAW)) {
  const slug = slugOf(key);
  if (slug === LICENSES_SLUG) {
    licenses = raw;
    continue;
  }
  if (slug === PRIVACY_SLUG) {
    privacy = raw;
    continue;
  }
  const parsed = parseAboutDoc(slug, raw);
  if (parsed.ok) docs.push(parsed.doc);
  else console.warn(`[about] 跳过 ${key}：${parsed.reason}`);
}

if (docs.length === 0) console.warn('[about] 一篇正文都没解析出来，检查 glob 路径与 src/about 内容');
if (!licenses) console.warn('[about] licenses.md 缺失或为空');
if (!privacy) console.warn('[about] privacy.md 缺失或为空');

/** 已按 date 降序排好；[0] 即当前的关于页。解析失败的篇已被跳过。 */
export const ABOUT_DOCS: AboutDoc[] = sortAboutDocs(docs);

/** licenses.md 原文；文件缺失则为空串。 */
export const ABOUT_LICENSES: string = licenses;

/** privacy.md 原文；文件缺失则为空串。与 licenses 同为保留名，不进正文列表 ——
 *  带 frontmatter 才会参与 date 排序，而它一旦参与就会把当前关于页挤成往期。 */
export const ABOUT_PRIVACY: string = privacy;
