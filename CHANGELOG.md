# @narumitw/morsel

## 0.4.1

### Patch Changes

- 58bde0f: Update Vega Embed to 7.4.0 in the viewer.

## 0.4.0

### Minor Changes

- 336cb31: Extract a reusable diagram viewer workspace configured for public npm access.
  Provide composable React controls, shared action bindings, scoped styles, and a
  renderer-independent browser core.
  Keep Mermaid and Vega-Lite rendering in Morsel and preserve existing source,
  camera, fullscreen, and export controls.

### Patch Changes

- bdfd97c: Preserve keyboard focus on share pagination controls while loading and block repeated navigation.
- 527628e: Support diagram-viewer package changesets alongside repository changesets. Keep
  Morsel tags, container publication, and deployment separate from npm publication.

## 0.3.1

### Patch Changes

- 4341cb8: Fix Markdown math and footnote rendering, chart input and zoom controls, and account loading after failed logout.
- 0745513: Update Go dependencies and patch Go toolchains for GO-2026-6859.

## 0.3.0

### Minor Changes

- 362f181: Add a Settings page for saved themes and Mermaid styles while keeping diagram toolbars consistent.

### Patch Changes

- 1aa156e: Group Appearance, API keys, Security, and Invitations under Settings, and move Shares to the main navigation.

## 0.2.1

### Patch Changes

- 0311d7b: Update Mermaid and npm development dependencies.

## 0.2.0

### Minor Changes

- 143f0b7: Add Streamable HTTP MCP support.
- 0f8ee7e: Add native MCP OAuth with passkey consent, rotating refresh tokens, and connected-app revocation while preserving API-key clients.

## 0.1.2

### Patch Changes

- 94a54ec: Update KaTeX and viewer development dependencies.

## 0.1.1

### Patch Changes

- e336780: Automatically prepare Changesets version pull requests and publish one repository tag, container, and GitHub release without versioning or publishing npm workspaces.
