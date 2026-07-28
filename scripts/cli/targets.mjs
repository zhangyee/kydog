// scripts/cli/targets.mjs
// host 平台映射；binary 文件名加 Windows .exe 后缀

const ALLOWED = new Set(['darwin-arm64', 'darwin-x64', 'win32-x64']);

export function mapPlatformArch(platform, arch) {
  const key = `${platform}-${arch}`;
  if (!ALLOWED.has(key)) {
    throw new Error(`unsupported platform/arch: ${key} (supported: ${[...ALLOWED].join(', ')})`);
  }
  return key;
}

export function hostTarget() {
  return mapPlatformArch(process.platform, process.arch);
}

export function binaryFileName(name, platform = process.platform) {
  return platform === 'win32' ? `${name}.exe` : name;
}
