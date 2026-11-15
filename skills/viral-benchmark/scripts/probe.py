#!/usr/bin/env python3
"""
爆款对标分析助手 · 素材读取脚本

用法：
  python3 probe.py <链接或文件夹或视频文件> [更多...] -o <输出目录>

- 链接：用 yt-dlp 只读元数据（播放、点赞、粉丝、时长、发布日期），顺带抓封面和字幕，不下载视频。
- 本地视频 / 文件夹：用 ffprobe 读时长和画幅，用 ffmpeg 抽 8 帧拼成一张联系表，方便 Agent 看画面。
  如果视频旁边有同名 .info.json（yt-dlp --write-info-json 生成），会一起读进来。

输出：
  <输出目录>/对标表.csv        每条一行，数据缺的留空，等 Agent 或用户补
  <输出目录>/probe.json        完整原始信息
  <输出目录>/frames/*.jpg      本地视频的联系表（每格秒数见 probe.json 的 frame_seconds）
  <输出目录>/subs/*            链接视频的字幕（有的话）
"""
import argparse
import csv
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

VIDEO_EXT = {".mp4", ".mov", ".m4v", ".webm", ".mkv", ".avi", ".flv"}

CSV_FIELDS = [
    "编号", "来源", "平台", "账号", "标题", "粉丝数", "播放", "点赞", "收藏", "评论",
    "赞粉比", "账号平时点赞", "比平时(倍)", "时长(秒)", "画幅", "发布日期", "联系表", "字幕",
    # 下面这些由 Agent 判断后填（账号平时点赞、收藏一般要用户补）
    "视频类型", "开头3秒在干什么", "同形式在几个号上火过", "评论区在追问什么",
    "换主角测试", "能借什么", "要换什么", "借不走的", "结论",
]


def run(cmd):
    return subprocess.run(cmd, capture_output=True, text=True)


def platform_of(url):
    u = url.lower()
    for key, name in [("youtube", "YouTube"), ("youtu.be", "YouTube"), ("tiktok", "TikTok"),
                      ("instagram", "Instagram"), ("bilibili", "B站"), ("b23.tv", "B站"),
                      ("xiaohongshu", "小红书"), ("xhslink", "小红书"), ("douyin", "抖音"),
                      ("x.com", "X"), ("twitter", "X")]:
        if key in u:
            return name
    return "其他"


def ratio(likes, followers):
    try:
        if likes and followers:
            return round(float(likes) / float(followers), 3)
    except (TypeError, ValueError, ZeroDivisionError):
        pass
    return ""


def aspect(w, h):
    if not w or not h:
        return ""
    w, h = int(w), int(h)
    if h > w * 1.2:
        return f"竖屏 {w}x{h}"
    if w > h * 1.2:
        return f"横屏 {w}x{h}"
    return f"方形 {w}x{h}"


def fmt_date(d):
    if d and len(str(d)) == 8:
        d = str(d)
        return f"{d[:4]}-{d[4:6]}-{d[6:]}"
    return d or ""


def from_info(info):
    return {
        "账号": info.get("uploader") or info.get("channel") or "",
        "标题": (info.get("title") or "").replace("\n", " ")[:80],
        "粉丝数": info.get("channel_follower_count") or "",
        "播放": info.get("view_count") or "",
        "点赞": info.get("like_count") or "",
        "评论": info.get("comment_count") or "",
        "时长(秒)": round(info["duration"]) if info.get("duration") else "",
        "画幅": aspect(info.get("width"), info.get("height")),
        "发布日期": fmt_date(info.get("upload_date")),
    }


def probe_url(url, out, cookies=None):
    row = {"来源": url, "平台": platform_of(url)}
    if not shutil.which("yt-dlp"):
        row["结论"] = "未安装 yt-dlp，数据请手动补"
        return row, {}
    base = ["yt-dlp", "--no-warnings"] + (["--cookies-from-browser", cookies] if cookies else [])
    r = run(base + ["--dump-json", "--skip-download", url])
    if r.returncode != 0 or not r.stdout.strip():
        row["结论"] = "读取失败（可能需要登录，可加 --cookies-from-browser chrome 再试），数据请手动补"
        return row, {"error": r.stderr[-500:]}
    info = json.loads(r.stdout.splitlines()[0])
    row.update(from_info(info))
    vid = info.get("id", "video")

    # 封面图：不下载视频，也能先看一眼画面
    frames = out / "frames"
    frames.mkdir(exist_ok=True)
    run(base + ["--skip-download", "--write-thumbnail", "--convert-thumbnails", "jpg",
                "-o", str(frames / f"{vid}.%(ext)s"), url])
    thumbs = sorted(frames.glob(f"{vid}*.jpg"))
    if thumbs:
        row["联系表"] = str(thumbs[0]) + "（封面）"

    # 字幕：按语言逐个试，拿到一个就停（YouTube 容易限流）
    subs_dir = out / "subs"
    subs_dir.mkdir(exist_ok=True)
    for lang in ("zh-Hans", "zh", "zh-CN", "en"):
        run(base + ["--skip-download", "--write-subs", "--write-auto-subs", "--sub-langs", lang,
                    "--convert-subs", "srt", "-o", str(subs_dir / f"{vid}.%(ext)s"), url])
        subs = sorted(subs_dir.glob(f"{vid}*.srt")) + sorted(subs_dir.glob(f"{vid}*.vtt"))
        if subs:
            row["字幕"] = subs_to_text(subs[0])
            break

    keep = {k: info.get(k) for k in ("id", "title", "description", "uploader", "channel_follower_count",
                                      "view_count", "like_count", "comment_count", "duration",
                                      "upload_date", "width", "height", "tags", "webpage_url")}
    return row, keep


def subs_to_text(sub_path):
    """把 srt / vtt 转成去重后的纯文本，自动字幕的滚动重复行也去掉。返回 txt 路径。"""
    import re
    lines, last = [], None
    for raw in Path(sub_path).read_text(encoding="utf-8", errors="ignore").splitlines():
        t = raw.strip()
        if (not t or t.isdigit() or "-->" in t or t.startswith(("WEBVTT", "Kind:", "Language:"))):
            continue
        t = re.sub(r"<[^>]+>", "", t).strip()
        if t and t != last and (not lines or t not in lines[-3:]):
            lines.append(t)
        last = t
    txt = Path(sub_path).with_suffix(".txt")
    txt.write_text("\n".join(lines), encoding="utf-8")
    return str(txt)


def probe_file(path, out, idx, n=8):
    row = {"来源": str(path), "平台": "本地文件", "标题": path.stem}
    meta = {}
    sidecar = path.with_suffix(".info.json")
    if sidecar.exists():
        try:
            info = json.loads(sidecar.read_text(encoding="utf-8"))
            row.update(from_info(info))
            row["平台"] = info.get("extractor_key") or "本地文件"
            row["来源"] = info.get("webpage_url") or str(path)
        except Exception:
            pass
    r = run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries",
             "stream=width,height:format=duration", "-of", "json", str(path)])
    if r.returncode == 0:
        j = json.loads(r.stdout)
        st = (j.get("streams") or [{}])[0]
        dur = float(j.get("format", {}).get("duration", 0) or 0)
        row.setdefault("时长(秒)", round(dur))
        if not row.get("时长(秒)"):
            row["时长(秒)"] = round(dur)
        if not row.get("画幅"):
            row["画幅"] = aspect(st.get("width"), st.get("height"))
        meta = {"duration": dur, "width": st.get("width"), "height": st.get("height")}
        if dur > 0:
            frames = out / "frames"
            frames.mkdir(exist_ok=True)
            sheet = frames / f"{idx:02d}-{path.stem}.jpg"
            # n 帧按 4 列排；跳过最后 5%，避开平台片尾页
            span = dur * 0.95
            rows = (n + 3) // 4
            portrait = (st.get("height") or 0) > (st.get("width") or 0)
            width = 240 if portrait else 400
            run(["ffmpeg", "-v", "error", "-y", "-t", f"{span:.2f}", "-i", str(path), "-vf",
                 f"fps={n / span:.5f},scale={width}:-2,tile=4x{rows}", "-frames:v", "1", str(sheet)])
            if sheet.exists():
                row["联系表"] = str(sheet)
                # 联系表从左到右、从上到下，每格对应的大约秒数
                meta["frame_seconds"] = [round(k * span / n, 1) for k in range(n)]
    return row, meta


def collect(inputs):
    items = []
    for x in inputs:
        if x.startswith("http://") or x.startswith("https://"):
            items.append(("url", x))
            continue
        p = Path(x).expanduser()
        if p.is_dir():
            for f in sorted(p.iterdir()):
                if f.suffix.lower() in VIDEO_EXT:
                    items.append(("file", f))
                elif f.suffix.lower() in {".txt", ".md"}:
                    for line in f.read_text(encoding="utf-8").splitlines():
                        line = line.strip()
                        if line.startswith("http"):
                            items.append(("url", line))
        elif p.is_file() and p.suffix.lower() in VIDEO_EXT:
            items.append(("file", p))
        else:
            print(f"跳过：{x}", file=sys.stderr)
    return items


def main():
    ap = argparse.ArgumentParser(description="读取对标视频的数据和画面")
    ap.add_argument("inputs", nargs="+", help="链接、视频文件，或放视频 / 链接清单的文件夹")
    ap.add_argument("-o", "--out", default="对标输出", help="输出目录")
    ap.add_argument("--frames", type=int, default=8, help="本地视频抽几帧拼联系表（4 的倍数，默认 8，单条细拆用 16）")
    ap.add_argument("--cookies-from-browser", dest="cookies", metavar="BROWSER",
                    help="需要登录的平台（小红书、抖音等）可以借浏览器登录态，比如 chrome")
    a = ap.parse_args()

    if not shutil.which("ffprobe"):
        print("提示：未安装 ffmpeg，本地视频只能读文件名。", file=sys.stderr)

    out = Path(a.out).expanduser()
    out.mkdir(parents=True, exist_ok=True)
    rows, raw = [], []
    for i, (kind, x) in enumerate(collect(a.inputs), 1):
        row, meta = probe_url(x, out, a.cookies) if kind == "url" else probe_file(x, out, i, max(4, a.frames))
        row["编号"] = i
        row["赞粉比"] = ratio(row.get("点赞"), row.get("粉丝数"))
        rows.append(row)
        raw.append({"编号": i, "输入": str(x), "meta": meta})
        print(f"[{i}] {row.get('平台')} · {row.get('标题', '')[:30]} · 赞 {row.get('点赞', '?')} / 粉 {row.get('粉丝数', '?')}")

    with open(out / "对标表.csv", "w", encoding="utf-8-sig", newline="") as f:
        w = csv.DictWriter(f, fieldnames=CSV_FIELDS, extrasaction="ignore")
        w.writeheader()
        w.writerows(rows)
    (out / "probe.json").write_text(json.dumps(raw, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\n已写入 {out / '对标表.csv'}，共 {len(rows)} 条。")


if __name__ == "__main__":
    main()
