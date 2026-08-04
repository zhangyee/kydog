import { useEffect, useState } from 'react';
import type { ResearchCustomVar, ResearchVarKind, SettingsFile } from '../../shared/types';
import { PRESET_RESEARCH_VARS } from '../../shared/researchVars';
import { validateCustomVarName } from '../../shared/researchValidate';
import { Card, BlockHeader, SubHeader, Divider, Btn, Empty, inputStyle, labelStyle, hintStyle } from './ui';

type Research = SettingsFile['research'];

export function ResearchCredentialsSection() {
  const [presets, setPresets] = useState<Record<string, string>>({});
  const [custom, setCustom] = useState<ResearchCustomVar[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        const r = await window.kydog.invoke('research.get');
        setPresets(r.presets);
        setCustom(r.custom);
      } catch (e) {
        setError(String((e as Error).message));
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const edit = (fn: () => void) => { setSaved(false); setError(null); fn(); };

  const onSave = async () => {
    setSaving(true); setError(null);
    try {
      const payload: Research = { presets, custom };
      const r = await window.kydog.invoke('research.save', payload);
      setPresets(r.presets);
      setCustom(r.custom);
      setSaved(true);
    } catch (e) {
      setError(String((e as Error).message));
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return <div style={{ padding: 28, color: 'var(--color-ink-soft)' }}>装载中…</div>;
  }

  const customNames = custom.map((c) => c.name);

  return (
    <div style={{ padding: '24px 28px 36px', maxWidth: 840 }}>
      <BlockHeader>预设</BlockHeader>
      <Card>
        <SubHeader subtitle="明文存于 ~/.kydog/kydog.json::research；留空则沿用 KyDog 启动时的同名环境变量" />
        {PRESET_RESEARCH_VARS.map((v) => (
          <VarRow
            key={v.name}
            name={v.name}
            kind={v.kind}
            label={v.label}
            hint={`${v.sources} · ${v.note}`}
            value={presets[v.name] ?? ''}
            onChange={(next) => edit(() => setPresets((p) => ({ ...p, [v.name]: next })))}
          />
        ))}
      </Card>

      <div style={{ height: 28 }} />

      <BlockHeader>自定义</BlockHeader>
      <Card>
        <SubHeader subtitle="预设之外的环境变量，同样写进 agent 的运行环境" />
        {custom.length === 0 && !adding && <Empty />}
        {custom.map((c, i) => (
          <VarRow
            key={c.name}
            name={c.name}
            kind={c.kind}
            label={c.name}
            hint={c.kind === 'email' ? '邮箱' : '密钥'}
            value={c.value}
            onChange={(next) => edit(() => setCustom((list) => list.map((x, j) => (j === i ? { ...x, value: next } : x))))}
            onRemove={() => edit(() => setCustom((list) => list.filter((_, j) => j !== i)))}
          />
        ))}

        {adding ? (
          <>
            <Divider />
            <AddVarForm
              existing={customNames}
              onCancel={() => setAdding(false)}
              onAdd={(entry) => { edit(() => setCustom((list) => [...list, entry])); setAdding(false); }}
            />
          </>
        ) : (
          <div style={{ marginTop: 12 }}>
            <Btn variant="primary" testId="research-add-var" onClick={() => setAdding(true)}>+ 添加变量</Btn>
          </div>
        )}
      </Card>

      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 20 }}>
        <button
          type="button"
          data-testid="research-save"
          onClick={() => void onSave()}
          disabled={saving}
          className="font-sans bg-[color:var(--color-paper-deep)] disabled:opacity-50 transition-colors hover:bg-[color:var(--color-hover-bg)]"
          style={{
            padding: '6px 16px', borderRadius: 999, fontSize: 12, fontWeight: 500,
            color: 'var(--color-ink)', border: '0.5px solid var(--color-ink-hair)',
          }}
        >
          {saving ? '保存中…' : '保存'}
        </button>
        {saved && (
          <span data-testid="research-saved" className="font-serif italic" style={{ fontSize: 11, color: 'var(--color-ink-soft)' }}>
            已保存，下一次工具调用即生效
          </span>
        )}
      </div>
      {error && (
        <div data-testid="research-error" style={{ color: 'var(--color-danger, #c0392b)', marginTop: 10, fontSize: 12 }}>{error}</div>
      )}
    </div>
  );
}

function VarRow({ name, kind, label, hint, value, onChange, onRemove }: {
  name: string;
  kind: ResearchVarKind;
  label: string;
  hint: string;
  value: string;
  onChange: (next: string) => void;
  onRemove?: () => void;
}) {
  const [shown, setShown] = useState(false);
  const isKey = kind === 'key';
  return (
    <div
      data-testid={`research-var-${name}`}
      style={{ display: 'flex', gap: 24, padding: '14px 0', borderTop: '0.5px solid var(--color-ink-hair-soft)', alignItems: 'flex-start' }}
    >
      <div style={{ width: 200, flexShrink: 0 }}>
        <div style={labelStyle}>{label}</div>
        <div className="font-mono" style={{ fontSize: 10, color: 'var(--color-ink-faint)', marginTop: 2 }}>{name}</div>
        <div style={hintStyle}>{hint}</div>
      </div>
      <div style={{ flex: 1, display: 'flex', gap: 8, alignItems: 'center' }}>
        <input
          type={isKey && !shown ? 'password' : 'text'}
          value={value}
          placeholder={isKey ? '未填写' : 'you@example.com'}
          onChange={(e) => onChange(e.target.value)}
          style={{ ...inputStyle, flex: 1 }}
        />
        {isKey && (
          <button
            type="button"
            onClick={() => setShown((v) => !v)}
            className="font-sans"
            style={{ background: 'transparent', color: 'var(--color-ink-soft)', fontSize: 11, padding: '4px 0' }}
          >
            {shown ? '隐藏' : '显示'}
          </button>
        )}
        {onRemove && <Btn variant="danger" onClick={onRemove}>删除</Btn>}
      </div>
    </div>
  );
}

function AddVarForm({ existing, onAdd, onCancel }: {
  existing: string[];
  onAdd: (entry: ResearchCustomVar) => void;
  onCancel: () => void;
}) {
  const [kind, setKind] = useState<ResearchVarKind>('key');
  const [name, setName] = useState('');
  const [value, setValue] = useState('');
  const [err, setErr] = useState<string | null>(null);

  const confirm = () => {
    const trimmed = name.trim();
    const msg = validateCustomVarName(trimmed, existing);
    if (msg) { setErr(msg); return; }
    onAdd({ name: trimmed, kind, value: value.trim() });
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        {(['key', 'email'] as const).map((k) => (
          <button
            key={k}
            type="button"
            data-testid={`research-kind-${k}`}
            onClick={() => setKind(k)}
            className="font-sans"
            style={{
              padding: '3px 12px', borderRadius: 999, fontSize: 11,
              border: '0.5px solid var(--color-ink-hair)',
              background: kind === k ? 'var(--color-paper-deep)' : 'transparent',
              color: 'var(--color-ink)',
            }}
          >
            {k === 'key' ? '密钥' : '邮箱'}
          </button>
        ))}
      </div>
      <input
        data-testid="research-new-name"
        value={name}
        placeholder="变量名，例如 MY_SOURCE_API_KEY"
        onChange={(e) => { setName(e.target.value); setErr(null); }}
        style={inputStyle}
      />
      <input
        data-testid="research-new-value"
        type={kind === 'key' ? 'password' : 'text'}
        value={value}
        placeholder="值"
        onChange={(e) => setValue(e.target.value)}
        style={inputStyle}
      />
      {err && <div style={{ color: 'var(--color-danger, #c0392b)', fontSize: 11 }}>{err}</div>}
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <Btn variant="secondary" onClick={onCancel}>取消</Btn>
        <Btn variant="primary" testId="research-new-confirm" onClick={confirm}>确定</Btn>
      </div>
    </div>
  );
}
