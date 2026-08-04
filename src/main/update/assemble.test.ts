import { describe, it, expect } from 'vitest';
// 从 pickAssembly.ts 而不是 assemble.ts 引入：后者 import electron，
// 而单测跑在 node 环境。assemble.ts 会把它原样再导出，装配处仍只认一个名字。
import { pickAssembly } from './pickAssembly';

describe('更新服务装配优先级', () => {
  it('e2e + fixture → fixture', () => {
    expect(pickAssembly({ isPackaged: true, e2e: '1', fixture: '/tmp/f.json' })).toBe('fixture');
    expect(pickAssembly({ isPackaged: false, e2e: '1', fixture: '/tmp/f.json' })).toBe('fixture');
  });

  it('e2e 无 fixture → no-op', () => {
    expect(pickAssembly({ isPackaged: true, e2e: '1', fixture: undefined })).toBe('noop');
  });

  it('未打包 → no-op（npm start 不会打生产 feed）', () => {
    expect(pickAssembly({ isPackaged: false, e2e: undefined, fixture: undefined })).toBe('noop');
  });

  it('打包且非 e2e → real', () => {
    expect(pickAssembly({ isPackaged: true, e2e: undefined, fixture: undefined })).toBe('real');
  });

  it('生产环境残留 fixture 变量一律忽略', () => {
    expect(pickAssembly({ isPackaged: true, e2e: undefined, fixture: '/tmp/f.json' })).toBe('real');
    expect(pickAssembly({ isPackaged: false, e2e: undefined, fixture: '/tmp/f.json' })).toBe('noop');
  });
});
