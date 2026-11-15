"use strict";
const $ = (s, el = document) => el.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const fmt = s => { s = Math.round(Math.max(0, s) * 10) / 10; const m = Math.floor(s / 60), r = s - m * 60; return `${String(m).padStart(2, "0")}:${(r < 10 ? "0" : "") + r.toFixed(r % 1 ? 1 : 0)}`; };
const big = v => { v = Number(v) || 0; return v >= 1e8 ? (v / 1e8).toFixed(1) + "亿" : v >= 1e4 ? (v / 1e4).toFixed(1) + "万" : String(v); };
const list = a => (Array.isArray(a) ? a : a ? [a] : []);
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const ago = ts => { const s = (Date.now() - ts) / 1000; return s < 60 ? "刚刚" : s < 3600 ? `${Math.floor(s / 60)} 分钟前` : s < 86400 ? `${Math.floor(s / 3600)} 小时前` : new Date(ts).toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" }); };

/* ---------------- 状态 ----------------
   task：一次上传。浏览器里抽好的帧都在这里，只存在内存
   run：一次拆解。报告存进历史记录（IndexedDB），刷新也不会丢
   view：右边当前看的是什么 */
const S = {
  tasks: new Map(),
  runs: [],                         // 历史记录，新的在前
  view: { type: "empty" },          // empty | task | run | sample
  tab: "report",                    // report | history
  dirKey: null,
  sampleVM: null,
  config: { link: false },
};
const KEY = { get: () => { try { return sessionStorage.getItem("modelKey") || ""; } catch { return ""; } },
              set: v => { try { v ? sessionStorage.setItem("modelKey", v) : sessionStorage.removeItem("modelKey"); } catch {} } };

/* ---------------- 历史记录：存在浏览器本地 ---------------- */
const DB = (() => {
  let p;
  const open = () => p || (p = new Promise((res, rej) => {
    const r = indexedDB.open("duibiao", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("runs", { keyPath: "id" });
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  }));
  const tx = async (mode, fn) => { const db = await open(); return new Promise((res, rej) => { const t = db.transaction("runs", mode); const out = fn(t.objectStore("runs")); t.oncomplete = () => res(out?.result); t.onerror = () => rej(t.error); }); };
  return {
    all: () => tx("readonly", s => s.getAll()).catch(() => []),
    put: rec => tx("readwrite", s => s.put(rec)).catch(() => {}),
    del: id => tx("readwrite", s => s.delete(id)).catch(() => {}),
    clear: () => tx("readwrite", s => s.clear()).catch(() => {}),
  };
})();
const saveRun = r => DB.put({ id: r.id, name: r.name, created: r.created, intent: r.intent, status: r.status, vm: r.vm || null,
                              error: r.error || "", poster: r.poster || "", seconds: r.seconds || 0 });

/* ---------------- 样例 ---------------- */
function sampleVM(k) {
  const s = window.SAMPLES[k];
  return {
    kind: "sample", key: k, title: s.title, verdict: s.verdict, metrics: s.metrics, lead: s.lead, dur: s.dur,
    timeline: s.timeline.map(([t, img, txt]) => ({ t, img: `/media/t/${k}-${img}.jpg`, html: txt })),
    audience: s.audience, comments: s.comments, why: s.why, hook: s.hook, cuts: s.cuts, advice: s.advice,
    dirs: Object.fromEntries(Object.entries(s.dirs).map(([n, d]) => [n, {
      borrow: d.borrow, change: d.change, methods: d.methods, still: d.still, topics: d.topics, follow: d.follow, tips: d.tips }])),
    file: s.file, poster: s.poster, name: s.name, info: s.info,
  };
}
const hasSamples = () => Object.keys(window.SAMPLES || {}).length > 0;
function renderSamples() {
  // 开源版不带样例视频，没有样例就把这一块藏起来
  $("#samples").parentElement.hidden = !hasSamples();
  if (!hasSamples()) return;
  $("#samples").innerHTML = Object.entries(window.SAMPLES).map(([k, s]) =>
    `<button type="button" class="sample" data-k="${k}" aria-pressed="${S.view.type === "sample" && S.view.id === k}"><img src="${s.poster}" alt=""><span>${esc(s.label)}<small>${esc(s.src)} · ${Math.round(s.dur)} 秒</small></span></button>`).join("");
}

/* ---------------- 抽帧和剪辑点 ---------------- */
function waitEvent(el, ok, ms = 15000) {
  return new Promise((res, rej) => {
    const t = setTimeout(() => { done(); rej(new Error("视频读取超时")); }, ms);
    const h1 = () => { done(); res(); }, h2 = () => { done(); rej(new Error("浏览器读不了这个视频")); };
    const done = () => { clearTimeout(t); el.removeEventListener(ok, h1); el.removeEventListener("error", h2); };
    el.addEventListener(ok, h1); el.addEventListener("error", h2);
  });
}
async function seek(el, t) {
  el.currentTime = Math.min(Math.max(t, 0), Math.max(0, el.duration - 0.05));
  await waitEvent(el, "seeked");
}
function frameCount(dur) { return dur < 8 ? 8 : Math.min(32, Math.ceil(Math.max(16, dur / 2) / 8) * 8); }

async function extract(file, onStep) {
  const url = URL.createObjectURL(file);
  const el = document.createElement("video");
  el.muted = true; el.playsInline = true; el.preload = "auto"; el.src = url;
  await waitEvent(el, "loadeddata", 20000);
  if (!el.videoWidth || !isFinite(el.duration) || el.duration <= 0) throw new Error("读不到画面，试试转成 H.264 编码的 mp4");
  const dur = el.duration, W = el.videoWidth, H = el.videoHeight;
  onStep(0, "done", `时长 ${fmt(dur)}，${H > W * 1.2 ? "竖屏" : W > H * 1.2 ? "横屏" : "方形"} ${W}×${H}`);

  // 抽帧：每帧 640 宽，左上角标时间，每 8 帧拼一张 4×2
  const n = frameCount(dur), span = dur * 0.95, fw = 640, fh = Math.round(640 * H / W);
  const frames = [];
  for (let i = 0; i < n; i++) {
    const t = span * (i + 0.5) / n;
    await seek(el, t);
    const c = document.createElement("canvas"); c.width = fw; c.height = fh;
    const g = c.getContext("2d"); g.drawImage(el, 0, 0, fw, fh);
    const label = `${t.toFixed(1)}s`;
    g.font = "bold 30px -apple-system, Helvetica, Arial, sans-serif";
    const tw = g.measureText(label).width;
    g.fillStyle = "rgba(0,0,0,.68)"; g.fillRect(8, 8, tw + 20, 42);
    g.fillStyle = "#fff"; g.textBaseline = "middle"; g.fillText(label, 18, 30);
    const th = document.createElement("canvas"); th.width = 160; th.height = Math.round(160 * fh / fw);
    th.getContext("2d").drawImage(c, 0, 0, th.width, th.height);
    frames.push({ t, canvas: c, thumb: th.toDataURL("image/jpeg", 0.7) });
    onStep(1, "doing", `已抽 ${i + 1} / ${n} 帧`);
  }
  const sheets = [];
  for (let i = 0; i < n; i += 8) {
    const group = frames.slice(i, i + 8), cols = 4, rows = Math.ceil(group.length / cols), gap = 4;
    const c = document.createElement("canvas"); c.width = cols * fw + (cols - 1) * gap; c.height = rows * fh + (rows - 1) * gap;
    const g = c.getContext("2d"); g.fillStyle = "#111"; g.fillRect(0, 0, c.width, c.height);
    group.forEach((f, j) => g.drawImage(f.canvas, (j % cols) * (fw + gap), Math.floor(j / cols) * (fh + gap)));
    sheets.push(c.toDataURL("image/jpeg", 0.82));
  }
  frames.forEach(f => delete f.canvas);
  onStep(1, "done", `<b>${n}</b> 帧，${sheets.length} 张拼图，每帧带时间`);

  // 剪辑点：按固定间隔取小图，比较画面中间区域的差异
  const rate = dur <= 30 ? 4 : dur <= 120 ? 2 : 1, step = 1 / rate;
  const sw = 48, sh = 48, sc = document.createElement("canvas"); sc.width = sw; sc.height = sh;
  const sg = sc.getContext("2d", { willReadFrequently: true });
  let prev = null; const diffs = [];
  for (let t = 0; t < dur * 0.98; t += step) {
    await seek(el, t);
    sg.drawImage(el, W * 0.05, H * 0.2, W * 0.9, H * 0.6, 0, 0, sw, sh);
    const d = sg.getImageData(0, 0, sw, sh).data, gray = new Float32Array(sw * sh);
    for (let p = 0; p < gray.length; p++) gray[p] = d[p * 4] * 0.3 + d[p * 4 + 1] * 0.59 + d[p * 4 + 2] * 0.11;
    if (prev) { let s = 0; for (let p = 0; p < gray.length; p++) s += Math.abs(gray[p] - prev[p]); diffs.push({ t, v: s / gray.length }); }
    prev = gray;
    if (diffs.length % 10 === 0) onStep(2, "doing", `已检查到 ${fmt(t)}`);
  }
  // 画面差异（0–255）：一镜到底的动作一般在 16 以下，切镜头通常在 25 以上，快剪会到 60 以上
  const cuts = [];
  diffs.forEach(({ t, v }, i) => {
    const peak = v >= (diffs[i - 1]?.v ?? 0) && v >= (diffs[i + 1]?.v ?? 0);
    if ((v > 45 || (v > 24 && peak)) && (!cuts.length || t - cuts[cuts.length - 1] > 0.4)) cuts.push(Math.round(t * 10) / 10);
  });
  const avg = Math.round(dur / (cuts.length + 1) * 10) / 10;
  onStep(2, "done", cuts.length ? `估计 <b>${cuts.length}</b> 处，平均 <b>${avg}</b> 秒一切` : "没有明显切换，可能是一镜到底");
  return { url, dur, W, H, n, frames, sheets, cuts, avg, name: file.name };
}

/* ---------------- 上传：每次上传是一个新任务，不影响正在拆的 ---------------- */
async function handleFile(file, task = null) {
  if (!file) return;
  if (!task) {
    if (!/^video\//.test(file.type) && !/\.(mp4|mov|m4v|webm)$/i.test(file.name)) return toast("请上传视频文件（MP4、MOV、WebM）");
    if (file.size > 500 * 1024 * 1024) return toast("视频太大了，先剪一段 3 分钟以内的再来");
    task = { id: uid(), name: file.name, status: "preparing", local: null, error: "", meta: null,
             steps: [["读取视频", "…", "doing"], ["抽帧", "", "todo"], ["剪辑点", "", "todo"]] };
    S.tasks.set(task.id, task);
    show({ type: "task", id: task.id });
  }
  task.url = URL.createObjectURL(file);
  if (isView("task", task.id)) render();
  const off = task.steps.length - 3;  // 贴链接时前面多了一步「读取链接」
  try {
    task.local = await extract(file, (i, st, txt) => {
      const k = i + off;
      task.steps[k] = [task.steps[k][0], txt, st];
      if (st === "done" && task.steps[k + 1]) task.steps[k + 1][2] = "doing";
      if (isView("task", task.id)) renderSteps();
    });
    task.status = "ready";
  } catch (e) {
    task.status = "error"; task.error = e.message || "处理视频时出错了";
  }
  if (isView("task", task.id)) render();
}

/* ---------------- 贴链接：服务器下载，回到浏览器里抽帧 ---------------- */
async function handleLink(url) {
  const task = { id: uid(), name: url, status: "preparing", local: null, error: "", meta: null,
                 steps: [["读取链接", "正在读数据、下载视频，可能要几十秒", "doing"], ["下载视频", "", "todo"], ["抽帧", "", "todo"], ["剪辑点", "", "todo"]] };
  S.tasks.set(task.id, task);
  show({ type: "task", id: task.id });
  try {
    const r = await fetch("/api/fetch", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || `读取失败（${r.status}）`);
    const m = j.meta || {};
    task.name = j.name; task.meta = m;
    const n = v => (v ? Number(v).toLocaleString("zh-CN") : "");
    task.steps[0] = ["读取链接", [m.platform, m.views && `播放 ${n(m.views)}`, m.likes && `点赞 ${n(m.likes)}`, m.topComments?.length && `评论 ${m.topComments.length} 条`].filter(Boolean).join(" · "), "done"];
    task.steps[1][2] = "doing";
    if (isView("task", task.id)) render();
    const blob = await (await fetch(j.file)).blob();
    await handleFile(new File([blob], `${j.name}.mp4`, { type: "video/mp4" }), task);
  } catch (e) {
    task.status = "error"; task.error = e.message || "读取链接出错";
    if (isView("task", task.id)) render();
  }
}

/* ---------------- 拆解：每次拆解是一条记录，后台跑，跑完进历史 ---------------- */
async function analyze(task) {
  const L = task.local; if (!L) return;
  const intent = $("#ctx").value.trim();
  const run = { id: uid(), taskId: task.id, name: task.name, created: Date.now(), intent, status: "running",
                poster: L.frames[Math.min(1, L.frames.length - 1)]?.thumb || "", started: Date.now() };
  S.runs.unshift(run); saveRun(run);
  show({ type: "run", id: run.id });
  try {
    const headers = { "Content-Type": "application/json" };
    if (KEY.get()) headers["X-User-Key"] = KEY.get();
    const body = { intent, name: L.name, duration: Math.round(L.dur * 10) / 10, width: L.W, height: L.H,
                   frames: L.n, cuts: L.cuts, avgCut: L.avg, sheets: L.sheets, meta: task.meta || null };
    const r = await fetch("/api/analyze", { method: "POST", headers, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.report) throw new Error(j.error || `请求失败（${r.status}）`);
    run.vm = reportVM(j.report, L, intent, task.meta);
    run.status = "done";
  } catch (e) {
    run.status = "error"; run.error = e.message || "拆解失败了";
  }
  run.seconds = Math.round((Date.now() - run.started) / 1000);
  saveRun(run);
  if (isView("run", run.id)) { S.dirKey = null; render(); }
  else { renderTabs(); toast(run.status === "done" ? `「${run.name}」拆好了，在历史记录里` : `「${run.name}」没拆成：${run.error}`); }
}

function reportVM(r, L, intent, M = null) {
  const near = t => L.frames.reduce((p, f) => Math.abs(f.t - t) < Math.abs(p.t - t) ? f : p, L.frames[0]).thumb;
  const v = String(r.verdict || "可以参考");
  const cls = v.includes("值得") ? "go" : v.includes("不建议") ? "no" : "maybe";
  const dirs = {};
  list(r.directions).slice(0, 3).forEach((d, i) => {
    dirs[d.name || `方向 ${i + 1}`] = {
      borrow: list(d.borrow), change: list(d.change),
      methods: list(d.methods).map(m => [m.name || m.method || "", m.how || ""]),
      still: d.still || "", topics: list(d.topics).map(t => [t.title || "", t.methods || "", t.watch || ""]),
      follow: list(d.follow).map(f => [f.if || f.when || "", f.then || ""]), tips: list(d.tips),
    };
  });
  const hook = r.hook || {};
  return {
    kind: "local", title: r.title || "拆解报告", verdict: [v, cls], dur: L.dur, lead: r.summary || "",
    metrics: M && (M.views || M.likes) ? [
      ...(M.views ? [["播放", big(M.views), M.platform || ""]] : []),
      ...(M.likes ? [["点赞", big(M.likes), M.followers ? `赞粉比 ${(M.likes / M.followers).toFixed(2)}` : ""]] : []),
      ...(M.baseline ? [["比平时", `${M.baseline.ratio}×`, `账号平时播放约 ${big(M.baseline.median)}`, true]] : []),
      ["剪辑", L.cuts.length ? `约 ${L.cuts.length} 处` : "0 处", L.cuts.length ? `平均 ${L.avg} 秒一切` : "一镜到底", !M.baseline],
      ["时长", `${Math.round(L.dur)} 秒`, hook.type ? `开头：${hook.type}` : ""]] :
    [["时长", `${Math.round(L.dur)} 秒`, L.H > L.W * 1.2 ? "竖屏" : L.W > L.H * 1.2 ? "横屏" : "方形"],
              ["抽帧", `${L.n} 帧`, `约 ${(L.dur * 0.95 / L.n).toFixed(1)} 秒一帧`],
              ["剪辑", L.cuts.length ? `约 ${L.cuts.length} 处` : "0 处", L.cuts.length ? `平均 ${L.avg} 秒一切` : "一镜到底", true],
              ["开头钩子", hook.type || "—", ""]],
    timeline: list(r.timeline).map(x => ({ t: Number(x.t) || 0, img: near(Number(x.t) || 0), html: esc(x.text || "").replace(/「([^」]+)」/g, "<q>$1</q>") })),
    audience: [["谁在看", r.audience?.who || ""], ["为什么看", r.audience?.why || ""], ["评论区可能在聊", r.audience?.comments || ""]].filter(x => x[1]),
    comments: (M?.topComments || []).slice(0, 4).map(c => [`${c.likes} 赞`, c.text]),
    why: [["数据信号", r.why?.data || "本地视频读不到播放和点赞，可以在第 2 步写上"], ["开头 3 秒", (hook.type ? `【${esc(hook.type)}】` : "") + esc(hook.text || "")],
          ["节奏", esc(r.why?.rhythm || "")], ["一句话", `<b>${esc(r.why?.formula || "")}</b>`]].filter(x => x[1]),
    hook: 3, cuts: L.cuts,
    advice: [["结论", `${v}。${r.advice?.reason || ""}`], ["换主角测试", r.advice?.swap_test || ""], ["借不走的", r.advice?.cannot || ""], ["适合谁", r.advice?.fit || ""]].filter(x => x[1]),
    dirs, intent,
  };
}

/* ---------------- 视图 ---------------- */
const isView = (type, id) => S.view.type === type && S.view.id === id;
const curTask = () => S.view.type === "task" ? S.tasks.get(S.view.id)
                    : S.view.type === "run" ? S.tasks.get(curRun()?.taskId) : null;
const curRun = () => S.view.type === "run" ? S.runs.find(r => r.id === S.view.id) : null;
function show(view) { S.view = view; S.tab = "report"; S.dirKey = null; render(); window.scrollTo({ top: 0, behavior: "smooth" }); }

function toast(msg) {
  let t = $("#toast");
  if (!t) { t = document.createElement("div"); t.id = "toast"; document.body.appendChild(t); }
  t.textContent = msg; t.className = "show";
  clearTimeout(toast.timer); toast.timer = setTimeout(() => { t.className = ""; }, 3200);
}

function renderSteps() {
  const el = $("#steps"), task = curTask(), run = curRun();
  let steps = task ? task.steps.slice() : [];
  if (task?.status === "ready" && !run) steps.push(["AI 看图", "等你点开始", "todo"]);
  if (run) {
    steps.push(run.status === "running" ? ["AI 看图", "已发送，正在看画面", "doing"]
             : run.status === "done" ? ["AI 看图", `用时 ${run.seconds} 秒`, "done"] : ["AI 看图", "没完成", "warn"]);
  }
  el.hidden = !steps.length;
  el.innerHTML = steps.map(([a, b, c]) => `<li class="${c === "done" ? "" : c}"><span><b style="font-family:inherit">${a}</b>${b ? "：" + b : ""}</span></li>`).join("");
}

function renderTabs() {
  const running = S.runs.filter(r => r.status === "running").length;
  $("#tabs").hidden = false;
  $("#tabs").innerHTML = `<button type="button" role="tab" data-tab="report" aria-selected="${S.tab === "report"}">拆解报告</button>
    <button type="button" role="tab" data-tab="history" aria-selected="${S.tab === "history"}">历史记录${S.runs.length ? ` · ${S.runs.length}` : ""}${running ? ` <span class="running-dot">${running} 个正在拆</span>` : ""}</button>`;
}

function renderLeft() {
  const task = curTask(), run = curRun(), v = $("#video");
  const sample = S.view.type === "sample" ? window.SAMPLES[S.view.id] : null;
  const hasMedia = task || sample || run;
  $("#mode-file").classList.toggle("big", !hasMedia);
  $("#player-wrap").hidden = !hasMedia;
  const src = task?.url || sample?.file || "";
  if (src && v.getAttribute("src") !== src) { v.src = src; }
  if (!src) { v.removeAttribute("src"); v.load(); }
  v.poster = sample?.poster || (!task && run?.poster) || "";
  $("#fname").textContent = task?.name || sample?.name || run?.name || "";
  $("#finfo").textContent = sample ? sample.info : task?.local ? `${fmt(task.local.dur)} · ${task.local.H > task.local.W * 1.2 ? "竖屏" : task.local.W > task.local.H * 1.2 ? "横屏" : "方形"} · ${task.meta ? task.meta.platform + (task.meta.uploader ? " · " + task.meta.uploader : "") : "本地文件"}`
    : task ? "处理中…" : run ? "原视频没有保存，重新上传后可以播放" : "";
  if (run && run.intent && !$("#ctx").dataset.touched) { $("#ctx").value = run.intent; $("#count").textContent = `${run.intent.length} / 800`; }

  const btn = $("#run"), label = btn.firstElementChild;
  const ready = task?.status === "ready";
  btn.disabled = !ready || run?.status === "running";
  label.textContent = run?.status === "running" ? "AI 正在拆这条视频…"
    : task?.status === "preparing" ? "正在处理视频…"
    : ready && run ? "按新想法再拆一次"
    : ready ? "开始拆这条视频"
    : run ? "重新上传视频，可以再拆"
    : "先放一条视频";
  renderSteps();
}

function render() {
  renderSamples(); renderTabs(); renderLeft();
  if (S.tab === "history") return renderHistory();
  const P = $("#panel"), T = $("#rtitle"), V = $("#verdict");
  const setHead = (t, v, cls) => { T.textContent = t; V.textContent = v; V.className = "verdict v-" + cls; };
  const errBox = msg => `<div class="lead" style="background:var(--no-bg);margin-bottom:16px"><p style="font-family:inherit;font-size:15px;color:var(--no)">${esc(msg)}</p></div>`;

  if (S.view.type === "sample") return renderReport(S.sampleVM);
  const run = curRun(), task = curTask();
  if (run?.status === "done") return renderReport(run.vm);
  if (run?.status === "running") {
    const L = task?.local;
    setHead("AI 正在看这条视频", "拆解中", "maybe");
    P.innerHTML = `<div class="sec"><div class="sec-h"><i>进度</i><h3 id="elapsed">已经 ${Math.round((Date.now() - run.started) / 1000)} 秒</h3></div>
      <div class="live">已发送 ${L ? `${L.sheets.length} 张拼图（${L.n} 帧）` : "画面"}${run.intent ? "和你写的想法" : ""}<br>正在读画面里的字幕和剧情，一般要 20 到 90 秒<br>可以先上传下一条视频，这条拆完会自动进历史记录</div></div>
      <div class="skel"><div class="h"></div><div class="w8"></div><div></div><div class="w6"></div><div class="h"></div><div class="w8"></div><div class="w6"></div><div class="h"></div><div></div><div class="w8"></div></div>`;
    return;
  }
  if (run?.status === "error") {
    setHead("这次没拆成", "出错了", "no");
    P.innerHTML = errBox(run.error) + (task?.local ? `<p class="t">视频还在，改一下想法或者稍等一会儿，再点左边的按钮重新拆。</p>` : `<p class="t">重新上传这条视频，就可以再拆一次。</p>`);
    return;
  }
  if (S.view.type === "task" && task) {
    if (task.status === "error") { setHead("这条视频读不了", "出错了", "no"); P.innerHTML = errBox(task.error); return; }
    if (task.status === "preparing") {
      setHead("正在处理视频", "处理中", "maybe");
      P.innerHTML = `<div class="live">在你的浏览器里抽帧、估计剪辑点，视频不会上传。长一点的视频要十几秒。</div><div class="skel"><div class="h"></div><div class="w8"></div><div></div><div class="w6"></div></div>`;
      return;
    }
    const L = task.local, pct = t => (t / L.dur * 100).toFixed(2);
    const bar = `<div class="cutbar"><div class="hook" style="width:${pct(Math.min(3, L.dur))}%"></div>${L.cuts.map(c => `<span style="left:${pct(c)}%" data-t="${c}" title="${fmt(c)}"></span>`).join("")}</div><div class="cutaxis"><span>00:00</span><span>${fmt(L.dur / 2)}</span><span>${fmt(L.dur)}</span></div>`;
    const pick = L.frames.filter((_, i) => i % Math.max(1, Math.round(L.n / 16)) === 0).slice(0, 16);
    setHead("视频准备好了，写下你想做什么，就可以开始", "待拆解", "maybe");
    P.innerHTML = `<div class="metrics"><div class="metric"><small>时长</small><b>${Math.round(L.dur)} 秒</b><em>${L.W}×${L.H}</em></div><div class="metric"><small>抽帧</small><b>${L.n} 帧</b><em>${L.sheets.length} 张拼图</em></div><div class="metric hot"><small>剪辑</small><b>${L.cuts.length ? "约 " + L.cuts.length + " 处" : "0 处"}</b><em>${L.cuts.length ? "平均 " + L.avg + " 秒一切" : "一镜到底"}</em></div><div class="metric"><small>播放 / 点赞</small><b>${task.meta?.views ? big(task.meta.views) : "待补"}</b><em>${task.meta?.likes ? "点赞 " + big(task.meta.likes) : task.meta ? "没读到" : "本地视频读不到"}</em></div></div>
      <div class="sec"><div class="sec-h"><i>预览</i><h3>AI 会看到的画面</h3></div><p class="t">这是从你的视频里抽出的一部分画面，字幕要看得清，分析才准。</p><div class="frames">${pick.map(f => `<div><img src="${f.thumb}" alt=""><span>${f.t.toFixed(1)}s</span></div>`).join("")}</div></div>
      <div class="sec"><div class="sec-h"><i>节奏</i><h3>剪辑点</h3></div>${bar}</div>
      <div class="empty-cta"><span>左边第 2 步写得越具体，报告越贴近你的账号。也可以顺手写上这条视频的播放、点赞。</span></div>`;
    return;
  }
  setHead("放一条视频进来，报告会出现在这里", "等待上传", "maybe");
  P.innerHTML = `
    <p class="t" style="font-size:15px;max-width:60ch">AI 会看完整条视频的画面，读出里面的字幕和剧情，再结合你在第 2 步写的想法，给你一份这样的报告：</p>
    <div class="ghosts">
      <div class="ghost"><i>01</i><b>内容总结</b><p>一句话说清它拍了什么，再按时间线分段，点时间就能跳到那一秒</p></div>
      <div class="ghost"><i>02</i><b>受众</b><p>谁在看、为什么看、评论区可能在聊什么</p></div>
      <div class="ghost"><i>03</i><b>为什么能火</b><p>开头 3 秒、剪辑节奏，以及一张剪辑点时间条</p></div>
      <div class="ghost"><i>04</i><b>对标建议</b><p>值不值得对标、换个主角还成不成立、哪些东西借不走</p></div>
      <div class="ghost"><i>05</i><b>复刻思路</b><p>按你想做的内容，借什么、换什么、用哪几种二创手法</p></div>
      <div class="ghost"><i>06</i><b>第一批三条选题</b><p>每条怎么做、发完看什么，评论区出现什么就接什么</p></div>
      <div class="ghost"><i>07</i><b>制作提醒</b><p>做之前要注意的几件事，最后可以下载 Markdown</p></div>
    </div>
    <div class="empty-cta"><span>${hasSamples() ? "还没有视频？点左边任意一个样例，先看一份完整的报告。" : "上传一条你想参考的视频，就能开始拆。"}</span><span style="font:12px var(--mono);color:var(--muted)">拆过的报告都在「历史记录」里</span></div>`;
}

function renderHistory() {
  $("#rtitle").textContent = "历史记录";
  $("#verdict").textContent = `${S.runs.length} 条`; $("#verdict").className = "verdict v-maybe";
  const badge = r => r.status === "running" ? `<span class="hstat run">拆解中 · ${Math.round((Date.now() - r.started) / 1000)} 秒</span>`
    : r.status === "error" ? `<span class="hstat err">没拆成</span>`
    : `<span class="hstat v-${r.vm?.verdict?.[1] || "maybe"}">${esc(r.vm?.verdict?.[0] || "完成")}</span>`;
  $("#panel").innerHTML = S.runs.length ? `
    <p class="t">每次拆解都会存在这台电脑的浏览器里，刷新也不会丢。原视频不保存，报告和缩略图都在。</p>
    <div class="hist">${S.runs.map(r => `
      <div class="hrow" data-run="${r.id}" tabindex="0" role="button">
        <img src="${r.poster || ""}" alt="">
        <div><b>${esc(r.vm?.title || r.name)}</b>
          <p>${esc(r.name)} · ${ago(r.created)}${r.seconds ? ` · 用时 ${r.seconds} 秒` : ""}</p>
          ${r.intent ? `<p class="hint">想法：${esc(r.intent.slice(0, 50))}${r.intent.length > 50 ? "…" : ""}</p>` : ""}
          ${r.status === "error" ? `<p class="hint" style="color:var(--no)">${esc(r.error)}</p>` : ""}
        </div>
        <div class="hside">${badge(r)}${r.status !== "running" ? `<button type="button" class="hdel" data-del="${r.id}" aria-label="删除这条">删除</button>` : ""}</div>
      </div>`).join("")}</div>
    <div class="foot"><p>只存在这台电脑的这个浏览器里，换电脑或清理浏览器数据就没了。</p><button class="btn" type="button" id="hclear">清空历史</button></div>`
    : `<div class="empty-cta"><span>还没有拆过视频。上传一条，拆完会自动出现在这里。</span></div>`;
}

function renderReport(s) {
  if (!S.dirKey || !s.dirs[S.dirKey]) S.dirKey = Object.keys(s.dirs)[0];
  const d = s.dirs[S.dirKey] || { borrow: [], change: [], methods: [], still: "", topics: [], follow: [], tips: [] };
  $("#rtitle").textContent = s.title;
  $("#verdict").textContent = s.verdict[0]; $("#verdict").className = "verdict v-" + s.verdict[1];
  const pct = t => (t / s.dur * 100).toFixed(2);
  const dirNames = Object.keys(s.dirs);
  const dirIntro = s.kind === "local" && s.intent ? `按你在第 2 步写的想法来：<b>${esc(s.intent.slice(0, 60))}${s.intent.length > 60 ? "…" : ""}</b>`
    : "你在第 2 步没写想做什么，先按这条视频的类型给几个方向，点一下换。写了的话，这里会直接按你说的来。";
  $("#panel").innerHTML = `
    <div class="metrics">${s.metrics.map(([k, v, e, hot]) => `<div class="metric ${hot ? "hot" : ""}"><small>${k}</small><b>${esc(v)}</b>${e ? `<em>${esc(e)}</em>` : ""}</div>`).join("")}</div>
    <div class="sec"><div class="sec-h"><i>01</i><h3>内容总结</h3></div>
      <div class="lead"><p>${esc(s.lead)}</p></div>
      <div class="timeline">${s.timeline.map(x => `<div class="tl"><button class="time" data-t="${x.t}">${fmt(x.t)}</button><img src="${x.img}" alt="" loading="lazy"><p>${x.html}</p></div>`).join("")}</div>
    </div>
    <div class="sec"><div class="sec-h"><i>02</i><h3>受众</h3></div>
      <dl class="kv">${s.audience.map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join("")}</dl>
      ${s.comments.length ? `<div class="quotes">${s.comments.map(([n, c]) => `<div class="quote"><b>${n}</b><span>${esc(c)}</span></div>`).join("")}</div>` : ""}
    </div>
    <div class="sec"><div class="sec-h"><i>03</i><h3>为什么能火</h3></div>
      <dl class="kv">${s.why.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("")}</dl>
      <p class="t" style="margin-top:14px"><span class="pill">剪辑点</span>${s.cuts.length ? "每条竖线是一次切换，点击可以跳到那一秒；黄色是开头 3 秒" : "没有检测到切换，一镜到底；黄色是开头 3 秒"}</p>
      <div class="cutbar"><div class="hook" style="width:${pct(Math.min(s.hook, s.dur))}%"></div>${s.cuts.map(c => `<span style="left:${pct(c)}%" data-t="${c}" title="${fmt(c)}"></span>`).join("")}</div>
      <div class="cutaxis"><span>00:00</span><span>${fmt(s.dur / 2)}</span><span>${fmt(s.dur)}</span></div>
    </div>
    <div class="sec"><div class="sec-h"><i>04</i><h3>对标建议</h3></div>
      <dl class="kv">${s.advice.map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join("")}</dl>
    </div>
    <div class="sec"><div class="sec-h"><i>05</i><h3>复刻思路</h3></div>
      <p class="t">${dirIntro}</p>
      ${dirNames.length > 1 ? `<div class="dirs">${dirNames.map(k => `<button type="button" class="dir" data-dir="${esc(k)}" aria-pressed="${k === S.dirKey}">${esc(k)}</button>`).join("")}</div>` : ""}
      <div class="cols"><div class="col"><h4>借什么</h4><ul>${d.borrow.map(x => `<li>${esc(x)}</li>`).join("")}</ul></div><div class="col"><h4>换什么</h4><ul>${d.change.map(x => `<li>${esc(x)}</li>`).join("")}</ul></div></div>
      <div class="methods">${d.methods.map(([m, h]) => `<div class="method"><b>${esc(m)}</b><span>${esc(h)}</span></div>`).join("")}</div>
      ${d.still ? `<div class="still"><b>看过原片的人刷到你这条，还能看到：</b>${esc(d.still)}</div>` : ""}
    </div>
    <div class="sec"><div class="sec-h"><i>06</i><h3>第一批三条选题</h3></div>
      <div class="topics">${d.topics.map(([t, m, w], i) => `<div class="topic"><span class="n">0${i + 1}</span><h4>${esc(t)}</h4>${m ? `<p>手法：${esc(m)}</p>` : ""}${w ? `<p>发完看：${esc(w)}</p>` : ""}</div>`).join("")}</div>
      <div class="followups">${d.follow.map(([a, b]) => `<div><span>${esc(a)}，${esc(b)}</span></div>`).join("")}</div>
    </div>
    <div class="sec"><div class="sec-h"><i>07</i><h3>制作提醒</h3></div>
      <ul class="tips">${d.tips.map(x => `<li>${esc(x)}</li>`).join("")}</ul>
    </div>
    <div class="foot"><p>${s.kind === "sample" ? "这是样例报告。上传你自己的视频，会按同样的结构拆。" : "报告由 AI 看抽帧画面生成，数据以你提供的为准，仅供参考。"}</p><button class="btn" type="button" id="dl">下载 Markdown</button></div>`;
}

function toMarkdown(s) {
  const d = s.dirs[S.dirKey] || Object.values(s.dirs)[0] || { borrow: [], change: [], methods: [], topics: [], follow: [], tips: [] };
  const strip = h => String(h).replace(/<q>/g, "「").replace(/<\/q>/g, "」").replace(/<[^>]+>/g, "");
  return [`# 对标分析报告 · ${s.title}`, "", `结论：${s.verdict[0]}`, "", "## 内容总结", s.lead, "",
    ...s.timeline.map(x => `- ${fmt(x.t)} ${strip(x.html)}`), "", "## 受众", ...s.audience.map(([k, v]) => `- ${k}：${v}`), "",
    "## 为什么能火", ...s.why.map(([k, v]) => `- ${k}：${strip(v)}`), s.cuts.length ? `- 剪辑点：${s.cuts.map(c => c + "s").join("、")}` : "- 剪辑点：一镜到底", "",
    "## 对标建议", ...s.advice.map(([k, v]) => `- ${k}：${v}`), "", `## 复刻思路 · ${S.dirKey || ""}`,
    `- 借什么：${d.borrow.join("、")}`, `- 换什么：${d.change.join("、")}`, ...d.methods.map(([m, h]) => `- ${m}：${h}`), d.still ? `- 看过原片的人还能看到：${d.still}` : "", "",
    "## 第一批三条选题", ...d.topics.map(([t, m, w], i) => `${i + 1}. ${t}${m ? `（${m}）` : ""}${w ? ` 发完看：${w}` : ""}`), ...d.follow.map(([a, b]) => `- ${a}，${b}`), "",
    "## 制作提醒", ...d.tips.map(x => `- ${x}`)].join("\n");
}

/* ---------------- 事件 ---------------- */
document.addEventListener("click", e => {
  const smp = e.target.closest(".sample");
  if (smp) { S.sampleVM = sampleVM(smp.dataset.k); show({ type: "sample", id: smp.dataset.k }); return; }
  const tab = e.target.closest("[data-tab]");
  if (tab) { S.tab = tab.dataset.tab; render(); return; }
  const del = e.target.closest("[data-del]");
  if (del) { e.stopPropagation(); S.runs = S.runs.filter(r => r.id !== del.dataset.del); DB.del(del.dataset.del); if (isView("run", del.dataset.del)) S.view = { type: "empty" }; render(); return; }
  if (e.target.id === "hclear") {
    if (e.target.dataset.sure !== "1") { e.target.dataset.sure = "1"; e.target.textContent = "再点一次确认清空"; return; }
    const keep = S.runs.filter(r => r.status === "running");
    S.runs.filter(r => r.status !== "running").forEach(r => DB.del(r.id)); S.runs = keep;
    if (S.view.type === "run" && !keep.some(r => r.id === S.view.id)) S.view = { type: "empty" };
    render(); return;
  }
  const row = e.target.closest("[data-run]");
  if (row) { $("#ctx").dataset.touched = ""; show({ type: "run", id: row.dataset.run }); return; }
  const dir = e.target.closest(".dir");
  if (dir) { S.dirKey = dir.dataset.dir; renderReport(S.view.type === "sample" ? S.sampleVM : curRun().vm); return; }
  const tm = e.target.closest("[data-t]");
  if (tm) {
    const v = $("#video");
    if (!v.getAttribute("src")) return toast("原视频没有保存，重新上传这条视频就能跳到对应时间");
    v.currentTime = +tm.dataset.t; v.play().catch(() => {}); v.scrollIntoView({ block: "nearest", behavior: "smooth" }); return;
  }
  const mode = e.target.closest("[data-mode]");
  if (mode) { document.querySelectorAll("[data-mode]").forEach(b => b.setAttribute("aria-pressed", b === mode)); $("#mode-file").hidden = mode.dataset.mode !== "file"; $("#mode-link").hidden = mode.dataset.mode !== "link"; return; }
  if (e.target.closest("#run")) { const t = curTask(); if (t) analyze(t); return; }
  if (e.target.id === "dl") {
    const vm = S.view.type === "sample" ? S.sampleVM : curRun()?.vm; if (!vm) return;
    const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(new Blob([toMarkdown(vm)], { type: "text/markdown" })), download: "对标分析报告.md" });
    document.body.appendChild(a); a.click(); a.remove(); return;
  }
});
document.addEventListener("keydown", e => { if (e.key === "Enter" && e.target.matches?.("[data-run]")) e.target.click(); });
$("#file").addEventListener("change", e => { handleFile(e.target.files[0]); e.target.value = ""; });
const drop = $("#mode-file");
["dragenter", "dragover"].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.style.background = "#eceeca"; }));
["dragleave", "drop"].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.style.background = ""; }));
drop.addEventListener("drop", e => handleFile(e.dataTransfer.files[0]));

const ctx = $("#ctx");
ctx.addEventListener("input", () => { ctx.dataset.touched = "1"; $("#count").textContent = `${ctx.value.length} / 800`; });
document.querySelectorAll(".chip").forEach(c => c.addEventListener("click", () => {
  const t = c.dataset.fill, i = t.indexOf("____");
  const pre = ctx.value && !/[，。\n]$/.test(ctx.value) ? "，" : "";
  const start = ctx.value.length + pre.length + i;
  ctx.value += pre + t.replace("____", "");
  ctx.focus(); ctx.setSelectionRange(start, start);
  ctx.dispatchEvent(new Event("input"));
}));

// 正在拆的任务：每秒刷新一下用时
setInterval(() => {
  const run = curRun();
  if (run?.status === "running" && S.tab === "report") { const el = $("#elapsed"); if (el) el.textContent = `已经 ${Math.round((Date.now() - run.started) / 1000)} 秒`; }
  if (S.tab === "history" && S.runs.some(r => r.status === "running")) renderHistory();
}, 1000);

/* ---------------- Key ---------------- */
const dlg = $("#keydlg");
function renderKey() { const has = !!KEY.get(); $("#keylabel").textContent = has ? "使用你的 Key" : "设置 API Key"; $("#lamp").style.background = has ? "#777f22" : "#aaa494"; }
$("#keybtn").onclick = () => { $("#keyinput").value = KEY.get(); dlg.showModal(); };
$("#keycancel").onclick = () => dlg.close();
$("#keyclear").onclick = () => { KEY.set(""); $("#keyinput").value = ""; renderKey(); dlg.close(); };
$("#keyform").addEventListener("submit", () => { KEY.set($("#keyinput").value.trim()); renderKey(); });

$("#linkform").addEventListener("submit", e => {
  e.preventDefault();
  const url = $("#link").value.trim();
  if (!/^https?:\/\//.test(url)) return toast("请贴一个以 http 开头的视频链接");
  $("#link").value = "";
  handleLink(url);
});

/* ---------------- 启动：读出历史记录 ---------------- */
(async () => {
  renderKey(); render();
  try {
    S.config = await (await fetch("/api/config")).json();
    if (S.config.link) {
      $("#link").disabled = false; $("#linkgo").disabled = false;
      $("#linknote").innerHTML = "贴一条视频链接，服务器下载一份只用来分析，24 小时后自动删除。YouTube、X、B 站、TikTok 一般能直接读；小红书、抖音要登录，建议先下载下来再上传。";
    }
  } catch {}
  const rows = await DB.all();
  rows.forEach(r => { if (r.status === "running") { r.status = "error"; r.error = "页面刷新了，这次拆解中断了"; DB.put(r); } });
  S.runs = rows.sort((a, b) => b.created - a.created).concat(S.runs.filter(r => !rows.some(x => x.id === r.id)));
  render();
})();
