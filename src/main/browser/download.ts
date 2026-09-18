import { randomUUID } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { KydogError } from '../../shared/errors';

/** 单个文件上限（spec §5）。防一个写错的剧本把磁盘刷爆，不是产品限制。 */
export const MAX_DOWNLOAD_BYTES = 50 * 1024 * 1024;
/** 一轮任务最多下载几个（spec §5）。 */
export const MAX_DOWNLOADS_PER_RUN = 10;
/**
 * **停滞超时**（毫秒）：连续这么久**一个字节都没收到**才放弃，收到进度就续命。
 *
 * 不是「总时长上限」—— 那是个陷阱：上限 50 MB 配 60 秒总时长，等于慢网上的大文件
 * 永远下不完，而报出来的却是「超时」，读起来像站点的问题。2026-09-16 实测撞到过：
 * arXiv 的 `2210.02747` 是 **25 MB**，60 秒总时限直接判死，而下载本身是好的。
 */
export const DOWNLOAD_STALL_MS = 60_000;

/** PDF 的魔数。判据是**文件头**，不是 content-type，也不是「下载完成了」——见 `looksLikePdf`。 */
const PDF_MAGIC = '%PDF-';

/**
 * 这次 `will-download` 是不是 agent 自己点名的那一个。
 *
 * **判据是协议层事实**：`getURLChain()` 是含重定向的完整链，`chain[0]` 是最初请求的地址，
 * 拿它与这个标签上待决的 agent 请求比对。与导航那一侧用的是同一个机制
 * （`browserService` 里那处注释：「一个广告 frame 自发拉起的下载不许冒充终态」）。
 *
 * **两个方向都重要**：对得上要放行，对不上要**取消**。只实现放行那一半的话，
 * 页面自发拉起的下载会被误当成 agent 要的东西落进 `papers/`，
 * 而「下载了什么」就不再可追溯到一次工具调用了（spec §3）。
 *
 * 链为空时返回 false —— 我们不知道它从哪来，**不知道就不放行**。
 */
export function isAgentRequested(chain: readonly string[], pending: ReadonlySet<string>): boolean {
  if (chain.length === 0) return false;
  return pending.has(chain[0]);
}

/**
 * 文件头是不是 PDF。
 *
 * **这是本期最要紧的一道闸。** 2026-09-16 实测：会话外取 MDPI / PeerJ / ChemRxiv 的 PDF
 * 直链，回的是 `text/html`、5 KB 左右的 Cloudflare 拦截页。把它存成 `x.pdf` 再交给
 * `fastpaper read`，**文件在、大小不为零、后缀也对**，只有内容是拦截页 —— 一条静默的假绿。
 *
 * 所以判据是**魔数**：
 * - 不是 content-type —— 那是站点说的，拦截页照样能声称自己是 application/pdf
 * - 不是「下载完成了」—— 完成的是一次 HTTP 传输，与内容是什么无关
 */
export function looksLikePdf(head: Uint8Array): boolean {
  if (head.length < PDF_MAGIC.length) return false;
  for (let i = 0; i < PDF_MAGIC.length; i += 1) {
    if (head[i] !== PDF_MAGIC.charCodeAt(i)) return false;
  }
  return true;
}

/**
 * 从 URL 与可选的提示推一个**安全**的落盘文件名。
 *
 * 安全的含义只有一条：**结果里不能有路径分隔符，也不能是 `.` / `..`** ——
 * 否则一个 `?filename=../../x` 就写出了 `papers/` 之外。这里不做「好看」的事，
 * 只做「不越界」的事。
 *
 * 推不出名字时回落到 `download.pdf`，不抛 —— 名字推不出来不是失败，内容才是。
 */
export function safeFilename(url: string, hint?: string): string {
  const raw = (hint ?? lastPathSegment(url) ?? '').trim();
  // 只取 basename，并把分隔符与控制字符换掉。`path.basename` 对 `..` 回 `..`，所以还要单独挡。
  //
  // 控制字符用 codePoint 逐个过滤，不写进正则字面量：eslint 的 `no-control-regex` 挡的是
  // 「正则里塞控制字符可读性差」，不是这条需求本身 —— 换个写法比关规则诚实。
  const cleaned = [...raw.replace(/[\\/]+/g, '/')]
    .map((ch) => ((ch.codePointAt(0) ?? 0) < 0x20 || '<>:"|?*'.includes(ch) ? '_' : ch))
    .join('');
  const base = path.basename(cleaned).trim();
  if (base === '' || base === '.' || base === '..') return 'download.pdf';
  return base.toLowerCase().endsWith('.pdf') ? base : `${base}.pdf`;
}

function lastPathSegment(url: string): string | null {
  try {
    const u = new URL(url);
    const seg = u.pathname.split('/').filter(Boolean).pop();
    return seg ?? null;
  } catch {
    return null;
  }
}

/** 落盘前的三查（spec §4）。任何一样不满足都**不落盘**，并说清实际看到了什么。 */
export function assertDownloadable(args: {
  url: string;
  httpStatusCode: number | null;
  totalBytes: number;
  maxBytes?: number;
}): void {
  const max = args.maxBytes ?? MAX_DOWNLOAD_BYTES;
  // 状态码为 null = Electron 没给（有些路径拿不到），不据此定论 —— 让内容判据去判。
  if (args.httpStatusCode !== null && (args.httpStatusCode < 200 || args.httpStatusCode >= 300)) {
    throw new KydogError('browser.download_failed',
      `取这个地址没拿到文件：服务器返回 HTTP ${args.httpStatusCode}。`
      + '这不是「文件不是 PDF」——是根本没取到字节，换个入口再试或交给用户。');
  }
  if (args.totalBytes > max) {
    throw new KydogError('browser.download_too_large',
      `这个文件 ${args.totalBytes} 字节，超过单文件上限 ${max} 字节，没有下载。`
      + '把链接报给用户，让他自己取。');
  }
}

/** 内容判据（spec §4）。**落盘之后、交给下游之前**跑，判不过由调用方删文件。 */
export function assertPdfContent(args: {
  url: string;
  head: Uint8Array;
  mimeType: string | null;
  bytes: number;
}): void {
  if (looksLikePdf(args.head)) return;
  const peek = [...args.head.slice(0, 16)]
    .map((b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '.')).join('');
  throw new KydogError('browser.download_not_pdf',
    `取回来了 ${args.bytes} 字节，但**文件头不是 PDF**`
    + `（content-type: ${args.mimeType ?? '未知'}，开头 16 字节看起来是 ${JSON.stringify(peek)}）。`
    + '最常见的原因是这个地址在当前会话下回的是拦截页或登录页，而不是文件 —— '
    + '文件已经删掉，没有留一个坏文件。把链接原样报给用户，让他自己在浏览器里打开。');
}

/**
 * 这次下载的字节先落到哪里：**目标目录里一个带随机名的隐藏临时文件**。
 *
 * - 在目标目录里，是为了之后那一步 `rename` 在同一个文件系统上、是原子的
 * - 点开头、`.part` 结尾，是为了进程中途死掉留下残片时，没人会把它当成一篇论文去读
 */
export function tmpDownloadPath(dir: string): string {
  return path.join(dir, `.kydog-download-${randomUUID()}.part`);
}

/**
 * 把一次**已经传完**的下载落成最终文件（spec §4）。
 *
 * **两条不变量，都是 2026-09-17 手测撞出来的**（见 `download.test.ts` 那一组的说明）：
 *
 * 1. **判不过时，删的只有这次的临时文件。** 旧实现把字节直接写到最终路径、判不过就删最终路径 ——
 *    摘要页 `/abs/2210.02747` 与 PDF `/pdf/2210.02747` 推出同一个文件名，于是 HTML
 *    先盖掉上一轮那份好 PDF，再被当成坏文件删掉。错误信息说「没有留一个坏文件」，丢的却是好文件。
 * 2. **不覆盖同名文件，另起名字**（`x.pdf` → `x-2.pdf` → `x-3.pdf`）。MDPI 的直链末段恒为
 *    `pdf`、ChinaXiv 恒为 `download.htm`，不另起名字的话同一个源的第二篇会静默盖掉第一篇。
 *    **以返回的 `path` 为准**，不要假设文件叫你给的那个名字。
 *
 * 占名字用 `open(…, 'wx')` —— 「不存在才创建」是文件系统替我们判的，没有「先查再写」的空档。
 * 占到之后 `rename` 盖掉的是我们自己刚建的空占位文件。
 */
export async function settleDownload(args: {
  tmpPath: string;
  dir: string;
  url: string;
  filename?: string;
  mimeType: string | null;
}): Promise<{ path: string; bytes: number }> {
  try {
    const buf = await fsp.readFile(args.tmpPath);
    assertPdfContent({ url: args.url, head: buf.subarray(0, 16), mimeType: args.mimeType, bytes: buf.length });
    const target = await claimFreePath(args.dir, safeFilename(args.url, args.filename));
    await fsp.rename(args.tmpPath, target);
    return { path: target, bytes: buf.length };
  } catch (err) {
    await fsp.rm(args.tmpPath, { force: true }).catch(() => {});
    throw err;
  }
}

async function claimFreePath(dir: string, filename: string): Promise<string> {
  const ext = path.extname(filename);
  const stem = filename.slice(0, filename.length - ext.length);
  for (let n = 1; ; n += 1) {
    const candidate = path.join(dir, n === 1 ? filename : `${stem}-${n}${ext}`);
    try {
      const fh = await fsp.open(candidate, 'wx');
      await fh.close();
      return candidate;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
  }
}
