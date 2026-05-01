// src/main/llm/cloudEnvSync.ts
import type { ProviderId, ProviderOverride } from '../../shared/types';

/** 由 KyDog 接管的 env vars；apply 时先全清再按当前配置写入。 */
export const MANAGED_VARS = [
  // Azure
  'AZURE_OPENAI_BASE_URL',
  'AZURE_OPENAI_RESOURCE_NAME',
  'AZURE_OPENAI_API_VERSION',
  'AZURE_OPENAI_DEPLOYMENT_NAME_MAP',
  // Bedrock
  'AWS_PROFILE',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_BEARER_TOKEN_BEDROCK',
  'AWS_REGION',
  'AWS_BEDROCK_FORCE_CACHE',
  // Vertex
  'GOOGLE_CLOUD_PROJECT',
  'GOOGLE_CLOUD_LOCATION',
  'GOOGLE_APPLICATION_CREDENTIALS',
] as const;

export function applyCloudEnv(providers: Record<ProviderId, ProviderOverride>): void {
  for (const k of MANAGED_VARS) delete process.env[k];

  const azure = providers['azure-openai-responses']?.cloud;
  if (azure?.kind === 'azure') {
    if (azure.resourceName) {
      process.env.AZURE_OPENAI_RESOURCE_NAME = azure.resourceName;
    } else if (providers['azure-openai-responses']?.baseUrl) {
      process.env.AZURE_OPENAI_BASE_URL = providers['azure-openai-responses']!.baseUrl!;
    }
    if (azure.apiVersion) process.env.AZURE_OPENAI_API_VERSION = azure.apiVersion;
    if (azure.deploymentNameMap) {
      process.env.AZURE_OPENAI_DEPLOYMENT_NAME_MAP = Object.entries(azure.deploymentNameMap)
        .map(([k, v]) => `${k}=${v}`)
        .join(',');
    }
  }

  const bedrock = providers['amazon-bedrock']?.cloud;
  if (bedrock?.kind === 'bedrock') {
    if (bedrock.authMode === 'profile' && bedrock.awsProfile) {
      process.env.AWS_PROFILE = bedrock.awsProfile;
    }
    if (bedrock.authMode === 'iamKeys') {
      if (bedrock.awsAccessKeyId) process.env.AWS_ACCESS_KEY_ID = bedrock.awsAccessKeyId;
      if (bedrock.awsSecretAccessKey) process.env.AWS_SECRET_ACCESS_KEY = bedrock.awsSecretAccessKey;
    }
    if (bedrock.authMode === 'bearer' && bedrock.awsBearerToken) {
      process.env.AWS_BEARER_TOKEN_BEDROCK = bedrock.awsBearerToken;
    }
    if (bedrock.region) process.env.AWS_REGION = bedrock.region;
    if (bedrock.forceCache) process.env.AWS_BEDROCK_FORCE_CACHE = '1';
  }

  const vertex = providers['google-vertex']?.cloud;
  if (vertex?.kind === 'vertex') {
    process.env.GOOGLE_CLOUD_PROJECT = vertex.project;
    process.env.GOOGLE_CLOUD_LOCATION = vertex.location;
    if (vertex.serviceAccountKeyPath) {
      process.env.GOOGLE_APPLICATION_CREDENTIALS = vertex.serviceAccountKeyPath;
    }
  }
}
