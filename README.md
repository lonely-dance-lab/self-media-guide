# 自媒体创作不完全指南

我做自媒体时整理的方法、模板、Agent Skill 和网页工具，配套同名系列文章。

核心是二创，不是搬运：**复用的是结构，替换的是内容。**

## 目录

| 文章 | 讲什么 | 这里有什么 |
|---|---|---|
| 如何快速起号 | 找对标、拆结构、二创手法、跑通 MVP | [`01-快速起号/`](01-快速起号/)：方法论、对标表、拆解模板、二创清单<br>[`skills/viral-benchmark/`](skills/viral-benchmark/)：爆款对标分析 Skill |
| [如何拆解一条爆款视频](https://x.com/Lonely__MH/status/2123710962570289446) | 拆开头、结构、拍法、评论，写出自己的拍摄方案 | [`tools/benchmark-studio/`](tools/benchmark-studio/)：对标研究室，拖进视频就出拆解报告的网页工具 |

---

## viral-benchmark · 爆款对标分析

给它一条你想参考的视频，它会帮你把这条视频看懂，告诉你值不值得对标、怎么换成自己的内容，最后交给你一份完整的《对标分析报告》。

**在线视频链接、本地视频、本地文件夹里的多个视频，都可以直接丢给它。**

支持 Claude Code、Codex，以及其他支持 Agent Skills 的 Agent。

### 它能做什么

- **内容总结**：这条视频拍了什么，按时间线分段，带秒数
- **受众分析**：谁在看、为什么看、评论区在问什么
- **为什么能火**：数据信号、开头 3 秒、剪辑点和节奏
- **对标建议**：值得对标 / 可以参考 / 不建议，过不过「换主角测试」
- **复刻思路**：按你想做的内容，给出借什么、换什么、用哪几种二创手法
- **第一批三条选题**：发完看什么数据、评论区出现什么就怎么接下一条
- **制作提醒**：先出样片省积分、转头变脸怎么补、动作对不准怎么办

### 安装

**方式一：一行命令（推荐）**

用 [skills CLI](https://skills.sh) 安装，会自动识别你用的 Agent：

```bash
npx skills add lonely-dance-lab/self-media-guide --skill viral-benchmark -g
```

`-g` 表示装到全局，所有项目都能用。

**方式二：手动复制**

```bash
git clone https://github.com/lonely-dance-lab/self-media-guide.git
cd self-media-guide

# Claude Code
mkdir -p ~/.claude/skills && cp -r skills/viral-benchmark ~/.claude/skills/

# Codex
mkdir -p ~/.codex/skills && cp -r skills/viral-benchmark ~/.codex/skills/
```

装好以后检查一下：`~/.claude/skills/viral-benchmark/SKILL.md` 这个文件存在就对了。

**依赖**

| 依赖 | 用来做什么 | 安装（macOS） |
|---|---|---|
| Python 3 | 运行读取脚本 | 系统自带 |
| ffmpeg | 读本地视频、抽帧 | `brew install ffmpeg` |
| yt-dlp | 读视频链接的数据、评论和画面 | `brew install yt-dlp` |

只分析本地视频的话，可以不装 yt-dlp。装了的话记得经常更新（`brew upgrade yt-dlp`），平台一改版，旧版本就读不到视频。

### 使用

在 Claude Code 或 Codex 里直接说就行，它会自动调用这个 Skill。在 Claude Code 里也可以输入 `/viral-benchmark` 直接指定。

**支持三种输入**

| 输入 | 怎么给 | 适合 |
|---|---|---|
| 在线视频链接 | 贴一条或几条链接 | 刷到一条爆款，想马上拆 |
| 本地单个视频 | 给视频文件的路径 | 小红书、抖音这类读不到链接的，先下载下来 |
| 本地文件夹 | 给文件夹路径，里面放多个视频；也可以放一个 `.txt`，每行一条链接 | 一次收集了一批对标，想比一比先做哪条 |

**示例**

分析一条在线视频：

```text
这条为什么能火？帮我分析一下 https://www.youtube.com/shorts/xxxx
```

分析一个本地视频，顺便说清楚你想做什么：

```text
帮我分析这个视频 ~/Downloads/舞蹈.mp4，我想用自己的 IP 角色复刻
```

分析一个文件夹里的多个视频：

```text
帮我看看这几个能不能当对标，先做哪条 ~/Downloads/对标视频/
```

**不同平台能读到什么**

| 平台 | 数据 | 画面 | 评论 | 账号平时播放 |
|---|---|---|---|---|
| YouTube | ✓ | ✓ | ✓ 热门 20 条 | ✓ 最近 15 条的中位数 |
| X | ✓ | ✓ | 读不到，可以截图给它 | 读不到，可以告诉它 |
| B 站、TikTok | 一般能读 | 一般能读 | 读不到 | 视情况 |
| 小红书、抖音 | 常需要登录 | 常需要登录 | 读不到 | 读不到 |
| 本地视频 | 你来补 | ✓ | 你来补 | 你来补 |

读不到的数据，可以直接告诉它，或者发截图。数据越全，「为什么能火」判断得越准。

**它会怎么做**

1. 读视频：按时长自动抽帧，拼成带时间标注的联系表，并估计剪辑点、平均几秒切一次。给链接的话，还会读播放数据、热门评论，以及账号最近作品的播放中位数，算出这条比平时好多少倍
2. 先分析：直接写出内容总结、受众、为什么能火、值不值得对标，不用你先回答问题
3. 问你想做什么：你没说的话，它会根据这条视频的类型给 2–3 个方向让你选
4. 出报告：按你选的方向写复刻思路、三条选题和制作提醒

**你会拿到什么**

- 一条视频：一份 `对标分析报告.md`，数据在报告最后的附录里
- 多条视频：每条一份分析，外加一节横向对比，告诉你先做哪条。3 条及以上还会多一张 `数据对比.csv`，可以用 Excel、Numbers 或飞书表格打开

完整的报告长什么样，看示例：[`舞蹈视频-对标分析报告.md`](skills/viral-benchmark/examples/舞蹈视频-对标分析报告.md)

**用得更顺的小技巧**

- 一开始就说清楚你想做什么，比如「我想用自己的 IP 角色跳这支舞」，它会直接按这个方向写
- 链接里有 `?` 的，在终端里要加引号；在 Agent 里直接贴就行
- 下载下来的视频只用来抽帧分析，不要拿去直接发布

### 常见问题

**小红书、抖音的链接读不到？**
这两个平台常需要登录。先把视频下载到本地再给它，数据用截图补。也可以试试让它加上 `--cookies-from-browser chrome`，借用浏览器的登录状态。

**给了链接，却只拿到一张封面？**
多半是 yt-dlp 版本旧了，运行 `brew upgrade yt-dlp`（或 `pip install -U yt-dlp`）后再试。还不行，就手动把视频下载下来，给它本地文件。

**抽帧失败，或者读不到画面？**
视频编码不常见，转成 H.264 的 mp4 再试。

**它会帮我生成视频吗？**
不会。它只负责分析和出方案，也不写生成提示词。拿到报告后，把参考视频和角色图交给视频 Agent 去做，比如 YouArt Desktop 的「爆款复刻」。

**怎么更新到最新版？**
方式一：`npx skills update viral-benchmark`。方式二：`git pull` 之后重新复制一遍。

---

## 对标研究室 · 爆款拆解网页

不想装 Agent？用网页也行。拖进一条视频，写一句你想做什么，AI 看完画面，给你一份拆解报告：内容总结、受众、为什么能火、对标建议、复刻思路、三条选题、制作提醒。

```bash
cd tools/benchmark-studio
export MODEL_API_KEY=你的模型 API Key
node server.mjs        # 打开 http://localhost:4318
```

- 只需要 Node.js 22，不用装依赖
- 上传的视频只在浏览器里处理，不上传
- 本机装了 yt-dlp 和 ffmpeg，还能直接贴视频链接分析
- 默认对接蚂蚁数科的 ling-3.2-flash，也可以换成其他能看图的模型

详细说明见 [`tools/benchmark-studio/README.md`](tools/benchmark-studio/README.md)。

---

## 仓库结构

```text
self-media-guide/
├── 01-快速起号/                  方法论一页纸和模板
│   ├── README.md
│   ├── 对标表模板.csv
│   ├── 拆解笔记模板.md
│   └── 二创清单.md
├── skills/
│   └── viral-benchmark/          爆款对标分析 Skill
│       ├── SKILL.md              Agent 读的说明
│       ├── references/           筛选规则、报告模板
│       ├── scripts/probe.py      读视频数据、抽帧
│       └── examples/             示例报告
└── tools/
    └── benchmark-studio/         对标研究室网页工具
        ├── server.mjs            提供页面、转发给模型、贴链接下载
        ├── public/               页面：上传、抽帧、报告、历史记录
        └── README.md
```

## 欢迎补充

你所在赛道的拆解经验、新的二创手法，欢迎提 Issue 或 PR。

## License

[MIT](LICENSE)
