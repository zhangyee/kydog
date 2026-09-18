# Windows 安装排错

## 装不上：卡在解压画面，关掉重新点 Setup 也不行

### 症状

双击 `KyDog-x.y.z.Setup.exe` 之后，停在解压画面既不结束、也不报错；关掉再点 Setup，还是一样。有时会弹出「安装失败」的对话框，日志里写着 `序列不包含任何元素`（英文系统是 `Sequence contains no elements`）。

另一种样子：`%LOCALAPPDATA%\kydog` 里已经有 `app-x.y.z` 文件夹，但双击里面的 `KyDog.exe` 什么反应都没有，也不报错。

### 修法

1. 按 **Ctrl+Shift+Esc** 打开任务管理器，切到「详细信息」，把所有 **KyDog.exe** 和 **Update.exe** 都「结束任务」。
2. 按 **Win+R**，输入 `%LOCALAPPDATA%`，回车。
3. 在打开的文件夹里，把 **SquirrelTemp** 和 **kydog** 两个文件夹**都**删掉。只删一个还是装不上。
4. 重新双击 Setup.exe。普通双击就行，**不要**右键「以管理员身份运行」：KyDog 装在当前用户自己的目录下，提权帮不上忙。

**删 `kydog` 文件夹不会丢数据。** 它里面只有程序文件。设置、会话记录和 API key 在 `C:\Users\<用户名>\.kydog`，项目和论文在你自己选的项目目录里，都不在这个文件夹下。

如果想把问题报给我们，删之前先把 `SquirrelTemp` 里的 `.log` 文件复制出来，贴到 [Issues](https://github.com/zhangyee/kydog/issues)。

### 为什么会这样

Windows 版用 Squirrel 安装：Setup.exe 先把安装包解压到 `%LOCALAPPDATA%\SquirrelTemp`，再装进 `%LOCALAPPDATA%\kydog`。装之前它要先清空旧的 `kydog` 文件夹。

最常见的起因是**安装时 KyDog 还开着**：旧文件被占住，清空只清掉一半就失败了，Squirrel 的日志里这时会写 `is the app still running???`。这一次失败会连带留下两个坏东西：

- `SquirrelTemp` 里一份**空的**安装清单。之后每次运行 Setup 都会先读它，一读到空清单就立刻失败。所以重试多少次结果都一样，删掉 `SquirrelTemp` 之前没有任何办法绕过去。
- 一个删了一半的 `kydog` 文件夹。文件夹名还在，里面缺了一部分文件，所以双击 `KyDog.exe` 没有反应：程序在加载阶段就起不来了，还没跑到能弹出错误提示的那一步。

这和 Windows 是家庭版还是专业版没有关系。

### 以后怎么避免

手动安装新版之前，先把 KyDog 完全退出，再去任务管理器看一眼，确认没有 KyDog.exe 和 Update.exe 还在跑。

### 干净重装后还是打不开

先看 `C:\Users\<用户名>\.kydog\logs\main.log`。

- **双击之后这个文件里没有新内容**：KyDog 自己的代码一行都没跑到。KyDog 目前还没有代码签名，最常见的原因是杀毒软件或安全管家把文件拦了、隔离了。看一下安全软件的隔离区或拦截记录，把 KyDog 放行后再照上面的步骤重装一遍。
- **有新内容**：最后几行会写明卡在哪一步，把它贴到 [Issues](https://github.com/zhangyee/kydog/issues)。

## 装好之后，find、grep 这些命令找不到

KyDog 的命令行工具（find、grep、sed 等）都来自 [Git for Windows](https://git-scm.com/download/win)，装上它就有了。

1. 下载 Git for Windows 并安装，一路用默认选项。有两处别改：
   - 如果安装器问装给所有用户还是只装给当前用户，选**所有用户**。KyDog 先到 `C:\Program Files\Git` 下面找 bash。
   - 设置 PATH 的那一页，保持默认选中的**中间那一项**。不要选第三项（Use Git and optional Unix tools from the Command Prompt），它会用 Git 自带的同名命令盖掉 Windows 自己的 `find.exe`、`sort.exe`。
2. 装完**完全退出 KyDog 再打开**。KyDog 只在启动时检查一次 Git。

想确认装好了，在 PowerShell 里跑：

```powershell
& "C:\Program Files\Git\bin\bash.exe" -c "which find grep sed awk; find --version | head -1"
```

能打出四个路径，最后一行是 `find (GNU findutils) …`，就装好了。
