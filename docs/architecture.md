# Let's GPC 架构与重构计划

## 1. 结论

不 fork OptMeowt。保留它有价值的产品能力，但从零实现 Chrome-only MV3 扩展，避免继承多浏览器构建层、旧功能残留、全请求监听、UI 框架和远程合规数据管道。

Let's GPC 的核心约束是：

1. 请求热路径中不运行扩展 JavaScript。
2. 默认不向项目控制的服务器联网，不接受远程配置或代码。
3. 权限、数据模型和 API 数量保持最小且可解释。
4. 设置变更要原子、可回滚；导入必须先完整验证。
5. 对 Chrome 扩展无法弥补的标准缺口如实说明。

## 2. OptMeowt 取舍

2026-08-10 对官方仓库 `privacy-tech-lab/gpc-optmeowt` 当前代码和商店 CRX 的只读检查得到：商店包约 3.68 MiB，其中截图与 source map 占约 80.1%；代码还在每个请求/响应上执行域名解析、IndexedDB 和标签查询，并按天下载二十多 MiB 的州合规 CSV。

| 能力 | Let's GPC | 取舍 |
| --- | --- | --- |
| `Sec-GPC: 1` | 保留 | 一条动态 DNR 规则 |
| `navigator.globalPrivacyControl` | 保留 | MAIN world、`document_start`，无中间注入层 |
| 全局/域名开关 | 保留 | 一份规范化设置同时生成网络和页面规则 |
| 第三方接收方单独旁路 | 删除 | 会让同一顶层导航内的 GPC 值不一致，违背规范缓存语义 |
| Topics 退出 | 修正后保留 | Chrome 原生 Privacy API；不把响应策略伪装成请求头 |
| 顶层/资源域名列表 | 保留 | 顶层导航一次写入；资源域仅在用户打开弹窗时采样 |
| well-known 检查 | 修正后保留 | 按需请求，正确表述为支持声明 |
| 导入/导出/清空/主题 | 保留 | 原生 Web API，无第三方库 |
| 州合规 CSV 与“可能合规”结论 | 删除 | 非 GPC 信号核心、体积/网络/隐私成本高，且不能证明实际合规 |
| `webRequest`/`webNavigation` 全量分析 | 删除 | 不进入每个请求的扩展 JS 热路径 |
| DNT、opt-out cookie、USPAPI、分析模式残留 | 删除 | 当前产品已不需要 |
| Firefox 共用构建 | 暂不做 | 先把 Chrome 语义和验证做实；以后用独立适配层评估 |

删除合规数据功能不是缺功能：它既不是 OptMeowt README 所描述的两个核心退出机制，也不能可靠回答网站是否依法处理了某次 GPC 请求。Let's GPC 保留可由网站自己发布、规范定义的 well-known 支持声明，同时拒绝把声明升级成法律结论。

## 3. 行为模型

### 全局启用

- DNR 规则对 HTTP(S) 请求与 WebSocket 握手执行 `set Sec-GPC: 1`。
- 顶层 HTTP(S) 文档在第一段页面脚本前获得只读 `navigator.globalPrivacyControl` getter。
- 若 Topics 开关启用，扩展把 Chrome 的全局 Topics setting 设置为 `false`。

### 域名例外

一份 `disabledHosts` 同时用于：

- `excludedTopDomains`：在该域名作为顶层站点时，整个导航上下文的请求都不添加信号；
- content script `excludeMatches`：该域名作为顶层页面时不暴露 JS 属性。

这是一个明确的“此域名及子域作为顶层网站时，整个页面上下文不发送本扩展信号”模型，不是模糊的 URL 子串匹配。非例外顶层页发往任何资源域的请求仍携带 GPC，保持同一导航上下文一致；资源列表里的开关只是方便配置该域名未来作为顶层网站时的行为。国际化域名保存为 punycode；父域例外覆盖子域但不覆盖相似兄弟域。

站点例外变更后提示刷新，因为旧页面已经执行过的页面脚本无法倒转；新网络请求的 DNR 规则会立即更新。

### Topics

`blockTopics=true` 且总开关启用时调用 `topicsEnabled.set(false)`；任何一个关闭时调用 `clear()`，释放本扩展的 override。UI 随后读取实际值与 `levelOfControl`，不会把由用户、政策或其他扩展造成的关闭冒充成本扩展的功劳。

## 4. 组件

| 文件 | 职责 | 常驻性 |
| --- | --- | --- |
| `core.js` | 纯函数、验证、规则生成、导入规范化 | 被需要时加载 |
| `gpc.js` | 不到 0.5 KiB 的页面 getter 注入 | 每个允许的顶层文档执行一次 |
| `background.js` | 设置对账、域名记录、消息处理、badge | 事件型 service worker |
| `popup.*` | 当前站点、信号实测、按需资源/声明检查 | 用户打开时 |
| `options.*` | 域名管理、导入导出、边界说明 | 用户打开时 |

没有 content-script bridge、web-accessible resource、IndexedDB、PSL 库、模板引擎或打包器。

## 5. 权限

| 权限 | 唯一用途 |
| --- | --- |
| `declarativeNetRequestWithHostAccess` | 在已有 host access 范围内设置请求头 |
| `scripting` | 注册 MAIN-world 页面脚本，并在 popup 打开时读取当前页面状态/Resource Timing |
| `storage` | 保存设置、例外和最小域名记录 |
| `privacy` | 通过 Chrome 原生 setting 关闭 Topics |
| `http://*/*`, `https://*/*`, `ws://*/*`, `wss://*/*` | 覆盖网页请求与 WebSocket 握手；不申请 file、tabs、history、cookies 或 `<all_urls>` |

Chrome 仍会把 HTTP(S) host access 显示为强权限；这是向所有网站添加请求头和页面属性的功能边界，不能用文案掩盖。

## 6. 数据与隐私

`chrome.storage.local` 只保存：

- `settings`：总开关、Topics、主题、例外 hostname 数组；
- `domain:<hostname>`：`[lastSeen, flags]`，flags 只表示顶层页面/资源域来源。

唯一域名总上限为 5,000 条。达到上限后，新的显式例外会淘汰最旧的非例外历史；如果全是受保护例外则明确拒绝，不会静默成功。设置页只渲染最近或匹配搜索的前 500 行，搜索仍覆盖全部记录。导入文件上限 8 MB；先解析和验证全部 hostname、时间戳、flags、设置，再写入并重建规则。失败时恢复旧设置和域名记录。导出由 service worker 的同一串行队列生成实时快照，不依赖设置页可能过期的内存状态。

自动记录跳过隐身标签页。没有完整 URL、路径、查询参数、请求头、响应头或页面内容持久化。设置 storage access level 为 `TRUSTED_CONTEXTS`，页面 MAIN-world 脚本不能直接读取扩展数据。

唯一按需外联是用户打开 popup 时访问当前 origin 自己的 `/.well-known/gpc.json`；使用 `credentials: omit`、拒绝重定向和 2.5 秒超时，避免站点把检查带到第三方 origin。项目没有第一方后端。
代价是只通过重定向发布的有效支持声明会显示为未知；这是有意选择的隐私边界，不影响 GPC 信号本身。

## 7. 性能预算

- 动态网络规则：1 条。
- 注册页面脚本：0 或 1 条。
- 每个网络请求的扩展 JS：0。
- 每次顶层 URL 变更：最多 1 次小型本地写入和 badge 更新。
- 每次 popup 打开：1 次页面快照；最多 1 次当前 origin 的 well-known 请求。
- 生产 npm 依赖：0。
- 压缩包目标：低于 50,000 B；当前 35,713 B，由打包脚本硬性检查。
- 运行时文本目标：低于 100,000 B；当前 64,280 B，由 manifest 测试硬性检查。
- 域名列表 DOM：最多 500 行；本地存储最多 5,000 个唯一域名。

## 8. 无法规避的边界

- MV3 没有在 Dedicated/Shared/Service Worker 启动前注入脚本的 API，因此无法补齐规范要求的 `WorkerNavigator.globalPrivacyControl`。
- 为保持例外的顶层语义，当前不向 sub frame 注入页面属性；网络头仍覆盖其进入网络栈的请求。
- 全局关闭或顶层站点例外时不注入 polyfill，因此页面读到 `undefined`；这不同于完整原生实现按规范返回布尔值 `false`。
- 设置或站点例外变更会立即更新 DNR，而旧文档里的页面属性只能等顶层刷新后更新；popup 会提示刷新，但扩展无法完全复刻规范的浏览上下文缓存语义。
- Service Worker/CacheStorage 直接返回而未进入网络栈的内容没有新的请求可修改。
- WebTransport/HTTP3、扩展冲突、企业策略、用户收窄 host access 和受限 Chrome 页面必须作为单独兼容性边界，不宣称绝对覆盖。
- Chrome 后续原生 GPC 已进入 Chromium main 的 feature flag 阶段；稳定版真正提供可控原生实现后，应优先迁移而不是永久维护 polyfill。

## 9. 验证门槛

合入或发布前必须全部满足：

1. `node --test` 全绿且没有跳过当前平台的 Chrome 集成测试。
2. 真实本地服务器收到主导航、同源子资源、跨域子资源的预期 header；原始 header 列表中只有一个值 `1`。
3. 第一段 inline script 读到布尔 `true`，而例外页面读到 `undefined`。
4. 跨域验证必须证明非例外页面的第三方请求仍携带头，而顶层例外会一致旁路整页，不能只检查规则 JSON。
5. Topics set/clear 和 `levelOfControl` 有真实 Chrome 结果。
6. popup/options 无初始化错误；真实点击站点开关，并保存真实浏览器截图人工检查。
7. manifest 权限白名单、无远程脚本、无 source map、体积预算由测试锁定。
8. 打包 ZIP 解压后重跑 manifest/静态检查；商店提交包不得带测试、设计源文件或截图。

当前真实 Chrome 矩阵已覆盖 WebSocket、Worker fetch、IPv6、localhost 子域、并发设置更新、动态脚本清空、严格导入和极限列表渲染。后续增强只有在有证据且不进入请求热路径时加入；Chrome 原生 GPC 稳定后优先迁移。州合规数据和常驻流量分析不进入路线图。

## 10. 官方依据

- [W3C GPC Working Draft](https://www.w3.org/TR/gpc/)
- [Chrome DNR API](https://developer.chrome.com/docs/extensions/reference/api/declarativeNetRequest)
- [Chrome content scripts](https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts)
- [Chrome Scripting API](https://developer.chrome.com/docs/extensions/reference/api/scripting)
- [Chrome Privacy API](https://developer.chrome.com/docs/extensions/reference/api/privacy)
- [Chrome Permissions Policy](https://developer.chrome.com/docs/privacy-security/permissions-policy)
- [OptMeowt official repository](https://github.com/privacy-tech-lab/gpc-optmeowt)
- [Chromium native GPC landing commit](https://chromium.googlesource.com/chromium/src/+/9f6110d690bed64b39bb85adf99cd5343924cdff)
