import { useState, type CSSProperties, type Ref } from 'react';
import type { AskOption } from '../../../shared/askQuestion';

const ROW_HEIGHT = 32;

/**
 * 三档背景，层次不能混：什么都没有 < hover(paper-edge 0.935) < 选中(hover-bg 0.92)。
 * 用两个不同的 token 是必要的——单选题选中即前进，翻回去时才看得到选中态，
 * 那时它必须和「鼠标恰好停在这一行」区分得开；多选题更明显，同色会让人分不清
 * 「已勾选」和「鼠标在这儿」。
 *
 * hover 走 JS 状态而不是 CSS :hover：这一行的背景由内联 style 给，
 * 内联样式压得过类选择器，`hover:` 工具类在这里不会生效。
 */
function rowStyle(selected: boolean, hovered: boolean): CSSProperties {
  return {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    height: ROW_HEIGHT,
    padding: '0 8px',
    borderRadius: 4,
    background: selected
      ? 'var(--color-hover-bg)'
      : hovered
        ? 'var(--color-paper-edge)'
        : 'transparent',
    cursor: 'pointer',
    width: '100%',
    border: 'none',
    textAlign: 'left',
  };
}

function Lead({ multiSelect, index, selected }: { multiSelect: boolean; index: number; selected: boolean }) {
  if (!multiSelect) {
    return (
      <span
        className="font-mono"
        // 单选题没有勾选框，序号的深浅就是唯一的选中标记。
        style={{ fontSize: 11, color: selected ? 'var(--color-ink)' : 'var(--color-ink-faint)', minWidth: 12 }}
      >
        {index + 1}
      </span>
    );
  }
  return (
    <span
      aria-hidden
      style={{
        width: 12, height: 12, minWidth: 12, borderRadius: 2,
        border: '1px solid var(--color-ink-hair)',
        background: selected ? 'var(--color-ink)' : 'transparent',
      }}
    />
  );
}

export function QuestionOptionRow({
  option, index, multiSelect, selected, onSelect,
}: {
  option: AskOption;
  index: number;
  multiSelect: boolean;
  selected: boolean;
  onSelect: () => void;
}) {
  const [hovered, setHovered] = useState(false);
  return (
    <button
      type="button"
      data-testid={`ask-option-${option.id}`}
      data-selected={selected ? 'true' : 'false'}
      onClick={onSelect}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={rowStyle(selected, hovered)}
    >
      <Lead multiSelect={multiSelect} index={index} selected={selected} />
      <span style={{ fontSize: 13, color: 'var(--color-ink)' }}>{option.label}</span>
      {option.recommended && (
        <span
          style={{
            fontSize: 10, padding: '1px 6px', borderRadius: 999,
            background: 'var(--color-paper-deep)', color: 'var(--color-ink-soft)',
          }}
        >
          推荐
        </span>
      )}
      <span style={{ flex: 1, fontSize: 12, color: 'var(--color-ink-soft)' }}>{option.description}</span>
    </button>
  );
}

/**
 * 自定义答案行。它就是第 n+1 个选项：同样的行高、同样的前导、与上一行之间没有
 * 分割线，也没有展开态。标签位是一个透明的行内输入框。
 *
 * 「选中」不由点击或焦点驱动，只由文本 trim 后非空驱动（askDraft 不变量一）。
 */
export function QuestionCustomRow({
  index, multiSelect, value, onChange, inputRef,
}: {
  index: number;
  multiSelect: boolean;
  value: string;
  onChange: (text: string) => void;
  inputRef?: Ref<HTMLInputElement>;
}) {
  const selected = value.trim() !== '';
  const [hovered, setHovered] = useState(false);
  return (
    <div
      data-testid="ask-custom-row"
      data-selected={selected ? 'true' : 'false'}
      style={rowStyle(selected, hovered)}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      // 整行可点：它长得跟其他选项行一样（同样的 cursor: pointer），点编号或
      // 勾选框却没反应会很怪。聚焦是导航，不是选中——选中仍然只由文本非空驱动。
      onClick={(e) => e.currentTarget.querySelector('input')?.focus()}
    >
      <Lead multiSelect={multiSelect} index={index} selected={selected} />
      <input
        ref={inputRef}
        data-testid="ask-custom-input"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={multiSelect ? '其他，我想说点别的' : '都不是，我想说点别的'}
        style={{
          flex: 1, height: 24, fontSize: 13, border: 'none', background: 'transparent',
          padding: 0, outline: 'none', color: 'var(--color-ink)',
        }}
      />
    </div>
  );
}
