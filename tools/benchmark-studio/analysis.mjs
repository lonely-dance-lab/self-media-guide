export const DEFAULT_ENDPOINT = "https://maas-api.antdigital.com/v1/chat/completions";
export const DEFAULT_MODEL = "ling-3.2-flash";
export const MAX_BODY = 20 * 1024 * 1024;

export function hasFrames(body) {
  return Array.isArray(body?.sheets) && body.sheets.length > 0 && body.sheets.length <= 6 &&
    body.sheets.every(sheet => typeof sheet === "string" && sheet.startsWith("data:image/jpeg;base64,"));
}

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

async function callModel(key, messages, { endpoint, model, extra }) {
  const waits = [20, 40, 80];
  let timeouts = 0;
  for (let attempt = 0; ; attempt++) {
    // 同时拆好几条时模型会排队，单次最多等 7 分钟；超时再试一次
    const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), 420_000);
    let r;
    try {
      r = await fetch(endpoint, { method: "POST", signal: ctl.signal,
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model, temperature: 0.3, ...extra, messages }) });
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

export async function analyzeFrames(body, key, { endpoint, model, disableThinking }) {
  const extra = endpoint.includes("antdigital") || disableThinking ? { enable_thinking: false } : {};
  const settings = { endpoint, model, extra };
  const content = [
    ...body.sheets.map(url => ({ type: "image_url", image_url: { url } })),
    { type: "text", text: userText(body) },
  ];
  const messages = [{ role: "system", content: SYSTEM }, { role: "user", content }];
  const reply = await callModel(key, messages, settings);
  try {
    return firstJSON(reply);
  } catch (error) {
    messages.push(
      { role: "assistant", content: reply.slice(-8000) },
      { role: "user", content: `你的回复没法解析成 JSON（${error.message}）。只输出修正后的完整 JSON，不要别的文字。` },
    );
    return firstJSON(await callModel(key, messages, settings));
  }
}
