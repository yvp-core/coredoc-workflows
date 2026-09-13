## Search before building

Search repository code before adding a mechanism. Search external documentation
only when the reviewed work or recommended fix proposes custom
infrastructure/concurrency machinery or relies on an unfamiliar,
version-sensitive API. Check whether the current runtime has a built-in and
whether it satisfies the accepted requirement.

Check reuse in this order and stop at the first option that meets the actual
contract: an existing repository helper, the standard library, a native platform
feature, then an already-installed dependency. Build only the remaining behavior.
Prefer fixing the shared cause over repeating a guard in every caller. Verify
semantics and supported versions before substituting a built-in; fewer lines do
not justify removing validation, error handling, accessibility, or tests.

Use the result to remove duplicate machinery or validate a load-bearing choice;
do not turn the search into an alternative-technology survey. When no search tool
is available, mark the version-sensitive claim unverified rather than presenting
memory as evidence.
