# 自媒体创作不完全指南

我做自媒体时整理的方法、模板、Agent Skill 和小工具，跟着同名系列文章一篇篇更新。

核心是二创，不是搬运。

## 目录

| 篇 | 内容 | 这里有什么 |
|---|---|---|
| （一）如何快速起号 | 找对标、拆骨架、换血肉、先发三条 | [`01-快速起号/`](01-快速起号/)：方法论、对标表、拆解模板、二创清单<br>[`skills/viral-benchmark/`](skills/viral-benchmark/)：起号对标助手 Skill |
| （二） | 更新中 | |
| （三） | 更新中 | |

## Skills

### viral-benchmark · 起号对标助手

丢一批对标视频进去（链接，或者下载好放在文件夹里的视频），按「找对标 → 筛选 → 拆骨架 → 二创思路 → 先发三条」走一遍，输出填好的对标表和一份拆解与选题。Claude Code 和 Codex 都能用。

**安装**

```bash
git clone https://github.com/lonely-dance-lab/self-media-guide.git
cd self-media-guide

# Claude Code
cp -r skills/viral-benchmark ~/.claude/skills/

# Codex
cp -r skills/viral-benchmark ~/.codex/skills/
```

依赖：Python 3、`ffmpeg`（读本地视频）、`yt-dlp`（读链接）。

```bash
brew install ffmpeg yt-dlp   # macOS
```

**用法**

直接跟 Agent 说，比如：

> 我想做一个 AI 角色跳舞、顺便讲穿搭的小红书号。帮我看看这几个对标能不能做：~/Downloads/对标视频/

- 给链接：只读数据、封面和字幕，不下载视频
- 给文件夹：放下载好的视频，或者一个写满链接的 `.txt`
- 小红书、抖音的链接常需要登录，读不到时 Agent 会请你补数据

示例输出见 [`skills/viral-benchmark/examples/`](skills/viral-benchmark/examples/)。

## 欢迎补充

你所在赛道的拆解经验、新的二创手法，欢迎提 Issue 或 PR。
