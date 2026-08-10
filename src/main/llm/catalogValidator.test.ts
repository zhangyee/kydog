import { describe, expect, it } from 'vitest';
import { getBuiltinProviders } from '@earendil-works/pi-ai/providers/all';
import { PROVIDER_CATALOG } from './catalog';

/**
 * pi 内置但 KyDog 刻意没有收进 catalog 的 provider。
 *
 * 这份快照存在的唯一目的是让下面那条 warn 平时保持安静：pi 有 30+ 个内置 provider，
 * 我们只挑其中一部分露给用户，如果无差别地把「pi 有我们没有」全 warn 出来，每次跑测试
 * 都会刷 17 行，真的新增一个也淹在里面 —— 那就等于没有检查。
 *
 * pi 升级后如果这里报了新名字，做个决定：想收就加进 PROVIDER_CATALOG，不收就补到这个
 * 列表里。两种做法都行，但要显式做过一次。
 */
const UNSURFACED: readonly string[] = [
  'ant-ling',
  'cloudflare-ai-gateway',
  'cloudflare-workers-ai',
  'fireworks',
  'minimax-cn',
  'moonshotai',
  'moonshotai-cn',
  'nvidia',
  'opencode-go',
  'qwen-token-plan',
  'qwen-token-plan-cn',
  'together',
  'xiaomi',
  'xiaomi-token-plan-ams',
  'xiaomi-token-plan-cn',
  'xiaomi-token-plan-sgp',
  'zai-coding-cn',
];

describe('catalog 与 pi 内置 provider 的一致性', () => {
  // 0.83 之前读的是 pi-coding-agent 上的 BUILTIN_PROVIDERS，那个导出已经没有了；
  // 现在的权威来源是 pi-ai 的 providers/all，它读的是生成出来的静态目录，不联网、可重现。
  const piIds = new Set<string>(getBuiltinProviders());
  const ourIds = PROVIDER_CATALOG.map((e) => e.id as string);

  it('pi 确实给出了非空的内置 provider 清单', () => {
    // 钉住这条通路本身。上一版就是因为导出改名后静默走了跳过分支，测试绿了两个月却
    // 什么都没比较过 —— 拿不到清单必须是失败，不能是「跳过」。
    expect(piIds.size).toBeGreaterThan(0);
  });

  it('catalog 里的每个 provider，pi 都认识', () => {
    // 这个方向是真 bug：catalog 列了 pi 不认识的 id，用户能在设置里选中它，
    // 但建 session 时 pi 找不到对应 provider。pi 删掉某个 provider 时也会在这里炸
    // （0.83 删 Gemini CLI / Antigravity 就是这种情况）。
    const onlyInUs = ourIds.filter((id) => !piIds.has(id));
    expect(onlyInUs, `catalog 里这些 id 在 pi 内置清单里不存在：${onlyInUs.join(', ')}`).toEqual([]);
  });

  it('pi 新增的 provider 会被指出来（informational）', () => {
    const known = new Set([...ourIds, ...UNSURFACED]);
    const unexpected = [...piIds].filter((id) => !known.has(id)).sort();
    if (unexpected.length > 0) {
      console.warn(
        `pi 新增了 catalog 未处理的 provider：${unexpected.join(', ')}\n`
        + '决定是否收进 PROVIDER_CATALOG；不收就补进 catalogValidator.test.ts 的 UNSURFACED。',
      );
    }

    const stale = UNSURFACED.filter((id) => !piIds.has(id)).sort();
    if (stale.length > 0) {
      console.warn(`UNSURFACED 里这些 provider pi 已经没有了，可以删掉：${stale.join(', ')}`);
    }
  });
});
