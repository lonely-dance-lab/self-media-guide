// 对标研究室 · 本地服务（Node.js 22+，不装依赖）
//   MODEL_API_KEY=sk-... node server.mjs        打开 http://localhost:4318
// 只做两件事：提供页面；把抽帧拼图转发给能看图的模型，拿回报告 JSON。
// 默认对接蚂蚁数科 MaaS 的 ling-3.2-flash，换成其他兼容 OpenAI 格式的视觉模型，改 MODEL_ENDPOINT / MODEL_NAME 即可。
// 上传的视频不经过服务器。Key 只在服务器上，用户也可以在页面里填自己的 Key。
// 贴链接：本机装了 yt-dlp 和 ffmpeg 就自动开放（DISABLE_LINK=1 可以关掉），服务器下载一份 720p 以内的视频，只用来分析，24 小时后自动删除。

import { createServer } from "node:http";
import { readFile, stat, mkdir, readdir, unlink } from "node:fs/promises";
import { execFile } from "node:child_process";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { analyzeFrames, DEFAULT_ENDPOINT, DEFAULT_MODEL, hasFrames, MAX_BODY } from "./analysis.mjs";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "public");
const PORT = Number(process.env.PORT || 4318);
const ENDPOINT = process.env.MODEL_ENDPOINT || DEFAULT_ENDPOINT;
const MODEL = process.env.MODEL_NAME || DEFAULT_MODEL;
const SERVER_KEY = process.env.MODEL_API_KEY || process.env.LING_API_KEY || "";
const FREE_RUNS = Number(process.env.FREE_RUNS || 0); // 每个 IP 每天能用服务器 Key 拆几次，0 表示不限
const CACHE = join(ROOT, "..", ".cache");
const YTDLP = process.env.YTDLP || "yt-dlp";
const COOKIES = process.env.YTDLP_COOKIES_BROWSER || ""; // 小红书、抖音要登录态，比如设成 chrome
const MAX_SECONDS = 600;
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
                ".jpg": "image/jpeg", ".png": "image/png", ".mp4": "video/mp4", ".svg": "image/svg+xml" };

/* ---------------- 贴链接 ---------------- */
let LINK = false;
const runCmd = (cmd, args, timeout) => new Promise(res => execFile(cmd, args, { timeout, maxBuffer: 256 * 1024 * 1024 },
  (e, out, err) => res({ ok: !e, out: String(out || ""), err: String(err || e?.message || "") })));
async function detectLink() {
  if (process.env.DISABLE_LINK === "1") return false;
  const [a, b] = await Promise.all([runCmd(YTDLP, ["--version"], 15000), runCmd("ffmpeg", ["-version"], 15000)]);
  return a.ok && b.ok;
}
function platformOf(u) {
  const x = u.toLowerCase();
  return [["youtu", "YouTube"], ["tiktok", "TikTok"], ["bilibili", "B站"], ["b23.tv", "B站"], ["xiaohongshu", "小红书"], ["xhslink", "小红书"],
          ["douyin", "抖音"], ["instagram", "Instagram"], ["x.com", "X"], ["twitter", "X"]].find(([k]) => x.includes(k))?.[1] || "其他";
}
async function fetchLink(url) {
  const base = ["--no-warnings", "--no-playlist", ...(COOKIES ? ["--cookies-from-browser", COOKIES] : [])];
  const platform = platformOf(url);
  const withComments = platform === "YouTube" ? ["--write-comments", "--extractor-args", "youtube:max_comments=60,all,0,0;comment_sort=top"] : [];
  let r = await runCmd(YTDLP, [...base, "--dump-json", "--skip-download", ...withComments, url], 180000);
  if (!r.ok && withComments.length) r = await runCmd(YTDLP, [...base, "--dump-json", "--skip-download", url], 120000);
  if (!r.ok || !r.out.trim()) throw Object.assign(new Error(["小红书", "抖音", "Instagram"].includes(platform)
    ? "这个平台需要登录才能读，先把视频下载下来再上传吧" : "读不到这个链接，检查一下链接，或者先下载下来再上传"), { status: 502 });
  const info = JSON.parse(r.out.split("\n")[0]);
  if ((info.duration || 0) > MAX_SECONDS) throw Object.assign(new Error("这条超过 10 分钟了，先剪一段再上传吧"), { status: 400 });
  const id = String(info.id || Date.now()).replace(/[^\w-]/g, "").slice(0, 40) || String(Date.now());
  await mkdir(CACHE, { recursive: true });
  const file = join(CACHE, `${id}.mp4`);
  if (!(await stat(file).catch(() => null))) {
    const d = await runCmd(YTDLP, [...base, "-f", "b[height<=720][ext=mp4]/bv*[height<=720]+ba/b[height<=720]/b",
                                   "--merge-output-format", "mp4", "-o", file, url], 600000);
    if (!(await stat(file).catch(() => null))) throw Object.assign(new Error("视频下载失败。可能是 yt-dlp 版本旧了，更新一下再试，或者先下载下来再上传"), { status: 502, detail: d.err.slice(-300) });
  }
  // 账号最近作品的播放中位数
  let baseline = null;
  const home = info.channel_url || info.uploader_url;
  if (home) {
    const list = home.includes("youtube") ? home.replace(/\/$/, "") + (url.includes("/shorts/") || (info.duration || 0) <= 180 ? "/shorts" : "/videos") : home;
    const b = await runCmd(YTDLP, [...base, "--flat-playlist", "--playlist-end", "16", "--dump-json", list], 120000);
    const views = b.out.split("\n").map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(e => e && e.id !== info.id && e.view_count).map(e => e.view_count).slice(0, 15).sort((x, y) => x - y);
    if (views.length >= 3 && info.view_count) {
      const median = views[Math.floor(views.length / 2)];
      baseline = { median, sample: views.length, ratio: Math.round(info.view_count / median * 10) / 10 };
    }
  }
  const date = String(info.upload_date || "");
  return {
    file: `/cache/${id}.mp4`,
    name: String(info.title || id).replace(/\s+/g, " ").slice(0, 60),
    meta: {
      platform, url, uploader: info.uploader || info.channel || "", title: String(info.title || "").slice(0, 120),
      date: date.length === 8 ? `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6)}` : "",
      views: info.view_count || null, likes: info.like_count || null, comments: info.comment_count || null,
      followers: info.channel_follower_count || null, baseline,
      topComments: (info.comments || []).sort((a, b) => (b.like_count || 0) - (a.like_count || 0)).slice(0, 20)
        .map(c => ({ likes: c.like_count || 0, text: String(c.text || "").replace(/\s+/g, " ").slice(0, 120) })),
    },
  };
}
async function cleanCache() {
  const files = await readdir(CACHE).catch(() => []);
  for (const f of files) { const p = join(CACHE, f), st = await stat(p).catch(() => null); if (st && Date.now() - st.mtimeMs > 24 * 3600 * 1000) await unlink(p).catch(() => {}); }
}
async function handleFetch(req, res) {
  if (!LINK) return send(res, 403, { error: "在线版只支持上传视频，自己部署后可以贴链接" });
  let body = ""; for await (const c of req) { body += c; if (body.length > 10000) break; }
  let url = ""; try { url = String(JSON.parse(body).url || "").trim(); } catch {}
  if (!/^https?:\/\/\S+$/.test(url)) return send(res, 400, { error: "这不是一个视频链接" });
  try { send(res, 200, await fetchLink(url)); }
  catch (e) { send(res, e.status || 500, { error: e.message || "读取链接出错" }); }
}

const quota = new Map();
function useQuota(ip) {
  if (!FREE_RUNS) return true;
  const day = new Date().toISOString().slice(0, 10), q = quota.get(ip);
  const used = q && q.day === day ? q.n : 0;
  if (used >= FREE_RUNS) return false;
  quota.set(ip, { day, n: used + 1 });
  return true;
}

async function analyze(req, res) {
  let size = 0; const chunks = [];
  for await (const c of req) { size += c.length; if (size > MAX_BODY) return send(res, 413, { error: "视频画面太多了，换一条短一点的试试" }); chunks.push(c); }
  let b;
  try { b = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return send(res, 400, { error: "请求格式不对，刷新页面再试" }); }
  if (!hasFrames(b))
    return send(res, 400, { error: "抽帧数据不完整，重新上传视频试试" });
  const userKey = String(req.headers["x-user-key"] || "").trim();
  const key = userKey || SERVER_KEY;
  if (!key) return send(res, 401, { error: "还没有 API Key，点右上角「设置 API Key」填你自己的" });
  const ip = String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();
  if (!userKey && !useQuota(ip)) return send(res, 429, { error: `今天的免费次数（${FREE_RUNS} 次）用完了，可以在右上角填你自己的 Key 继续用` });

  try {
    const report = await analyzeFrames(b, key, {
      endpoint: ENDPOINT, model: MODEL, disableThinking: process.env.DISABLE_THINKING === "1",
    });
    send(res, 200, { report });
  } catch (e) {
    send(res, e.status && e.status < 600 ? e.status : 502, { error: e.message || "分析失败了，再试一次" });
  }
}

function send(res, status, obj) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(obj));
}

async function serveStatic(req, res) {
  const path = decodeURIComponent(new URL(req.url, "http://x").pathname);
  const inCache = path.startsWith("/cache/");
  const base = inCache ? CACHE : ROOT;
  const file = normalize(join(base, inCache ? path.slice(6) : path === "/" ? "/index.html" : path));
  if (!file.startsWith(base)) return send(res, 403, { error: "forbidden" });
  try {
    const st = await stat(file);
    if (!st.isFile()) throw 0;
    const type = TYPES[extname(file).toLowerCase()] || "application/octet-stream";
    const range = req.headers.range;
    if (range && type === "video/mp4") {  // 视频要支持拖进度条
      const [a, z] = range.replace("bytes=", "").split("-").map(Number);
      const start = a || 0, end = Math.min(z || st.size - 1, st.size - 1);
      const { createReadStream } = await import("node:fs");
      res.writeHead(206, { "Content-Type": type, "Content-Range": `bytes ${start}-${end}/${st.size}`, "Accept-Ranges": "bytes", "Content-Length": end - start + 1 });
      return createReadStream(file, { start, end }).pipe(res);
    }
    res.writeHead(200, { "Content-Type": type, "Content-Length": st.size, "Accept-Ranges": "bytes" });
    res.end(await readFile(file));
  } catch { send(res, 404, { error: "not found" }); }
}

LINK = await detectLink();
await cleanCache(); setInterval(cleanCache, 3600 * 1000);

createServer((req, res) => {
  if (req.method === "POST" && req.url === "/api/analyze") return analyze(req, res);
  if (req.method === "POST" && req.url === "/api/fetch") return handleFetch(req, res);
  if (req.method === "GET" && req.url === "/api/config") return send(res, 200, { serverKey: !!SERVER_KEY, freeRuns: FREE_RUNS, link: LINK });
  if (req.method === "GET") return serveStatic(req, res);
  send(res, 405, { error: "method not allowed" });
}).listen(PORT, () => console.log(`对标研究室已启动：http://localhost:${PORT}  模型 ${MODEL}${SERVER_KEY ? "" : "（没有设置 MODEL_API_KEY，需要在页面里填 Key）"}；贴链接：${LINK ? "已开放" : "未开放"}`));
