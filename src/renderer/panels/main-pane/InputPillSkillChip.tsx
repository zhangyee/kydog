import type { SkillEntry } from '../../../shared/types';

type Props = {
  skill: SkillEntry;
  onRemove: () => void;
};

export function InputPillSkillChip({ skill, onRemove }: Props) {
  return (
    <span
      data-testid="skill-chip"
      title={skill.description}
      className="font-mono inline-flex items-center select-none group"
      style={{
        padding: '2px 4px 2px 10px',
        background: 'color-mix(in srgb, var(--color-accent) 18%, transparent)',
        color: 'var(--color-accent)',
        borderRadius: 999,
        fontSize: 12,
        gap: 4,
        lineHeight: 1.4,
        cursor: 'default',
        whiteSpace: 'nowrap',
      }}
    >
      <span>/{skill.name}</span>
      <button
        type="button"
        data-testid="skill-chip-remove"
        onMouseDown={(e) => { e.preventDefault(); onRemove(); }}
        aria-label="移除"
        className="opacity-0 group-hover:opacity-100 transition-opacity"
        style={{
          width: 16,
          height: 16,
          padding: 0,
          border: 'none',
          borderRadius: 999,
          background: 'var(--color-accent)',
          color: 'var(--color-paper)',
          cursor: 'pointer',
          fontSize: 10,
          lineHeight: 1,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        ×
      </button>
    </span>
  );
}
