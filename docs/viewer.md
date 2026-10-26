# Viewer features

Morsel renders GitHub Flavored Markdown, syntax highlighting, KaTeX, Mermaid, and Vega-Lite charts. It offers system-aware light and dark modes plus Sepia, Sage, and Midnight reader themes. Authored HTML is disabled and output is sanitized; see the [security model](design.md#security-model).

## Authentication and management

Management uses three authenticated routes: `/manage/shares`, `/manage/api-keys`, and `/account` (Security). Signed-out visits go to `/login`; management navigation is hidden until sign-in completes. Login shows a Passkey button and a link to `/recover`, not a recovery form.

Initial setup uses `/setup` only while the server reports that setup is required. Later accounts register at `/invite` with a one-use operator invitation. Account display name and passkey name are separate fields. Display names need not be unique; the account UUID is the stable identity. The first account has no access to other accounts' management data. Recovery at `/recover` uses an account-targeted operator token and a replacement passkey. It replaces that account's passkeys and invalidates its other sessions, but does not revoke its API keys or affect other accounts.

Authentication links preserve the destination in `?next=`. Only the three exact management paths above are accepted. Missing, repeated, or invalid values use `/manage/shares`. Setup, invitation registration, and recovery also return to this destination. Tokens and credentials belong in forms, never in URLs.

Automatic redirects replace the current history entry. Session expiry clears private UI state and sends the user to login with the current management destination. Successful logout goes to `/login` with Shares as the default destination. Failed logout reports an error without claiming success. Network failures during the initial account check show a retry control rather than a login form.

The Go server serves all four authentication paths on direct visits and refreshes. Configure reverse proxies to bypass caching for these paths, including query-string variants, as for management pages.

The account menu shows the current account identity. To switch accounts, log out, then select the intended passkey at login. A server-derived `X-Morsel-Account-ID` marker on successful private browser responses binds data to the authorized account; it is not a request selector. Missing or mismatched markers discard the response and refresh identity without replaying a mutation. Identity changes clear share lists, Markdown details, saved links, cursors, filters, confirmations, pending operations, and one-time keys. Secret-free `BroadcastChannel` events invalidate other tabs after login, registration, recovery, and logout. Focus and visibility restoration also refresh identity. These checks supplement server authorization and CSRF validation; they do not replace them.

Management shows only the current account's shares. Public capability reads, previews, and Instant View remain available to anyone with a valid capability, regardless of the signed-in account. Public responses contain no account identity.

## Mermaid diagram controls

Mermaid diagrams open fitted to the available space without upscaling. Use **Reset zoom** to restore a readable size, which may crop a large diagram, or **Fit to screen** to display the entire diagram. Pan by dragging or using the arrow keys. Zoom with the toolbar, `+`/`-`, or `Ctrl`/`Command` plus the mouse wheel. Press `0` to fit the diagram.

Fullscreen uses the browser API when available and an in-page fallback otherwise. Inline one-finger gestures continue scrolling the document. In fullscreen, one finger pans and two fingers pan and zoom. Escape closes fallback fullscreen and returns focus to the control that opened it.

The toolbar can show or copy source, copy or download sanitized SVG, and create a local PNG. PNG output is limited to 8,192 pixels per dimension and 16 million pixels. Export never calls an external rendering service. Diagrams rerender for light and dark appearances while retaining the last successful SVG if a theme refresh fails.

Diagrams near the viewport render on demand. Failed renders preserve their source and expose **Retry diagram**. Morsel allows up to 20 diagrams per document and 50 KiB of UTF-8 source per diagram. Rendering is sequential and uses Mermaid's `securityLevel: "strict"`, `htmlLabels: false`, and DOMPurify SVG sanitation.

## Vega-Lite charts

Fenced `vega-lite` blocks containing JSON render as SVG charts near the viewport and rerender for light and dark appearances. Charts use the same fit, zoom, pan, fullscreen, source, copy, SVG export, and PNG export controls as Mermaid diagrams. Morsel allows up to 20 charts per document, 20 repeated views per chart, and 50 KiB of UTF-8 source per chart.

Chart data must be inline. The viewer disables Vega-Lite external data, image, and link resources, expansive data generators and transforms, authored embed options, tooltips, and action menus.
