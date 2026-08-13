# Let's GPC

[![Release](https://img.shields.io/github/v/release/WenliangCao/lets-gpc)](https://github.com/WenliangCao/lets-gpc/releases)
[![Tests](https://github.com/WenliangCao/lets-gpc/actions/workflows/test.yml/badge.svg)](https://github.com/WenliangCao/lets-gpc/actions/workflows/test.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

**English** | [简体中文](README.zh-CN.md)

A zero-dependency Manifest V3 extension for Chrome 145+ that turns one clear privacy preference into a small, auditable browser signal: Global Privacy Control, explicit top-level site exceptions, and Chrome Topics opt-out.

Let's GPC is not yet published in the Chrome Web Store. Download the latest package from [GitHub Releases](https://github.com/WenliangCao/lets-gpc/releases), or load the source directory directly.

## What is GPC?

Global Privacy Control (GPC) is a standardized way for a person to tell websites and services: **please do not sell or share my personal information with third parties, and do not use it for cross-context targeted advertising**.

The signal is deliberately simple:

- An HTTP request carries `Sec-GPC: 1`.
- Page JavaScript can read `navigator.globalPrivacyControl === true`.
- The preference belongs to the user's browser context, rather than being reselected on every website.

The [W3C GPC specification](https://www.w3.org/TR/gpc/) describes this as a user preference signal that websites and services can process in the context of applicable law and their relationship with the user. It does not turn a browser into a legal enforcement system.

### What GPC is not

GPC is not an ad blocker, cookie cleaner, consent-banner auto-clicker, or data-deletion request. It does not promise that every website will honor the preference, and it does not exercise every privacy right in every jurisdiction. It communicates intent; the recipient determines the response it is required or willing to make.

## Why does a browser need an extension for this?

Modern pages are assembled from the site you opened plus analytics, CDNs, embedded media, payment systems, advertising technology, and other services. Asking a person to find and repeat a privacy opt-out on every site does not scale—the W3C specification calls this kind of burden “privacy labor.” A universal signal exists to make one browser-level choice reusable.

The practical problem is that a user also needs a dependable control surface. A site-level toggle cannot add a browser request header to every navigation and subresource, a page script cannot control the browser's network stack, and a network-only switch does not expose the DOM value websites may inspect. Chrome's extension APIs provide the narrow bridge between these layers:

1. A visible switch records the user's preference locally.
2. Chrome's declarative network layer sends `Sec-GPC: 1` without running extension JavaScript for every request.
3. A `document_start` MAIN-world script exposes the page-side value where the extension API permits it.
4. Chrome's native privacy setting can disable Topics at browser level.
5. A top-level site exception lets the user express a different preference for a whole browsing context.

That is the motivation for Let's GPC: make a browser-wide privacy preference observable and controllable in one place, while keeping the implementation small enough to inspect and the behavior honest about what a Chrome extension cannot do.

## Why Let's GPC?

The project is intentionally focused on the signal itself. It does not build a legal-compliance database, upload browsing data, inspect full request histories, or download remote rule sets. The extension should be quiet when the browser is browsing and active only when a setting, navigation, or UI action requires it.

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

The release ZIP stays below 50 KB, enforced by the packaging script and tests.

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

The test suite combines pure-function and manifest checks with a real-Chrome integration test covering the network signal, page API, site exceptions, Topics controls, storage workflows, localized UI, and release-package constraints.

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

## Privacy

Read the public [Let's GPC Privacy Policy](https://wenliangcao.github.io/lets-gpc/). The extension has no telemetry or developer-operated backend; its limited domain records and settings stay in Chrome local storage.

## Primary references

- [W3C Global Privacy Control](https://www.w3.org/TR/gpc/)
- [Global Privacy Control project](https://globalprivacycontrol.org/)
- [Chrome Declarative Net Request API](https://developer.chrome.com/docs/extensions/reference/api/declarativeNetRequest)
- [Chrome Scripting API](https://developer.chrome.com/docs/extensions/reference/api/scripting)
- [Chrome Privacy API](https://developer.chrome.com/docs/extensions/reference/api/privacy)
- [Chrome Permissions Policy](https://developer.chrome.com/docs/privacy-security/permissions-policy)
