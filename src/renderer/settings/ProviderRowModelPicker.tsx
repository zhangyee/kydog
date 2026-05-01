// src/renderer/settings/ProviderRowModelPicker.tsx
import { useLlmStore } from '../stores/llmStore';

export function ProviderRowModelPicker({
  providerId, value, onChange, disabled,
}: {
  providerId: string;
  value: string | null;
  onChange: (modelId: string) => void;
  disabled?: boolean;
}) {
  const entry = useLlmStore((s) => s.configured.find((c) => c.providerId === providerId));
  const options = entry?.modelIds ?? [];
  return (
    <select
      value={value ?? ''}
      disabled={disabled || options.length === 0}
      onChange={(e) => onChange(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      style={{
        background: 'transparent',
        border: '0.5px solid var(--color-ink-hair)',
        borderRadius: 999,
        padding: '3px 10px',
        fontFamily: 'var(--font-mono)',
        fontSize: 11,
        color: 'var(--color-ink)',
      }}
    >
      <option value="">{options.length ? '选择模型…' : '无可用模型'}</option>
      {options.map((m) => (
        <option key={m} value={m}>{m}</option>
      ))}
    </select>
  );
}
