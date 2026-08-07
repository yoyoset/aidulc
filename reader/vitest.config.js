import { defineConfig } from 'vitest/config';

// reader/ 的 core/*.js 是挂在 window 上的 IIFE(非 ES module, 复用 aidu 前端的既有写法),
// 零 DOM 依赖 —— 不引入 jsdom, tests/setup.js 用一个最小 shim (window = globalThis) 即可。
export default defineConfig({
  test: {
    environment: 'node',
    setupFiles: ['./tests/setup.js'],
    include: ['tests/**/*.test.js'],
  },
});
