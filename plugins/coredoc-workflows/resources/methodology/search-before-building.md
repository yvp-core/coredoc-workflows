## Search before building

Search repository code before adding a mechanism. Search external documentation
only when the reviewed work or recommended fix proposes custom infrastructure or
concurrency machinery or relies on an unfamiliar, version-sensitive API.

Reuse the first option that meets the actual contract, in this order: an
existing repository helper, the standard library, a native platform feature,
then an already-installed dependency. Build only the rest, and fix a shared
cause rather than repeating a guard in every caller. Verify semantics and
supported versions before substituting a built-in; fewer lines never justify
removing validation, error handling, accessibility, or tests.

Do not turn the search into a technology survey. Without a search tool, mark the
version-sensitive claim unverified rather than presenting memory as evidence.
