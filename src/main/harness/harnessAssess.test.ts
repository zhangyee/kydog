import { describe, it, expect } from 'vitest';
import { assessHarnessFile, templateSha, type HarnessRecord } from './harnessAssess';
import { renderTemplate } from './seed';

// 两版模板都带 front matter 占位符：「只改了名字」那条要靠它才测得到东西。
const OLD = '---\nname: {{userName}}\n---\n\n# USER\n\n旧版正文\n';
const NEW = '---\nname: {{userName}}\n---\n\n# USER\n\n新版正文，多了一节\n';
const EN = '---\nname: {{userName}}\n---\n\n# USER\n\nnew english body\n';
const names = { userName: '老张', agentName: 'KyDog' };
const rec = (template: string | null, locale: 'zh' | 'en' | null = 'zh', keptTemplateSha: string | null = null): HarnessRecord =>
  ({ template, locale, keptTemplateSha });

describe('assessHarnessFile：判定表（spec §3.2）', () => {
  it('R0 文件不存在 → missing，不补记；同一份记录下文件存在且模板变了 → available（这个判据查得到东西）', () => {
    const base = { template: NEW, locale: 'zh' as const, record: rec(OLD), names };
    const gone = assessHarnessFile({ ...base, disk: null });
    expect(gone).toEqual({ template: 'missing', edit: null, localeDiffers: false, backfill: null });
    expect(assessHarnessFile({ ...base, disk: renderTemplate(OLD, names) }).template).toBe('available');
  });

  it('R1 老用户（无记录）且文件恰好等于当前模板 → latest 并补记；不等 → available + unknown', () => {
    const hit = assessHarnessFile({ template: NEW, locale: 'zh', record: null, disk: renderTemplate(NEW, names), names });
    expect(hit).toEqual({ template: 'latest', edit: null, localeDiffers: false, backfill: rec(NEW) });
    const miss = assessHarnessFile({ template: NEW, locale: 'zh', record: null, disk: renderTemplate(OLD, names), names });
    expect(miss).toEqual({ template: 'available', edit: 'unknown', localeDiffers: false, backfill: null });
  });

  it('R1 自愈：文件已换成新模板、状态没写成（记录还是旧模板）→ latest + 补记，不误判 edited', () => {
    const r = assessHarnessFile({ template: NEW, locale: 'zh', record: rec(OLD), disk: renderTemplate(NEW, names), names });
    expect(r.template).toBe('latest');
    expect(r.backfill).toEqual(rec(NEW));
  });

  it('R1 记录已与当前模板、语言一致 → 不重复补记；语言不一致 → 补记', () => {
    const disk = renderTemplate(NEW, names);
    expect(assessHarnessFile({ template: NEW, locale: 'zh', record: rec(NEW, 'zh'), disk, names }).backfill).toBeNull();
    expect(assessHarnessFile({ template: NEW, locale: 'zh', record: rec(NEW, 'en'), disk, names }).backfill).toEqual(rec(NEW, 'zh'));
  });

  it('R2 从当前模板写入后又改过 → latest，不补记', () => {
    const r = assessHarnessFile({ template: NEW, locale: 'zh', record: rec(NEW), disk: renderTemplate(NEW, names) + '\n我加的一行\n', names });
    expect(r).toEqual({ template: 'latest', edit: null, localeDiffers: false, backfill: null });
  });

  it('只改了名字 → unchanged（决策 6 要挡的误报）；正文也改了 → edited', () => {
    const renamed = { ...names, userName: 'Dr. Li' };
    const onlyName = assessHarnessFile({ template: NEW, locale: 'zh', record: rec(OLD), disk: renderTemplate(OLD, renamed), names: renamed });
    expect(onlyName).toMatchObject({ template: 'available', edit: 'unchanged' });
    const bodyToo = assessHarnessFile({ template: NEW, locale: 'zh', record: rec(OLD), disk: renderTemplate(OLD, renamed) + '补充\n', names: renamed });
    expect(bodyToo).toMatchObject({ template: 'available', edit: 'edited' });
  });

  it('R3 对当前这版选过保持 → kept（改动状态照算）；模板再变 → 回到 available', () => {
    const disk = renderTemplate(OLD, names) + '改过\n';
    const kept = assessHarnessFile({ template: NEW, locale: 'zh', record: rec(OLD, 'zh', templateSha(NEW)), disk, names });
    expect(kept).toEqual({ template: 'kept', edit: 'edited', localeDiffers: false, backfill: null });
    const NEWER = NEW + '\n又一节\n';
    expect(assessHarnessFile({ template: NEWER, locale: 'zh', record: rec(OLD, 'zh', templateSha(NEW)), disk, names }).template)
      .toBe('available');
  });

  it('老用户选过保持（记录里模板为 null）→ kept + unknown；模板再变 → available + unknown，不是 edited', () => {
    const disk = renderTemplate(OLD, names);
    const kept = assessHarnessFile({ template: NEW, locale: 'zh', record: rec(null, null, templateSha(NEW)), disk, names });
    expect(kept).toEqual({ template: 'kept', edit: 'unknown', localeDiffers: false, backfill: null });
    const NEWER = NEW + '\n又一节\n';
    expect(assessHarnessFile({ template: NEWER, locale: 'zh', record: rec(null, null, templateSha(NEW)), disk, names }))
      .toEqual({ template: 'available', edit: 'unknown', localeDiffers: false, backfill: null });
  });

  it('切换界面语言 → available + localeDiffers；语言没变的同一份文件 → 没有这个标记', () => {
    const disk = renderTemplate(NEW, names);
    expect(assessHarnessFile({ template: EN, locale: 'en', record: rec(NEW, 'zh'), disk, names }))
      .toEqual({ template: 'available', edit: 'unchanged', localeDiffers: true, backfill: null });
    expect(assessHarnessFile({ template: EN, locale: 'zh', record: rec(NEW, 'zh'), disk, names }).localeDiffers).toBe(false);
  });

  it('R4 的判定不看记录里的语言是不是 null（老用户选过保持后又切了语言）', () => {
    const r = assessHarnessFile({ template: EN, locale: 'en', record: rec(null, null, templateSha(NEW)), disk: renderTemplate(NEW, names), names });
    expect(r).toEqual({ template: 'available', edit: 'unknown', localeDiffers: false, backfill: null });
  });
});

describe('templateSha', () => {
  it('同一文本同一指纹，差一个字符就不同', () => {
    expect(templateSha(NEW)).toBe(templateSha(String(NEW)));
    expect(templateSha(NEW)).not.toBe(templateSha(NEW + ' '));
    expect(templateSha(NEW)).toMatch(/^[0-9a-f]{64}$/);
  });
});
