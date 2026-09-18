# Windows 安装排错

## 安装停在解压画面，重新运行 Setup 也无法安装

### 症状

双击 `KyDog-x.y.z.Setup.exe` 后，安装停在解压画面，既不结束也不报错；关闭后重新运行 Setup，情况相同。有时会弹出安装失败的对话框，日志中的错误是 `序列不包含任何元素`（英文系统为 `Sequence contains no elements`）。

另一种情况：`%LOCALAPPDATA%\kydog` 下已经有 `app-x.y.z` 文件夹，但双击其中的 `KyDog.exe` 没有任何反应，也没有错误提示。

### 解决方法

1. 按 **Ctrl+Shift+Esc** 打开任务管理器，切换到「详细信息」，结束所有 **KyDog.exe** 和 **Update.exe** 进程。
2. 按 **Win+R**，输入 `%LOCALAPPDATA%`，回车。
3. 在打开的文件夹中，删除 **SquirrelTemp** 和 **kydog** 两个文件夹。两个都要删除，只删一个仍然无法安装。
4. 重新双击 Setup.exe。直接双击即可，不要右键选择「以管理员身份运行」：KyDog 安装在当前用户的目录下，管理员权限对安装没有帮助。

**删除 `kydog` 文件夹不会丢失数据。** 该文件夹只包含程序文件。设置、会话记录与 API key 保存在 `C:\Users\<用户名>\.kydog`，项目与论文保存在你选择的项目目录中。

如需反馈问题，请在删除前把 `SquirrelTemp` 中的 `.log` 文件复制出来，附在 [Issues](https://github.com/zhangyee/kydog/issues) 中。

### 原因

Windows 版使用 Squirrel 安装：Setup.exe 先把安装包解压到 `%LOCALAPPDATA%\SquirrelTemp`，再安装到 `%LOCALAPPDATA%\kydog`。安装前，它会先清空旧的 `kydog` 文件夹。

最常见的原因是安装时 KyDog 仍在运行。旧文件被占用，清空旧目录的操作中途失败，Squirrel 日志中会出现 `is the app still running???`。这次失败会留下两个问题：

- `SquirrelTemp` 中留下一份**空的**安装清单。之后每次运行 Setup，都会先读取这份清单并立即失败。因此在删除 `SquirrelTemp` 之前，重试多少次结果都相同。
- `kydog` 文件夹只被删除了一部分。文件夹仍在，但缺少部分文件，`KyDog.exe` 在加载阶段即失败，因此不会出现错误提示。

这个问题与 Windows 是家庭版还是专业版无关。

### 预防

手动安装新版本之前，先完全退出 KyDog，并在任务管理器中确认没有 KyDog.exe 和 Update.exe 进程。

### 重新安装后仍无法启动

查看 `C:\Users\<用户名>\.kydog\logs\main.log`：

- **双击后该文件没有新增内容**：说明 KyDog 的代码没有开始运行。KyDog 目前没有代码签名，常见原因是安全软件拦截或隔离了程序文件。请在安全软件的隔离区或拦截记录中放行 KyDog，然后按上面的步骤重新安装。
- **有新增内容**：最后几行会记录启动在哪一步失败，请附在 [Issues](https://github.com/zhangyee/kydog/issues) 中。

## 安装完成后，找不到 find、grep 等命令

KyDog 使用的命令行工具（find、grep、sed 等）由 [Git for Windows](https://git-scm.com/download/win) 提供，安装后即可使用。

1. 下载并安装 Git for Windows，使用默认选项。注意以下两处：
   - 如果安装程序询问为所有用户安装还是仅为当前用户安装，选择**所有用户**。KyDog 会先在 `C:\Program Files\Git` 下查找 bash。
   - 设置 PATH 的页面保持默认选中的**第二项**。不要选第三项（Use Git and optional Unix tools from the Command Prompt），它会用 Git 自带的同名命令覆盖 Windows 自带的 `find.exe`、`sort.exe`。
2. 安装完成后，完全退出 KyDog 再重新打开。KyDog 只在启动时检查一次 Git。

验证安装：在 PowerShell 中运行

```powershell
& "C:\Program Files\Git\bin\bash.exe" -c "which find grep sed awk; find --version | head -1"
```

输出四个路径，且最后一行为 `find (GNU findutils) …`，即安装成功。
