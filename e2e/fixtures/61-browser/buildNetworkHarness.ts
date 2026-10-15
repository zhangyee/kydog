import { build } from 'vite';
import { builtinModules } from 'node:module';
import path from 'node:path';
export async function buildNetworkHarness(outDir: string): Promise<string> {
  await build({ configFile: false, logLevel: 'warn', build: {
    ssr: path.resolve(__dirname, 'networkHarnessMain.ts'), outDir, emptyOutDir: true, minify: false,
    rollupOptions: {
      external: [...builtinModules, ...builtinModules.map(n => `node:${n}`), 'electron', '@earendil-works/pi-coding-agent', 'undici', 'jsdom'],
      output: { format: 'cjs', entryFileNames: 'network-main.cjs' },
    },
  } });
  return path.join(outDir, 'network-main.cjs');
}
