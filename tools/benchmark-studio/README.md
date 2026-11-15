# 对标研究室

拖进一条爆款视频，写下你想做什么，AI 看完画面，给你一份拆解报告：内容总结、受众、为什么能火、对标建议、复刻思路、三条选题、制作提醒。

上传的视频只在浏览器里处理：抽帧、拼图、估计剪辑点都在你的电脑上完成，发给模型的只有抽出来的画面。自己部署还可以直接贴视频链接。

## 运行

需要 Node.js 22 或更新版本，不用装依赖。

```bash
cd tools/benchmark-studio
export MODEL_API_KEY=你的模型 API Key
node server.mjs
```

打开 http://localhost:4318

没有设置 `MODEL_API_KEY` 也能启动，用户在页面右上角填自己的 Key 就行。

## 用哪个模型

需要一个**能看图**、接口**兼容 OpenAI 格式**的模型。

默认对接蚂蚁数科 MaaS 的 `ling-3.2-flash`：能看图、价格便宜，拆一条一分半的视频大约用 5000 个输入 token。在 [蚂蚁数科模型服务平台](https://maas.antdigital.com) 创建 Key 填进去就能用。

换成其他模型，改这两个环境变量：

```bash
export MODEL_ENDPOINT=https://你的服务地址/v1/chat/completions
export MODEL_NAME=你的模型名
```

## 贴链接分析

自己部署时，只要机器上装了 **yt-dlp** 和 **ffmpeg**，页面上的「粘贴链接」就会自动打开：

```bash
brew install yt-dlp ffmpeg      # macOS
brew upgrade yt-dlp             # 平台经常改版，yt-dlp 要保持最新
```

贴一条链接，服务器会读出播放、点赞、粉丝数，下载一份 720p 以内的视频，再交给浏览器抽帧。YouTube 还会读点赞最多的评论和账号最近作品的播放中位数，报告里「为什么能火」「受众」会用上这些真实数据。下载的视频放在 `.cache/`，24 小时后自动删除。

- YouTube、X、B 站、TikTok 一般能直接读
- 小红书、抖音要登录，可以设 `YTDLP_COOKIES_BROWSER=chrome` 借用浏览器的登录状态，读不到就先下载下来再上传
- 公开的演示站可以设 `DISABLE_LINK=1` 关掉这个功能

## 可选设置

| 环境变量 | 作用 | 默认 |
|---|---|---|
| `PORT` | 端口 | 4318 |
| `MODEL_ENDPOINT` | 模型接口地址 | 蚂蚁数科 MaaS |
| `MODEL_NAME` | 模型名 | ling-3.2-flash |
| `FREE_RUNS` | 用服务器 Key 时，每个 IP 每天能拆几次，0 表示不限 | 0 |
| `DISABLE_LINK` | 设成 `1` 关掉贴链接 | 不设（装了 yt-dlp 和 ffmpeg 就打开） |
| `YTDLP` | yt-dlp 的路径 | yt-dlp |
| `YTDLP_COOKIES_BROWSER` | 读需要登录的平台时借用哪个浏览器的登录状态，比如 chrome | 不设 |
| `DISABLE_THINKING` | 设成 `1`，请求里会带上关闭思考的参数（对接蚂蚁数科时自动带上） | 不设 |

## 文件

- `server.mjs`：提供页面，把抽帧拼图转发给模型，拿回报告 JSON；被限流时自动等待重试；回复格式不对时让模型自己改一次
- `public/app.js`：上传、抽帧（每帧 640 宽、左上角标时间、每 8 帧拼一张）、估计剪辑点、渲染报告、下载 Markdown
- `public/samples.js`：样例报告，默认为空，页面会自动隐藏「试试样例」；想加样例照文件里的说明填
