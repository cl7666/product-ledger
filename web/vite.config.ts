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
        manualChunks: {
          react: ['react', 'react-dom', 'react-router-dom'],
          antd: ['antd', '@ant-design/icons'],
        },
      },
    },
  },
});
