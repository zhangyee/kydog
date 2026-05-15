import { describe, it, expect, beforeEach } from 'vitest';
import { registerSaver, unregisterSaver, getSaver, _clearSaversForTesting } from './saveRegistry';

describe('saveRegistry', () => {
  beforeEach(_clearSaversForTesting);

  it('register 后 getSaver 取得同一函数', () => {
    const fn = async () => true;
    registerSaver('/p/a.md', fn);
    expect(getSaver('/p/a.md')).toBe(fn);
  });

  it('unregister 后 getSaver 返回 undefined', () => {
    registerSaver('/p/a.md', async () => true);
    unregisterSaver('/p/a.md');
    expect(getSaver('/p/a.md')).toBeUndefined();
  });

  it('未注册的 id 返回 undefined', () => {
    expect(getSaver('/p/missing.md')).toBeUndefined();
  });
});
