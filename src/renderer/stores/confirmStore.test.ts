import { describe, it, expect, beforeEach } from 'vitest';
import { useConfirmStore, confirm } from './confirmStore';

function reset() {
  useConfirmStore.setState({ request: null });
}

describe('confirmStore', () => {
  beforeEach(reset);

  it('confirm() 打开请求并带上选项', () => {
    void confirm({ title: '删除？', message: '不可撤销', confirmLabel: '删除' });
    const req = useConfirmStore.getState().request;
    expect(req?.title).toBe('删除？');
    expect(req?.message).toBe('不可撤销');
    expect(req?.confirmLabel).toBe('删除');
  });

  it('resolve(true) 兑现 true 并清空请求', async () => {
    const p = confirm({ title: 't' });
    useConfirmStore.getState().resolve(true);
    await expect(p).resolves.toBe(true);
    expect(useConfirmStore.getState().request).toBeNull();
  });

  it('resolve(false) 兑现 false', async () => {
    const p = confirm({ title: 't' });
    useConfirmStore.getState().resolve(false);
    await expect(p).resolves.toBe(false);
  });

  it('重入：旧请求以 false 结算，新请求替换生效', async () => {
    const p1 = confirm({ title: 'first' });
    const p2 = confirm({ title: 'second' });
    await expect(p1).resolves.toBe(false);
    expect(useConfirmStore.getState().request?.title).toBe('second');
    useConfirmStore.getState().resolve(true);
    await expect(p2).resolves.toBe(true);
  });
});
