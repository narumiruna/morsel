# @narumitw/diagram-viewer

React diagram frame, composable controls, and browser-only core. It has no
Mermaid, Vega, Radix, or Morsel runtime dependency. Rendering stays in the host.
The verified React and React DOM version is **19.3.1**. License: AGPL-3.0-only.

## Install

```sh
npm install @narumitw/diagram-viewer
```

The package is public on npm. The verified React and React DOM version is
19.3.1. The host still owns rendering and SVG sanitation.

## Build and use

From the Morsel repository root:

```sh
npm ci
npm run build --workspace @narumitw/diagram-viewer
npm run ci --workspace @narumitw/diagram-viewer
npm run test:browser --workspace @narumitw/diagram-viewer
npm pack --workspace @narumitw/diagram-viewer --pack-destination /tmp
```

These commands only build, test, and pack the package. The packed-consumer check
installs the exact generated tarball in a temporary app. It does not publish it.

Import the stylesheet explicitly. Supply trusted or sanitized SVG, not arbitrary
author HTML:

```tsx
import { DiagramViewer } from "@narumitw/diagram-viewer"
import "@narumitw/diagram-viewer/styles.css"

const svg = '<svg viewBox="0 0 100 50"><text x="5" y="20">Example</text></svg>'

export function Example() {
  return (
    <DiagramViewer
      source="graph TD; A-->B"
      svg={svg}
      graphicName="Example diagram"
      filename="example"
      background="#ffffff"
    />
  )
}
```

The default toolbar order is zoom out, zoom percentage, zoom in, fit, reset,
fullscreen, source toggle, copy source, SVG download, and PNG download. A retry
button appears only when both `renderError` and `retryRender` are supplied.

## Compose controls

Select and order actions through children, not a configuration array. This
example omits the download actions, replaces a built-in icon, and uses an app
button with the same action/state rules:

```tsx
import {
  DiagramActionButton, DiagramRoot, DiagramSource, DiagramStatus,
  DiagramToolbar, DiagramViewport, DiagramZoom, useDiagramAction,
} from "@narumitw/diagram-viewer"

function AppZoomButton() {
  const binding = useDiagramAction("zoomIn")
  return <button {...binding} className="app-zoom"><span aria-hidden="true">+</span></button>
}

export function Composed({ source, svg }: { source: string; svg: string }) {
  return (
    <DiagramRoot source={source} svg={svg}>
      <DiagramToolbar>
        <DiagramActionButton action="source">Source</DiagramActionButton>
        <AppZoomButton />
        <DiagramZoom />
        <button type="button" onClick={() => console.log("app action")}>App action</button>
      </DiagramToolbar>
      <DiagramViewport />
      <DiagramSource />
      <DiagramStatus />
    </DiagramRoot>
  )
}
```

Keep exactly one viewport and source view mounted in each root. Include
`DiagramStatus` for polite action feedback and optionally `DiagramPanHint` for
cropping instructions. `DiagramDefaultToolbar` can be used in a composed root.
`DiagramToolbar` is a native fieldset, not an ARIA toolbar: Tab follows DOM order,
including custom controls. Arrow keys are camera shortcuts only on the viewport,
not on toolbar controls, editable elements, source, or live chart inputs.

`useDiagramAction(action)` returns native button props: `type`, `onClick`,
`disabled`, accessible name, busy state, and applicable toggle/control state.
Spread them onto a native button; do not replace its handler or state. A custom
visible label must also set a matching accessible name. `DiagramActionButton`
accepts children, an `aria-label`, a scoped class, and button presentation props.
Do not replace its built-in handler. Actions are:

```text
zoomOut zoomIn fit reset fullscreen source copy svg png retry
```

`useDiagramState()` exposes an immutable snapshot with exact scale bounds,
cropping, source visibility, fullscreen/fallback state, async action flags, and
status. It observes the same core controller used by all buttons. Zoom labels
are rounded for display; disabled bounds use the exact values.

## Host-owned chart mount

Use `hostManaged` when an imperative renderer owns the children. React never
updates those children. The host must finalize its renderer and remove its own
mount during cleanup:

```tsx
import { useEffect, useRef, useState } from "react"
import { DiagramViewer } from "@narumitw/diagram-viewer"

export function HostChart({ source }: { source: string }) {
  const stage = useRef<HTMLDivElement>(null)
  const [ready, setReady] = useState(false)
  useEffect(() => {
    const target = stage.current
    if (!target) return
    setReady(false)
    const mount = document.createElement("div")
    target.append(mount)
    // Replace with your local renderer. Never insert unsanitized author HTML.
    mount.innerHTML = '<svg viewBox="0 0 100 50"><text y="20">Chart</text></svg>'
    setReady(true)
    return () => mount.remove() // Also finalize your renderer here.
  }, [source])
  return <DiagramViewer source={source} hostManaged stageRef={stage} ready={ready} />
}
```

`ready: false` disables camera/export actions but keeps source access. Set it to
true after rendering. For replacements while `ready` remains true, change
`contentVersion` after the DOM update; this refreshes the camera. Changing `svg`
also refreshes the camera. Source mode and fullscreen retain the same SVG and
host mount. `refreshing`, `renderError`, and `retryRender` are host-owned render
state; retry execution is not a renderer plugin system.

When keeping a previous successful SVG during refresh, keep its export
`background` paired with it until a new render succeeds. `background` affects
PNG export, not CSS. `filename`, `graphicName`, `typeLabel` (such as `chart`),
`stageClassName`, and `className` let the host supply wording and presentation.

## Styles and accessibility

All default CSS is scoped to `ndv-` classes. Root CSS variables are
`--ndv-background`, `--ndv-foreground`, `--ndv-border`, `--ndv-control`,
`--ndv-radius`, and `--ndv-focus`. Set them on the root with `style`, or override
them in a stylesheet loaded after the package CSS. Choose foreground/background
pairs with sufficient contrast. No theme provider is needed.

Buttons have accessible names, visible focus, 44-pixel default targets, and
keyboard/pointer tooltips inside the viewer, including fullscreen. Source is a
named, keyboard-scrollable text region. Copy and export results use polite
status feedback. Inline touch scrolls the page; expanded touch pans/pinches.
Fit selects an overview; reset selects readable labels and can crop the image.

Fullscreen keeps the live DOM node. If the native API fails, the existing
in-place fallback isolates background siblings with `inert`, locks scroll
containers, and restores each affected inline axis declaration and its priority
on exit or unmount. It also returns focus to the opener. Escape and the fullscreen
button close fallback mode. A failed or late native request cannot reopen the
fallback after destruction.

## Framework-independent core

```ts
import { createDiagramController } from "@narumitw/diagram-viewer/core"

const controller = createDiagramController(
  { root, viewport, stage }, // mounted host DOM elements
  { source: "graph TD; A-->B", background: "#ffffff", filename: "diagram" },
)
const unsubscribe = controller.subscribe(() => console.log(controller.getState()))
controller.run("fit")
controller.update({ source: "new source", ready: true }) // full option replacement
controller.refresh() // after imperative stage changes
unsubscribe()
controller.destroy() // on unmount; releases listeners, gestures, and fullscreen
```

The core has no React or renderer imports and no import-time browser access. It
can be imported in Node.js; creating an instance, exports, clipboard, and
fullscreen require mounted browser DOM and supported browser APIs. The core
never populates the stage: the host owns its content. Use `getAction(action)`
for framework-independent accessible names and exact disabled/busy/toggle state.
Camera primitives, `createPngExport`, `serializeDiagramSvg`, and
`downloadDiagram` are also exported from `/core`. SVG serialization and PNG
helpers accept an explicit background color, defaulting to white.

## Trust, limits, and verification

This package is **not an untrusted HTML renderer**. Sanitize SVG before passing
`svg`. Keep resource policies, source limits, lazy rendering, renderer queues,
stale-result handling, and renderer finalization in the host. Source is text,
never HTML. The package loads no remote renderer, CDN, font, or resource.

SVG download uses the rendered markup directly. PNG separately serializes a
clone with natural dimensions and background; it does not alter the live SVG.
PNG limits are 8,192 pixels per dimension, 16 million pixels, and 16 MiB of
serialized SVG. Decode/encoding failures produce action feedback.

`npm run test:package --workspace @narumitw/diagram-viewer` packs built output,
checks the inventory, imports core without React/DOM, typechecks the consumer
examples, builds an isolated Vite consumer, and exercises it in Chromium.
The consumer installs exact tooling/React versions in a temporary directory and
removes it afterward. `ci` builds first, then runs this check. Chromium must be
installed with `npx playwright install chromium`; WSL launches use Wayland.
Automated interaction and accessibility checks cover desktop Chromium, not
physical touch devices or screen readers. Optional visual/device review remains
with the host application's owner. npm account setup, real publication, and
migrations in other apps remain separate owner actions.
Browser captures are ignored under `test-results/`. Automated Chromium checks do
not establish physical-device, screen-reader, or other-browser compatibility.

## Releases

Add a changeset for this package from the repository root:

```sh
npm run changeset -- add patch "Describe the package change." --package @narumitw/diagram-viewer
npm run changeset -- status
```

Use `minor` for features or `major` for breaking changes. The shared version PR
updates this package's version, changelog, and workspace dependency metadata.
The independent **Publish diagram-viewer** job in the **Publish** workflow
publishes new committed versions with public access and provenance. It skips
pending package changesets and versions already on npm. It does not create Morsel
tags or deploy the service.

The package owner must configure an npm trusted publisher for
`narumiruna/morsel`, workflow `release.yml`, with direct `npm publish` allowed.
See [public npm releases](../../docs/development.md#public-npm-releases) for setup
and failure handling. Validation uses test doubles; it never runs a real publish.
