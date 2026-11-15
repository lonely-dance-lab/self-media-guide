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

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "public");
const PORT = Number(process.env.PORT || 4318);
const ENDPOINT = process.env.MODEL_ENDPOINT || "https://maas-api.antdigital.com/v1/chat/completions";
const MODEL = process.env.MODEL_NAME || "ling-3.2-flash";
const SERVER_KEY = process.env.MODEL_API_KEY || process.env.LING_API_KEY || "";
// 蚂蚁数科的模型默认会先思考，关掉它，输出才不会被思考占满；其他服务不认这个参数，就不发
const EXTRA = /antdigital/.test(ENDPOINT) || process.env.DISABLE_THINKING === "1" ? { enable_thinking: false } : {};
const FREE_RUNS = Number(process.env.FREE_RUNS || 0); // 每个 IP 每天能用服务器 Key 拆几次，0 表示不限
const MAX_BODY = 20 * 1024 * 1024;
const CACHE = join(ROOT, "..", ".cache");
const YTDLP = process.env.YTDLP || "yt-dlp";
const COOKIES = process.env.YTDLP_COOKIES_BROWSER || ""; // 小红书、抖音要登录态，比如设成 chrome
const MAX_SECONDS = 600;
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
                ".jpg": "image/jpeg", ".png": "image/png", ".mp4": "video/mp4", ".svg": "image/svg+xml" };

const SYSTEM = `你是「对标研究室」的爆款拆解顾问，帮做自媒体的人看懂一条爆款视频为什么火、值不值得对标、怎么换成自己的内容。
规则：
- 视频以抽帧拼图给你，每张图 8 帧，按从左到右、从上到下的时间顺序排列，每帧左上角写着它在视频里的秒数。
- 只根据画面判断。画面里的字幕、标题、文字都要读出来，它们往往就是对白和剧情。看不清就写「看不清」，不要猜。
- 播放、点赞、评论等数据，只用下面明确给你的；没给就是不知道，不要编数字。
- 说人话，给明确判断。复刻思路要具体到这条视频，不要泛泛而谈。不写给视频模型的生成提示词。
- 只输出一个 JSON 对象，不要任何别的文字。`;

const SCHEMA = `{
  "title": "报告标题：一句话点出这条视频最抓人的地方，20 字以内",
  "verdict": "值得对标 | 可以参考 | 不建议",
  "summary": "一句话说清它拍了什么：谁，在什么场景，做了什么，结果怎样",
  "hook": {"type": "冲突 | 反常 | 结果前置 | 提问 | 其他", "text": "开头 3 秒具体在干什么"},
  "timeline": [{"t": 秒数, "text": "这一段在干什么，画面里的对白用「」引出来"}],
  "audience": {"who": "谁在看", "why": "为什么看", "comments": "评论区可能在聊什么（推测）"},
  "why": {"data": "数据能说明什么（用户没给数据就写：需要和账号平时的数据对比）", "rhythm": "剪辑节奏和画面信息，静音能不能看懂", "formula": "一句话公式：A + B + C"},
  "advice": {"reason": "一句理由", "swap_test": "换主角测试：把主角和场景换成用户的，还成立吗", "cannot": "借不走的东西", "fit": "适合什么样的账号"},
  "directions": [{
    "name": "方向名，10 字以内",
    "borrow": ["借什么"], "change": ["换什么"],
    "methods": [{"name": "二创手法名", "how": "具体怎么做"}],
    "still": "看过原片的人刷到这条，还能看到什么",
    "topics": [{"title": "选题标题", "methods": "用到的手法", "watch": "发完重点看什么"}],
    "follow": [{"if": "评论区出现……", "then": "下一条做……"}],
    "tips": ["制作时要注意的事，按这条视频的类型给"]
  }]
}`;

function userText(b) {
  const intent = (b.intent || "").trim();
  return [
    `视频：${b.name || "未命名"}，时长 ${b.duration} 秒，画面 ${b.width}×${b.height}。`,
    `一共 ${b.frames} 帧，拼成 ${b.sheets.length} 张图。`,
    dataText(b.meta),
    b.cuts?.length ? `程序估计的剪辑点（秒）：${b.cuts.join("、")}，平均 ${b.avgCut} 秒一切。` : "程序没有检测到明显的镜头切换，可能是一镜到底。",
    intent ? `用户的想法：「${intent}」\n复刻思路只给 1 个方向，完全按用户的想法来写，方向名概括用户想做的事。`
           : "用户没写想法。按这条视频的类型给 2 到 3 个不同的复刻方向。",
    "timeline 写 5 到 9 段，t 用每帧左上角的秒数。topics 每个方向写 3 条，follow 写 2 条，tips 写 2 到 3 条，methods 写 3 条。",
    `按这个格式输出：\n${SCHEMA}`,
  ].join("\n");
}

function dataText(m) {
  if (!m) return "";
  const n = v => (v || v === 0 ? Number(v).toLocaleString("zh-CN") : "");
  const lines = [`来源：${m.platform || ""}${m.uploader ? "，作者 " + m.uploader : ""}${m.date ? "，发布于 " + m.date : ""}`];
  if (m.title) lines.push(`标题：${m.title}`);
  const d = [["播放", m.views], ["点赞", m.likes], ["评论", m.comments], ["作者粉丝", m.followers]].filter(x => x[1]).map(([k, v]) => `${k} ${n(v)}`);
  if (d.length) lines.push("公开数据：" + d.join("，"));
  if (m.baseline) lines.push(`作者最近 ${m.baseline.sample} 条作品的播放中位数约 ${n(m.baseline.median)}，这条是平时的 ${m.baseline.ratio} 倍。`);
  if (m.topComments?.length) lines.push("点赞最多的评论：\n" + m.topComments.slice(0, 15).map(c => `- ${c.likes} 赞：${c.text}`).join("\n"));
  return lines.join("\n") + "\n写受众和为什么能火时，用上这些真实数据和评论。";
}

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

function firstJSON(text) {
  const s = String(text || ""), i = s.indexOf("{");
  if (i < 0) throw new Error("回复里没有 JSON");
  let depth = 0, inStr = false, esc = false;
  for (let j = i; j < s.length; j++) {
    const c = s[j];
    if (inStr) { if (esc) esc = false; else if (c === "\\") esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return JSON.parse(s.slice(i, j + 1));
  }
  throw new Error("JSON 不完整");
}

async function callModel(key, messages) {
  const waits = [20, 40, 80];
  let timeouts = 0;
  for (let attempt = 0; ; attempt++) {
    // 同时拆好几条时模型会排队，单次最多等 7 分钟；超时再试一次
    const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), 420_000);
    let r;
    try {
      r = await fetch(ENDPOINT, { method: "POST", signal: ctl.signal,
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: MODEL, temperature: 0.3, ...EXTRA, messages }) });
    } catch (e) {
      if (e.name === "AbortError" && timeouts++ < 1) continue;
      throw Object.assign(new Error(e.name === "AbortError" ? "模型太久没回复，可能是人多在排队，稍后再试" : "连不上模型服务"), { status: 504 });
    } finally { clearTimeout(timer); }
    if (r.status === 429 && attempt < waits.length) { await new Promise(res => setTimeout(res, waits[attempt] * 1000)); continue; }
    const text = await r.text();
    if (!r.ok) {
      const msg = { 401: "Key 无效，请检查后重新填写", 402: "这个 Key 的余额不足", 403: "这个 Key 没有这个模型的权限",
                    429: "现在人多，排队超时了，过一两分钟再试" }[r.status] || `模型服务返回 ${r.status}`;
      throw Object.assign(new Error(msg), { status: r.status });
    }
    const j = JSON.parse(text);
    return j.choices?.[0]?.message?.content || "";
  }
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
  if (!Array.isArray(b.sheets) || !b.sheets.length || b.sheets.length > 6 || !b.sheets.every(s => /^data:image\/jpeg;base64,/.test(s)))
    return send(res, 400, { error: "抽帧数据不完整，重新上传视频试试" });
  const userKey = String(req.headers["x-user-key"] || "").trim();
  const key = userKey || SERVER_KEY;
  if (!key) return send(res, 401, { error: "还没有 API Key，点右上角「设置 API Key」填你自己的" });
  const ip = String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();
  if (!userKey && !useQuota(ip)) return send(res, 429, { error: `今天的免费次数（${FREE_RUNS} 次）用完了，可以在右上角填你自己的 Key 继续用` });

  const content = [...b.sheets.map(url => ({ type: "image_url", image_url: { url } })), { type: "text", text: userText(b) }];
  const messages = [{ role: "system", content: SYSTEM }, { role: "user", content }];
  try {
    let reply = await callModel(key, messages), report;
    try { report = firstJSON(reply); }
    catch (e) {
      // 格式坏了：把原回复和报错还给它，让它自己改一次
      messages.push({ role: "assistant", content: reply.slice(-8000) },
                    { role: "user", content: `你的回复没法解析成 JSON（${e.message}）。只输出修正后的完整 JSON，不要别的文字。` });
      reply = await callModel(key, messages);
      report = firstJSON(reply);
    }
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
