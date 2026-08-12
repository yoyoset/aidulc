# 聚合门禁, 对标 aidu 的 `npm run check`。一条命令串起本项目全部质量检查,
# 任一项失败则整体非零退出(供人工/未来 CI 调用), 结尾打印每项 PASS/FAIL 摘要。
#
# clippy 的"参数过多/类型复杂"警告(结构性问题, 集中在 jobs.rs 等命令层, 详见
# S2 架构收口计划)当前有 8 处已知存量, 用 $ClippyBaseline 放行存量、禁止新增
# ——警告数超过基线才判失败; 等 S2 拆分 jobs.rs 把这些真正修掉后, 把这个数字
# 调低, 不要调高。
param(
    # R4 (2026-08-11): 实测警告数 7 (修掉 L2 attach_pack_state 的 doc 缩进警告), 棘轮收紧 8→7。
    # 只降不升; 真清零需把多参数函数改成接收请求结构体 (docs/ROADMAP.md P3), 不要调高绕过。
    [int]$ClippyBaseline = 7
)

$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $PSScriptRoot
$results = @()

function Run-Check {
    param([string]$Name, [scriptblock]$Action)
    Write-Output ""
    Write-Output "=== $Name ==="
    & $Action
    $ok = ($LASTEXITCODE -eq 0) -or ($null -eq $LASTEXITCODE)
    $script:results += [PSCustomObject]@{ Name = $Name; Pass = $ok }
    if (-not $ok) {
        Write-Output "--- $Name 失败 (exit $LASTEXITCODE) ---"
    }
}

# 1. schema 一致性 (contracts/ <-> prep/aidulc_prep/schemas/)
Run-Check "schema:verify" {
    & "$root\scripts\sync_schema.ps1" -Verify
}

# 2. Rust 格式
Run-Check "cargo fmt --check" {
    Push-Location "$root\src-tauri"
    cargo fmt --check
    Pop-Location
}

# 3. Rust clippy (基线放行存量, 禁止新增)
# 实测坑(2026-08-07): `cargo clippy 2>&1 | Out-String` 在 PowerShell 5.1 下对原生程序
# 合并 stdout/stderr 不可靠 —— 同一份未改动代码连续两次门禁跑出 8 和 7 两个不同计数
# (直接用 Bash 跑两次稳定都是 8, 只有走 PS 的 `2>&1` 管道才会漏行)。改用文件重定向
# (交给 cmd.exe 而不是 PowerShell 处理流合并)彻底绕开这个坑, 不是猜一个数字将就。
Run-Check "cargo clippy (baseline<=$ClippyBaseline)" {
    Push-Location "$root\src-tauri"
    $tmpOut = Join-Path $env:TEMP "aidulc_clippy_$PID.txt"
    cmd /c "cargo clippy --release -p aidulc > `"$tmpOut`" 2>&1"
    $output = Get-Content $tmpOut -Raw
    Remove-Item $tmpOut -ErrorAction SilentlyContinue
    Write-Output $output
    # 排除 cargo 自己的摘要行(如 "warning: `aidulc` (bin "aidulc") generated 8 warnings")
    # ——它本身也以 "warning:" 开头, 不排除会把警告数错多算 1。
    $count = ([regex]::Matches($output, '(?m)^warning:(?!.*\bgenerated\b)')).Count
    Pop-Location
    Write-Output "clippy 警告数: $count (基线: $ClippyBaseline)"
    if ($count -gt $ClippyBaseline) {
        Write-Output "超过基线, 说明引入了新警告 —— 请修复新增项, 不要调高 -ClippyBaseline 绕过"
        $global:LASTEXITCODE = 1
    } else {
        $global:LASTEXITCODE = 0
    }
}

# 4. Rust 产物构建 (R0, 2026-08-07): "门禁全绿"必须蕴含"exe 是最新的"。
# 前端资源在编译期经 generate_context! 嵌入二进制(build.rs 已把 ../reader 递归声明为
# rerun-if-changed), 只跑 clippy/test 产不出 release/aidulc.exe —— 之前就是这个洞让
# "前端改了但用户跑的还是旧界面"成了静默故障。
Run-Check "cargo build --release" {
    Push-Location "$root\src-tauri"
    cargo build --release -p aidulc
    Pop-Location
}

# 5. Rust 测试 (必须单线程, 见 memory/pipeline.md: 并行有共享临时 DB 状态冲突)
Run-Check "cargo test --release -- --test-threads=1" {
    Push-Location "$root\src-tauri"
    cargo test --release -p aidulc -- --test-threads=1
    Pop-Location
}

# 6. Python 测试
Run-Check "pytest" {
    & "$root\prep\.venv\Scripts\python.exe" -m pytest "$root\prep\tests" -q
}

# 7. 前端测试
Run-Check "vitest" {
    Push-Location "$root\reader"
    npx vitest run
    Pop-Location
}

# 7.5 (S5, 2026-08-08): 阅读器渲染路径冒烟测试 (最小 DOM stub 驱动 AtomicBlock +
# ReaderRenderer, 不引入 jsdom; 覆盖三模式建块/揭示折叠/词级高亮/节奏线/当前句切换)。
Run-Check "node smoke (reader DOM 渲染路径)" {
    Push-Location "$root\reader"
    node tests\_smoke_dom.mjs
    Pop-Location
}

# 7.6 (UX 审计 2026-08-09): 视图层改动冒烟测试 —— 防止已落地的打磨项静默回归。
# 覆盖 prep 移除任务确认三态文案、settings 直达"模型中心"tab、导入卡单对话框、
# 创建译本弹窗三节标题与控件对齐 (A1 回归, 曾误删控件唯一挂载点导致不渲染)。
Run-Check "node smoke (视图层: prep/settings/library)" {
    Push-Location "$root\reader"
    node tests\_smoke_views.mjs
    Pop-Location
}

# 7.7 (V5, 2026-08-09): 服务端协议本地实测 —— 文件 KV 驱动同一份 worker 代码,
# 覆盖 鉴权失败/越权/正常推拉/新者胜/一次性码/限速。30 项断言。
Run-Check "node smoke (worker 协议 v1 本地实测)" {
    Push-Location "$root\cloud\worker"
    node test\local_test.mjs
    Pop-Location
}

# 7.7b (S3, 2026-08-10): server.mjs Node HTTP 入口冒烟 —— 同一份 worker 代码经
# node:http 适配层走真实网络层 (首台换 token/401/推拉/capabilities)。5 项断言。
Run-Check "node smoke (VPS 后端 server.mjs HTTP 入口)" {
    Push-Location "$root\cloud\worker"
    node test\server_test.mjs
    Pop-Location
}

# 7.8 (V7, 2026-08-09): 手机端核心逻辑 + 同步链路 —— 纯逻辑(配比/调度预览一致性/
# 撤销/翻面锁) + 离线完整复习→恢复网络自动补推、条数对上。27 项断言。
Run-Check "node smoke (手机端 core + 同步链路)" {
    Push-Location "$root\cloud\mobile"
    node test\app_test.mjs
    Pop-Location
}

# 7.8b (M0, 2026-08-12): 手机端 browserAdapter 真 IndexedDB 测试 —— 发货实现此前
# 零覆盖: tx/getAll/getMeta 在 IDBRequest 未完成时同步读 result → InvalidStateError,
# 手机端所有读取一律失败、显示 0。用 fake-indexeddb 跑与 app_test.mjs 相同的核心链路
# (存词→读回→getToken→sync 全链路), 锁死"读取必须等请求完成"这一修复。17 项断言。
Run-Check "node smoke (手机端 browserAdapter + IndexedDB)" {
    Push-Location "$root\cloud\mobile"
    node test\browser_adapter_test.mjs
    Pop-Location
}

# 7.9 (V7 补充, 2026-08-10): 手机端 UI 控制器冒烟 —— 最小 DOM stub 驱动真实 app.js,
# 覆盖 设计稿 01b 全部交互(整卡翻面单向/250ms 评分解锁/按钮评分/左右滑评分/
# 3秒撤销/长按操作层/下滑退出保留进度) + 冲突 6(手机"跳到原文"不可用→提示在电脑上
# 打开), 不引入 jsdom、不依赖 __TAURI__。26 项断言。
Run-Check "node smoke (手机端 UI 控制器: 翻面/评分/撤销/退出)" {
    Push-Location "$root\cloud\mobile"
    node test\ui_smoke.mjs
    Pop-Location
}

# 7.10 (P0 更新机制, 2026-08-10): PWA 构建版本一致性 —— SW 更新检查只比 sw.js 字节,
# 版本必须嵌入 sw.js 且与 build-info.js 一致, 否则发布后已装用户永远拿旧壳。
# 部署用 scripts/deploy_mobile.ps1 (强制版本递增); 这里是静态一致性门禁。
Run-Check "mobile:build-version 一致性 (sw.js == build-info.js)" {
    $sw = Get-Content "$root\cloud\mobile\sw.js" -Raw
    $bi = Get-Content "$root\cloud\mobile\build-info.js" -Raw
    $m1 = [regex]::Match($sw, "const BUILD_VERSION = '([^']+)'")
    $m2 = [regex]::Match($bi, "AIDULC_BUILD_VERSION = '([^']+)'")
    if (-not $m1.Success) { Write-Output "FAIL: sw.js 缺 BUILD_VERSION"; $global:LASTEXITCODE = 1; return }
    if (-not $m2.Success) { Write-Output "FAIL: build-info.js 缺 AIDULC_BUILD_VERSION"; $global:LASTEXITCODE = 1; return }
    if ($m1.Groups[1].Value -ne $m2.Groups[1].Value) {
        Write-Output "FAIL: 版本不一致 sw.js=$($m1.Groups[1].Value) build-info.js=$($m2.Groups[1].Value)"
        $global:LASTEXITCODE = 1
    } else {
        Write-Output "OK: 构建版本 $($m1.Groups[1].Value) 两端一致"
        $global:LASTEXITCODE = 0
    }
}

# 7.10b (L0-b, 2026-08-11): 改手机端必须涨版本 —— 现有 7.10 只查 sw.js 与 build-info.js
# 两个数字互相相等, 拦不住"改了 cloud/mobile/** 却没 bump"。本门禁: 若 git diff 显示
# cloud/mobile/** 有未提交改动 (除 .last-deployed-version 外), 而工作区 BUILD_VERSION
# 与 HEAD 相同 → 门禁失败。
Run-Check "mobile:version-bumped(改手机端必须涨版本)" {
    Push-Location $root
    $diffLines = git diff --name-only HEAD -- cloud/mobile
    $changed = $diffLines | Where-Object { $_ -and $_ -notmatch '\.last-deployed-version$' }
    if (-not $changed) {
        Write-Output "OK: cloud/mobile 无未提交改动"
        $global:LASTEXITCODE = 0
        Pop-Location
        return
    }
    Write-Output "cloud/mobile 有改动: $($changed -join ', ')"
    $swNow = Get-Content "$root\cloud\mobile\sw.js" -Raw
    $mNow = [regex]::Match($swNow, "const BUILD_VERSION = '([^']+)'")
    $headSw = git show HEAD:cloud/mobile/sw.js
    $mHead = [regex]::Match($headSw, "const BUILD_VERSION = '([^']+)'")
    Pop-Location
    if (-not $mNow.Success) { Write-Output "FAIL: 工作区 sw.js 缺 BUILD_VERSION"; $global:LASTEXITCODE = 1; return }
    if (-not $mHead.Success) { Write-Output "FAIL: HEAD sw.js 缺 BUILD_VERSION"; $global:LASTEXITCODE = 1; return }
    if ($mNow.Groups[1].Value -eq $mHead.Groups[1].Value) {
        Write-Output "FAIL: 改了 cloud/mobile/** 但 BUILD_VERSION 未变 ($($mNow.Groups[1].Value)) —— 已装用户拿不到新代码, 先 bump 再提交"
        $global:LASTEXITCODE = 1
    } else {
        Write-Output "OK: 版本 $($mHead.Groups[1].Value) -> $($mNow.Groups[1].Value)"
        $global:LASTEXITCODE = 0
    }
}

# 7.11 (P1-D, 2026-08-10): 旧 AIDU 生词 → .aidu-data v3 转换脚本自检 (interval 天→ms /
# lemma 小写 / _key 丢弃 / 字典透传 的规范不被改坏)
Run-Check "node import_old_aidu --self-test" {
    Push-Location "$root"
    node scripts\import_old_aidu.mjs --self-test
    Pop-Location
}

# 7.12 (F3, 2026-08-11): 验收脚本禁止指向生产端点 —— 08-11 实测污染: 临时脚本用真实域名
# 对生产 VPS 跑 1424 词 fixture, 落进用户生产库。门禁保证 cloud/**/test/** 与 scripts/**
# 里出现真实域名 (sync.viiyd.com / *.pages.dev / *.workers.dev) 直接失败; 只允许
# 127.0.0.1 / localhost / 临时 KV_DIR / RFC 保留 example.com。
Run-Check "test:no-prod-endpoint(测试/脚本禁真实域名)" {
    $targets = @()
    $targets += Get-ChildItem "$root\cloud" -Recurse -Include "*.mjs","*.js" -File |
        Where-Object { $_.FullName -match "\\(test|tests)\\" }
    $targets += Get-ChildItem "$root\scripts" -Recurse -Include "*.mjs","*.js","*.ps1" -File |
        Where-Object { $_.Name -ne "check.ps1" }  # 本门禁定义处提及域名是文档, 不算违规
    $offenders = $targets | Select-String -Pattern 'sync\.viiyd\.com|\.pages\.dev|\.workers\.dev' -CaseSensitive:$false
    if ($offenders) {
        $offenders | ForEach-Object { Write-Output "$($_.Path):$($_.LineNumber): $($_.Line.Trim())" }
        $global:LASTEXITCODE = 1
    } else {
        Write-Output "干净: 测试/脚本无生产域名 (只允许 localhost/127.0.0.1/KV_DIR/example.com)"
        $global:LASTEXITCODE = 0
    }
}

# 8. CSS 令牌纪律: tokens.css 之外的样式文件不得出现裸 #hex 颜色(S3.1, 2026-08-07 清零后
# 立即上强约束, 不设豁免——颜色只能来自 var(--md-sys-color-*))。字号/间距暂不做等价约束:
# 阶梯令牌刚建立, 存量 px/rem 替换是后续工作, 现在加约束会让门禁对着几百处存量代码常年变红。
Run-Check "css:no-raw-hex(tokens.css 之外)" {
    $offenders = Get-ChildItem "$root\reader\styles\*.css" -Exclude "tokens.css" |
        Select-String -Pattern '#[0-9a-fA-F]{3,8}\b'
    if ($offenders) {
        $offenders | ForEach-Object { Write-Output "$($_.Path):$($_.LineNumber): $($_.Line.Trim())" }
        $global:LASTEXITCODE = 1
    } else {
        Write-Output "干净: 除 tokens.css 外无裸 hex 颜色"
        $global:LASTEXITCODE = 0
    }
}

# 8.4 (完整设计交付确认 §10 item 11): .atomic-block(JS 里的 .blk 别名)及其子元素禁止
# backdrop-filter 与 background-image —— 3000+ span 的章节里逐块纹理/滤镜重绘代价成倍上升。
# 纸纹只能是 body::before 单一实例(tokens 里的 --rd-grain-*)。reader.css 顶栏的
# backdrop-filter 在 .rd-top 上, 不是 atomic-block, 不受影响。
Run-Check "css:no-blk-texture(.atomic-block 禁 backdrop-filter/background-image)" {
    $offenders = Get-ChildItem "$root\reader\styles\*.css" |
        Select-String -Pattern '\.atomic-block[^{]*\{[\s\S]*?(backdrop-filter|background-image)'
    if ($offenders) {
        Write-Output "违反: .atomic-block 上使用了 backdrop-filter 或 background-image"
        $global:LASTEXITCODE = 1
    } else {
        Write-Output "干净: .atomic-block 未使用滤镜/纹理"
        $global:LASTEXITCODE = 0
    }
}

# 8.4b (S6b, 2026-08-10): 虚线规则 —— 设计 §07 "1.5px dashed + 40% 纸面填充是全系统唯一
# 允许的虚线"。任何 dashed 边框必须 1.5px 且带 40% surface 填充; 且只允许出现在空态
# 类(.book-empty / .prep-dropzone 这类导入/空容器)。新增虚线必须同样满足, 否则门禁失败。
Run-Check "css:dashed-rule(虚线=1.5px+40%填充, 仅空态)" {
    $cssFiles = Get-ChildItem "$root\reader\styles\*.css"
    $viol = @()
    foreach ($f in $cssFiles) {
        $content = Get-Content -Raw -Encoding UTF8 $f.FullName
        # 找所有含 dashed 的规则块
        foreach ($m in [regex]::Matches($content, '([^{}]+)\{([^{}]*dashed[^{}]*)\}')) {
            $sel = $m.Groups[1].Value.Trim()
            $body = $m.Groups[2].Value
            $dash = [regex]::Match($body, 'dashed')
            # 1.5px dashed
            if ($dash.Success -and $body -notmatch '1\.5px\s+dashed') {
                $viol += "$($f.Name): $sel 虚线不是 1.5px dashed"
            }
            # 40% 纸面填充 (color-mix surface 40%)
            if ($dash.Success -and $body -notmatch '40%\s*,?\s*transparent' -and $body -notmatch 'rgba\([^)]*\.4') {
                $viol += "$($f.Name): $sel 虚线缺 40% 纸面填充"
            }
            # 只允许空态类
            if ($dash.Success -and $sel -notmatch 'book-empty|dropzone|empty|import') {
                $viol += "$($f.Name): $sel 虚线出现在非空态类"
            }
        }
    }
    if ($viol.Count) {
        $viol | ForEach-Object { Write-Output "违反: $_" }
        $global:LASTEXITCODE = 1
    } else {
        Write-Output "干净: 全部虚线 = 1.5px + 40% 填充, 且仅空态"
        $global:LASTEXITCODE = 0
    }
}

# 8.5 (M7 Round 6, 2026-08-08): 令牌对比度门禁 —— 直接解析 tokens.css 计算每个
# palette × mode 的关键前景/背景对, WCAG AA 正文 ≥ 4.5 不达标即失败。
# 防"以后改了某个令牌把无障碍做坏"静默发生。
Run-Check "contrast (WCAG AA >= 4.5, 解析 tokens.css)" {
    Push-Location "$root"
    node scripts\check_contrast.mjs
    Pop-Location
}

Write-Output ""
Write-Output "=================================="
Write-Output "汇总"
Write-Output "=================================="
$allPass = $true
foreach ($r in $results) {
    $mark = if ($r.Pass) { "PASS" } else { "FAIL"; $allPass = $false }
    Write-Output ("{0,-40} {1}" -f $r.Name, $mark)
}
Write-Output "=================================="

if ($allPass) {
    Write-Output "全部通过"
    exit 0
} else {
    Write-Output "存在失败项, 见上方明细"
    exit 1
}
