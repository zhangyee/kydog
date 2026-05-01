import { describe, it } from 'vitest';
import { PROVIDER_CATALOG } from './catalog';

describe('catalogValidator (informational)', () => {
  it('对比 pi.BUILTIN_PROVIDERS（warning，不 fail）', async () => {
    let pi: typeof import('@mariozechner/pi-coding-agent');
    try {
      pi = await import('@mariozechner/pi-coding-agent');
    } catch {
      console.warn('pi-coding-agent 未安装，跳过 catalog 同步检查');
      return;
    }
    const piIds = new Set<string>();
    const piExports = (pi as any);
    if (Array.isArray(piExports.BUILTIN_PROVIDERS)) {
      for (const p of piExports.BUILTIN_PROVIDERS) piIds.add(p.id);
    }
    if (piIds.size === 0) {
      console.warn('pi 未导出 BUILTIN_PROVIDERS（可能是版本差异），跳过');
      return;
    }
    const ourIds = new Set(PROVIDER_CATALOG.map((e) => e.id));
    const onlyInPi = [...piIds].filter((x) => !ourIds.has(x) && PROVIDER_CATALOG.find((e) => e.kind !== 'cloud') !== undefined);
    const onlyInUs = [...ourIds].filter((x) => !piIds.has(x));
    if (onlyInPi.length || onlyInUs.length) {
      console.warn('catalog drift detected', { onlyInPi, onlyInUs });
    }
  });
});
