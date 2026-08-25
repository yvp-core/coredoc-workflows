## UI surface setup

Select the runtime before testing:

- An explicit desktop, Electron, or native-app request selects the real Electron
  surface. Apply the generic `electron-qa` workflow through the Coredoc adapter:
  set `D="<plugin-root>/bin/coredoc-workflows coredoc-desktop"` and run `$D doctor`.
  The development app must be started with
  `COREDOC_DESKTOP_QA_PORT=9333`. Opening its renderer URL in Chrome is not a
  valid substitute because preload and IPC would be absent.
- An explicit URL or web request selects a browser. Prefer a host-provided
  browser controller when it already owns the user's signed-in session;
  otherwise use the bundled browser below.
- In diff-aware mode, changes under `apps/desktop` select Electron and changes
  under `apps/web` select web. Ask only when both surfaces changed and the
  requested acceptance path does not resolve the ambiguity.

When Electron is selected, later generic `$B` examples describe intent rather
than the driver: use the corresponding `$D snapshot`, `$D click`,
`$D fill`, `$D screenshot`, and `$D console` commands. Do not navigate to
the renderer dev-server URL, and mark browser-only checks such as responsive
viewports or browser history as not applicable unless the desktop feature embeds
a real web surface.

For Electron, the app itself owns authentication through its safeStorage-backed
session. For web, the selected browser owns its cookie session. Never inspect,
decrypt, copy, or print credential files, cookies, local storage, access tokens,
or refresh tokens. If human authentication is required, use the normal UI and
hand OAuth, MFA, CAPTCHA, or native dialogs to the user.
