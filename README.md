# ompw

[![CI](https://github.com/Mc-andan/ompw/actions/workflows/ci.yml/badge.svg)](https://github.com/Mc-andan/ompw/actions/workflows/ci.yml)
[![License: GPL-3.0-only](https://img.shields.io/badge/license-GPL--3.0--only-blue)](LICENSE)

在项目目录运行 `ompw`，通过一个经过认证的浏览器入口控制多个原生 [Oh My Pi (OMP)](https://github.com/can1357/oh-my-pi) 终端。

ompw 是独立的会话宿主，不是 OMP 官方组件。它保留 OMP 原生 JSONL 会话，不重新实现模型对话，也不把浏览器窗口当作进程生命周期。登录成功即获得运行 OMP 的系统账户权限，请按远程终端服务保护它。

## 目录

- [能力与边界](#能力与边界)
- [环境要求](#环境要求)
- [安装](#安装)
- [首次登录](#首次登录)
- [多会话使用](#多会话使用)
- [独立 OMP 恢复](#独立-omp-恢复)
- [HTTPS 与监听配置](#https-与监听配置)
- [命令参考](#命令参考)
- [数据与升级](#数据与升级)
- [从源码运行和构建](#从源码运行和构建)
- [故障排查](#故障排查)
- [安全模型](#安全模型)
- [开发与贡献](#开发与贡献)
- [许可证与第三方组件](#许可证与第三方组件)

## 能力与边界

- 一个后台服务、一个浏览器地址、一套管理员密码和 TOTP 验证器绑定。
- 不同项目分别托管 OMP；同项目默认复用已有会话，`--new` 创建独立会话。
- 网页侧栏显示会话、工作目录和状态，切换终端不会停止其他会话。
- 每个会话独立维护终端画面、滚动历史、行列数和输入控制权。同一会话的其他浏览器连接默认为只读。
- 浏览器断开、退出登录、启动命令结束或关闭启动窗口后，后台 OMP 继续运行。
- 网页可以单独启动或释放一个会话；`ompw stop` 显式结束整个后台和所有托管 OMP。
- 原生会话重复托管检查覆盖 CLI 启动和受托管 OMP 内部 `/resume`；占用在确认进程退出后释放。
- 当前限制：最多 16 个运行中的 OMP、256 个目录中的会话记录、每个登录和每个会话最多 8 个终端连接、全局最多 64 个连接。

**不提供** DDNS、路由器配置、公网转发、操作系统启动项或 Windows 服务安装。电脑重启、账户注销或后台崩溃后，不会继续执行原进程；保留的会话可重新恢复。当前是文本终端，不支持终端图像协议。

## 环境要求

| 项目 | 要求 |
| --- | --- |
| 已验证宿主平台 | Windows 10 22H2 / Windows 11，x64，支持 ConPTY |
| OMP | 本机已安装并配置，`omp --version` 可用；多会话桥接在 OMP 18.1.11 验证 |
| 浏览器 | 现代 Chrome、Edge、Firefox 或 Safari；手机可使用响应式界面，具体 IME/软键盘行为依浏览器而异 |
| 安装版运行 | 无需另装 Node.js；程序目录附带运行时 |
| 源码开发 | Node.js 24.15.0 或更新的 Node.js 24、npm；Windows 打包需要 PowerShell |

OMP 的认证、模型设置和工具权限由 OMP 自己管理。先在普通终端运行一次 `omp`，完成它自己的初始化。浏览器的 ompw 登录不是模型提供商登录。

Linux/macOS 的底层库具有跨平台能力，但本项目的发行包、安装器及完整运行流程目前只验证 Windows x64；不宣称其他宿主平台已受支持。

## 安装

### Windows 程序包

若 [Releases](https://github.com/Mc-andan/ompw/releases) 提供与你的平台匹配的包，下载 `ompw-win32-x64.zip`。没有发布包时，按下文从源码构建。

1. 解压 ZIP，保留整个 `ompw-win32-x64` 目录，不能只复制 `ompw.exe`。
2. 在该目录打开 PowerShell，执行：

```powershell
.\ompw.exe install
```

安装到 `%LOCALAPPDATA%\Programs\ompw`，并添加当前用户 PATH，不需要管理员权限。关闭并重新打开终端后：

```powershell
cd E:\projects\project-a
ompw
```

安装包包含入口、Node 运行时、原生 ConPTY 模块、网页和 OMP 桥接扩展。它不是单文件 EXE。当前构建没有代码签名证书；Windows 可能提示未知发布者。只运行你信任且可核验源码的构建，不要关闭系统安全防护。

### 免安装运行

在目标项目目录使用程序的绝对路径，工作目录仍然是当前项目：

```powershell
& "E:\tools\ompw-win32-x64\ompw.exe"
```

### 卸载

先执行 `ompw stop`。删除 `%LOCALAPPDATA%\Programs\ompw`，再从 Windows 当前用户 PATH 删除该目录。登录凭据和会话目录不会自动删除；是否删除 `%USERPROFILE%\.ompw` 由你决定。OMP 的原生会话位于独立的 OMP 数据目录。

## 首次登录

首次运行 `ompw` 时，若没有凭据，会在本机终端引导初始化：

1. 设置至少 16 个字符的管理员密码，再输入一次确认。
2. 将显示的 `otpauth://` 信息或 `Manual key` 添加到支持 TOTP 的验证器，例如 Microsoft Authenticator、Google Authenticator 或 1Password。
3. 手动配置时使用：基于时间、SHA-1、6 位数字、30 秒周期。条目名为 `ompw`。
4. 输入验证器当前 6 位码完成绑定。绑定密钥不是验证码，也不能自行编写随机数字。
5. 等待验证器刷新到下一组新码，再登录浏览器。绑定码已标记使用，不能重复登录。

命令完成后会输出会话链接，默认入口为：

```text
http://127.0.0.1:4310
```

网页填写初始化时的管理员密码和 ompw 验证器的当前码。密码不做 trim 或大小写转换；验证码支持复制出的分组空格和全角数字。

**不要公开密码、TOTP 密钥、`auth.json`、Cookie 或 `daemon.json`。** 项目不会生成默认密码，也不提供公开注册或通过网页重置凭据。

## 多会话使用

### 不同项目共用一个网页

```powershell
cd E:\projects\project-a
ompw

cd E:\projects\project-b
ompw
```

第一次命令启动后台服务，随后命令连接同一服务。每条命令在注册完成后退出，输出携带 `?session=<id>` 的链接；这个 ID 是会话选择器，不是认证令牌。

登录后从侧栏选择 `project-a` 或 `project-b`。手机使用“会话列表”按钮。切换只断开旧会话的浏览器订阅，后台进程不会因此停止。

### 同一个项目运行多个 OMP

```powershell
cd E:\projects\project-a
ompw --new
```

新的托管会话显示为独立条目，例如 `project-a (2)`。不带 `--new` 时复用该项目已有的默认条目；多个会话仍共用同一工作目录，**并不自动创建 Git worktree**。同时改同一文件需要自行协调。

### 输入控制与单会话释放

第一个连接会话的浏览器取得输入控制，后续连接只读。使用“放弃输入控制”和“获取输入控制”交接。不能强制抢占仍在线的控制者；每个会话分别分配控制权，尺寸调整也只作用于当前控制的会话。

“释放 OMP”会中断选中会话的运行任务，执行 OMP 清理并等待实际退出。确认框显示目标，不影响其他会话。未完成退出会显示错误，不会谎报已释放或强杀进程。

### 查看状态与停止整个服务

```powershell
ompw status
ompw stop
```

`status` 输出全部托管会话及状态。`stop` 等待所有托管进程正常退出，再关闭服务；无法确认退出时返回错误，服务保留以便处理和重试。停止后台后，目录保留；下次运行 `ompw` 只启动请求的会话，其他记录以停止状态显示，可在网页分别启动。

## 独立 OMP 恢复

1. 在网页选中目标会话，点击“释放 OMP”，等待状态变成“已停止”。
2. 使用页面显示的完整命令：

```powershell
omp --resume "C:\Users\you\.omp\agent\sessions\...\session.jsonl"
```

3. 退出独立 OMP 后，在原项目重新运行 `ompw` 或点击网页“启动 OMP”。

也可导入已有原生会话：

```powershell
ompw --resume "E:\saved\session.jsonl"
ompw --resume <原生会话ID或前缀>
```

`--new` 与 `--resume` 互斥。自定义 OMP 会话目录优先使用完整文件路径；ID 查找有 20,000 个文件的扫描上限。

**独立 OMP 不会遵守 ompw 私有锁。不要让独立 OMP 与托管 OMP 同时写同一个原生会话。** ompw 无法事后无损接管未由它创建的终端进程。这里的 resume 是恢复原生记录，不是迁移仍运行的工具任务。

## HTTPS 与监听配置

HTTP 只允许本机回环地址。直接监听非回环地址需要证书和私钥：

```powershell
ompw stop
ompw --host 0.0.0.0 --port 4310 `
  --origin "https://terminal.example.com:4310" `
  --cert "E:\certs\fullchain.pem" `
  --key "E:\certs\privkey.pem"
```

- `--origin` 是浏览器地址栏的完整 origin，协议、域名、外部端口必须一致，末尾不要加 `/`。
- `--port` 是本机监听端口；外部端口与本机端口不同时，`--origin` 使用外部地址。
- 证书需要被浏览器信任，并匹配访问域名。私钥应限制为当前账户可读。
- 也可由你自行配置可信反向代理终止 HTTPS，ompw 保持回环 HTTP 监听并设置 HTTPS `--origin`；代理必须保留对应 Host/Origin 并支持 WebSocket。ompw 不信任转发的来源 IP，代理下登录限速可能合并。
- 服务配置保存在私有目录的 `service.json`，下次启动继续使用。后台运行时不能通过另一条注册命令修改监听配置；先 `ompw stop`。
- DDNS、网络转发、防火墙和反向代理不由 ompw 自动配置。

## 命令参考

| 命令/选项 | 行为 |
| --- | --- |
| `ompw` / `ompw serve` | 启动后台（如未运行），注册或复用当前项目会话 |
| `ompw --new` | 当前项目创建额外独立会话 |
| `ompw --resume <id\|path>` | 托管已有原生会话 |
| `ompw --cwd <path>` | 显式指定工作目录 |
| `ompw status` | 列出后台地址和全部会话状态 |
| `ompw stop` | 正常关闭后台及所有托管 OMP |
| `ompw setup` | 本机设置/替换密码及 TOTP 绑定，要求后台停止 |
| `ompw auth-check` | 本机隐藏输入，分别诊断密码/验证码，不修改凭据、不消耗验证码 |
| `ompw install` | Windows 程序包安装到当前用户目录 |
| `--data-dir <path>` | 使用独立私有配置目录；相关命令必须使用同一路径 |
| `--omp <path>` | 首次启动或停止后台后指定 OMP 可执行程序 |
| `--host` / `--port` / `--origin` | 设置服务监听与严格来源校验 |
| `--cert` / `--key` | PEM 证书和私钥，一起使用 |
| `--help` | 显示命令帮助 |

`daemon` 是内部前台入口，供自动后台启动及开发诊断使用，不是常规启动方式。`--data-dir` 必须是专用私有目录，不要指定项目根目录或共享目录。每个数据目录只有一个后台实例；默认用户只需一个。

## 数据与升级

默认私有根目录为 `%USERPROFILE%\.ompw`：

| 文件/目录 | 用途 |
| --- | --- |
| `auth.json` | scrypt 密码哈希、TOTP 密钥与已使用时间步，敏感 |
| `service.json` | 监听、origin、证书路径和 OMP 程序设置 |
| `daemon.json` | 后台 PID、控制端口、随机控制令牌，敏感 |
| `server.lock` | 后台或凭据设置进程的独占锁 |
| `launcher/` | 启动器并发协调锁 |
| `sessions.json` | 多会话目录，包含项目和原生文件路径 |
| `hosts/<id>/` | 各会话运行元数据、退出请求、上次会话信息 |
| `native-locks/` | 原生会话路径和文件身份的托管占用 |
| `workspaces/` | 旧单会话版本数据；升级后保留原路径以避免遗失进程标记 |
| `daemon.log` | 后台启动/错误日志，可能包含本机路径 |

OMP 的模型凭据、原生会话、工具产物仍由 OMP 在自己的目录管理。终端滚动缓存有界，后台重启不保留全部屏幕字节，恢复后由 OMP 原生会话重建内容。

升级步骤：`ompw stop`，备份私有数据与需要的原生会话，解压新包，再执行新包的 `ompw.exe install`。旧版本若是前台单会话宿主，先在旧窗口按 `Ctrl+C` 正常退出；不能跨版本热替换活跃后台。升级会导入旧会话目录，不重置登录凭据，不手工改写 OMP JSONL。

## 从源码运行和构建

```powershell
git clone https://github.com/Mc-andan/ompw.git
cd ompw
npm ci
npm run build
node src/cli.ts --cwd "E:\projects\project-a"
```

`npm run build` 只构建浏览器资源，不能直接双击 `public/index.html`。后端需要 HTTP/WebSocket 服务。源码运行也会启动后台；修改服务端代码后，先用同一数据目录执行 `node src/cli.ts stop`，再重新启动。

### 验证

```powershell
npm run check
npm test
npm audit --registry=https://registry.npmjs.org
```

测试覆盖密码/TOTP、验证码重放与格式、登录过期、HTTP/WS 认证及 CSRF、会话控制/尺寸隔离、本机控制令牌和原生文件占用。自动测试无需 OMP 模型账户；真实 OMP/浏览器流程需本机安装 OMP，且应使用单独的 `--data-dir`，不要在测试中修改真实凭据。

### Windows x64 打包

```powershell
npm run package
```

输出：

```text
dist/ompw-win32-x64/ompw.exe
dist/ompw-win32-x64.zip
```

打包脚本构建前后端，复制当前 Node.js 运行时，通过 Node SEA/postject 生成入口，包含 node-pty 的 Windows x64 模块和辅助程序、OMP 桥接扩展、许可及源码。`postject` 对被修改的 Node 原签名发出提示是当前未签名构建的预期行为，不代表已完成代码签名。

需要 Windows x64、Node.js 24，以及 Node 安装目录内的 `LICENSE`。依赖使用 lockfile 固定。若 node-pty 没有适用预构建文件，安装可能需要 Python 和 Visual Studio C++ Build Tools；当前 Windows x64 包使用预构建模块。

从本地构建安装：

```powershell
npm run install:command
```

构建脚本会替换 `dist/ompw-win32-x64`，不要把用户数据放到该输出目录。`dist/`、`node_modules/`、生成的网页 bundle 和测试私有目录不提交 Git。

## 故障排查

### 找不到 ompw

安装后重新打开终端。执行 `where.exe ompw` 检查解析路径；也可直接运行：

```powershell
& "$env:LOCALAPPDATA\Programs\ompw\ompw.exe" --help
```

### 密码或验证码不匹配

在另一个本机终端运行 `ompw auth-check`，后台无需关闭。两项输入都隐藏：

- `PASSWORD: MISMATCH`：不是初始化保存的密码；检查密码管理器、输入法和大小写。
- `OTP: MATCH`：绑定和当前码匹配。
- `OTP: ALREADY_USED`：等待验证器刷新新码。
- `OTP: MISMATCH`：检查是否选择 ompw 条目，以及手机自动时间。
- `OTP: POSSIBLE_CLOCK_OFFSET`：可能存在时间偏差；诊断搜索不代表服务器放宽校验。

遗忘密码或丢失验证器：先 `ompw stop`，再 `ompw setup`。setup 同时替换密码和验证器密钥，需要重新绑定，不删除 OMP 原生会话。不要把诊断输入、密钥或 auth.json 发到 Issue。

### 访问地址校验失败

使用启动输出的地址；检查 `service.json` 的 origin 和实际 Host 是否一致。`localhost` 与 `127.0.0.1` 是不同 origin。远程 HTTPS 地址需要显式配置，不能用服务器 IP 随意替换域名。

### 登录次数过多

等待页面提示的秒数后再试。反复提交旧码会占用失败尝试窗口。不要通过关闭 TOTP、禁用限速或修改 lastCounter 规避检查。

### 找不到 OMP / 启动超时

先执行 `omp --version`。必要时停止服务并指定 `--omp "完整路径\omp.exe"`。后台继承首次启动时的环境；新安装程序后重启后台。启动超时不自动杀死 OMP，网页可检查启动对话框或扩展错误。桥接依赖 OMP 原生存储接口，接口不兼容时会拒绝托管而不是跳过保护。

### 锁文件、残留进程与崩溃

先尝试 `ompw status` / `ompw stop`。正常退出会清理服务锁和控制地址。异常退出保留锁以防重复写入；**不要直接删除锁后重试**。

必须先确认对应后台 PID、`host-process.json` 与 `runtime.json` 记录的 OMP PID 都已退出，备份数据后才能人工清理失效的 `server.lock`、`daemon.json` 或 `launcher/server.lock`。不要删除原生占用记录来绕过仍运行的进程。若残留 OMP 存活，先正常结束它；进程身份无法确认时保持停止状态。

### 端口被占用

停止同一 ompw 后台后选择空闲 `--port` 和匹配 `--origin`。不要结束不属于 ompw 的进程。启动失败详情在所选数据目录的 `daemon.log`。

## 安全模型

- 管理员密码使用 scrypt（N=131072、r=8、p=1、独立随机 salt），只保存哈希。
- TOTP 使用 SHA-1、6 位、30 秒、前后各一个时间步；已使用时间步在签发会话前持久化。
- 登录 Cookie 为 HttpOnly、SameSite=Strict，HTTPS 使用 Secure 和 `__Host-` 前缀；登录令牌只在内存保存，后台重启失效。
- 空闲 30 分钟或绝对 12 小时过期；后台输出/心跳本身不会持续延长登录。
- HTTP 写操作要求严格 Origin 与 CSRF，WebSocket 握手要求 Cookie 和严格 Origin；退出撤销相关连接。
- 本机控制接口独立监听随机回环端口，使用 256 位随机令牌，拒绝携带浏览器 Origin/Fetch Metadata 的请求。令牌只存私有目录，不出现在浏览器 URL。
- 私有目录限制 Windows ACL / POSIX 权限；发现不安全的显式 Windows 共享授权会拒绝启动。
- 前端静态资源本地提供，无第三方运行时 CDN。此服务不提供账户间权限隔离或沙箱；OMP 的工具权限和模型网络请求由 OMP 配置决定。

本机同一账户、管理员或能读取私有目录的攻击者不在认证防护边界内。TOTP 不是抗钓鱼认证。没有“绝对无漏洞”的保证；依赖审计只检查已知公告，不等于渗透测试或完整安全审计。

报告安全问题时，请优先使用仓库 [Security](https://github.com/Mc-andan/ompw/security) 中可用的私密报告渠道。若仓库尚未启用私密报告，先向维护者请求私密沟通方式，不要把可利用细节、真实凭据或数据公开到 Issue。项目不承诺固定安全响应 SLA。

## 开发与贡献

仓库结构：

```text
src/cli.ts             命令、初始化、后台启动
src/control.ts         私有本机控制协议
src/daemon.ts          后台生命周期
src/registry.ts        多会话目录与注册
src/session.ts         PTY、屏幕状态、进程交接
src/omp-extension.ts   原生会话元数据和占用保护
src/auth.ts            登录与验证码校验
src/server.ts          HTTP、WebSocket、会话路由
src/web/               浏览器界面
scripts/               Windows 打包与安装
test/                  边界与回归测试
```

欢迎通过 [Issues](https://github.com/Mc-andan/ompw/issues) 报告问题或讨论修改，再提交 Pull Request。问题报告应包含 ompw/OMP/Node/Windows 版本、复现步骤、期望/实际行为和脱敏日志；不要包含 `auth.json`、`daemon.json`、私钥、Cookie 或完整私人对话。

提交前运行 `npm run check`、`npm test`、`npm run build`；涉及终端/生命周期改动时，还应使用隔离数据目录验证真实 OMP 的启动、重连、单会话释放和后台关闭。新增测试应保护可观察行为和数据安全，不锁定 UI 文案或实现细节。贡献使用本项目 GPL-3.0-only 许可；不要求独立 CLA。讨论应尊重参与者，不发布他人隐私或凭据。

CI 在 Windows + Node.js 24 上进行依赖安装、类型检查、测试和网页构建。未运行的测试平台或场景不得在 PR 中声称已验证。

## 许可证与第三方组件

Copyright (C) 2026 Mc-andan and contributors.

ompw 以 **GNU General Public License v3.0 only (`GPL-3.0-only`)** 发布，完整条款见 [LICENSE](LICENSE)。允许按许可证使用、修改和分发；分发修改版或二进制时需履行相应源代码和许可声明义务。本项目不提供任何担保，包括适销性或特定用途适用性的默示担保。

Node.js、node-pty、xterm.js、lucide、OTPAuth、Inquirer、ws 及其他依赖保留各自许可证。发行目录包含 `THIRD-PARTY-NOTICES.txt`、`runtime/LICENSE`、项目 LICENSE 和对应项目源码；依赖版本与获取信息在 package-lock.json 中。OMP 是独立安装的上游程序，不随本项目重新授权。
