import { describe, it, expect } from 'vitest';
import { MODEL_CONCURRENCY, withPermit } from './pdfTranslatePage';

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
  it('按页码依次消费，带上 stopReason，且同样过 semaphore', async () => {
    const { mkdtempSync, writeFileSync } = await import('node:fs');
    const os = await import('node:os'); const path = await import('node:path');
    const dir = mkdtempSync(path.join(os.tmpdir(), 'kt-'));
    const f = path.join(dir, 'fx.json');
    writeFileSync(f, JSON.stringify({ 3: [{ text: 'A', stopReason: 'length' }, { text: 'B', stopReason: 'stop' }] }));
    process.env.KYDOG_TRANSLATE_FIXTURE = f;
    const { translatePage } = await import('./pdfTranslatePage');
    const base = { page: 3, providerId: 'anthropic' as const, modelId: 'm', runtimeRevision: 0, langOut: 'zh' as const, lines: [] };
    expect(await translatePage(base)).toEqual({ text: 'A', truncated: true });
    expect(await translatePage(base)).toEqual({ text: 'B', truncated: false });
    await expect(translatePage(base)).rejects.toThrow();   // 耗尽即报错，不静默降级
    delete process.env.KYDOG_TRANSLATE_FIXTURE;
  });
});
