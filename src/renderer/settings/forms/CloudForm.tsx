// src/renderer/settings/forms/CloudForm.tsx
import { useState, type ReactNode } from 'react';
import { useLlmStore } from '../../stores/llmStore';
import { useUiStore } from '../../stores/uiStore';
import { ProviderRowModelPicker } from '../ProviderRowModelPicker';
import { inputStyle } from '../ui';
import type { AzureCfg, BedrockCfg, VertexCfg } from '../../../shared/types';

const CFG_KIND_BY_PROVIDER: Record<string, 'azure' | 'bedrock' | 'vertex'> = {
  'azure-openai-responses': 'azure',
  'amazon-bedrock': 'bedrock',
  'google-vertex': 'vertex',
};

export function CloudForm({ providerId }: { providerId: string }) {
  const cfgKind = CFG_KIND_BY_PROVIDER[providerId];
  const refresh = useLlmStore((s) => s.refresh);
  const closeDetail = useUiStore((s) => s.closeSettingsDetail);

  if (cfgKind === 'azure') return <AzureBranch providerId={providerId} onSave={refresh} onRemove={() => { closeDetail(); }} />;
  if (cfgKind === 'bedrock') return <BedrockBranch providerId={providerId} onSave={refresh} onRemove={() => { closeDetail(); }} />;
  if (cfgKind === 'vertex') return <VertexBranch providerId={providerId} onSave={refresh} onRemove={() => { closeDetail(); }} />;
  return <div>未知 cloud provider {providerId}</div>;
}

function AzureBranch({ providerId, onSave, onRemove }: { providerId: string; onSave: () => Promise<void>; onRemove: () => void }) {
  const [apiKey, setApiKey] = useState('');
  const [resourceName, setResourceName] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [apiVersion, setApiVersion] = useState('');
  const [deployRows, setDeployRows] = useState<Array<{ model: string; deployment: string }>>([]);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setError(null);
    if (!resourceName && !baseUrl) {
      setError('Resource name 与 Base URL 必须二选一');
      return;
    }
    const cloud: AzureCfg = {
      kind: 'azure',
      resourceName: resourceName || undefined,
      apiVersion: apiVersion || undefined,
      deploymentNameMap: deployRows.length
        ? Object.fromEntries(deployRows.filter((r) => r.model && r.deployment).map((r) => [r.model, r.deployment]))
        : undefined,
    };
    await window.kydog.invoke('llm.configure', {
      providerId,
      cfg: { kind: 'cloud', cloud, apiKey: apiKey || undefined, baseUrl: baseUrl || undefined },
    });
    await onSave();
  };

  return (
    <div>
      <Row label="API Key（→ auth blob）"><input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="sk-…" style={inputStyle} /></Row>
      <Row label="Resource name（与 Base URL 互斥）"><input value={resourceName} onChange={(e) => setResourceName(e.target.value)} placeholder="your-resource" style={inputStyle} /></Row>
      <Row label="Base URL"><input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://your-res.openai.azure.com" style={inputStyle} /></Row>
      <Row label="API Version"><input value={apiVersion} onChange={(e) => setApiVersion(e.target.value)} placeholder="2024-02-01" style={inputStyle} /></Row>
      <Row label="Deployment map">
        <DeploymentMapEditor rows={deployRows} onChange={setDeployRows} />
      </Row>
      <ModelRow providerId={providerId} />
      {error ? <div className="font-serif italic" style={{ color: 'var(--color-accent)', padding: '8px 0' }}>{error}</div> : null}
      <Footer providerId={providerId} onSubmit={submit} onRemove={onRemove} />
    </div>
  );
}

function BedrockBranch({ providerId, onSave, onRemove }: { providerId: string; onSave: () => Promise<void>; onRemove: () => void }) {
  const [authMode, setAuthMode] = useState<'profile' | 'iamKeys' | 'bearer'>('profile');
  const [awsProfile, setAwsProfile] = useState('');
  const [awsAccessKeyId, setAwsAccessKeyId] = useState('');
  const [awsSecretAccessKey, setAwsSecretAccessKey] = useState('');
  const [awsBearerToken, setAwsBearerToken] = useState('');
  const [region, setRegion] = useState('');
  const [forceCache, setForceCache] = useState(false);

  const submit = async () => {
    const cloud: BedrockCfg = {
      kind: 'bedrock', authMode,
      awsProfile: authMode === 'profile' ? awsProfile : undefined,
      awsAccessKeyId: authMode === 'iamKeys' ? awsAccessKeyId : undefined,
      awsSecretAccessKey: authMode === 'iamKeys' ? awsSecretAccessKey : undefined,
      awsBearerToken: authMode === 'bearer' ? awsBearerToken : undefined,
      region: region || undefined,
      forceCache: forceCache || undefined,
    };
    await window.kydog.invoke('llm.configure', { providerId, cfg: { kind: 'cloud', cloud } });
    await onSave();
  };

  return (
    <div>
      <Row label="认证方式">
        <div style={{ display: 'flex', gap: 14, fontSize: 12 }}>
          {(['profile', 'iamKeys', 'bearer'] as const).map((m) => (
            <label key={m}><input type="radio" checked={authMode === m} onChange={() => setAuthMode(m)} /> {m}</label>
          ))}
        </div>
      </Row>
      {authMode === 'profile' && (
        <Row label="AWS_PROFILE">
          <input value={awsProfile} onChange={(e) => setAwsProfile(e.target.value)} placeholder="default" style={inputStyle} />
        </Row>
      )}
      {authMode === 'iamKeys' && (
        <>
          <Row label="Access Key ID"><input value={awsAccessKeyId} onChange={(e) => setAwsAccessKeyId(e.target.value)} placeholder="AKIA…" style={inputStyle} /></Row>
          <Row label="Secret Access Key"><input type="password" value={awsSecretAccessKey} onChange={(e) => setAwsSecretAccessKey(e.target.value)} style={inputStyle} /></Row>
        </>
      )}
      {authMode === 'bearer' && (
        <Row label="Bearer Token">
          <input type="password" value={awsBearerToken} onChange={(e) => setAwsBearerToken(e.target.value)} style={inputStyle} />
        </Row>
      )}
      <Row label="Region"><input value={region} onChange={(e) => setRegion(e.target.value)} placeholder="us-east-1" style={inputStyle} /></Row>
      <Row label="Force cache">
        <label style={{ fontSize: 12 }}>
          <input type="checkbox" checked={forceCache} onChange={(e) => setForceCache(e.target.checked)} /> 启用 AWS_BEDROCK_FORCE_CACHE
        </label>
      </Row>
      <div className="font-serif italic" style={{ fontSize: 11, color: 'var(--color-ink-faint)', padding: '4px 0 12px' }}>
        ⓘ ECS / IRSA 自动检测（AWS_CONTAINER_CREDENTIALS_* / AWS_WEB_IDENTITY_TOKEN_FILE）由用户外部设置；KyDog 不接管。
      </div>
      <ModelRow providerId={providerId} />
      <Footer providerId={providerId} onSubmit={submit} onRemove={onRemove} />
    </div>
  );
}

function VertexBranch({ providerId, onSave, onRemove }: { providerId: string; onSave: () => Promise<void>; onRemove: () => void }) {
  const [project, setProject] = useState('');
  const [location, setLocation] = useState('');
  const [authMode, setAuthMode] = useState<'adc' | 'sa'>('adc');
  const [saPath, setSaPath] = useState('');
  const [error, setError] = useState<string | null>(null);

  const pickFile = async () => {
    const r = await window.kydog.invoke('dialog.pickFile', { filters: [{ name: 'JSON', extensions: ['json'] }] });
    if (r) setSaPath(r);
  };
  const submit = async () => {
    setError(null);
    if (!project || !location) { setError('Project / Location 必填'); return; }
    const cloud: VertexCfg = {
      kind: 'vertex', project, location,
      serviceAccountKeyPath: authMode === 'sa' && saPath ? saPath : undefined,
    };
    await window.kydog.invoke('llm.configure', { providerId, cfg: { kind: 'cloud', cloud } });
    await onSave();
  };

  return (
    <div>
      <Row label="Project"><input value={project} onChange={(e) => setProject(e.target.value)} placeholder="my-gcp-project" style={inputStyle} /></Row>
      <Row label="Location"><input value={location} onChange={(e) => setLocation(e.target.value)} placeholder="us-central1" style={inputStyle} /></Row>
      <Row label="凭证方式">
        <div style={{ display: 'flex', gap: 14, fontSize: 12 }}>
          <label><input type="radio" checked={authMode === 'adc'} onChange={() => setAuthMode('adc')} /> ADC（gcloud auth application-default login）</label>
          <label><input type="radio" checked={authMode === 'sa'} onChange={() => setAuthMode('sa')} /> Service Account Key 文件</label>
        </div>
      </Row>
      {authMode === 'sa' ? (
        <Row label="Key path">
          <div style={{ display: 'flex', gap: 8 }}>
            <input value={saPath} onChange={(e) => setSaPath(e.target.value)} placeholder="/path/to/sa.json" style={{ ...inputStyle, flex: 1 }} />
            <button type="button" onClick={pickFile} className="font-sans" style={{ background: 'transparent', textDecoration: 'underline', fontSize: 11 }}>选择…</button>
          </div>
        </Row>
      ) : null}
      <ModelRow providerId={providerId} />
      {error ? <div className="font-serif italic" style={{ color: 'var(--color-accent)', padding: '8px 0' }}>{error}</div> : null}
      <Footer providerId={providerId} onSubmit={submit} onRemove={onRemove} />
    </div>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div style={{ display: 'flex', gap: 24, padding: '14px 0', borderTop: '0.5px solid var(--color-ink-hair-soft)', alignItems: 'flex-start' }}>
      <div style={{ width: 180, flexShrink: 0 }} className="font-sans"><strong style={{ fontWeight: 500, fontSize: 13 }}>{label}</strong></div>
      <div style={{ flex: 1 }}>{children}</div>
    </div>
  );
}
function ModelRow({ providerId }: { providerId: string }) {
  const configured = useLlmStore((s) => s.configured.find((c) => c.providerId === providerId));
  return (
    <Row label="默认模型">
      <ProviderRowModelPicker
        providerId={providerId}
        value={configured?.defaultModel ?? null}
        disabled={!configured}
        emptyLabel={configured ? '无可用模型' : '先保存配置'}
        onChange={async (m) => { await window.kydog.invoke('llm.setDefault', { providerId, modelId: m }); }}
      />
    </Row>
  );
}
function Footer({ providerId, onSubmit, onRemove }: { providerId: string; onSubmit: () => Promise<void>; onRemove: () => void }) {
  const [saving, setSaving] = useState(false);
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '16px 0 0' }}>
      <button type="button" onClick={async () => {
        if (!confirm('移除该 provider？')) return;
        await window.kydog.invoke('llm.remove', { providerId });
        onRemove();
      }} className="font-sans" style={{ background: 'transparent', color: 'var(--color-accent, #a04040)', fontSize: 11 }}>
        移除
      </button>
      <button type="button" disabled={saving} onClick={async () => {
        setSaving(true); try { await onSubmit(); } finally { setSaving(false); }
      }}
        className="font-sans bg-[color:var(--color-paper-deep)] disabled:opacity-50 transition-colors hover:bg-[color:var(--color-hover-bg)]"
        style={{ padding: '6px 16px', borderRadius: 999, fontSize: 12, fontWeight: 500, color: 'var(--color-ink)', border: '0.5px solid var(--color-ink-hair)' }}>
        {saving ? '保存中…' : '保存'}
      </button>
    </div>
  );
}

function DeploymentMapEditor({ rows, onChange }: { rows: Array<{ model: string; deployment: string }>; onChange: (r: Array<{ model: string; deployment: string }>) => void }) {
  return (
    <div>
      {rows.map((r, i) => (
        <div key={i} style={{ display: 'flex', gap: 8, padding: '4px 0' }}>
          <input value={r.model} placeholder="modelId" onChange={(e) => onChange(rows.map((x, j) => j === i ? { ...x, model: e.target.value } : x))} style={inputStyle} />
          <input value={r.deployment} placeholder="deploymentName" onChange={(e) => onChange(rows.map((x, j) => j === i ? { ...x, deployment: e.target.value } : x))} style={inputStyle} />
          <button type="button" onClick={() => onChange(rows.filter((_, j) => j !== i))} style={{ background: 'transparent', color: 'var(--color-accent, #a04040)', fontSize: 11 }}>×</button>
        </div>
      ))}
      <button type="button" onClick={() => onChange([...rows, { model: '', deployment: '' }])} className="font-sans"
        style={{ marginTop: 6, fontSize: 11, color: 'var(--color-ink-soft)', background: 'transparent', textDecoration: 'underline' }}>
        + 新增映射
      </button>
    </div>
  );
}
