import { describe, it, expect, beforeEach } from 'vitest';
import { useHarnessStore, isDraftDirty, toTextareaNewlines } from './harnessStore';
import { editStateLine, templateStateLabel, applyResultLine } from '../shared/harnessCopy';

describe('harnessStore', () => {
  beforeEach(() => useHarnessStore.setState({ active: 'SOUL.md', drafts: {}, revision: 0 }));

  it('草稿按文件名各存各的；清掉一份不动另一份', () => {
    const s = useHarnessStore.getState();
    s.setDraft('AGENTS.md', { base: 'a', text: 'a2' });
    s.setDraft('USER.md', { base: 'u', text: 'u' });
    s.clearDraft('AGENTS.md');
    expect(useHarnessStore.getState().drafts).toEqual({ 'USER.md': { base: 'u', text: 'u' } });
  });

  it('CRLF 文件一打开不算改过；改了一个字才算', () => {
    const base = '# A\r\n\r\n- x\r\n';
    const opened = { base, text: toTextareaNewlines(base) };
    expect(opened.text).toBe('# A\n\n- x\n');
    expect(isDraftDirty(opened)).toBe(false);
    expect(isDraftDirty({ ...opened, text: opened.text + 'y' })).toBe(true);
    expect(isDraftDirty({ base: null, text: '' })).toBe(true);
  });
});

describe('harnessCopy', () => {
  it('改动状态三句各不相同；语言换了补一句新模板是哪一版', () => {
    const lines = (['unchanged', 'edited', 'unknown'] as const)
      .map((edit) => editStateLine({ edit, localeDiffers: false, templateLocale: 'zh' }));
    expect(new Set(lines).size).toBe(3);
    expect(lines[0]).toContain('不会丢失');
    expect(editStateLine({ edit: 'unchanged', localeDiffers: true, templateLocale: 'en' })).toBe(`${lines[0]}；新模板是英文版`);
  });

  it('模板状态文案：available 语言换了带版本名，没换不带', () => {
    expect(templateStateLabel({ template: 'available', localeDiffers: true, templateLocale: 'zh' })).toBe('有新版本（中文版）');
    expect(templateStateLabel({ template: 'available', localeDiffers: false, templateLocale: 'zh' })).toBe('有新版本');
    expect(templateStateLabel({ template: 'kept', localeDiffers: false, templateLocale: 'zh' })).toBe('有新版本（你选过保持）');
  });

  it('结果文案：备份路径拼在 ~/.kydog/ 下；失败按选的是哪个动作说', () => {
    expect(applyResultLine({ name: 'AGENTS.md', outcome: 'updated', backupName: 'AGENTS.md.bak-2026-09-17' }, 'update'))
      .toBe('已更新，旧文件备份为 ~/.kydog/AGENTS.md.bak-2026-09-17');
    expect(applyResultLine({ name: 'AGENTS.md', outcome: 'updated', backupName: null }, 'update')).toBe('已创建');
    expect(applyResultLine({ name: 'AGENTS.md', outcome: 'failed', error: 'EACCES' }, 'update')).toContain('原文件没有改动');
    expect(applyResultLine({ name: 'AGENTS.md', outcome: 'failed', error: 'EACCES' }, 'keep')).not.toContain('原文件');
  });
});
