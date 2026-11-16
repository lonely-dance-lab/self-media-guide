import { analyzeFrames, DEFAULT_ENDPOINT, DEFAULT_MODEL, hasFrames, MAX_BODY } from "./analysis.mjs";

function json(body, status = 200) {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

async function readBody(request) {
  const reader = request.body?.getReader();
  if (!reader) return null;
  const decoder = new TextDecoder();
  const parts = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY) {
        await reader.cancel();
        throw Object.assign(new Error("视频画面太多了，换一条短一点的试试"), { status: 413 });
      }
      parts.push(decoder.decode(value, { stream: true }));
    }
    parts.push(decoder.decode());
    return JSON.parse(parts.join(""));
  } finally {
    reader.releaseLock();
  }
}

async function analyze(request, env) {
  const key = request.headers.get("X-User-Key")?.trim();
  if (!key) return json({ error: "还没有 API Key，点右上角「设置 API Key」填你自己的" }, 401);

  let body;
  try {
    body = await readBody(request);
  } catch (error) {
    if (error.status === 413) return json({ error: error.message }, 413);
    return json({ error: "请求格式不对，刷新页面再试" }, 400);
  }
  if (!hasFrames(body)) return json({ error: "抽帧数据不完整，重新上传视频试试" }, 400);

  try {
    const report = await analyzeFrames(body, key, {
      endpoint: env.MODEL_ENDPOINT || DEFAULT_ENDPOINT,
      model: env.MODEL_NAME || DEFAULT_MODEL,
      disableThinking: env.DISABLE_THINKING === "1",
    });
    return json({ report });
  } catch (error) {
    const status = error.status >= 400 && error.status < 600 ? error.status : 502;
    return json({ error: status === 502 ? "分析失败了，再试一次" : error.message }, status);
  }
}

// 设了 CF_BEACON_TOKEN 才在首页加 Cloudflare 访问统计，自己部署不设就没有
async function page(request, env) {
  const res = await env.ASSETS.fetch(request);
  const token = env.CF_BEACON_TOKEN;
  if (!token || !(res.headers.get("Content-Type") || "").includes("text/html")) return res;
  const tag = `<script defer src="https://static.cloudflareinsights.com/beacon.min.js" data-cf-beacon='${JSON.stringify({ token })}'></script>`;
  return new HTMLRewriter().on("body", { element(el) { el.append(tag, { html: true }); } }).transform(res);
}

export default {
  fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (request.method === "GET" && (pathname === "/" || pathname === "/index.html")) return page(request, env);
    if (request.method === "GET" && pathname === "/api/config") {
      return json({ serverKey: false, freeRuns: 0, link: false });
    }
    if (request.method === "POST" && pathname === "/api/analyze") return analyze(request, env);
    if (request.method === "POST" && pathname === "/api/fetch") {
      return json({ error: "在线版只支持上传视频，自己部署后可以贴链接" }, 403);
    }
    return json({ error: "not found" }, 404);
  },
};
