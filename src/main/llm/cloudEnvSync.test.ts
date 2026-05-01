import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { ProviderOverride, ProviderId } from '../../shared/types';
import { applyCloudEnv, MANAGED_VARS } from './cloudEnvSync';

const ALL_VARS: string[] = [...MANAGED_VARS];

describe('cloudEnvSync.applyCloudEnv', () => {
  const saved = new Map<string, string | undefined>();
  beforeEach(() => {
    for (const k of ALL_VARS) {
      saved.set(k, process.env[k]);
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('Azure: resourceName 优先；deploymentNameMap 序列化为 k=v,逗号分隔', () => {
    const providers: Record<ProviderId, ProviderOverride> = {
      'azure-openai-responses': {
        cloud: {
          kind: 'azure',
          resourceName: 'my-res',
          apiVersion: '2024-02-01',
          deploymentNameMap: { 'gpt-4o': 'my-gpt4o', 'gpt-4': 'my-gpt4' },
        },
      },
    };
    applyCloudEnv(providers);
    expect(process.env.AZURE_OPENAI_RESOURCE_NAME).toBe('my-res');
    expect(process.env.AZURE_OPENAI_BASE_URL).toBeUndefined();
    expect(process.env.AZURE_OPENAI_API_VERSION).toBe('2024-02-01');
    expect(process.env.AZURE_OPENAI_DEPLOYMENT_NAME_MAP).toBe('gpt-4o=my-gpt4o,gpt-4=my-gpt4');
  });

  it('Azure: 无 resourceName 但有 baseUrl → 设 BASE_URL', () => {
    applyCloudEnv({
      'azure-openai-responses': { baseUrl: 'https://x.openai.azure.com', cloud: { kind: 'azure' } },
    });
    expect(process.env.AZURE_OPENAI_BASE_URL).toBe('https://x.openai.azure.com');
    expect(process.env.AZURE_OPENAI_RESOURCE_NAME).toBeUndefined();
  });

  it('Bedrock profile mode', () => {
    applyCloudEnv({
      'amazon-bedrock': { cloud: { kind: 'bedrock', authMode: 'profile', awsProfile: 'me', region: 'us-west-2' } },
    });
    expect(process.env.AWS_PROFILE).toBe('me');
    expect(process.env.AWS_REGION).toBe('us-west-2');
    expect(process.env.AWS_ACCESS_KEY_ID).toBeUndefined();
    expect(process.env.AWS_BEARER_TOKEN_BEDROCK).toBeUndefined();
  });

  it('Bedrock iamKeys mode + forceCache', () => {
    applyCloudEnv({
      'amazon-bedrock': { cloud: {
        kind: 'bedrock', authMode: 'iamKeys',
        awsAccessKeyId: 'AKIA', awsSecretAccessKey: 'sec', forceCache: true,
      } },
    });
    expect(process.env.AWS_ACCESS_KEY_ID).toBe('AKIA');
    expect(process.env.AWS_SECRET_ACCESS_KEY).toBe('sec');
    expect(process.env.AWS_BEDROCK_FORCE_CACHE).toBe('1');
    expect(process.env.AWS_PROFILE).toBeUndefined();
  });

  it('Bedrock bearer mode', () => {
    applyCloudEnv({
      'amazon-bedrock': { cloud: { kind: 'bedrock', authMode: 'bearer', awsBearerToken: 'tok' } },
    });
    expect(process.env.AWS_BEARER_TOKEN_BEDROCK).toBe('tok');
    expect(process.env.AWS_PROFILE).toBeUndefined();
    expect(process.env.AWS_ACCESS_KEY_ID).toBeUndefined();
  });

  it('Vertex: project + location 必设；serviceAccountKeyPath 设到 GOOGLE_APPLICATION_CREDENTIALS', () => {
    applyCloudEnv({
      'google-vertex': { cloud: {
        kind: 'vertex', project: 'p1', location: 'us-central1',
        serviceAccountKeyPath: '/tmp/sa.json',
      } },
    });
    expect(process.env.GOOGLE_CLOUD_PROJECT).toBe('p1');
    expect(process.env.GOOGLE_CLOUD_LOCATION).toBe('us-central1');
    expect(process.env.GOOGLE_APPLICATION_CREDENTIALS).toBe('/tmp/sa.json');
  });

  it('二次 apply: 切换 authMode 时清残留', () => {
    applyCloudEnv({
      'amazon-bedrock': { cloud: {
        kind: 'bedrock', authMode: 'iamKeys', awsAccessKeyId: 'A', awsSecretAccessKey: 'S',
      } },
    });
    applyCloudEnv({
      'amazon-bedrock': { cloud: { kind: 'bedrock', authMode: 'profile', awsProfile: 'me' } },
    });
    expect(process.env.AWS_PROFILE).toBe('me');
    expect(process.env.AWS_ACCESS_KEY_ID).toBeUndefined();
    expect(process.env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
  });

  it('providers 全空 → 全部 MANAGED_VARS 删除', () => {
    process.env.AWS_REGION = 'pre-existing';
    applyCloudEnv({});
    expect(process.env.AWS_REGION).toBeUndefined();
  });
});
