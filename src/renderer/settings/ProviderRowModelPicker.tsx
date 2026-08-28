// src/renderer/settings/ProviderRowModelPicker.tsx
import { useLlmStore } from '../stores/llmStore';

/**
 * `emptyLabel` 是这个 provider 还没有模型清单时占位项上的字。默认那句「无可用模型」
 * 只在**已经配好、清单确实是空的**时候才成立；配置前（key 还没保存、OAuth 还没登录）
 * 清单为空是必然的，照抄那句话等于告诉用户「这个 provider 没有模型」——用户会去换
 * provider，而不是去按保存。所以缺什么就由调用方说清楚缺什么。
 */
export function ProviderRowModelPicker({
  providerId, value, onChange, disabled, emptyLabel = '无可用模型',
}: {
  providerId: string;
  value: string | null;
  onChange: (modelId: string) => void;
  disabled?: boolean;
  emptyLabel?: string;
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
      <option value="">{options.length ? '选择模型…' : emptyLabel}</option>
      {options.map((m) => (
        <option key={m} value={m}>{m}</option>
      ))}
    </select>
  );
}
