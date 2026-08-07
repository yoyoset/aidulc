// reader/core/*.js 是 `(function (global) { ... })(window)` 形式的 IIFE(和 aidu 前端一致的写法),
// 在 vitest 的 node 环境里没有真实 window。这三个模块(timeline/shadow/search_index)是纯逻辑、
// 零 DOM 依赖, 只需要一个可挂属性的对象充当 window, 不需要引入 jsdom。
globalThis.window = globalThis;
