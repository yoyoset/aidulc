/**
 * storage.js —— 存储抽象接口 (V5, 2026-08-09)
 *
 * 契约: get/put/list/delete 四个原语。服务端业务代码只依赖这个接口,
 * 不写死任何 CF 专有 API —— 这样免费路径 (用户自己的 CF KV) 和付费路径
 * (托管在自己 VPS 上跑同一份代码) 共用同一份 worker 逻辑。
 *
 * 两个实现:
 *   1. createCloudflareKv(env.DB)   —— CF Workers KV 绑定
 *   2. createFileKv(dirPath)        —— 本地/VPS 文件存储 (node:fs, 同接口)
 *
 * 选择方式: worker 启动时若 env.DB 存在用 CF KV, 否则若 env.KV_DIR 存在用文件存储。
 * 本地测试 (node) 直接用 createFileKv 驱动同一套业务代码。
 */
'use strict';

/**
 * @typedef {Object} Storage
 * @property {(key: string) => Promise<string|null>} get
 * @property {(key: string, value: string) => Promise<void>} put
 * @property {(key: string) => Promise<void>} delete
 * @property {(prefix: string) => Promise<string[]>} list  // 返回该前缀下的键 (不含前缀过滤)
 */

/** CF Workers KV 实现: 只包一层 get/put/delete/list, 不引入任何 CF 语义之外的依赖。 */
export function createCloudflareKv(binding) {
  return {
    async get(key) {
      return binding.get(key);
    },
    async put(key, value) {
      await binding.put(key, value);
    },
    async delete(key) {
      await binding.delete(key);
    },
    async list(prefix) {
      // CF KV list 分页 (每页最多 1000); 这里全量遍历拼好。
      let cursor;
      const keys = [];
      do {
        const page = await binding.list({ prefix, cursor });
        for (const k of page.keys) keys.push(k.name);
        cursor = page.cursor;
      } while (cursor);
      return keys;
    },
  };
}

/**
 * 本地/VPS 文件存储: 一个键一个文件 (键的 : 换成 _), 文件内容即值。
 * 只用于本地测试 / 自建 VPS 后端; 语义与 KV 一致 (get 缺失返回 null)。
 * 用动态 import 保持 ESM (CF Worker 与 Node 测试同一份代码)。
 */
export function createFileKv(dirPath) {
  let fs = null;
  let path = null;
  const ensure = async () => {
    if (!fs) {
      fs = await import('node:fs');
      path = await import('node:path');
      if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
    }
  };
  const fileFor = (key) => path.join(dirPath, String(key).replace(/[^A-Za-z0-9._-]/g, '_'));

  return {
    async get(key) {
      await ensure();
      const p = fileFor(key);
      if (!fs.existsSync(p)) return null;
      return fs.readFileSync(p, 'utf8');
    },
    async put(key, value) {
      await ensure();
      fs.writeFileSync(fileFor(key), String(value), 'utf8');
    },
    async delete(key) {
      await ensure();
      const p = fileFor(key);
      if (fs.existsSync(p)) fs.unlinkSync(p);
    },
    async list(prefix) {
      await ensure();
      const p = fileFor(prefix);
      const dir = path.dirname(p);
      const base = path.basename(p);
      if (!fs.existsSync(dir)) return [];
      return fs
        .readdirSync(dir)
        .filter((f) => f.startsWith(base))
        .map((f) => f);
    },
  };
}
