repo: yoyoset/aidulc
branch: main
path: reader/

## Last sync
date: 2026-08-08T13:46:00Z

### Updated in this project
- 按《aidulc 设计语言 v1》产出七屏高保真设计稿（aidulc 完整设计.dc.html）
- 读取 reader/styles/tokens.css 作为配色与令牌唯一来源，未改动仓库
- 导航由六项等权页签重设计为三层结构 + 设置齿轮
- 产出逐文件落地清单（第 10 节）供实施使用

## Screen map
| 屏幕 | 对应仓库文件 |
| --- | --- |
| 我的书 | views/shell_view.js, views/library_view.js, styles/library.css |
| 导入 | views/wizard_view.js, services/import_service.js |
| 处理中 | views/prep_view.js, styles/prep.css, contracts/progress.schema.json |
| 生词本 | views/vocab_view.js, core/vocab_stats.js |
| 设置 / 模型中心 | views/settings_view.js, views/models_view.js, styles/settings.css |
| 阅读器三模式 | views/reader_view.js, views/reader/follow_bar.js, components/atomic_block.js, styles/reader.css |
| 令牌与主题 | styles/tokens.css, core/theme.js |
