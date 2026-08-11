# Let's GPC

[![Release](https://img.shields.io/github/v/release/WenliangCao/lets-gpc)](https://github.com/WenliangCao/lets-gpc/releases)
[![Tests](https://github.com/WenliangCao/lets-gpc/actions/workflows/test.yml/badge.svg)](https://github.com/WenliangCao/lets-gpc/actions/workflows/test.yml)

一个面向 Chrome 145+ 的零依赖 Manifest V3 扩展：只在需要时运行，把 MV3 能可靠实现的 Global Privacy Control 请求头、页面属性、站点例外和 Topics 退出做扎实。

项目尚未发布到 Chrome Web Store；可从 [GitHub Releases](https://github.com/WenliangCao/lets-gpc/releases) 下载，或直接加载源码目录。

## 已实现

- 用一条动态 DNR 规则在浏览器网络栈设置 `Sec-GPC: 1`，不监听每个请求。
- 在 `document_start` 的 MAIN world 暴露 `navigator.globalPrivacyControl === true`。
- 全局开关、当前站点开关，以及按顶层浏览上下文一致生效的域名例外。
- 使用 Chrome 原生 `privacy.websites.topicsEnabled` 关闭 Topics；不把本应由服务器响应提供的 `Permissions-Policy` 伪造成请求头。
- 自动记录访问过的顶层域名；只有打开弹窗时才读取页面已有的 Resource Timing 条目来列出资源域名。
- 仅在打开弹窗时按需直连当前 origin 的 `/.well-known/gpc.json`，拒绝重定向，并明确把结果表述为“支持声明”，而非合规证明。
- 域名搜索、开关、忘记、清空、全量校验后导入、导出。
- 系统、深色、浅色主题。
- 隐身窗口中不自动保存浏览历史。
- 最多保存 5,000 个唯一域名；设置页每次最多渲染 500 行，搜索仍覆盖全部本地记录。

## 体积与运行模型

当前未压缩扩展目录为 78,188 B，打包 ZIP 为 35,713 B；其中运行时文本 64,280 B，共 16 个文件。没有 npm runtime 依赖、构建器、source map、远程代码、遥测或远程配置。

热路径只有 Chrome 自己执行的一条声明式规则。service worker 不订阅 `webRequest`、`webNavigation` 或响应事件；它只在安装、启动、设置变更、顶层导航和 UI 消息时运行。

## 本地安装

1. 打开 `chrome://extensions`。
2. 打开“开发者模式”。
3. 选择“加载已解压的扩展程序”。
4. 源码安装选择本仓库的 `extension` 目录；Release 安装先解压 `lets-gpc.zip`，再选择解压后的目录。

Chrome 145 是最低版本，因为站点例外使用了该版本加入的 `excludedTopDomains`。

## 验证与打包

不需要 `npm install`：

```sh
npm test
npm run package
```

`npm test` 包含纯函数/manifest 测试和真实 Chrome 集成测试。后者通过 DevTools 协议侧载扩展并验证：

- 主导航和子资源恰好收到一个 `Sec-GPC: 1`；
- 页面第一段 inline script 能读到布尔值 `true`；
- 非例外顶层页的同源与跨域请求都一致携带信号；
- 顶层站点例外同时旁路该页面自身和跨域子请求；
- 全局关闭后动态规则、页面脚本和本扩展的 Topics override 都被清除；
- WebSocket 握手和 Worker 发出的网络请求收到请求头，同时如实验证 WorkerNavigator 的已知缺口；
- IPv4、IPv6、localhost 子域、父域继承和并发设置变更保持网络规则、页面属性与存储一致；
- popup 的真实站点开关、options 的 500 行渲染上限和队列化导出快照可用。

集成测试默认使用 macOS 的 `/Applications/Google Chrome.app`；可用 `CHROME_BINARY` 指定其他 Chrome/Chromium 路径。设置 `UI_SCREENSHOT_DIR` 可额外保存真实浏览器渲染截图。

## 明确边界

这不是“100% 原生 GPC”的虚假承诺：

- Chrome 扩展 API 无法在 Worker 启动前注入 `WorkerNavigator.globalPrivacyControl`；网络请求仍由 DNR 添加请求头。
- 页面脚本只注入顶层 HTTP(S) 文档，以保持站点例外语义一致；子 frame 的 Navigator 属性不是本扩展的承诺范围。
- 全局关闭或顶层站点例外时，本扩展不暴露页面属性（结果为 `undefined`），而不是原生规范实现应返回的布尔值 `false`。
- 设置变更会立即更新网络规则，但旧文档里的页面属性要到刷新后才能同步；popup 会明确提示刷新。
- Chrome 内部页、Web Store、其他扩展页等受限页面不能注入。
- 用户限制扩展的站点访问权时，popup/badge 会显示无权限；企业策略或另一个修改同一请求头的扩展仍可能改变最终结果。
- `/.well-known/gpc.json` 只表示网站公开声明支持 GPC，不证明单次请求已被依法处理。
- 为避免站点借检查请求联系第三方，扩展不跟随 well-known 重定向；只通过重定向发布的声明会显示为未知。
- 扩展表达技术偏好，不提供法律结论或合规保证。

完整设计取舍和与 OptMeowt 的差异见 [`docs/architecture.md`](docs/architecture.md)。

## 主要依据

- [W3C Global Privacy Control](https://www.w3.org/TR/gpc/)
- [Chrome Declarative Net Request API](https://developer.chrome.com/docs/extensions/reference/api/declarativeNetRequest)
- [Chrome Scripting API](https://developer.chrome.com/docs/extensions/reference/api/scripting)
- [Chrome Privacy API](https://developer.chrome.com/docs/extensions/reference/api/privacy)
- [Chrome Permissions Policy](https://developer.chrome.com/docs/privacy-security/permissions-policy)
