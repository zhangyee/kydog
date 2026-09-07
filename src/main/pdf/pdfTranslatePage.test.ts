import { describe, it, expect, vi } from 'vitest';
import { MODEL_CONCURRENCY, withPermit } from './pdfTranslatePage';

// registry 替身：真的那份要 pi 的 ModelRuntime。这里只需要它的 runtimeRevision 与 getModel。
const reg = vi.hoisted(() => ({ runtimeRevision: 0, models: new Set<string>() }));
vi.mock('../llm/providerRegistry', () => ({
  getProviderRegistry: () => ({
    get runtimeRevision() { return reg.runtimeRevision; },
    modelRuntime: {
      getModel: (p: string, m: string) => (reg.models.has(`${p}/${m}`) ? { id: m } : undefined),
      completeSimple: async () => { throw new Error('本文件不该走到真正的上游调用'); },
    },
  }),
}));

const defer = () => { let r!: () => void; const p = new Promise<void>((res) => { r = res; }); return { p, r }; };

describe('withPermit（全应用并发上界）', () => {
  it(`第 ${MODEL_CONCURRENCY + 1} 个请求在前 ${MODEL_CONCURRENCY} 个完成前进不去`, async () => {
    const gates = Array.from({ length: MODEL_CONCURRENCY }, defer);
    const started: number[] = [];
    const runs = gates.map((g, i) => withPermit(async () => { started.push(i); await g.p; }));
    const extra = withPermit(async () => { started.push(99); });
    await Promise.resolve(); await Promise.resolve();
    expect(started).toEqual([...gates.map((_, i) => i)]);   // 99 还没进去
    gates[0].r();
    await runs[0];
    await Promise.resolve(); await Promise.resolve();
    expect(started).toContain(99);
    gates.slice(1).forEach((g) => g.r());
    await Promise.all([...runs, extra]);
  });

  it('抛错也释放 permit——否则一次异常就让后续永久排队', async () => {
    await expect(withPermit(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    await expect(withPermit(async () => 'ok')).resolves.toBe('ok');
  });

  it('多趟作业共享同一个上界（模块级，不按作业分配）', async () => {
    // 两组各 MODEL_CONCURRENCY 个，同时在飞的仍只有 MODEL_CONCURRENCY 个
    const gates = Array.from({ length: MODEL_CONCURRENCY * 2 }, defer);
    let inFlight = 0; let peak = 0;
    const runs = gates.map((g) => withPermit(async () => {
      inFlight++; peak = Math.max(peak, inFlight); await g.p; inFlight--;
    }));
    await Promise.resolve(); await Promise.resolve();
    gates.forEach((g) => g.r());
    await Promise.all(runs);
    expect(peak).toBe(MODEL_CONCURRENCY);
  });
});

describe('fixture 分支', () => {
  it('两个入口按页码依次共用同一条队列、带上 stopReason，且同样过 semaphore', async () => {
    const { mkdtempSync, writeFileSync } = await import('node:fs');
    const os = await import('node:os'); const path = await import('node:path');
    const dir = mkdtempSync(path.join(os.tmpdir(), 'kt-'));
    const f = path.join(dir, 'fx.json');
    writeFileSync(f, JSON.stringify({ 3: [{ text: 'A', stopReason: 'length' }, { text: 'B', stopReason: 'stop' }] }));
    process.env.KYDOG_TRANSLATE_FIXTURE = f;
    const { layoutPage, translateGroups } = await import('./pdfTranslatePage');
    const common = { page: 3, providerId: 'anthropic' as const, modelId: 'm', runtimeRevision: 0 };
    expect(await layoutPage({ ...common, lines: [] })).toEqual({ text: 'A', truncated: true });
    expect(await translateGroups({ ...common, langOut: 'zh', groups: [] })).toEqual({ text: 'B', truncated: false });
    await expect(layoutPage({ ...common, lines: [] })).rejects.toThrow();   // 耗尽即报错，不静默降级
    delete process.env.KYDOG_TRANSLATE_FIXTURE;
  });
});

/**
 * 不变量 #10 的另一半：作业开始钉住的 `runtimeRevision` 与逐页调用时 registry 上的那份必须
 * 相同，否则整趟中止。这条分支 e2e 走不到——fixture 分支的 `return` 排在它**之前**（那正是
 * fixture 能不碰上游的原因），所以只能在这里钉。
 */
describe('runtimeRevision 失配（provider 配置在翻译途中变了）', () => {
  const base = { page: 1, providerId: 'anthropic' as const, modelId: 'm' };
  it('对不上 → llm.not_configured 中止整趟，且不去问模型', async () => {
    delete process.env.KYDOG_TRANSLATE_FIXTURE;   // 上面那条用例跑完已删，这里不依赖它的顺序
    reg.runtimeRevision = 3;
    reg.models = new Set(['anthropic/m']);        // 模型还在——被拒的理由只能是 revision
    const { layoutPage, translateGroups } = await import('./pdfTranslatePage');
    await expect(layoutPage({ ...base, runtimeRevision: 2, lines: [] }))
      .rejects.toMatchObject({ code: 'llm.not_configured' });
    await expect(translateGroups({ ...base, runtimeRevision: 2, langOut: 'zh', groups: [] }))
      .rejects.toMatchObject({ code: 'llm.not_configured' });
  });

  it('对得上但模型没了 → 同样是 llm.not_configured（两道校验都在 fixture 分支之后）', async () => {
    delete process.env.KYDOG_TRANSLATE_FIXTURE;
    reg.runtimeRevision = 3;
    reg.models = new Set();
    const { layoutPage, translateGroups } = await import('./pdfTranslatePage');
    await expect(layoutPage({ ...base, runtimeRevision: 3, lines: [] }))
      .rejects.toMatchObject({ code: 'llm.not_configured' });
    await expect(translateGroups({ ...base, runtimeRevision: 3, langOut: 'zh', groups: [] }))
      .rejects.toMatchObject({ code: 'llm.not_configured' });
  });
});
