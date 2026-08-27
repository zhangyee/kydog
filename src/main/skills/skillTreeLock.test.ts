import { describe, it, expect } from 'vitest';
import { withSkillTree } from './skillTreeLock';

describe('withSkillTree', () => {
  it('串行执行，不交错', async () => {
    const log: string[] = [];
    const task = (n: number) => withSkillTree(async () => {
      log.push(`in${n}`);
      await new Promise((r) => setTimeout(r, 5));
      log.push(`out${n}`);
    });
    await Promise.all([task(1), task(2), task(3)]);
    expect(log).toEqual(['in1', 'out1', 'in2', 'out2', 'in3', 'out3']);
  });

  it('一个失败不会卡住后续', async () => {
    await expect(withSkillTree(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(await withSkillTree(async () => 42)).toBe(42);
  });
});
