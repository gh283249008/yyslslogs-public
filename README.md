# 燕云LOGS 0.4.1

燕云十六声本地采集器与手动上传工具。本仓库发布 0.4.1 公开版源码与下载包。

## 下载

[下载 Windows x64 完整包](https://github.com/gh283249008/yyslslogs-public/releases/tag/v0.4.1fix)，解压后保留整个目录。支持 Win64r、Win64rh，内置官网签名解码配置源。

本次新增鸣金·霆识别和浅钢蓝配色，同步网站 rDPS 规则；断石按客户端数据版本采用对应数值，旧报告保持原口径。包含加速器连接支持。已确认的副本 Boss 自动显示名称，本次补入桃靥剑姬和耶律阿不里；新名称严格匹配客户端数据版本与完整身份，未知目标保留待确认提示。

- **燕云 Logs.exe**：采集和本地保存。
- **yylogs上传器.exe**：按日期生成 .yylogs 压缩包，登录后手动上传。
- 网站：[燕云LOGS](https://yylogs.dreemurr.net)。

上传包默认保存到程序根目录，原始记录保留在本机。上传器不会后台自动上传。

## 源码与构建

运行源码来自已验收的 0.4.1 成品。app 为采集器界面，package-generator 为生成/上传工具，modules 与 tools 为采集、存储和解析模块；config 及 evidence 仅含运行必需的版本化配置、字典和协议描述符，不含战斗记录。

Windows x64、Node.js 24：

```powershell
npm ci --prefix app
npm ci --prefix tools
$env:YYSLS_BUILD_PYTHON = 'C:/runtimes/python312'
$env:YYSLS_BUILD_WIRESHARK = 'C:/Program Files/Wireshark'
node tools/build-public.mjs
```

Python 运行时需要 CPython 3.12、DLLs 及完整标准库；Wireshark 目录需有 tshark/dumpcap。最终用户无需安装 Node/Python/Wireshark。Npcap 驱动不捆绑，按程序引导从官方下载。

## 许可

应用许可为 GPL-3.0-or-later，第三方组件保留其原始许可；详见 LICENSE、THIRD-PARTY.txt 与 vendor/kagerou/LICENSE.md。

本仓库不含网站服务端、部署配置、凭据、用户采集记录或旧版本开发历史。
