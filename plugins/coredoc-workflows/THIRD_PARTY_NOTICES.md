# Third-party notices

## Bun 1.3.14

The plugin bundles the official `bun-darwin-aarch64` executable from Bun
`1.3.14` as its JavaScript runtime.

- Upstream: https://github.com/oven-sh/bun
- Release: https://github.com/oven-sh/bun/releases/tag/bun-v1.3.14
- Source revision: `0d9b296af33f2b851fcbf4df3e9ec89751734ba4`
- Runtime provenance: [`runtime/bun/provenance.json`](runtime/bun/provenance.json)
- Upstream license and linked-library notices:
  [`runtime/bun/LICENSE.md`](runtime/bun/LICENSE.md)

Bun itself is MIT-licensed and the official executable statically links
components under additional licenses, including LGPL-covered WebKit/
JavaScriptCore. The bundled upstream license file contains the component
inventory and relinking instructions.

## Bun 1.1.13 in the compiled browser server

The browser server was compiled with Bun `1.1.13`, source revision
`bd6a6051203ff577240615ff4e242270035a36b7`. Its exact upstream license and
linked-library notices are preserved in
[`runtime/browse/BUN-LICENSE.md`](runtime/browse/BUN-LICENSE.md).

The executable's own provenance file explicitly records that the original
source closure and build environment were not archived, so its build is not
claimed to be reproducible. Any replacement is treated as a new artifact with a
new digest and independent review.

## gstack

The workflow methods in `skills/*/SKILL.md.tmpl`, the shared partials in
`resources/methodology/`, the review checklist and specialist references in
`resources/`, the redaction taxonomy in `scripts/lib/`, and the compiled browser
server in `runtime/browse/` all derive from **gstack**.

- Upstream: https://github.com/garrytan/gstack.git
- Derived from version `1.60.1.0`, revision `a3259400a366593e0c909dd9ac3e59752efd2488`
- Copyright (c) 2026 Garry Tan, MIT License (full text below)

**These files are a fork, not a vendored copy.** They were adapted and are now
maintained here directly: the upstream product coupling is gone (its telemetry,
cross-session brain, `~/.gstack` state, upgrade prompts, install detection, and
host-specific binaries), the authorization boundaries were rewritten for this
plugin, and the methods point at this repository's own resources. There is no
automatic upstream sync and no manifest tracking upstream hashes. Adopting a
future upstream improvement is a manual, deliberate diff — take the idea, not
the patch.

Editing these files freely is expected and does not need to preserve upstream
wording. The obligation that survives is the one below: the copyright notice and
permission notice stay with the work.

The security audit method carries credits of its own to roughly a dozen external
research projects, preserved in
[`resources/security-acknowledgements.md`](resources/security-acknowledgements.md).

The bundled `darwin-arm64` browser server is compiled from that same revision.
Its build command, toolchain, SHA-256 digest, and byte size are recorded in
[`runtime/browse/provenance.json`](runtime/browse/provenance.json) and verified
by the test suite.

### MIT License

Copyright (c) 2026 Garry Tan

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
