import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mount, findAllWhere } from '../../../test-support/miniReact';

vi.mock('react', async (importOriginal) => {
  const real = await importOriginal<typeof import('react')>();
  const mini = await import('../../../test-support/miniReact');
  return { ...real, ...mini.reactHooks } as unknown as typeof real;
});

const { UserMessage } = await import('./UserMessage');
const { ImageChip, FileChip } = await import('./AttachmentChips');
const { CommentCard } = await import('./CommentCard');
const { encodeUserTurn, refTag } = await import('../../../shared/userTurn');
const { useUiStore } = await import('../../stores/uiStore');

const byType = (tree: unknown, t: unknown) => findAllWhere(tree as never, (el) => el.type === t);
const byTestId = (tree: unknown, id: string) => findAllWhere(tree as never, (el) => el.props['data-testid'] === id);

describe('UserMessage —— 按发出去的文字解回来显示', () => {
  let openFile: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    openFile = vi.fn();
    useUiStore.setState({ openFile } as never);
  });

  it('完整的一轮：缩略图带名字与 data URL、文件标签、批注卡、行内引用都在；纯文字消息只有正文', () => {
    const { text, images } = encodeUserTurn({
      body: `对比 ${refTag('refs/dpo.pdf')} 的表 2`,
      attachments: [{ kind: 'file', path: 'notes/a.md' }, { kind: 'image', name: '截图 1', data: 'AAAA', mimeType: 'image/png' }],
      comments: [{ file: 'notes/ch3.md', section: '3.2', quote: 'q', note: 'n' }],
    });
    const m = mount(UserMessage, { name: 'Yee', content: text, images, projectPath: '/proj' });
    const [thumb] = byType(m.tree, ImageChip);
    expect(thumb.props).toMatchObject({ src: 'data:image/png;base64,AAAA', name: '截图 1', testId: 'user-attachment' });
    expect(byType(m.tree, FileChip)[0].props).toMatchObject({ name: 'a.md', title: 'notes/a.md' });
    expect(byType(m.tree, CommentCard)[0].props).toMatchObject({ file: 'notes/ch3.md', section: '3.2', quote: 'q', note: 'n', testId: 'user-comment-card' });
    expect(byTestId(m.tree, 'user-ref')[0].props['data-path']).toBe('refs/dpo.pdf');

    const plain = mount(UserMessage, { name: 'Yee', content: '只有文字', projectPath: '/proj' });
    expect(byTestId(plain.tree, 'user-attachments')).toHaveLength(0);
    expect(byType(plain.tree, CommentCard)).toHaveLength(0);
    expect(JSON.stringify(plain.tree)).toContain('只有文字');
  });

  it('解不出名字的图：叫「图片 N」（先证明解得出时用解出的名字）', () => {
    const { text, images } = encodeUserTurn({ body: 'x', attachments: [{ kind: 'image', name: '截图 1', data: 'A', mimeType: 'image/png' }], comments: [] });
    expect(byType(mount(UserMessage, { name: 'Y', content: text, images, projectPath: '/p' }).tree, ImageChip)[0].props.name).toBe('截图 1');
    const bare = mount(UserMessage, { name: 'Y', content: 'x', images: [{ data: 'A', mimeType: 'image/png' }], projectPath: '/p' });
    expect(byType(bare.tree, ImageChip)[0].props.name).toBe('图片 1');
  });

  it('点 md 文件标签：按对话的项目解析成绝对路径去开；点不能开的文件（csv）什么也不做', () => {
    const { text } = encodeUserTurn({ body: '', attachments: [{ kind: 'file', path: 'notes/a.md' }, { kind: 'file', path: 'data/b.csv' }], comments: [] });
    const m = mount(UserMessage, { name: 'Y', content: text, projectPath: '/proj' });
    const [md, csv] = byType(m.tree, FileChip);
    (md.props.onClick as () => void)();
    expect(openFile).toHaveBeenCalledWith('/proj/notes/a.md');
    expect(csv.props.onClick).toBeUndefined();
  });

  it('格式不合格的消息：原样当正文显示（标签文字照原样出现）', () => {
    const broken = 'x\n\n<kydog-comment file="a">oops';
    const m = mount(UserMessage, { name: 'Y', content: broken, projectPath: '/p' });
    expect(byType(m.tree, CommentCard)).toHaveLength(0);
    expect(JSON.stringify(m.tree)).toContain('<kydog-comment file=\\"a\\">oops');
  });
});
