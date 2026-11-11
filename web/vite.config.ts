import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    host: '127.0.0.1',
    // 忽略 npm / 构建过程产生的临时目录，避免 Windows 上 EBUSY 导致 dev server 崩溃
    watch: {
      // 本机文件事件偶发丢失（HMR 拿不到部分改动），开启轮询确保改动一定生效
      usePolling: true,
      interval: 250,
      ignored: ['**/.package.json.*', '**/*.tmpdir/**', '**/dist/**', '**/.tmp/**', '**/node_modules/**'],
    },
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:4399',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    chunkSizeWarningLimit: 900,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined;
          if (id.includes('@ant-design/icons')) return 'icons';
          // antd 的 barrel 会重新导出所有组件，按组件拆会让 antd 与组件 chunk 互相引用；
          // 这里只把 antd 本体和它依赖的 rc-* / @ant-design 基础库分开，避免循环 chunk。
          if (id.includes('/antd/')) return 'antd';
          if (id.includes('/rc-') || id.includes('/@rc-component/') || id.includes('/@ant-design/')) {
            return 'antd-core';
          }
          if (id.includes('/react/') || id.includes('/react-dom/') || id.includes('/react-router')) return 'react';
          if (id.includes('/dayjs/')) return 'dayjs';
          return undefined;
        },
      },
    },
  },
});
