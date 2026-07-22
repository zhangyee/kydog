import { describe, it, expect, beforeEach } from 'vitest';
import { useIdentityStore } from './identityStore';

describe('identityStore', () => {
  beforeEach(() => { useIdentityStore.setState({ userName: 'You', agentName: 'KyDog' }); });

  it('缺省 You / KyDog', () => {
    expect(useIdentityStore.getState().userName).toBe('You');
    expect(useIdentityStore.getState().agentName).toBe('KyDog');
  });

  it('setIdentity 完整替换，含空格称呼不截断', () => {
    useIdentityStore.getState().setIdentity({ userName: 'Dr. Zhang', agentName: '狗哥' });
    expect(useIdentityStore.getState().userName).toBe('Dr. Zhang'); // 不是 'Dr.'
    expect(useIdentityStore.getState().agentName).toBe('狗哥');
  });
});
