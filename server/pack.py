# -*- coding: utf-8 -*-
"""生成服务端升级包 / 部署包（零依赖，只用 Python 标准库）。

用途：
  python server/pack.py                      -> 桌面 tvguard-server-YYYYMMDD-vX.Y.Z.zip
  python server/pack.py D:/some/path.zip    -> 指定输出路径
  python server/pack.py --keep              -> 不升版本号，重打同一个包

版本号：唯一来源是 package.json 的 version，每次打包默认 patch +1 并写回，
这样每个升级包在「管理端升级 · 当前状态」里都有可区分的版本号（和客户端
versionCode 一个思路）。写回后记得一起提交。

要点：zip 内路径一律用正斜杠。PowerShell 的 Compress-Archive 会写成
"src\\app.js"（反斜杠），部分解压工具不能识别为目录，会把所有文件
平铺到一层 —— 这就是以前必须一个个文件替换的原因。
"""
import json
import os
import subprocess
import sys
import zipfile
from datetime import datetime

ROOT = os.path.dirname(os.path.abspath(__file__))
ROOT_FILES = [
    "Dockerfile", "docker-compose.yml", "package.json",
    ".env.example", ".dockerignore", "README.md", "INSTALL.txt",
]
DIRS = ["src", "public"]
SKIP_NAMES = {".DS_Store", "Thumbs.db", "__pycache__"}
PKG = os.path.join(ROOT, "package.json")


def git(*args):
    try:
        return subprocess.check_output(
            ["git", "-C", ROOT, *args], stderr=subprocess.DEVNULL
        ).decode("utf-8", "ignore").strip()
    except Exception:
        return ""


def bump_version():
    """patch +1 并写回 package.json，返回新版本号；读不到就返回空串。"""
    try:
        with open(PKG, encoding="utf-8") as f:
            pkg = json.load(f)
    except Exception:
        return ""
    parts = str(pkg.get("version") or "1.0.0").split(".")
    while len(parts) < 3:
        parts.append("0")
    try:
        parts[2] = str(int(parts[2]) + 1)
    except ValueError:
        parts[2] = "1"
    pkg["version"] = ".".join(parts[:3])
    with open(PKG, "w", encoding="utf-8", newline="\n") as f:
        json.dump(pkg, f, ensure_ascii=False, indent=2)
        f.write("\n")
    return pkg["version"]


def build_meta(version):
    # 带时区偏移的 ISO 时间：容器可能跑在 UTC、浏览器在 +08，只有带偏移才不会差 8 小时。
    now = datetime.now().astimezone()
    return {
        "version": version,
        "build": now.strftime("%Y-%m-%d %H:%M:%S"),
        "commit": git("rev-parse", "--short", "HEAD") or "unknown",
        "packedAt": now.isoformat(timespec="seconds"),
    }


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("-")]
    keep = "--keep" in sys.argv or "--no-bump" in sys.argv
    version = bump_version() if not keep else ""
    if not version:
        try:
            with open(PKG, encoding="utf-8") as f:
                version = str(json.load(f).get("version") or "")
        except Exception:
            version = ""

    if args:
        out = os.path.abspath(args[0])
    else:
        desktop = os.path.join(os.path.expanduser("~"), "Desktop")
        out = os.path.join(desktop, "tvguard-server-%s%s.zip" % (
            datetime.now().strftime("%Y%m%d"),
            ("-v" + version) if version else "",
        ))

    meta = build_meta(version)
    count = 0
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        z.writestr("BUILD.json", json.dumps(meta, ensure_ascii=False, indent=2))
        for name in ROOT_FILES:
            fp = os.path.join(ROOT, name)
            if os.path.isfile(fp):
                z.write(fp, name)  # 顶层文件：名字本身就是 POSIX 路径
                count += 1
        for d in DIRS:
            base = os.path.join(ROOT, d)
            for cur, dirs, files in os.walk(base):
                dirs[:] = [x for x in dirs if x not in SKIP_NAMES]
                for f in files:
                    if f in SKIP_NAMES or f.endswith((".pyc", ".log")):
                        continue
                    fp = os.path.join(cur, f)
                    rel = os.path.relpath(fp, ROOT).replace(os.sep, "/")
                    z.write(fp, rel)  # 关键：全部正斜杠
                    count += 1

    print("zip  :", out)
    print("files:", count, "(含 BUILD.json)")
    print("ver  :", "v" + version if version else "未标记")
    print("build:", meta["build"], "commit:", meta["commit"])
    # 自检：任何反斜杠路径都会让部分解压工具平铺，直接判失败
    with zipfile.ZipFile(out) as z:
        bad = [n for n in z.namelist() if "\\" in n]
        if bad:
            raise SystemExit("打包失败：发现反斜杠路径 " + str(bad[:3]))
        print("check: 全部路径为正斜杠 OK")


if __name__ == "__main__":
    main()
