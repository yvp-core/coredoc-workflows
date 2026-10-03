## UI surface setup

Select the runtime before testing:

- An explicit desktop, Electron, or native-app request selects the real Electron
  surface. Follow `coredoc-desktop`, which applies the generic `electron-qa`
  workflow through the Coredoc adapter:
  define `D() { "<plugin-root>"/bin/coredoc-workflows coredoc-desktop "$@"; }`
  in each command and run `D doctor`.
  The development app must be started with
  `COREDOC_DESKTOP_QA_PORT=9333`. Opening its renderer URL in Chrome is not a
  valid substitute because preload and IPC would be absent.
- An explicit URL or web request selects a browser. Prefer a host-provided
  browser controller when it already owns the user's signed-in session;
  otherwise use `coredoc-browse`, the bundled browser below.
- In diff-aware mode, changes under `apps/desktop` select Electron and changes
  under `apps/web` select web. Ask only when both surfaces changed and the
  requested acceptance path does not resolve the ambiguity.

With Electron selected, later `B` examples state intent: run the matching
`D snapshot`, `D click`, `D fill`, `D screenshot` or `D console` instead, and
mark browser-only checks such as responsive viewports or browser history not
applicable unless the feature embeds a real web surface.

For Electron, the app itself owns authentication through its safeStorage-backed
session. For web, the selected browser owns its cookie session. Never inspect,
export, decrypt, copy, or print credential files, cookies, local storage,
browser profiles, password stores, access tokens, or refresh tokens. If human
authentication is required, use the normal UI and hand OAuth, MFA, CAPTCHA, or
native dialogs to the user.
