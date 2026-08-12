# STAGE REPORT 2026-08-12 UX4 —— 把"报告说好了"和"用户点下去有反应"之间的缝封死

来源任务: `docs/GOAL_2026-08-12_UX4.md`。顺序按文档重排执行: **M0 → 契约门禁 → M1 → M2 →
M4 → N1 → M5 → M6**(M3 按文档移出本轮)。每条一个提交, 落地前 `.\scripts\check.ps1` 全绿。
8 个提交: `b30df68` M0 / `ce78b83` 契约门禁 / `71c663a` M1 / `7019b27` M2 / `beb7f08` M4 /
`232ac0e` N1 / `5325e38` M5 / `f07e1f9` M6。

**根因与文档矛盾处全部以实测为准**, 两处修正如实记录:
- **M2**: 文档列了三个怀疑点(change 监听者消费 reviewFocus / reviewView 提前 return /
  focus-hidden 无 CSS), 逐个验证全排除。真凶是 `global.AiduStore.set(...)` —— `global.AiduStore`
  是**类**(`app/store.js: global.AiduStore = Store`), 类上没有实例方法 `set`, 一点「开始复习」
  就抛 `TypeError`, 路由根本没走到。L3 的 smoke 6d 用 `globalThis.AiduStore = storeV(实例)` 掩盖
  了这个 bug(生产路径 global.AiduStore 永远是类)。**文档怀疑点全部不成立, 以实测为准。**
- **M5**: 文档未猜中。实测真凶是 `refreshLibPath`(每次 render 和「更改…」成功后都会跑)里的
  `dataMigrationStatus` 回调, `pending=false` 时无条件 `libMsg.textContent = ''` —— 更改成功
  刚写上「已切换书库位置到 X」, 几毫秒内就被抹成空, 用户看到的就是"选了目录没有任何结果"。

---

## 一、需要用户本人操作(DS 做不了)

| # | 事项 | 说明 |
|---|---|---|
| U1 | **真机点验 + 截图**(本轮教训 8 要求) | 本环境无法开真机/浏览器截图, 以下场景需用户真机复验并贴图: M1 红卡与折叠展开 (`%APPDATA%\aidulc\data.db`, edition `job-1786205609337-11852-1` 的 pack_dir 已不存在 → 书卡红色「成品文件缺失」+ 点「译本 (1)」展开出两出口); M2 点「开始复习」进专注模式三栏; M4 扫描 F:/hf_cache 出候选; M5 更改/加载三按钮的结果文案。自动化侧已用**最终 DOM 断言**锁定(见各卡), 真机截图是最终验收 |
| U2 | 清理服务端 1424 条 `w0…w1423` 测试数据 | 手机端已 0.7.2, 不清会拉进手机 |
| U3 | 踢掉泄露的两个 token | `5e31f8fa…`、`92925809…` |
| U4 | 轮换 ROOT_SECRET | 曾明文出现 |
| U5 | `git push origin main` | 本地已超前 102 提交 |
| U6 | 备份 `%APPDATA%\aidulc` | |
| U7 | 真机手势/扫码验证 | |
| U8 | 删除 UX3 的 CF 测试资源 | 测试 worker + 5 个测试 namespace |

---

## 二、八条协作教训的证据

### 教训 1: 同类要扫描给清单

- **M0 同类**(`tx`/`getAll`/`getMeta` 同步读 IDBRequest.result): `cloud/mobile/adapter.js` 全文件
  扫描, 同步读 `.result` 共 3 处(`getAll`、`getMeta`, 写路径 `put`/`clear`/`setWords` 不读 result),
  全改为 `req.onsuccess` 取值; 修复后 `rg "r\.result"` 为零。线上 adapter.js 复核无 `r.result`。
- **M2 同类**(`global.AiduStore.set` / `AiduStore.set` 调用): 全项目 grep `global\.AiduStore`,
  命中 `vocab_view.js:121/122`(开始复习)、`vocab_view.js:367-370`(词行打开)、`review_view.js:227-236`
  (来源跳转兜底), 三处全修为 `this.store`。修后 `grep "global.AiduStore.set|AiduStore.set"` 只剩注释。
- **N1 同类**: 向导完成页「先去配模型」原写 `global.AiduStore.set`(M2 同款隐患), 主动改 `this.store`。

### 教训 2: 数字贴命令 + 原始输出

- **clippy 棘轮**: 收尾 `cargo clippy --release -p aidulc` 计数 **7**, 等于基线 7, 未升高。
  本轮新增 `aggregate_book_pack_state`/`infer_model_family`/`set_family`/`wizard_service::reset`/
  `misc.rs book_count` 均零新增警告。
- **门禁项数**: 22 → 23(契约门禁 7.6b)→ 24(M0 手机端 7.8b)。收尾 **24 项全绿**。
- **M4 真实扫描**: 见教训 3。
- **M0 部署**: 线上 `build-info.js` 返回 `AIDULC_BUILD_VERSION = '0.7.2'`; `sw.js BUILD_VERSION`
  同为 0.7.2; 线上 `adapter.js` 含 `req.onsuccess` 修复、无 `r.result;` 残留(命令输出见 M0 卡)。

### 教训 3: 真实数据副本跑一次, 给前后计数

- **M0**: `test/browser_adapter_test.mjs`(fake-indexeddb, 真 IndexedDB 语义)覆盖 存词→读回→
  getToken→sync 全链路, **17 项断言全过**(此前 browserAdapter 零测试覆盖, 全部 50 项 app_test
  只测 nodeAdapter)。全链路: ROOT_SECRET 换 token → 本地写 1 词 → 断网同步失败本地不丢 →
  恢复网络推 2 词 → 远端条数 2 对上 → 待推清空。
- **M4 真实 F:/hf_cache 扫描**(本机真实目录, 一次性验证后移除): `scan_model_dir("F:/hf_cache")`
  返回 8 个候选, `infer_model_family` 判定:

  ```
  asr     | ggml-large-v3.bin                      | F:/hf_cache\ggml-large-v3.bin
  vad     | ggml-silero-v5.1.2.bin                 | F:/hf_cache\ggml-silero-v5.1.2.bin
  tts     | kokoro-v1_0.pth                        | F:/hf_cache\kokoro-v1_0.pth
  llm     | Qwen3-4B-Instruct-2507-Q4_K_M.gguf     | F:/hf_cache\Qwen3-4B-Instruct-2507-Q4_K_M.gguf
  llm     | sakura-7b-qwen2.5-v1.0-iq4xs.gguf      | F:/hf_cache\sakura-7b-qwen2.5-v1.0-iq4xs.gguf
  tts     | kokoro-v1_0.pth (HF 深层)              | ...\hub\models--hexgrad--Kokoro-82M\snapshots\f3ff...\kokoro-v1_0.pth
  unknown | pytorch_model.bin (manga-ocr)          | ...\hub\models--kha-white--manga-ocr-base\snapshots\...
  llm     | sakura-7b-qwen2.5-v1.0-iq4xs.gguf (HF) | ...\hub\models--SakuraLLM--Sakura-7B-Qwen2.5-v1.0-GGUF\snapshots\...
  ```

  结论: Qwen/Kokoro 家族判定正确(平铺 + HF `hub/models--*/snapshots/*` 深层都命中, 递归确认);
  **ggml-large-v3 / ggml-silero / manga-ocr 不再被塞进「语音合成」**(前两者 vad/asr、后者 unknown,
  前端一律标「未识别」)。

### 教训 4: 功能名→代码路径对照表

| UI 功能名 | 实现代码路径 |
|---|---|
| 手机端读取(曾全失败) | `cloud/mobile/adapter.js` `browserAdapter`(tx/getAll/getMeta, M0 修复) |
| 成品文件缺失检测 | `src-tauri/src/commands/library.rs::attach_pack_state` + `aggregate_book_pack_state`(M1-a) |
| 「开始复习」 | `reader/views/vocab_view.js` 开始复习按钮 → `this.store.set({reviewFocus})` + `router.navigate('vocab')` → `reader/main.js` vocab 处理器 → `review_view.js` 渲染 |
| 模型扫描/家族识别 | `src-tauri/src/infrastructure/model_store/scan.rs::scan_model_dir`(本就递归) + `application/model_service.rs::infer_model_family`(M4-3③) |
| 存量误登记改家族 | `commands/models.rs::models_set_family` → `model_service.rs::set_family`(M4-3③) |
| 分词当前方案 | `prep/aidulc_prep/pipeline/nlp/stage.py` → `spacy.load(get_nlp_model('en'))` = **spaCy en_core_web_sm 内置**(M4-1 写明) |
| 书库位置更改 | `commands/misc.rs::library_dir_pick_and_set`(L7 只改配置不搬文件, M5 加 book_count) |
| 主题顺序/跟随系统 | `reader/views/settings_view.js` 阅读显示 form(M6) + `core/theme.js::resolveTheme`(L9 已有 system 档) |

### 教训 5: 实测点击路径

| 卡 | 点击路径 | 结果 |
|---|---|---|
| M1 | 书卡「重新生成译本」 | 复用创建译本流程, 模态标题带书名(assert `.modal-title` 含「创建译本」+ 书名) |
| M1 | 「移除这个译本记录」 | `AiduModal.confirm` 确认弹窗(confirmText='移除')→ 只删 DB 行 |
| M1-b | 「译本 (N) ▸」 | 点 → `.edition-body` 去 `collapsed`(内容展开); 再点 → 恢复 |
| M2 | 生词本「开始复习」 | 点 → `.review-grid` 出现、`.vocab-today-card` 消失、nav 加 `focus-hidden`; Esc/「退出复习」→ 反过来 |
| M4 | 扫描已有模型 → 选路径 → 扫描 | 弹窗列出默认路径 → 候选列表(路径/大小/推测家族/已登记)→ 勾选 → 「登记选中 N 个」→ register |
| M5 | 更改… 选目录 | 结果文案「书库位置已改为 X, 原目录 N 本书未移动」(只改配置不搬文件) |
| M5 | 加载已有书库… → 选目录 → 扫描 → 确认 → 登记 | 结果文案「扫描到 N 本, 已登记 M 本」 |

### 教训 6: 发布步骤与线上版本号

- **M0**: `cloud/mobile/sw.js` + `build-info.js` bump `0.7.1 → 0.7.2`; 跑 `scripts/deploy_mobile.ps1`
  (已含 `$ErrorActionPreference='Continue'` + `$LASTEXITCODE` 判定, 不再被 wrangler stderr 中断)。
  线上验证命令:`Invoke-WebRequest https://aidulc-mobile.pages.dev/build-info.js` →
  `AIDULC_BUILD_VERSION = '0.7.2'`; `sw.js` → `BUILD_VERSION = '0.7.2'`; 线上 `adapter.js` 含
  `req.onsuccess` 且无 `r.result` 同步读。
- `mobile:version-bumped` 门禁: 本轮 cloud/mobile 有改动且版本已变 → PASS。

### 教训 7: (沿用 UX3 证据链, 本轮无新迁移)

### 教训 8(本轮重点): 单测通过 ≠ 用户点得动 —— 断言落在用户可见的最终 DOM

本轮每张 UI 卡的自动化断言全部写成 **「断言的 DOM 选择器 + 断言的可见文案/类名」**, 报告如下:

| 卡 | 断言的 DOM 选择器 | 断言的可见文案 / 类名 |
|---|---|---|
| 契约门禁 | 7 个视图容器内所有 `button`(逐个 click) | 300ms 内 DOM 快照变化 / toast 计数增加 / `document.body` 出现或消失 `.modal-overlay` / 路由 navigate 或 `location.hash` 变化; 例外 3 项全为系统层外部动作并写明理由 |
| M1-a | `.book-card .book-badge.badge-err` | 文案 `成品文件缺失`; 同卡不含 `已就绪` |
| M1-a | `.book-card .book-card-err-hint` | 提示行存在(原版书卡聚合标红) |
| M1-b | `.edition-toggle` 点击后 `.edition-body` | 不含 `collapsed`(展开); 再点含 `collapsed`; 箭头 `▾`(展开)/`▸`(折叠) |
| M1-c | `.edition-card` 内两个按钮 | 文案 `重新生成译本` / `移除这个译本记录`; 点击后 `.modal-overlay` 出现 |
| M2 | 点击后容器内 `.review-grid` | 存在; `.vocab-today-card` 不存在; nav 含 `focus-hidden`; 「退出复习」后反过来 |
| M4-1 | `.model-group`(分词/NLP 段)内 `button` | 不含 `去下载`; 段文本含 `spaCy` + `en_core_web_sm`(当前方案) |
| M4-3 | `.scan-path-row` | 默认含模型目录 + HF 缓存 |
| M4-3 | `.scan-candidate .book-badge` | llm/tts/nlp 命中者显示 `翻译/讲解`/`语音合成`/`分词/NLP`; whisper/silero/未知显示 `未识别`; 未识别行有 `select.scan-fam` 下拉 |
| M4-3 | `.scan-candidate input.scan-cb` | 未登记默认勾选; 已登记禁用 |
| M4-3⑤ | 0 结果区 `button` | 文案 `选择目录扫描…` / `添加自定义模型`; 消息含 `没找到模型` + 扫过的路径 |
| M4-3③ | `.model-history-toggle` 展开后的 `button` | 含 `改家族`; 保存 → `models_set_family` 被调 |
| N1 | `.wizard-choice` | 三个选择; 样书项 `disabled=true` 且含 `即将支持`; 模型发现步文本含 `GB` + `几十分钟`; 无模型目录时不调用 scan('C:/') |
| N1 | 设置页 `button` | 含 `重新运行首次向导`; 点击 → `wizard_reset` + `location.hash === '#/wizard'` |
| M5 | 书库位置节 `.import-tip` | 更改成功含 `书库位置已改为` + `原目录 N 本书未移动`; 取消含 `已取消, 书库位置未更改`; 加载结果含 `扫描到 N 本, 已登记 M 本` |
| M5 | 三按钮父容器 | 含 `page-toolbar`(收进一组) |
| M6 | `.settings-form` 子元素顺序 | `主题` hint → select → `主题色` hint → `.rd-theme-chips`; `PALETTES` 5 键与 `tokens.css --swatch-*` 5 个一一对应 |

**真机截图**: 见 U1(本环境无真机, 自动化以最终 DOM 断言锁定, 真机点验为最终验收)。

---

## 三、各卡要点与验证

### M0(P0) 手机端一个词都没有的真凶: IndexedDB 用法错误
- `browserAdapter::tx` 在 `fn(os)` 同步读 `r.result` —— IDBRequest 未完成必抛 `InvalidStateError`。
  写路径不读 result 所以一直能写, **所有读取(词表/token/worker_url)从上线起全失败**, 净效果安静地 0。
- 修: `tx` 支持 `fn(os, capture)` 捕获 IDBRequest, 在 `req.onsuccess` 取 `result`、`t.oncomplete`
  resolve; `getAll`/`getMeta` 改用 capture。**发货实现从此有测试**: `fake-indexeddb` 跑同一套
  核心链路(17 断言), 不再"只测 nodeAdapter"。门禁 `7.8b`。
- bump 0.7.2 并部署, 线上 asset 验证通过(教训 6)。

### 契约门禁 ui:no-silent-action
- 遍历 7 个视图全部 button, 逐个 click, 断言 300ms 内 DOM/toast/modal/路由之一变化; 无变化的
  门禁失败。**关键实现细节**: 每点一次重新查询按钮 —— 视图重渲染会重建按钮元素, 先收集后点
  会点到游离节点(改动落在容器外, 快照恒不变 → 假"没反应")。
- 例外清单(显式 + 理由): `settings|打开日志文件`、`settings|在资源管理器中打开`、`vocab|恢复`
  —— 全为系统层外部动作; `已是激活态的筛选段` 重复点击按设计 no-op。
- 当前 **85 次点击全绿**。已抓到的同类问题见 M2/M5 卡(修后门禁仍绿, 例外清单保持 3 项不扩)。

### M1(P0) 成品缺失的红卡与译本展开
- M1-a: `library_list` 原版分支此前只对嵌套 edition 调 `attach_pack_state`, book 对象没有
  `pack_state`, 前端判 `book.pack_state` 恒 undefined → 红卡永不渲染。新增
  `aggregate_book_pack_state`(无 edition→不设 / 全 ok→ok / 任一坏→最坏值 missing>incomplete,
  单测 `m1a_book_pack_state_aggregates_from_editions`), 前端状态徽章被 `pack_state` 覆盖。
- M1-b: 折叠开关切外层 `editions` 容器而非真正藏内容的 `.edition-body` → 箭头变内容永不展开。
  改切 `.edition-body`, 并修正箭头方向(折叠 ▸ / 展开 ▾, 初始折叠)。
- M1-c: 两出口在 M1-a/b 修复后可见; 「重新生成译本」复用创建译本流程(source_id 预填),
  「移除这个译本记录」确认弹窗只删 DB 行。smoke 3c/3d 锁全部 DOM 断言。

### M2(P0) 「开始复习」仍无反应
- **实测排除**(文档三怀疑点): ①全项目 `store.on('change')` 订阅只有 `library_view`(书库渲染),
  不消费 reviewFocus、不重新 dispatch; ②`reviewView.render` 无提前 return; ③`focus-hidden`
  是 UI 视觉, 不是"没反应"。
- **真凶**: `global.AiduStore` 是类(`app/store.js: global.AiduStore = Store`), 类没有静态 `set`,
  `vocab_view` 开始复习一点 `global.AiduStore.set(...)` 就抛 `TypeError: AiduStore.set is not a
  function`, 路由根本没走到。验证命令:`typeof AiduStore.set` → `undefined`; 调用抛
  `AiduStore.set is not a function`。
- **掩盖来源**: L3 smoke 6d 用 `globalThis.AiduStore = storeV(实例)` 换掉了全局, 生产路径
  global.AiduStore 永远是类 —— 测试替身把真 bug 盖住了。6d 移除掩盖, 新增 6e 全链路断言。
- M2-b: 确认无二次选词层, 点了直进第一张卡。

### M4(P0-) 模型与依赖: 按用户的三个问题重做
- M4-1: 分词/NLP 段去掉「去下载」(DOWNLOAD_CATALOG 无 nlp 条目 = 空对话框根源), 写明当前方案
  (内置 spaCy en_core_web_sm); 通用规则: 无下载目录项就不渲染下载按钮。
- M4-2: 无更新渠道的本地模型组件(llm/tts)补可操作话:"要换新版: 下载后用「添加自定义模型」
  指向新文件, 再设为推荐"。
- M4-3 五问题全修(扫描路径可见可增删 + HF 缓存默认项 / 去 C:/ fallback / 家族特征识别 +
  未识别让用户选 + 存量可改家族(`models_set_family`, 单测)/ 候选勾选后登记 / 0 结果可点下一步),
  真实 F:/hf_cache 扫描验证见教训 3。

### N1(P1) 新用户能自己走通第一条路
- 完成页三选一(①导入我的书 ②内置样书置灰"即将支持" ③先去配模型); 模型发现步代价告知
  (总下载量取自 DOWNLOAD_CATALOG 同一份 sizeBytes + 单书几十分钟量级, 估不出明说);
  无模型目录不扫 C:/; 向导可重入(`wizard_reset` 命令 + 设置页按钮 + `#/wizard` 路由)。
- 完成页不再显示底部"跳过"导航(用三个选择替代)。

### M5(P0-) 「更改」书库位置无反馈
- **真凶**: `refreshLibPath` 的 `dataMigrationStatus` 回调 `pending=false` 时无条件清空 `libMsg`,
  把"更改成功"结果当场抹掉。改为只清自己写的迁移提示(startsWith 检测)。
- 三按钮逐个明确结果(见教训 5); 后端 `library_dir_pick_and_set` 新增 `book_count`(DB 书数),
  前端结果"原目录 N 本书未移动"; 排版收进 `.page-toolbar` 一组。smoke 2g 锁结果文案。

### M6(P1) 主题色顺序 + 跟随系统联动
- 顺序修: `主题色` hint 被先 append, 实际渲染成 主题色标签→主题标签→下拉→色点。改为
  主题 label → 下拉 → 主题色 label → 色点; 顺带修掉 `form.append` 里 themeLabel/themeRow/chipsRow
  的重复追加。
- 联动: `resolveTheme('system', true) === 'dark'`(vitest L9 已有 + smoke 11 再锁);
  `_applyCss` 用 `AiduTheme.resolveTheme` 解析后才写 `body.dataset.theme` —— 系统深色下 system 档
  取的就是深色令牌, 不只 `data-theme` 显式设置才生效。
- 色系: `SettingsView.PALETTES` 5 键与 `tokens.css --swatch-*` 5 个一一对应(clay/sage/ocean/
  rose/slate), 无写死第二处。

---

## 四、门禁结论

收尾 `check.ps1` **24 项全绿**:

```
schema:verify                          PASS
cargo fmt --check                      PASS
cargo clippy (baseline<=7)             PASS   (实测 7, 未升高)
cargo build --release                  PASS
cargo test --release --test-threads=1  PASS   (256 passed)
pytest                                 PASS   (167 passed)
vitest                                 PASS   (124 passed)
node smoke (reader DOM 渲染路径)         PASS
node smoke (视图层)                    PASS
node smoke (契约: ui:no-silent-action)  PASS   (85 次点击, 本轮新增 7.6b)
node smoke (worker 协议 v1)             PASS
node smoke (VPS server.mjs)            PASS
node smoke (手机端 core+同步)            PASS
node smoke (手机端 browserAdapter+IndexedDB) PASS  (M0 新增 7.8b, 17 断言)
node smoke (手机端 UI)                  PASS
mobile:build-version 一致性             PASS
mobile:version-bumped                  PASS
node import_old_aidu --self-test       PASS
test:no-prod-endpoint                  PASS
css:no-raw-hex / no-blk-texture / dashed-rule  PASS
contrast (WCAG AA >= 4.5)              PASS
全部通过
```

## 五、遗留与方向

- **M3(多后端 × 主体矩阵)** 按文档移出本轮, 设计结论已留档在 `GOAL_2026-08-12_UX4.md`。
- **真机截图** 待 U1(自动化已用最终 DOM 断言锁定, 真机为最终验收)。
- **M2 教训扩散**: 全项目 `global.AiduStore.set` 已清零; 建议在 CLAUDE.md 或代码规范里把
  "视图用构造注入的 store 实例, 不用 global.AiduStore(那是类)" 写成显式规则。
- **契约门禁范围**: 目前覆盖 7 个主视图; review_view(进行中会话交互)不在其中, 由 M2 专项
  DOM 断言覆盖, 未来可考虑扩展。
