import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    rollupOptions: {
      // 两个页面入口：主窗口，以及主进程用来把 PDF 画成 PNG 的那张不显示的页
      // （src/main/pdf/pdfRaster.ts）。加了 input 就得把 index.html 也列上，
      // 否则 rollup 只认这里写的这些。产物路径按相对 root 保留目录层级。
      input: {
        main_window: here('./index.html'),
        pdf_raster: here('./src/renderer/assets/pdf-raster.html'),
      },
    },
  },
});
