import { HARNESS_FILE_NAMES, type HarnessFileName, type HarnessReadResult } from '../../shared/types';
import { applyResultLine, editStateLine } from '../shared/harnessCopy';
import { useHarnessStore, isDraftDirty, toTextareaNewlines } from '../stores/harnessStore';
import { useUiStore } from '../stores/uiStore';
import { useThreadsStore } from '../stores/threadsStore';
import { confirm } from '../stores/confirmStore';

/**
 * 长期记忆页与检视栏里那几个动作（spec §6.3）：它们调主进程、弹 confirm()，结果写回 harnessStore。
 * 卡片与检视栏都从这里走，两处说法与语义不会漂移。
 */

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));
const H = () => useHarnessStore.getState();

let seq = 0;

/** 拉三份的状态与内容。并发调用时只认最后一次的结果。 */
export async function refreshHarness(): Promise<void> {
  const mine = ++seq;
  try {
    const [st, ...reads] = await Promise.all([
      window.kydog.invoke('harness.status'),
      ...HARNESS_FILE_NAMES.map((name) => window.kydog.invoke('harness.read', { name })),
    ]);
    if (mine !== seq) return;
    const docs: Partial<Record<HarnessFileName, HarnessReadResult>> = {};
    HARNESS_FILE_NAMES.forEach((name, i) => { docs[name] = reads[i]; });
    H().setLoaded(st.files, docs);
  } catch (err) {
    if (mine === seq) H().setLoadError(errText(err));
  }
}

/**
 * 在右侧检视栏里打开一份。右栏那块地被浏览器侧栏占着就先收起浏览器（标签页不关，
 * 见 uiStore.closeBrowser），检视栏收着就展开 —— 用户点了「查看」，得让他看得见。
 */
export async function openHarness(name: HarnessFileName, opts: { edit?: boolean } = {}): Promise<void> {
  const ui = useUiStore.getState();
  if (ui.browserOpen) ui.closeBrowser();
  if (useUiStore.getState().inspectorCollapsed) ui.toggleInspector();
  if (opts.edit) {
    H().setOpened(name, 'view');
    await startHarnessEdit(name);
    return;
  }
  // 「查看」一定是查看态。没改过的草稿顺手丢掉；改过的留着，查看态里提示「继续编辑」。
  const draft = H().drafts[name];
  if (draft && !isDraftDirty(draft)) H().clearDraft(name);
  H().setOpened(name, 'view');
}

/**
 * 关掉检视栏里的这一份。在改而且改过 → 先问要不要放弃（取消 = 继续编辑，什么都不动）；
 * 没改过的草稿直接丢掉。关掉之后再点「查看」，出来的是查看态。
 */
export async function closeHarness(): Promise<void> {
  const name = H().opened;
  if (!name) return;
  const draft = H().drafts[name];
  if (draft && isDraftDirty(draft) && !(await confirmDiscard(name))) return;
  H().clearDraft(name);
  H().setOpened(null);
}

/** 进编辑态。已经有草稿（改到一半去看了别的）就接着改那一份，不拿磁盘内容盖掉它。 */
export async function startHarnessEdit(name: HarnessFileName): Promise<void> {
  if (H().drafts[name]) { H().setMode('edit'); return; }
  // 进编辑前重读一次：显示的那份可能已经旧了，拿它作 expected 只会平白冲突一次。
  try {
    const rd = await window.kydog.invoke('harness.read', { name });
    H().setDoc(name, rd);
    if (!rd.exists) return;
    H().setNote(name, null);
    H().setDraft(name, { base: rd.content, text: toTextareaNewlines(rd.content) });
    if (H().opened === name) H().setMode('edit');
  } catch (err) {
    H().setNote(name, `读不出这份文件：${errText(err)}`);
  }
}

const confirmDiscard = (name: HarnessFileName) => confirm({
  title: '放弃未保存的修改？',
  message: `${name} 里还没保存的改动会丢掉，改回磁盘上现在的内容。`,
  confirmLabel: '放弃修改',
  cancelLabel: '继续编辑',
});

export async function cancelHarnessEdit(name: HarnessFileName): Promise<void> {
  const draft = H().drafts[name];
  if (draft && isDraftDirty(draft) && !(await confirmDiscard(name))) return;
  H().clearDraft(name);
  if (H().opened === name) H().setMode('view');
  await refreshHarness();
}

export async function saveHarness(name: HarnessFileName): Promise<void> {
  const draft = H().drafts[name];
  if (!draft || H().busy) return;
  H().setBusy(true);
  try {
    let expected = draft.base;
    for (;;) {
      const r = await window.kydog.invoke('harness.write', { name, content: draft.text, expected });
      if (r.ok) break;
      // 取消 = 返回编辑、什么都不动。confirm() 的 Esc 与点背景都算取消，这个键上不许挂破坏性动作。
      const overwrite = await confirm({
        title: `${name} 在你编辑期间被改过`,
        message: r.diskContent === null
          ? '磁盘上的这份文件已经不在了。可以用你的版本重新写出来，或者返回编辑。'
          : '可能是 KyDog 按你的要求改了它。覆盖会丢掉磁盘上的那些改动；返回编辑则什么都不动，想先看看磁盘上现在的内容，可以取消编辑。',
        confirmLabel: '用我的版本覆盖',
        cancelLabel: '返回编辑',
      });
      if (!overwrite) return;
      expected = r.diskContent;                    // 仍是比较后写：覆盖的是刚才看到的那一版，不是强写
    }
    H().clearDraft(name);
    if (H().opened === name) H().setMode('view');
    H().setNote(name, '已保存，从下一个新对话开始生效');
    await refreshHarness();
  } catch (err) {
    H().setNote(name, `保存失败：${errText(err)}`);
  } finally {
    H().setBusy(false);
  }
}

/** 更新到当前模板（文件不存在时是创建，不用确认）。 */
export async function updateHarness(name: HarnessFileName): Promise<void> {
  const status = H().statuses?.find((s) => s.name === name);
  if (!status || H().busy) return;
  const creating = status.template === 'missing';
  if (!creating && !(await confirm({
    title: `把 ${name} 更新到新模板？`,
    message: `${editStateLine(status) || '已是最新'}。会先把现有文件备份在 ~/.kydog/ 里，再整份换成新模板。`,
    confirmLabel: '更新',
  }))) return;
  H().setBusy(true);
  try {
    const { results } = await window.kydog.invoke('harness.apply', { choices: [{ name, choice: 'update' }], source: 'harness-page' });
    const r = results[0];
    H().setNote(name, creating && r.outcome === 'failed' ? `创建失败：${r.error}` : applyResultLine(r, 'update'));
    await refreshHarness();
  } catch (err) {
    H().setNote(name, `${creating ? '创建' : '更新'}失败：${errText(err)}`);
  } finally {
    H().setBusy(false);
  }
}

/**
 * 长期记忆页此刻在不在中栏上。与 MainPane 的 showSettings 同一个判断 ——
 * 检视栏只在这时显示 harness 文件，离开这一页就回到它平常的内容（草稿与打开的是哪一份都留着）。
 */
export function useLongTermMemoryOnScreen(): boolean {
  const settingsTabOpen = useUiStore((s) => s.settingsTabOpen);
  const settingsTab = useUiStore((s) => s.settingsTab);
  const activeCenterTab = useUiStore((s) => s.activeCenterTab);
  const showFile = useUiStore((s) => s.activeCenterTab === 'file'
    && s.activeFileTabId !== null && s.openFileTabs.some((t) => t.id === s.activeFileTabId));
  const hasThread = useThreadsStore((s) => s.currentThreadId !== null
    && Object.values(s.threadsByProject).flat().some((t) => t.id === s.currentThreadId));
  return !showFile && settingsTabOpen && settingsTab === 'longTermMemory'
    && (activeCenterTab === 'settings' || !hasThread);
}
