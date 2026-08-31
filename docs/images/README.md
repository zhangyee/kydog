# README 配图

这个目录放 README 里引用的静态图。**动图不要放这里** —— 见下。

## 待补的三张静态图

| 文件名 | 内容 | 用在哪 |
|---|---|---|
| `hero.png` | 主界面全貌：左侧工作区 + 中间会话 + 右侧检查器，会话里最好有一次检索的工具卡片 | README「演示」第一张 |
| `search.png` | 一次多源检索的过程：工具卡片逐条亮起，能看清源名和命中数 | README「演示」，可选 |
| `reading.png` | PDF 阅读器与 Markdown 编辑器并排 —— 这是 KyDog 区别于编程智能体最直观的一屏 | README「演示」，可选 |

补完之后，把 `README.md` 与 `README.en.md`「演示」一节里对应的注释取消掉。

## 动图 / 视频不入库

GIF 一旦提交进 git，每换一版都在历史里永久留一份，仓库会不可逆地胀。做法是：

1. 把文件拖进任意一个 GitHub Issue 的编辑框（**不用真的发出去**）
2. GitHub 返回一个 `https://user-images.githubusercontent.com/...` 链接
3. 在 README 里引这个链接

文件走 GitHub 的 CDN，不进仓库。

### 建议规格

- **时长 10–20 秒，体积 3–5 MB。** 超过之后 README 首页在移动端会明显卡。
- **静态图打头，动图跟在后面。** GIF 会一直循环，读者读旁边文字时很分心；而静态图能放大看清界面文字，动图不能。
- **也可以直接贴 MP4。** 同样用 issue 上传，GitHub 会渲染成带播放控件的视频，同画质下体积只有 GIF 的几分之一。代价是不自动播放。

### 录什么

一条完整的 `/literature-review`：输入主题 → 多源并行检索的工具卡片一张张亮起 → 落成综述文件 → 在编辑器里打开。这条链是 KyDog 最不可替代的地方，静态图看不出来。

### 转换命令

两遍调色板，比默认转出来干净得多：

```bash
ffmpeg -i demo.mov -vf "fps=12,scale=1200:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=128[p];[s1][p]paletteuse=dither=bayer:bayer_scale=3" -loop 0 demo.gif
```
