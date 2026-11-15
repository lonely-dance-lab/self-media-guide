# 自媒体创作不完全指南

我做自媒体时整理的方法、模板和 Agent Skill，配套同名系列文章。

核心是二创，不是搬运：**复用的是结构，替换的是内容。**

## 目录

| 文章 | 讲什么 | 这里有什么 |
|---|---|---|
| 如何快速起号 | 找对标、拆结构、二创手法、跑通 MVP | [`01-快速起号/`](01-快速起号/)：方法论、对标表、拆解模板、二创清单<br>[`skills/viral-benchmark/`](skills/viral-benchmark/)：爆款对标分析 Skill |

---

## viral-benchmark · 爆款对标分析

给它一条你想参考的视频，它会帮你把这条视频看懂，告诉你值不值得对标、怎么换成自己的内容，最后交给你一份完整的《对标分析报告》。

支持 Claude Code、Codex，以及其他支持 Agent Skills 的 Agent。

### 它能做什么

- **内容总结**：这条视频拍了什么，按时间线分段，带秒数
- **受众分析**：谁在看、为什么看、评论区在问什么
- **为什么能火**：数据信号、开头 3 秒、节奏和卡点
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
| yt-dlp | 读视频链接的数据和字幕 | `brew install yt-dlp` |

只分析本地视频的话，可以不装 yt-dlp。

### 使用

在 Claude Code 或 Codex 里直接说就行，它会自动调用这个 Skill：

```text
帮我分析一下这个视频 ~/Downloads/舞蹈.mp4
```

```text
这条为什么能火？我想用自己的 IP 角色复刻 https://www.youtube.com/shorts/xxxx
```

```text
帮我看看这几个能不能当对标 ~/Downloads/对标视频/
```

在 Claude Code 里也可以输入 `/viral-benchmark` 直接指定。

**它会怎么做**

1. 读视频：本地视频抽 16 帧拼成一张图，链接读数据、封面和字幕
2. 先分析：直接写出内容总结、受众、为什么能火、值不值得对标，不用你先回答问题
3. 问你想做什么：你没说的话，它会根据这条视频给 2–3 个方向让你选
4. 出报告：按你选的方向写复刻思路、三条选题和制作提醒，交给你一份 `对标分析报告.md`

完整的报告长什么样，看示例：[`舞蹈视频-对标分析报告.md`](skills/viral-benchmark/examples/舞蹈视频-对标分析报告.md)

**用得更顺的小技巧**

- 一开始就说清楚你想做什么，比如「我想用自己的 IP 角色跳这支舞」，它会直接按这个方向写
- 把点赞、收藏、评论，以及这个账号平时一条大概多少赞告诉它，截图也行。数据越全，「为什么能火」判断得越准
- 一次给好几条视频，报告里会多一节横向对比，告诉你先做哪条

### 常见问题

**小红书、抖音的链接读不到？**
这两个平台常需要登录。先把视频下载到本地再给它，数据用截图补。也可以试试让它加上 `--cookies-from-browser chrome`，借用浏览器的登录状态。

**抽帧失败，或者读不到画面？**
视频编码不常见，转成 H.264 的 mp4 再试。

**它会帮我生成视频吗？**
不会。它只负责分析和出方案，也不写生成提示词。拿到报告后，把参考视频和角色图交给视频 Agent 去做，比如 YouArt Desktop 的「爆款复刻」。

**怎么更新到最新版？**
方式一：`npx skills update viral-benchmark`。方式二：`git pull` 之后重新复制一遍。

---

## 仓库结构

```text
self-media-guide/
├── 01-快速起号/                  方法论一页纸和模板
│   ├── README.md
│   ├── 对标表模板.csv
│   ├── 拆解笔记模板.md
│   └── 二创清单.md
└── skills/
    └── viral-benchmark/          爆款对标分析 Skill
        ├── SKILL.md              Agent 读的说明
        ├── references/           筛选规则、报告模板
        ├── scripts/probe.py      读视频数据、抽帧
        └── examples/             示例报告
```

## 欢迎补充

你所在赛道的拆解经验、新的二创手法，欢迎提 Issue 或 PR。

## License

[MIT](LICENSE)
