# Let's GPC

[![Release](https://img.shields.io/github/v/release/WenliangCao/lets-gpc)](https://github.com/WenliangCao/lets-gpc/releases)
[![Tests](https://github.com/WenliangCao/lets-gpc/actions/workflows/test.yml/badge.svg)](https://github.com/WenliangCao/lets-gpc/actions/workflows/test.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

**English** | [简体中文](README.zh-CN.md)

A zero-dependency Manifest V3 extension for Chrome 145+ that implements the Global Privacy Control signal, explicit top-level site exceptions, and Chrome Topics opt-out with minimal runtime overhead.

Let's GPC is not yet published in the Chrome Web Store. Download the latest package from [GitHub Releases](https://github.com/WenliangCao/lets-gpc/releases), or load the source directory directly.

## Features

- Sets `Sec-GPC: 1` in Chrome's network stack with one dynamic DNR rule and no per-request extension JavaScript.
- Exposes `navigator.globalPrivacyControl === true` in the MAIN world at `document_start` on supported top-level pages.
- Provides global and current-site controls with exceptions scoped to the top-level browsing context.
- Disables Topics through Chrome's native `privacy.websites.topicsEnabled` setting instead of inventing a `Permissions-Policy` request header.
- Records visited top-level domains locally; resource domains are read from existing Resource Timing entries only when the popup opens.
- Checks the current origin's `/.well-known/gpc.json` only on demand, rejects redirects, and treats it as a support declaration rather than proof of compliance.
- Supports domain search, enable/disable, forget, clear, strictly validated import, and consistent queued export.
- Supports English and Simplified Chinese through Chrome's native localization system. English is the default; the UI follows the browser language.
- Supports system, dark, and light themes and skips automatic domain-history recording in incognito windows.
- Caps local storage at 5,000 unique domains and renders at most 500 rows while still searching the complete local list.

## Size and runtime model

The unpacked release is 108,489 B and the release ZIP is 45,086 B. Runtime text is 83,136 B across 20 packaged files, including both locales and the Apache license notices.

There are no npm runtime dependencies, bundlers, source maps, remote code, telemetry, ads, or remote configuration. Chrome executes the single declarative network rule itself. The event-driven service worker does not subscribe to `webRequest`, `webNavigation`, or response events; it wakes only for installation, startup, setting changes, top-level URL changes, and UI messages.

## Install locally

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Select **Load unpacked**.
4. For a source install, select this repository's `extension` directory. For a release install, extract `lets-gpc.zip` and select the extracted directory.

Chrome 145 is the minimum version because site exceptions rely on `excludedTopDomains`, introduced in that version.

## Verify and package

No dependency installation is required:

```sh
npm test
npm run package
```

The test suite combines pure-function and manifest checks with a real-Chrome integration test. It verifies navigation and subresource headers, the earliest page-visible API value, top-level exception semantics, Topics set/clear behavior, WebSocket and Worker requests, IPv4/IPv6/localhost handling, concurrent mutations, strict import, live export snapshots, popup controls, the 500-row render cap, package contents, localization parity, and the absence of remote code.

Set `CHROME_BINARY` to use a specific Chrome/Chromium executable. Set `UI_SCREENSHOT_DIR` to save real rendered popup and options screenshots during the integration test.

## Explicit limitations

This extension does not claim to be a complete native browser implementation:

- Manifest V3 cannot inject `WorkerNavigator.globalPrivacyControl` before Dedicated, Shared, or Service Workers start. Their network requests are still covered when they enter Chrome's network stack.
- The page script is limited to supported top-level HTTP(S) documents so site-exception behavior remains coherent; subframe Navigator properties are outside the extension's guarantee.
- When globally disabled or excluded for a top-level site, the extension does not expose the property, producing `undefined` rather than the `false` required from a complete native implementation.
- Network-rule changes apply immediately, but an already-open document needs a reload before its page property changes. The popup reports this mismatch.
- Chrome internal pages, the Web Store, other extension pages, narrowed site access, enterprise policy, or another extension can prevent or alter the observable result.
- A valid `/.well-known/gpc.json` is a site's public declaration, not proof that a specific request was handled lawfully. Redirect-only declarations intentionally appear as unknown.

Let's GPC expresses a technical privacy preference. It does not provide legal advice or a compliance guarantee.

## Design position

The project deliberately excludes state-law CSV datasets, legal-compliance scoring, full request/response logging, remote rules, and recipient-domain exceptions. Those features are not required to send GPC and would add network traffic, storage churn, permissions, or inconsistent signal semantics. The result is narrower than feature-heavy privacy dashboards but complete for its stated Chrome GPC and Topics scope.

## License

Licensed under the [Apache License 2.0](LICENSE). It includes an explicit contributor patent grant and patent-litigation termination provision. Apache-2.0 also permits commercial use and redistribution when its conditions are followed.

## Primary references

- [W3C Global Privacy Control](https://www.w3.org/TR/gpc/)
- [Chrome Declarative Net Request API](https://developer.chrome.com/docs/extensions/reference/api/declarativeNetRequest)
- [Chrome Scripting API](https://developer.chrome.com/docs/extensions/reference/api/scripting)
- [Chrome Privacy API](https://developer.chrome.com/docs/extensions/reference/api/privacy)
- [Chrome Permissions Policy](https://developer.chrome.com/docs/privacy-security/permissions-policy)
