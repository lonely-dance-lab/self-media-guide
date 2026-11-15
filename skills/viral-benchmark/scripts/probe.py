#!/usr/bin/env python3
"""
爆款对标分析助手 · 素材读取脚本

用法：
  python3 probe.py <链接或文件夹或视频文件> [更多...] -o <输出目录>

- 链接：用 yt-dlp 读元数据（播放、点赞、粉丝、时长、发布日期），再尽量补齐分析要用的东西：
    · 下载一份 720p 以内的视频到 <输出目录>/videos/，只用来抽帧分析（--no-download 关闭）
    · 抓热门评论（目前只支持 YouTube，--comments 0 关闭）
    · 读账号最近 15 条作品的播放中位数，算这条比平时好多少（--no-baseline 关闭）
    · 有字幕就下载并转成纯文本
  下载失败时退回到封面图，并提示升级 yt-dlp 或手动下载。
- 本地视频 / 文件夹：用 ffprobe 读时长和画幅，按时长自动抽帧（每 2 秒左右一帧，8–32 帧），
  每 16 帧拼一张联系表，每格左上角标了时间。
  如果视频旁边有同名 .info.json（yt-dlp --write-info-json 生成），会一起读进来。

输出：
  <输出目录>/对标表.csv        每条一行，数据缺的留空，等 Agent 或用户补
  <输出目录>/probe.json        完整原始信息（含每格联系表对应的秒数 frame_seconds）
  <输出目录>/frames/*.jpg      联系表
  <输出目录>/comments/*.txt    热门评论（按点赞排序）
  <输出目录>/subs/*.txt        字幕纯文本
  <输出目录>/videos/*.mp4      链接下载下来的分析用视频
"""
import argparse
import csv
import json
import math
import os
import shutil
import statistics
import subprocess
import sys
from pathlib import Path

VIDEO_EXT = {".mp4", ".mov", ".m4v", ".webm", ".mkv", ".avi", ".flv"}
MAX_DOWNLOAD_SECONDS = 600

CSV_FIELDS = [
    "编号", "来源", "平台", "账号", "标题", "粉丝数", "播放", "点赞", "收藏", "评论",
    "赞粉比", "账号平时播放", "账号平时点赞", "比平时(倍)", "时长(秒)", "画幅", "发布日期",
    "联系表", "字幕", "评论摘录", "备注",
    # 下面这些由 Agent 判断后填
    "视频类型", "开头3秒在干什么", "评论区在问什么", "换主角测试", "能借什么", "要换什么", "借不走的", "结论",
]

FONT_CANDIDATES = [
    "/System/Library/Fonts/Supplemental/Arial.ttf",
    "/System/Library/Fonts/Helvetica.ttc",
    "/Library/Fonts/Arial.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/usr/share/fonts/dejavu/DejaVuSans.ttf",
    "C:/Windows/Fonts/arial.ttf",
]


def run(cmd, timeout=600):
    try:
        return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        return subprocess.CompletedProcess(cmd, 1, "", "超时")


def platform_of(url):
    u = url.lower()
    for key, name in [("youtube", "YouTube"), ("youtu.be", "YouTube"), ("tiktok", "TikTok"),
                      ("instagram", "Instagram"), ("bilibili", "B站"), ("b23.tv", "B站"),
                      ("xiaohongshu", "小红书"), ("xhslink", "小红书"), ("douyin", "抖音"),
                      ("x.com", "X"), ("twitter", "X")]:
        if key in u:
            return name
    return "其他"


def num(x):
    try:
        return float(x)
    except (TypeError, ValueError):
        return None


def ratio(a, b, digits=3):
    a, b = num(a), num(b)
    if a and b:
        return round(a / b, digits)
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


def note(row, text):
    row["备注"] = (row.get("备注", "") + "；" + text).strip("；")


# ---------------------------------------------------------------- 链接

def write_comments(info, out, vid, limit):
    comments = sorted(info.get("comments") or [], key=lambda c: c.get("like_count") or 0, reverse=True)[:limit]
    if not comments:
        return ""
    d = out / "comments"
    d.mkdir(exist_ok=True)
    p = d / f"{vid}.txt"
    lines = [f"{c.get('like_count') or 0} 赞 | {(c.get('text') or '').strip().replace(chr(10), ' ')}" for c in comments]
    p.write_text("\n".join(lines), encoding="utf-8")
    return str(p)


def baseline(base, info, url):
    """账号最近 15 条作品的播放中位数（不含这一条）。"""
    home = info.get("channel_url") or info.get("uploader_url")
    if not home:
        return None, 0
    if "youtube" in home:
        short = "/shorts/" in url or (info.get("duration") or 0) <= 180
        home = home.rstrip("/") + ("/shorts" if short else "/videos")
    r = run(base + ["--flat-playlist", "--playlist-end", "16", "--dump-json", home], timeout=120)
    views = []
    for line in r.stdout.splitlines():
        try:
            e = json.loads(line)
        except ValueError:
            continue
        if e.get("id") != info.get("id") and e.get("view_count"):
            views.append(e["view_count"])
    views = views[:15]
    if len(views) < 3:
        return None, len(views)
    return round(statistics.median(views)), len(views)


def probe_url(url, out, idx, a):
    row = {"来源": url, "平台": platform_of(url)}
    ytdlp = os.environ.get("YTDLP", "yt-dlp")
    if not shutil.which(ytdlp):
        note(row, "未安装 yt-dlp，请把视频下载下来再给本地文件，数据手动补")
        return row, {}
    base = [ytdlp, "--no-warnings", "--no-playlist"] + (["--cookies-from-browser", a.cookies] if a.cookies else [])

    want_comments = a.comments > 0 and row["平台"] == "YouTube"
    extra = (["--write-comments", "--extractor-args",
              f"youtube:max_comments={a.comments * 3},all,0,0;comment_sort=top"] if want_comments else [])
    r = run(base + ["--dump-json", "--skip-download"] + extra + [url], timeout=180)
    if r.returncode != 0 or not r.stdout.strip():
        if want_comments:  # 评论拖垮了读取，就不带评论再试一次
            r = run(base + ["--dump-json", "--skip-download", url], timeout=120)
    if r.returncode != 0 or not r.stdout.strip():
        note(row, "读取失败（可能需要登录，可加 --cookies-from-browser chrome 再试；或者把视频下载下来给本地文件），数据请手动补")
        return row, {"error": r.stderr[-500:]}
    info = json.loads(r.stdout.splitlines()[0])
    row.update(from_info(info))
    vid = "".join(c for c in str(info.get("id", f"video{idx}")) if c.isalnum() or c in "-_") or f"video{idx}"
    meta = {k: info.get(k) for k in ("id", "title", "description", "uploader", "channel_follower_count",
                                     "view_count", "like_count", "comment_count", "duration",
                                     "upload_date", "width", "height", "tags", "webpage_url")}

    if want_comments:
        p = write_comments(info, out, vid, a.comments)
        if p:
            row["评论摘录"] = p

    if not a.no_baseline:
        med, n = baseline(base, info, url)
        if med:
            row["账号平时播放"] = med
            row["比平时(倍)"] = ratio(row.get("播放"), med, 1)
            meta["baseline"] = {"median_views": med, "sample": n}
            note(row, f"账号平时播放为最近 {n} 条作品的中位数")

    # 字幕：按语言逐个试，拿到一个就停（YouTube 容易限流）
    subs_dir = out / "subs"
    subs_dir.mkdir(exist_ok=True)
    for lang in ("zh-Hans", "zh-Hant", "zh", "zh-CN", "en"):
        run(base + ["--skip-download", "--write-subs", "--write-auto-subs", "--sub-langs", lang,
                    "--convert-subs", "srt", "-o", str(subs_dir / f"{vid}.%(ext)s"), url], timeout=120)
        subs = sorted(subs_dir.glob(f"{vid}*.srt")) + sorted(subs_dir.glob(f"{vid}*.vtt"))
        if subs:
            row["字幕"] = subs_to_text(subs[0])
            break

    # 下载一份分析用的视频，拿去抽帧；失败就退回封面
    dur = info.get("duration") or 0
    if not a.no_download and dur and dur <= MAX_DOWNLOAD_SECONDS:
        vdir = out / "videos"
        vdir.mkdir(exist_ok=True)
        target = vdir / f"{vid}.mp4"
        if not target.exists():
            run(base + ["-f", "b[height<=720][ext=mp4]/bv*[height<=720]+ba/b[height<=720]/b",
                        "--merge-output-format", "mp4", "-o", str(target), url], timeout=600)
        if target.exists():
            frow, fmeta = probe_file(target, out, idx, a.frames, name=vid)
            for k in ("联系表",):
                if frow.get(k):
                    row[k] = frow[k]
            meta.update({k: v for k, v in fmeta.items() if k in ("frame_seconds", "sheets")})
            meta["video_file"] = str(target)
        else:
            note(row, "视频下载失败，只拿到封面。多半是 yt-dlp 版本旧了：brew upgrade yt-dlp（或 pip install -U yt-dlp）后再试，或者手动下载后给本地文件")
    elif dur > MAX_DOWNLOAD_SECONDS:
        note(row, f"超过 {MAX_DOWNLOAD_SECONDS // 60} 分钟，没有下载，只拿到封面")

    if not row.get("联系表"):
        frames = out / "frames"
        frames.mkdir(exist_ok=True)
        run(base + ["--skip-download", "--write-thumbnail", "--convert-thumbnails", "jpg",
                    "-o", str(frames / f"{idx:02d}-{vid}-封面.%(ext)s"), url], timeout=120)
        thumbs = sorted(frames.glob(f"{idx:02d}-{vid}-封面*.jpg"))
        if thumbs:
            row["联系表"] = str(thumbs[0]) + "（只有封面）"
    return row, meta


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


# ---------------------------------------------------------------- 本地视频

def auto_frames(dur, requested):
    if requested and requested > 0:
        n = requested
    else:
        n = math.ceil(dur / 2)  # 大约每 2 秒一帧
    n = max(8, min(32, n))
    return int(math.ceil(n / 4) * 4)


def make_sheet(path, sheet, start, step, k, width, font):
    rows = math.ceil(k / 4)
    vf = f"fps={1 / step:.5f},scale={width}:-2"
    if font:
        vf += (f",drawtext=fontfile='{font}':text='%{{pts\\:hms\\:{start:.2f}}}':x=8:y=8:"
               "fontsize=22:fontcolor=white:box=1:boxcolor=black@0.6:boxborderw=4")
    vf += f",tile=4x{rows}"
    cmd = ["ffmpeg", "-v", "error", "-y", "-ss", f"{start:.2f}", "-t", f"{step * k:.2f}",
           "-i", str(path), "-vf", vf, "-frames:v", "1", "-q:v", "3", str(sheet)]
    r = run(cmd)
    if (r.returncode != 0 or not sheet.exists()) and font:
        return make_sheet(path, sheet, start, step, k, width, None)  # ffmpeg 没带字体支持就不标时间
    return sheet.exists()


def probe_file(path, out, idx, frames_wanted=0, name=None):
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
    if not shutil.which("ffprobe"):
        note(row, "未安装 ffmpeg，读不到画面")
        return row, meta
    r = run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries",
             "stream=width,height:format=duration", "-of", "json", str(path)])
    if r.returncode != 0:
        note(row, "读不到这个视频，试试转成 H.264 的 mp4")
        return row, meta
    j = json.loads(r.stdout)
    st = (j.get("streams") or [{}])[0]
    dur = float(j.get("format", {}).get("duration", 0) or 0)
    if not row.get("时长(秒)"):
        row["时长(秒)"] = round(dur)
    if not row.get("画幅"):
        row["画幅"] = aspect(st.get("width"), st.get("height"))
    meta = {"duration": dur, "width": st.get("width"), "height": st.get("height")}
    if dur <= 0:
        return row, meta

    frames_dir = out / "frames"
    frames_dir.mkdir(exist_ok=True)
    n = auto_frames(dur, frames_wanted)
    span = dur * 0.95  # 跳过最后 5%，避开平台片尾页
    step = span / n
    portrait = (st.get("height") or 0) > (st.get("width") or 0)
    width = 320 if portrait else 480
    font = next((f for f in FONT_CANDIDATES if os.path.exists(f)), None)
    stem = name or path.stem
    sheets, seconds = [], []
    for c in range(math.ceil(n / 16)):
        k = min(16, n - c * 16)
        start = c * 16 * step
        sheet = frames_dir / f"{idx:02d}-{stem}-{c + 1}.jpg"
        if make_sheet(path, sheet, start, step, k, width, font):
            sheets.append(str(sheet))
            seconds.append([round(start + i * step, 1) for i in range(k)])
    if sheets:
        row["联系表"] = "；".join(sheets)
        meta["sheets"] = sheets
        meta["frame_seconds"] = seconds  # 每张联系表从左到右、从上到下，每格对应的秒数
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
    ap = argparse.ArgumentParser(description="读取对标视频的数据、画面和评论")
    ap.add_argument("inputs", nargs="+", help="链接、视频文件，或放视频 / 链接清单的文件夹")
    ap.add_argument("-o", "--out", default="对标输出", help="输出目录")
    ap.add_argument("--frames", type=int, default=0, help="抽几帧（默认按时长自动，每 2 秒左右一帧，8–32 帧）")
    ap.add_argument("--comments", type=int, default=20, help="抓多少条热门评论（目前只支持 YouTube，0 为不抓）")
    ap.add_argument("--no-download", action="store_true", help="链接只读数据和封面，不下载视频")
    ap.add_argument("--no-baseline", action="store_true", help="不读账号最近作品的播放中位数")
    ap.add_argument("--cookies-from-browser", dest="cookies", metavar="BROWSER",
                    help="需要登录的平台（小红书、抖音等）可以借浏览器登录态，比如 chrome")
    a = ap.parse_args()

    if not shutil.which("ffprobe"):
        print("提示：未安装 ffmpeg，看不到画面。macOS 可以 brew install ffmpeg", file=sys.stderr)

    out = Path(a.out).expanduser()
    out.mkdir(parents=True, exist_ok=True)
    rows, raw = [], []
    for i, (kind, x) in enumerate(collect(a.inputs), 1):
        row, meta = probe_url(x, out, i, a) if kind == "url" else probe_file(x, out, i, a.frames)
        row["编号"] = i
        row["赞粉比"] = ratio(row.get("点赞"), row.get("粉丝数"))
        rows.append(row)
        raw.append({"编号": i, "输入": str(x), "meta": meta})
        print(f"[{i}] {row.get('平台')} · {row.get('标题', '')[:30]} · 播放 {row.get('播放') or '?'} · "
              f"赞 {row.get('点赞') or '?'} · 比平时 {row.get('比平时(倍)') or '?'} 倍")
        print(f"    联系表：{row.get('联系表') or '无'}")
        if row.get("评论摘录"):
            print(f"    评论：{row['评论摘录']}")
        if row.get("备注"):
            print(f"    备注：{row['备注']}")

    with open(out / "对标表.csv", "w", encoding="utf-8-sig", newline="") as f:
        w = csv.DictWriter(f, fieldnames=CSV_FIELDS, extrasaction="ignore")
        w.writeheader()
        w.writerows(rows)
    (out / "probe.json").write_text(json.dumps(raw, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\n已写入 {out}，共 {len(rows)} 条。")


if __name__ == "__main__":
    main()
