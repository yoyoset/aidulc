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
      let mergedCount = 0;
      for (const remote of pullRes.changed || []) {
        const existing = await storage.getWords();
        const local = existing.find((w) => w.lemma === remote.lemma) || null;
        if (!local || (remote.updated_at || 0) > (local.updated_at || 0)) {
          await storage.putWord(remote);
          mergedCount++;
        }
      }
      await storage.clearPending();
      return { ok: true, mergedCount, rev: pullRes.rev || 0 };
    },
  };
}

if (typeof module !== 'undefined' && module.exports) module.exports = { makeAppLogic };
if (typeof window !== 'undefined') window.makeAidulcMobileApp = makeAppLogic;
