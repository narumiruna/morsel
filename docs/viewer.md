# Viewer features

Morsel renders GitHub Flavored Markdown, syntax highlighting, KaTeX, Mermaid, and Vega-Lite charts. It offers system-aware light and dark modes plus Sepia, Sage, and Midnight reader themes. Authored HTML is disabled and output is sanitized; see the [security model](design.md#security-model).

## Authentication and management

Management uses `/manage/shares`, `/manage/api-keys`, `/account` (Security), and admin-only `/manage/invitations` (Invitations). Signed-out visits go to `/login`; management navigation is hidden until sign-in completes. Login shows a Passkey button and a link to `/recover`, not a recovery form.

Initial setup uses `/setup` only while the server reports that setup is required and creates an `admin`. Later accounts register as `user` at `/invite` with a one-use admin link or operator token. **Invitation token**, **Account name**, **Passkey name**, and **Create account** remain the registration labels; there is no role choice. Display names need not be unique; the account UUID is the stable identity. Neither role has access to other accounts' management data. Recovery at `/recover` uses an account-targeted operator token and a replacement passkey. It replaces that account's passkeys and invalidates its other sessions, but preserves its role and does not revoke its API keys or affect other accounts.

Authentication links preserve the destination in `?next=`. Only the four exact management paths above are accepted. Missing, repeated, or invalid values use `/manage/shares`. Setup, invitation registration, and recovery also return to this destination. Setup/recovery tokens and credentials belong in forms, never in URLs. Only invitation tokens can enter through `/invite#token=<43-character base64url token>`; no grant token is accepted in a query or path.

Automatic redirects replace the current history entry. Session expiry clears private UI state and sends the user to login with the current management destination. Successful logout goes to `/login` with Shares as the default destination. Failed logout reports an error without claiming success. Network failures during the initial account check show a retry control rather than a login form.

The Go server serves all four authentication paths on direct visits and refreshes. Configure reverse proxies to bypass caching for these paths, including query-string variants, as for management pages.

The account menu shows the current account identity. To switch accounts, log out, then select the intended passkey at login. A server-derived `X-Morsel-Account-ID` marker on successful private browser responses binds data to the authorized account; it is not a request selector. Missing or mismatched markers discard the response and refresh identity without replaying a mutation. Identity changes clear share lists, Markdown details, saved links, cursors, filters, confirmations, pending operations, one-time keys, and invitation links. Secret-free `BroadcastChannel` events invalidate other tabs after login, registration, recovery, and logout. Focus and visibility restoration also refresh identity. These checks supplement server authorization and CSRF validation; they do not replace them.

Management shows only the current account's shares. Public capability reads, previews, and Instant View remain available to anyone with a valid capability, regardless of the signed-in account. Public responses contain no account identity.

### Invitations

An authenticated `/v1/account` response includes the database `role` (`admin` or `user`); signed-out responses omit it. Admins see **Invitations** and the **Manage invitations** heading. Users do not see the entry, and direct visits show access denied without redirect loops. API keys alone, even admin-owned keys, cannot create invitations.

Select **Create invitation link**, complete fresh verification if requested, then use **Copy link** or the **Invitation link** textbox for manual copying. Copy success requires clipboard completion. A link is shown once; **Dismiss invitation link** is required before creating another. Navigation warns before discarding an undismissed link. The viewer keeps it only in section memory and clears it on exit, logout, identity change, role loss, or an obsolete response. Current-identity, role, and response-marker checks discard obsolete responses and prevent starting a clipboard write after detected account or permission loss. A native write already started while authorized cannot be cancelled; logout does not erase clipboard contents. Late acknowledgements do not report success or start another write. A failed or uncertain mutation is never replayed automatically; explicit retry can create a new independent link.

Admins manually deliver these forwardable bearer links. They expire after one hour and work once; there is no SMTP, email binding, person verification, invitation list, or revocation. Dismissal, issuer logout, and issuer recovery do not revoke them. Every recipient becomes a user, including operator-issued invitations. Role editing, user directories, and invitations that create admins are not available.

The viewer accepts exactly one unescaped, canonical 43-character base64url fragment token, rejects duplicate/unknown fields or malformed encoding, and immediately replaces the current history entry with clean `/invite` before redirects or shared navigation can retain it. The token stays only in invitation-flow memory, not `history.state`, `next`, local/session storage, IndexedDB, telemetry, or automatic clipboard copies. Back/Forward, rerenders, and route changes cannot restore it from shared state. The prefilled form requires explicit **Create account**; only the existing POST body sends the token. Opening the page or fetching a preview does not consume it. Submission, success, unmount, or account change clears it; reload or cancellation can require reopening the original link. Cancellation does not consume the grant.

Signed-in recipients see instructions to log out or use a private window, then reopen the original link. There is no silent registration, account switch, or invitation persistence across logout. Both invite begin and finish reject a valid signed-in session with `409 sign_out_required` without consuming the grant or overwriting the session. Expired/invalid cookies may proceed; database errors fail closed. Invalid, expired, used, or concurrently redeemed grants use the existing generic invalid-grant response.

Fragment cleanup cannot erase message previews, URL rewriting, retained external copies, or browser history copies made before cleanup. Real messaging behavior and supported physical passkeys remain deployment checks, not behavior established by virtual authenticators.

## Mermaid diagram controls

Mermaid diagrams open fitted to the available space without upscaling. Use **Reset zoom** to restore a readable size, which may crop a large diagram, or **Fit to screen** to display the entire diagram. Pan by dragging or using the arrow keys. Zoom with the toolbar, `+`/`-`, or `Ctrl`/`Command` plus the mouse wheel. Press `0` to fit the diagram.

Fullscreen uses the browser API when available and an in-page fallback otherwise. Inline one-finger gestures continue scrolling the document. In fullscreen, one finger pans and two fingers pan and zoom. Escape closes fallback fullscreen and returns focus to the control that opened it.

The toolbar can show or copy source, copy or download sanitized SVG, and create a local PNG. PNG output is limited to 8,192 pixels per dimension and 16 million pixels. Export never calls an external rendering service. Diagrams rerender for light and dark appearances while retaining the last successful SVG if a theme refresh fails.

Diagrams near the viewport render on demand. Failed renders preserve their source and expose **Retry diagram**. Morsel allows up to 20 diagrams per document and 50 KiB of UTF-8 source per diagram. Rendering is sequential and uses Mermaid's `securityLevel: "strict"`, `htmlLabels: false`, and DOMPurify SVG sanitation.

## Vega-Lite charts

Fenced `vega-lite` blocks containing JSON render as SVG charts near the viewport and rerender for light and dark appearances. Charts use the same fit, zoom, pan, fullscreen, source, copy, SVG export, and PNG export controls as Mermaid diagrams. Morsel allows up to 20 charts per document, 20 repeated views per chart, and 50 KiB of UTF-8 source per chart.

Chart data must be inline. The viewer disables Vega-Lite external data, image, and link resources, expansive data generators and transforms, authored embed options, tooltips, and action menus.
