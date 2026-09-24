# Viewer features

Morsel renders GitHub Flavored Markdown, syntax highlighting, KaTeX, Mermaid, and Vega-Lite charts. It offers system-aware light and dark modes plus Sepia, Sage, and Midnight reader themes. Authored HTML is disabled and output is sanitized; see the [security model](design.md#security-model).

## Mermaid diagram controls

Mermaid diagrams open fitted to the available space without upscaling. Use **Reset zoom** to restore a readable size, which may crop a large diagram, or **Fit to screen** to display the entire diagram. Pan by dragging or using the arrow keys. Zoom with the toolbar, `+`/`-`, or `Ctrl`/`Command` plus the mouse wheel. Press `0` to fit the diagram.

Fullscreen uses the browser API when available and an in-page fallback otherwise. Inline one-finger gestures continue scrolling the document. In fullscreen, one finger pans and two fingers pan and zoom. Escape closes fallback fullscreen and returns focus to the control that opened it.

The toolbar can show or copy source, copy or download sanitized SVG, and create a local PNG. PNG output is limited to 8,192 pixels per dimension and 16 million pixels. Export never calls an external rendering service. Diagrams rerender for light and dark appearances while retaining the last successful SVG if a theme refresh fails.

Diagrams near the viewport render on demand. Failed renders preserve their source and expose **Retry diagram**. Morsel allows up to 20 diagrams per document and 50 KiB of UTF-8 source per diagram. Rendering is sequential and uses Mermaid's `securityLevel: "strict"`, `htmlLabels: false`, and DOMPurify SVG sanitation.

## Vega-Lite charts

Fenced `vega-lite` blocks containing JSON render as SVG charts near the viewport and rerender for light and dark appearances. Charts use the same fit, zoom, pan, fullscreen, source, copy, SVG export, and PNG export controls as Mermaid diagrams. Morsel allows up to 20 charts per document, 20 repeated views per chart, and 50 KiB of UTF-8 source per chart.

Chart data must be inline. The viewer disables Vega-Lite external data, image, and link resources, expansive data generators and transforms, authored embed options, tooltips, and action menus.
