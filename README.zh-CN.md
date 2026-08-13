# Let's GPC

[![Release](https://img.shields.io/github/v/release/WenliangCao/lets-gpc)](https://github.com/WenliangCao/lets-gpc/releases)
[![Chrome 应用商店](https://img.shields.io/chrome-web-store/v/ckmmgmllopcmflfebjhgnchodkdakdig?label=Chrome%20Web%20Store)](https://chromewebstore.google.com/detail/lets-gpc/ckmmgmllopcmflfebjhgnchodkdakdig?hl=zh-CN)
[![Chrome 应用商店用户数](https://img.shields.io/chrome-web-store/users/ckmmgmllopcmflfebjhgnchodkdakdig)](https://chromewebstore.google.com/detail/lets-gpc/ckmmgmllopcmflfebjhgnchodkdakdig?hl=zh-CN)
[![Tests](https://github.com/WenliangCao/lets-gpc/actions/workflows/test.yml/badge.svg)](https://github.com/WenliangCao/lets-gpc/actions/workflows/test.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

[English](README.md) | **简体中文**

一个面向 Chrome 145+ 的零依赖 Manifest V3 扩展：把一个清晰的隐私偏好转换成小巧、可审计的浏览器信号——Global Privacy Control、明确的顶层站点例外，以及 Chrome Topics 退出。

[从 Chrome 应用商店安装 Let's GPC](https://chromewebstore.google.com/detail/lets-gpc/ckmmgmllopcmflfebjhgnchodkdakdig?hl=zh-CN)。带版本号的安装包仍可从 [GitHub Releases](https://github.com/WenliangCao/lets-gpc/releases) 下载；开发时也可以直接加载源码目录。

## 什么是 GPC？

Global Privacy Control（GPC，全局隐私控制）是一种标准化的表达方式，让用户告诉网站和服务：**请不要把我的个人信息出售或共享给第三方，也不要把它用于跨上下文的定向广告。**

它的信号本身很简单：

- HTTP 请求携带 `Sec-GPC: 1`。
- 页面 JavaScript 可以读取 `navigator.globalPrivacyControl === true`。
- 这是浏览器上下文中的用户偏好，不需要用户在每个网站重新选择一次。

[W3C GPC 规范](https://www.w3.org/TR/gpc/) 将它定义为一种隐私偏好信号；网站和服务需要结合适用法律以及与用户的关系来处理它。它并不会把浏览器变成法律执行系统。

### GPC 不是什么

GPC 不是广告拦截器、Cookie 清理器、同意弹窗自动点击器，也不是删除数据请求。它不保证每个网站都会遵守，也不会自动行使每个司法辖区中的所有隐私权。它负责表达用户意图；接收方再决定自己必须或愿意如何响应。

## 为什么浏览器需要一个插件？

现代网页通常不只有你打开的那个网站，还会组合分析服务、CDN、嵌入式媒体、支付系统、广告技术和其他第三方服务。如果要求用户在每个网站分别寻找并重复设置隐私退出，实际无法长期坚持——W3C 规范把这种负担称为“隐私劳动”。通用信号的意义，就是让一次浏览器级选择可以重复使用。

但用户还需要一个可靠的控制面。网站自己的设置无法为每次导航和子资源请求添加浏览器请求头；页面脚本无法控制浏览器网络栈；只有网络层的开关又不能提供网站可能检查的 DOM 属性。Chrome 扩展 API 正好提供了这几层之间的窄桥：

1. 用一个可见开关在本地记录用户偏好。
2. 由 Chrome 声明式网络层发送 `Sec-GPC: 1`，每个请求不运行扩展 JavaScript。
3. 在 `document_start` 的 MAIN world 暴露页面侧的属性（在扩展 API 允许的范围内）。
4. 使用 Chrome 原生隐私设置在浏览器级关闭 Topics。
5. 允许用户为某个顶层网站上下文表达不同的偏好。

这就是 Let's GPC 的动机：把浏览器级隐私偏好放到一个地方进行控制和观察，同时让实现小到可以审计，并如实说明 Chrome 扩展做不到的事情。

## 为什么是 Let's GPC？

这个项目有意只专注于信号本身。它不会建立法律合规数据库，不上传浏览数据，不记录完整请求历史，也不下载远程规则。浏览器正常工作时，扩展应该保持安静；只有设置、导航或界面操作需要它时才运行。

## 功能

- 用一条动态 DNR 规则在 Chrome 网络栈设置 `Sec-GPC: 1`，每个请求不执行扩展 JavaScript。
- 在受支持顶层页面的 `document_start` 阶段，于 MAIN world 暴露 `navigator.globalPrivacyControl === true`。
- 提供全局和当前站点开关，例外严格按顶层浏览上下文生效。
- 使用 Chrome 原生 `privacy.websites.topicsEnabled` 设置关闭 Topics，不伪造 `Permissions-Policy` 请求头。
- 在本地记录访问过的顶层域名；仅在打开弹窗时从已有 Resource Timing 条目读取资源域名。
- 仅在需要时检查当前 origin 的 `/.well-known/gpc.json`，拒绝重定向，并把它视为支持声明而非合规证明。
- 支持域名搜索、启用/停用、忘记、清空、严格全量校验的导入，以及队列化实时导出。
- 通过 Chrome 原生本地化机制支持英文和简体中文。默认语言为英文，界面自动跟随浏览器语言。
- 支持跟随系统、深色和浅色主题；无痕窗口不自动保存域名历史。
- 最多保存 5,000 个唯一域名；设置页最多渲染 500 行，但搜索覆盖完整本地列表。

## 体积与运行模型

Release ZIP 保持在 50 KB 以内，并由打包脚本和测试强制检查。

项目没有 npm 运行时依赖、构建器、source map、远程代码、遥测、广告或远程配置。Chrome 自己执行唯一一条声明式网络规则。事件型 service worker 不监听 `webRequest`、`webNavigation` 或响应事件；仅在安装、启动、设置变更、顶层 URL 变化和 UI 消息时唤醒。

## 安装

日常使用建议直接[从 Chrome 应用商店添加 Let's GPC](https://chromewebstore.google.com/detail/lets-gpc/ckmmgmllopcmflfebjhgnchodkdakdig?hl=zh-CN)，以便自动接收更新。

### 本地安装

1. 打开 `chrome://extensions`。
2. 打开**开发者模式**。
3. 选择**加载已解压的扩展程序**。
4. 源码安装请选择仓库的 `extension` 目录；Release 安装请先解压带版本号的压缩包（例如 `lets-gpc-v0.1.3.zip`），再选择解压后的目录。

Chrome 145 是最低版本，因为站点例外依赖该版本引入的 `excludedTopDomains`。

## 验证与打包

无需安装依赖：

```sh
npm test
npm run package
```

测试包含纯函数、manifest 检查和真实 Chrome 集成测试，覆盖网络信号、页面 API、站点例外、Topics 控制、存储流程、本地化界面和 Release 包约束。

可用 `CHROME_BINARY` 指定 Chrome/Chromium 路径；设置 `UI_SCREENSHOT_DIR` 可在集成测试中保存真实渲染的 popup 和 options 截图。

## 明确边界

本扩展不会宣称自己等同于浏览器原生实现：

- Manifest V3 无法在 Dedicated、Shared 或 Service Worker 启动前注入 `WorkerNavigator.globalPrivacyControl`；其进入 Chrome 网络栈的网络请求仍会得到请求头。
- 为保持站点例外语义一致，页面脚本只注入受支持的顶层 HTTP(S) 文档；subframe 的 Navigator 属性不在保证范围内。
- 全局关闭或顶层站点例外时，扩展不暴露该属性，结果为 `undefined`，而不是完整原生实现应返回的 `false`。
- 网络规则立即更新，但已经打开的文档需要刷新才能改变页面属性；popup 会提示这种不一致。
- Chrome 内部页、Web Store、其他扩展页、被用户收窄的站点权限、企业策略或其他扩展都可能阻止或改变最终结果。
- 有效的 `/.well-known/gpc.json` 只是网站公开声明，不证明某次请求已被依法处理；仅通过重定向发布的声明会有意显示为未知。

Let's GPC 表达的是技术隐私偏好，不提供法律意见或合规保证。

## 设计取舍

项目有意不加入州法律 CSV 数据库、法律合规评分、完整请求/响应日志、远程规则和接收方域名例外。这些功能不是发送 GPC 所必需的，并会增加网络流量、存储写入、权限或信号语义不一致。它比重型隐私仪表盘更聚焦，但对声明的 Chrome GPC 与 Topics 范围是完整的。

## 许可证

项目采用 [Apache License 2.0](LICENSE)，包含明确的贡献者专利授权和专利诉讼终止条款。Apache-2.0 同时允许商业使用和重新分发，但必须遵守许可证条件。

## 隐私

请阅读公开的 [Let's GPC 隐私政策](https://wenliangcao.github.io/lets-gpc/)。扩展没有遥测或开发者自建后端；有限的域名记录和设置仅保存在 Chrome 本地存储中。

## 主要依据

- [W3C Global Privacy Control](https://www.w3.org/TR/gpc/)
- [Global Privacy Control 项目](https://globalprivacycontrol.org/)
- [Chrome Declarative Net Request API](https://developer.chrome.com/docs/extensions/reference/api/declarativeNetRequest)
- [Chrome Scripting API](https://developer.chrome.com/docs/extensions/reference/api/scripting)
- [Chrome Privacy API](https://developer.chrome.com/docs/extensions/reference/api/privacy)
- [Chrome Permissions Policy](https://developer.chrome.com/docs/privacy-security/permissions-policy)
