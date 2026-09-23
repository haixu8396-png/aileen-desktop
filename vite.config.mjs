import { defineConfig } from 'vite';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('./src', import.meta.url));

export default defineConfig({
  // 使用相对路径，方便 Electron 以 file:// 方式加载构建产物
  root: 'src',
  base: './',
  build: {
    outDir: '../dist',
    emptyOutDir: true,
    chunkSizeWarningLimit: 4096,
    rollupOptions: {
      // 主窗口 + 无边框悬浮展台窗，两个独立入口
      input: {
        index: resolve(root, 'index.html'),
        overlay: resolve(root, 'overlay.html'),
      },
    },
  },
  server: {
    port: 5173,
    strictPort: false,
  },
});
