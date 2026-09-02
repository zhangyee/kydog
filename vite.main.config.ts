import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    rollupOptions: {
      // 往这里加 external（electron 除外，它由运行时提供）＝ 该包不进 bundle，只以裸名
      // 留在产物里，运行时得从 node_modules 解析。所以必须同步加进 forge.config.ts 的
      // EXTERNAL_RUNTIME_MODULES，否则打包成品里根本没有它——而开发机上 out/ 能上溯到
      // <repo>/node_modules，照样跑得起来，只有装到别的机器上才炸。
      // e2e/54 的断言 2b 直接读产物里残留的裸名对账，漏了会红。
      external: ['@earendil-works/pi-coding-agent', 'electron'],
    },
  },
});
