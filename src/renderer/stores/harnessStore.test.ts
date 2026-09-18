import { describe, it, expect, beforeEach } from 'vitest';
import { useHarnessStore, isDraftDirty, toTextareaNewlines } from './harnessStore';
import { editStateLine, templateStateLabel, templateStateShort, harnessSubtitle, applyResultLine } from '../shared/harnessCopy';

describe('harnessStore', () => {
  beforeEach(() => useHarnessStore.setState({ opened: null, drafts: {}, revision: 0, notes: {} }));

  it('草稿按文件名各存各的；清掉一份不动另一份', () => {
    const s = useHarnessStore.getState();
    s.setDraft('AGENTS.md', { base: 'a', text: 'a2' });
    s.setDraft('USER.md', { base: 'u', text: 'u' });
    s.clearDraft('AGENTS.md');
    expect(useHarnessStore.getState().drafts).toEqual({ 'USER.md': { base: 'u', text: 'u' } });
  });

  it('结果文案按文件各存各的；置 null 只清那一份', () => {
    const s = useHarnessStore.getState();
    s.setNote('AGENTS.md', '已保存');
    s.setNote('SOUL.md', '已更新');
    s.setNote('AGENTS.md', null);
    expect(useHarnessStore.getState().notes).toEqual({ 'SOUL.md': '已更新' });
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

  it('卡片短状态：四种各不相同；语言换了带版本名', () => {
    const base = { localeDiffers: false, templateLocale: 'zh' as const };
    const labels = (['latest', 'available', 'kept', 'missing'] as const).map((template) => templateStateShort({ ...base, template }));
    expect(new Set(labels).size).toBe(4);
    expect(templateStateShort({ template: 'available', localeDiffers: true, templateLocale: 'en' })).toBe('有英文版');
  });

  it('卡片副标题：有称呼用称呼；没有称呼取正文前三个二级标题（不取一级、不取三级）', () => {
    expect(harnessSubtitle('Dr. Zhang', '## 不该出现')).toBe('称呼 Dr. Zhang');
    const body = '# AGENTS —— 操作手册\n\n## 核验纪律\n\n- x\n\n### 细则\n\n## 用工具的方式\n\n## 找论文走哪条路\n\n## 第四节\n';
    expect(harnessSubtitle(null, body)).toBe('核验纪律 · 用工具的方式 · 找论文走哪条路');
    expect(harnessSubtitle(null, '没有标题的正文')).toBe('');
  });

  it('结果文案：备份路径拼在 ~/.kydog/ 下；失败按选的是哪个动作说', () => {
    expect(applyResultLine({ name: 'AGENTS.md', outcome: 'updated', backupName: 'AGENTS.md.bak-2026-09-17' }, 'update'))
      .toBe('已更新，旧文件备份为 ~/.kydog/AGENTS.md.bak-2026-09-17');
    expect(applyResultLine({ name: 'AGENTS.md', outcome: 'updated', backupName: null }, 'update')).toBe('已创建');
    expect(applyResultLine({ name: 'AGENTS.md', outcome: 'failed', error: 'EACCES' }, 'update')).toContain('原文件没有改动');
    expect(applyResultLine({ name: 'AGENTS.md', outcome: 'failed', error: 'EACCES' }, 'keep')).not.toContain('原文件');
  });
});
