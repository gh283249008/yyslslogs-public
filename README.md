# 燕云LOGS 0.3.2

燕云十六声本地采集器与手动上传工具。本仓库仅发布 0.3.2 公开版源码与下载包。

## 下载

在 [Releases](https://github.com/gh283249008/yyslslogs-public/releases) 下载 Windows x64 完整压缩包，解压后保留整个目录。

- **燕云 Logs.exe**：采集和本地保存。
- **yylogs上传器.exe**：按日期生成 .yylogs 压缩包，登录后手动上传。
- 网站：[燕云LOGS](https://yylogs.dreemurr.net)。

上传包默认保存到程序根目录，原始记录保留在本机。上传器不会后台自动上传。

## 源码与构建

本目录来自已验收的 0.3.2 交付成品。app 为采集器界面，package-generator 为生成/上传工具，modules 与 tools 为采集、存储和解析模块；config 及 evidence 中仅包含运行必需的版本化配置、字典和协议描述符，不含战斗记录。

Windows x64、Node.js 24：

```powershell
npm ci --prefix app
npm ci --prefix tools
$env:YYSLS_BUILD_PYTHON = 'C:/runtimes/python312'
$env:YYSLS_BUILD_WIRESHARK = 'C:/Program Files/Wireshark'
node tools/build-public.mjs
```

Python 运行时需要 CPython 3.12、DLLs 及完整标准库；Wireshark 目录需有 tshark/dumpcap。构建产物使用随附运行库，最终用户无需安装 Node/Python/Wireshark。Npcap 驱动不捆绑，按程序引导从官方下载。

## 许可

应用许可为 GPL-3.0-or-later，第三方组件保留其原始许可；详见 LICENSE、THIRD-PARTY.txt 与 vendor/kagerou/LICENSE.md。

本仓库不含网站服务端、部署配置、凭据、用户采集记录或旧版本开发历史。
