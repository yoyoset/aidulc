"""check_venv_lock.py —— 侧车依赖三方一致性校验 (2026-11-15)

三方 = prep/pyproject.toml 的 dependencies  /  prep/requirements.lock  /  prep/.venv 实装版本。
任何一方不一致都退出 1。为什么要有: pyproject 以前根本没声明运行时依赖, 侧车能不能复现
取决于"这台机器的 venv 碰巧装了什么"; 光写一份锁文件而不校验, 过几个月它就和 venv 对不上,
变成又一份没人维护的名册。

用法: prep\\.venv\\Scripts\\python.exe scripts\\check_venv_lock.py
"""
import re
import subprocess
import sys
import tomllib
from pathlib import Path

root = Path(__file__).resolve().parent.parent
prep = root / "prep"


def norm(name: str) -> str:
    return re.sub(r"[-_.]+", "-", name).lower()


def base(ver: str) -> str:
    return ver.split("+", 1)[0]


def parse_pins(lines):
    pins = {}
    for raw in lines:
        s = raw.strip()
        if not s or s.startswith(("#", "-")):
            continue
        if " @ " in s:  # 直链 wheel (en_core_web_sm): 只比名字
            pins[norm(s.split(" @ ", 1)[0])] = "url"
            continue
        m = re.match(r"^([A-Za-z0-9_.\-]+)==(\S+)$", s)
        if m:
            pins[norm(m.group(1))] = m.group(2)
    return pins


lock = parse_pins((prep / "requirements.lock").read_text(encoding="utf-8").splitlines())
py = sys.executable
freeze = subprocess.run([py, "-m", "pip", "freeze"], capture_output=True, text=True, check=True).stdout
venv = parse_pins(freeze.splitlines())
# 本项目自身 (editable) 不在锁里
venv.pop("aidulc-prep", None)

errors = []

# 1. venv vs lock: 版本逐个比对 (本地版本号 +cu124 也要一致)
for name, ver in sorted(venv.items()):
    if name not in lock:
        errors.append(f"venv 里有 {name}=={ver}, 但 requirements.lock 没有")
    elif lock[name] != ver:
        errors.append(f"{name}: venv={ver}, lock={lock[name]}")
for name in sorted(set(lock) - set(venv)):
    errors.append(f"requirements.lock 里有 {name}, 但 venv 没装")

# 2. pyproject 直接依赖 vs lock: 精确版本 (忽略本地版本后缀)
proj = tomllib.loads((prep / "pyproject.toml").read_text(encoding="utf-8"))
deps = proj.get("project", {}).get("dependencies", [])
if not deps:
    errors.append("pyproject.toml 没有 [project].dependencies")
for d in deps:
    m = re.match(r"^([A-Za-z0-9_.\-]+)==(\S+)$", d.strip())
    if not m:
        errors.append(f"pyproject 依赖必须写精确版本 (==): {d}")
        continue
    name, ver = norm(m.group(1)), m.group(2)
    if name not in lock:
        errors.append(f"pyproject 依赖 {name} 不在 requirements.lock 里")
    elif base(lock[name]) != base(ver):
        errors.append(f"{name}: pyproject={ver}, lock={lock[name]}")

if errors:
    print(f"侧车依赖不一致 ({len(errors)} 处):")
    for e in errors:
        print("  - " + e)
    print("处理: 改了依赖就重新 pip freeze 覆盖 requirements.lock 并同步 pyproject.toml; "
          "不要为了过门禁手改版本号。")
    sys.exit(1)
print(f"侧车依赖一致: pyproject {len(deps)} 个直接依赖 / lock {len(lock)} 个包 / venv {len(venv)} 个包")
