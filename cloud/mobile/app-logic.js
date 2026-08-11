/**
 * app-logic.js —— 手机端应用逻辑 (V7, 2026-08-09)
 * 平台无关 (只依赖 adapter 的 storage/net/clock), node 可测。
 *
 * 核心规则 (与桌面端一致):
 *   - 本地先写: 评分先落 IndexedDB words + 待推队列 pending, UI 不等网络
 *   - 先推后拉: 每次同步先推本地未推的改动, 再拉远端
 *   - 离线可完整复习: 评分只写本地; 恢复网络自动补推
 *   - 冲突按 updated_at 新者胜
 */
'use strict';

function makeAppLogic(adapter) {
  const { storage, net, clock } = adapter;

  return {
    adapter,

    async init() {
      await storage.init();
    },

    // ---- 生词本 ----
    async loadWords() {
      return (await storage.getWords()) || [];
    },

    async saveLocal(word) {
      // 本地先写 + 进待推队列
      await storage.putWord(word);
      await storage.pushPending(word);
    },

    // ---- 配对 (P0-C, 2026-08-10) ----
    /**
     * 扫码/链接直连配对: 桌面端二维码内容是 `#t=<token>&u=<worker_url>`, token 是
     * 桌面端为手机单独换的 device token (绑同一个 user)。直接存进 IndexedDB 即免登录,
     * 不经过 authDevice 的网络兑换 (那个是 ROOT_SECRET/6 位码路径)。
     */
    async applyPairing({ token, workerUrl }) {
      if (token) await storage.setToken(token);
      if (workerUrl) await storage.setWorkerUrl(workerUrl);
      return true;
    },

    // ---- 同步 ----
    async authDevice({ workerUrl, rootSecret, code, deviceName }) {
      const r = await net.authDevice({ url: workerUrl, rootSecret, code, deviceName });
      if (r.ok && r.token) {
        await storage.setToken(r.token);
        await storage.setWorkerUrl(workerUrl);
        await storage.setDeviceName(deviceName);
        await storage.setToken(r.token);
      }
      return r;
    },

    async makeInviteCode({ type, name }) {
      const url = await storage.getWorkerUrl();
      const token = await storage.getToken();
      if (!url || !token) return { ok: false, error: '未登录' };
      return net.makeCode({ url, token, type, name });
    },

    /**
     * 同步一次: 先推后拉。离线 → 返回 {ok:false, offline:true}, 本地不动。
     * 成功 → 清待推队列 + 拉远端新者胜合并。
     */
    async sync() {
      const url = await storage.getWorkerUrl();
      const token = await storage.getToken();
      if (!url || !token) return { ok: false, offline: true, error: '未配置' };

      // 1. 先推: 待推队列 (本地先写 → 恢复网络自动补推)
      const pending = await storage.getPending();
      const words = {};
      for (const w of pending) {
        words[w.lemma || w.word] = w;
      }
      if (Object.keys(words).length > 0) {
        const pushRes = await net.syncPush({ url, token, words }).catch((e) => ({ ok: false, error: String(e) }));
        if (!pushRes || !pushRes.ok) {
          return { ok: false, offline: true, error: (pushRes && pushRes.error) || '推送失败', pushFailed: true };
        }
      }

      // 2. 再拉: 增量 (first pull since=0)
      const pullRes = await net.syncPull({ url, token, since: 0 }).catch((e) => ({ ok: false, error: String(e) }));
      if (!pullRes || !pullRes.ok) {
        return { ok: false, offline: true, error: (pullRes && pullRes.error) || '拉取失败' };
      }

      // 3. 合并远端 (新者胜), 写回本地; 清待推
      // F1 (2026-08-11): 原实现 getWords() 在循环内全表扫描 + 每条独立事务 ——
      // 2845 条 → ~400 万次反序列化 + 2845 个独立事务, 同步永远不返回 (页面停在初始 0)。
      // 改成: getWords() 提到循环外建 Map<lemma, entry>, 批量 setWords 一次写完。
      let mergedCount = 0;
      const existing = (await storage.getWords()) || [];
      const map = new Map();
      for (const w of existing) map.set(w.lemma, w);
      for (const remote of pullRes.changed || []) {
        const local = map.get(remote.lemma) || null;
        if (!local || (remote.updated_at || 0) > (local.updated_at || 0)) {
          map.set(remote.lemma, remote);
          mergedCount++;
        }
      }
      await storage.setWords(Array.from(map.values()));
      await storage.clearPending();
      // UX A3: 同步诊断元数据 (设置页展示: 上次 rev / 本次从服务端拉回多少条 ——
      // 拉回条数是"从服务端实际拿到的", 不是合并写回的, 用 changed.length)
      await storage.setMeta('last_rev', pullRes.rev || 0);
      await storage.setMeta('last_pulled', (pullRes.changed || []).length);
      return { ok: true, mergedCount, rev: pullRes.rev || 0 };
    },
  };
}

if (typeof module !== 'undefined' && module.exports) module.exports = { makeAppLogic };
if (typeof window !== 'undefined') window.makeAidulcMobileApp = makeAppLogic;
