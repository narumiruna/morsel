import { createPngExport, downloadDiagram } from "./diagramExport.js"
import { createDiagramView, maxDiagramScale, minDiagramScale } from "./diagramView.js"

/** Host-owned content and presentation. SVG must already be trusted or sanitized. */
export interface DiagramOptions {
  source: string
  /** Raw SVG for download. The host, not the controller, populates stage content. */
  svg?: string
  /** Defaults to true. Signal ready content changes with update or refresh. */
  ready?: boolean
  refreshing?: boolean
  renderError?: string
  retryRender?: () => void
  /** Explicit PNG export background color. Defaults to #ffffff. */
  background?: string
  /** Download basename without an extension. Defaults to diagram. */
  filename?: string
  /** Generic action/status wording, such as diagram or chart. Defaults to diagram. */
  typeLabel?: string
}

export type DiagramAction =
  | "zoomIn"
  | "zoomOut"
  | "fit"
  | "reset"
  | "fullscreen"
  | "source"
  | "copy"
  | "svg"
  | "png"
  | "retry"

/** A stable, frozen snapshot. A new object is published for each change. */
export interface DiagramState {
  readonly scale: number
  readonly minimum: number
  readonly maximum: number
  readonly cropped: boolean
  readonly showSource: boolean
  readonly expanded: boolean
  readonly fallback: boolean
  readonly exporting: boolean
  readonly copying: boolean
  readonly fullscreenPending: boolean
  readonly status: string
}

export interface DiagramActionMetadata {
  label: string
  disabled: boolean
  pressed?: boolean
  busy?: boolean
}

export interface DiagramController {
  getState(): Readonly<DiagramState>
  subscribe(listener: () => void): () => void
  /** Replaces all options. The host retains ownership of stage children. */
  update(options: DiagramOptions): void
  /** Call after an imperative renderer changes stage content. */
  refresh(): void
  getAction(action: DiagramAction): DiagramActionMetadata
  run(action: DiagramAction): void | Promise<void>
  destroy(): void
}

export const initialDiagramState: Readonly<DiagramState> = Object.freeze({
  scale: 1,
  minimum: minDiagramScale,
  maximum: maxDiagramScale,
  cropped: false,
  showSource: false,
  expanded: false,
  fallback: false,
  exporting: false,
  copying: false,
  fullscreenPending: false,
  status: "",
})

/** The same rules apply to built-in controls and custom host controls. */
export function getDiagramAction(
  state: Readonly<DiagramState>,
  options: DiagramOptions,
  action: DiagramAction,
): DiagramActionMetadata {
  const cameraDisabled = options.ready === false || state.showSource
  switch (action) {
    case "zoomIn":
      return { label: "Zoom in", disabled: cameraDisabled || state.scale >= state.maximum }
    case "zoomOut":
      return { label: "Zoom out", disabled: cameraDisabled || state.scale <= state.minimum }
    case "fit":
      return { label: "Fit to screen", disabled: cameraDisabled }
    case "reset":
      return { label: "Reset zoom", disabled: cameraDisabled }
    case "fullscreen":
      return {
        label: state.expanded ? "Exit fullscreen" : "Fullscreen",
        disabled: state.fullscreenPending,
        pressed: state.expanded,
        busy: state.fullscreenPending,
      }
    case "source":
      return {
        label: state.showSource ? `Show ${options.typeLabel ?? "diagram"}` : "Show source",
        disabled: false,
        pressed: state.showSource,
      }
    case "copy":
      return { label: "Copy source", disabled: state.copying, busy: state.copying }
    case "svg":
      return { label: "Download SVG", disabled: options.ready === false }
    case "png":
      return {
        label: "Download PNG",
        disabled: options.ready === false || state.exporting,
        busy: state.exporting,
      }
    case "retry":
      return {
        label: `Retry ${options.typeLabel ?? "diagram"}`,
        disabled: !options.renderError || !options.retryRender || options.refreshing === true,
        busy: options.refreshing === true,
      }
  }
}

interface IsolationRecord {
  element: HTMLElement
  inert: boolean
}

interface ScrollLockRecord {
  element: HTMLElement
  declarations: { property: string; value: string; priority: string }[]
}

// Like native fullscreen, only one fallback can own document isolation at a time.
// There is no DOM access at module import time.
const fallbackOwners = new WeakMap<Document, () => boolean>()

/** Browser-only instance; importing this module does not access browser globals. */
export function createDiagramController(
  elements: { root: HTMLElement; viewport: HTMLElement; stage: HTMLElement },
  initialOptions: DiagramOptions,
): DiagramController {
  const { root, viewport, stage } = elements
  const document = root.ownerDocument
  let options = { ...initialOptions }
  let state = initialDiagramState
  let message = ""
  let destroyed = false
  let nativeFullscreen = false
  let opener: HTMLElement | undefined
  let destroyedOpener: HTMLElement | undefined
  let isolation: IsolationRecord[] = []
  let scrollLocks: ScrollLockRecord[] = []
  const frames = new Set<number>()
  const listeners = new Set<() => void>()

  function publish(patch: Partial<DiagramState> = {}, force = false): void {
    if (destroyed) return
    const status = options.refreshing
      ? `Refreshing ${options.typeLabel ?? "diagram"}…`
      : options.renderError || message
    const next = { ...state, ...patch, status }
    if (
      !force &&
      (Object.keys(next) as (keyof DiagramState)[]).every((key) => next[key] === state[key])
    ) {
      return
    }
    state = Object.freeze(next)
    for (const listener of listeners) listener()
  }

  function feedback(value: string, patch: Partial<DiagramState> = {}): void {
    if (destroyed) return
    message = value
    publish(patch)
  }

  function nextFrame(callback: () => void): void {
    if (destroyed) return
    const frame = requestAnimationFrame(() => {
      frames.delete(frame)
      if (!destroyed) callback()
    })
    frames.add(frame)
  }

  function restoreFocus(): void {
    const target = opener
    opener = undefined
    if (target?.isConnected) target.focus({ preventScroll: true })
  }

  function restoreFallback(): void {
    for (const item of isolation) item.element.inert = item.inert
    isolation = []
    for (const item of scrollLocks) {
      for (const { property, value, priority } of item.declarations) {
        item.element.style.setProperty(property, value, priority)
      }
    }
    scrollLocks = []
    if (fallbackOwners.get(document) === closeFallback) fallbackOwners.delete(document)
  }

  function closeFallback(): boolean {
    if (!state.fallback) return false
    restoreFallback()
    publish({ fallback: false, expanded: nativeFullscreen })
    nextFrame(() => {
      camera.refresh()
      restoreFocus()
    })
    return true
  }

  function focusContent(): void {
    camera.refresh()
    // Source view can hide the viewport. Never move focus into hidden content.
    if (!state.showSource) viewport.focus({ preventScroll: true })
  }

  function openFallback(): void {
    if (destroyed || state.fallback) return
    fallbackOwners.get(document)?.()
    fallbackOwners.set(document, closeFallback)
    // Keep the live root and host-owned chart mounted in place. Turning it into
    // a dialog or reparenting it would reset renderer and native top-layer state.
    let current = root
    while (current.parentElement) {
      for (const sibling of current.parentElement.children) {
        if (sibling === current || !(sibling instanceof HTMLElement)) continue
        isolation.push({ element: sibling, inert: sibling.inert })
        sibling.inert = true
      }
      current = current.parentElement
    }
    const containers = new Set<HTMLElement>([document.documentElement, document.body])
    current = root.parentElement ?? root
    while (current) {
      const style = getComputedStyle(current)
      if (/(auto|scroll|overlay)/.test(`${style.overflow} ${style.overflowY}`))
        containers.add(current)
      if (!current.parentElement) break
      current = current.parentElement
    }
    scrollLocks = [...containers].map((element) => ({
      element,
      // A shorthand can be empty when only one axis is set or priorities differ.
      declarations: [
        "overflow-x",
        "overflow-y",
        "overscroll-behavior-x",
        "overscroll-behavior-y",
      ].map((property) => ({
        property,
        value: element.style.getPropertyValue(property),
        priority: element.style.getPropertyPriority(property),
      })),
    }))
    for (const item of scrollLocks) {
      item.element.style.overflow = "hidden"
      item.element.style.overscrollBehavior = "none"
    }
    publish({ fallback: true, expanded: true })
    nextFrame(focusContent)
  }

  function refresh(): void {
    if (destroyed || options.ready === false || (options.svg && !stage.querySelector("svg"))) return
    camera.refresh()
  }

  const camera = createDiagramView(viewport, stage, {
    isExpanded: () => document.fullscreenElement === root || state.fallback,
    onCropChange: (cropped) => publish({ cropped }),
    onEscape: closeFallback,
    onScaleChange: (scale, minimum, maximum) => publish({ scale, minimum, maximum }),
  })

  function fullscreenChange(): void {
    const active = document.fullscreenElement === root
    const wasActive = nativeFullscreen
    nativeFullscreen = active
    if (active && state.fallback) restoreFallback()
    publish({ expanded: active || state.fallback, ...(active ? { fallback: false } : {}) })
    if (active && !wasActive) nextFrame(focusContent)
    else if (!active && wasActive) {
      nextFrame(() => {
        camera.refresh()
        restoreFocus()
      })
    }
  }

  function closeOnEscape(event: KeyboardEvent): void {
    if (event.key !== "Escape" || !closeFallback()) return
    event.preventDefault()
    event.stopPropagation()
  }

  async function exitNative(): Promise<void> {
    if (document.fullscreenElement !== root || typeof document.exitFullscreen !== "function") return
    await document.exitFullscreen()
  }

  function restoreDestroyedFocus(): void {
    if (!document.fullscreenElement && destroyedOpener?.isConnected) {
      destroyedOpener.focus({ preventScroll: true })
    }
  }

  async function releaseDestroyedFullscreen(): Promise<void> {
    if (document.fullscreenElement !== root) return
    await exitNative().catch(() => {})
    restoreDestroyedFocus()
  }

  async function toggleFullscreen(): Promise<void> {
    if (closeFallback()) return
    const exiting = document.fullscreenElement === root
    if (!exiting && document.activeElement instanceof HTMLElement) opener = document.activeElement
    publish({ fullscreenPending: true })
    try {
      if (exiting) {
        await exitNative()
        if (destroyed) restoreDestroyedFocus()
      } else {
        if (typeof root.requestFullscreen !== "function") throw new Error("unavailable")
        await root.requestFullscreen()
        // A native request can succeed after unmount. Exit only our own root,
        // never a newer viewer's fullscreen session.
        if (destroyed) {
          await releaseDestroyedFullscreen()
          return
        }
      }
      if (!destroyed) fullscreenChange()
    } catch {
      if (destroyed) return
      if (exiting) feedback("Unable to exit fullscreen.")
      else {
        openFallback()
        feedback("Using fullscreen fallback.")
      }
    } finally {
      publish({ fullscreenPending: false })
    }
  }

  async function copy(): Promise<void> {
    const source = options.source
    publish({ copying: true })
    try {
      await navigator.clipboard.writeText(source)
      feedback("Copied to clipboard.")
    } catch {
      feedback("Copy failed. Check clipboard permissions.")
    } finally {
      publish({ copying: false })
    }
  }

  function downloadSVG(): void {
    // SVG download is deliberately raw; only PNG uses serializeDiagramSvg.
    const source = options.svg || stage.querySelector("svg")?.outerHTML
    if (!source) return
    try {
      downloadDiagram(
        new Blob([source], { type: "image/svg+xml;charset=utf-8" }),
        "svg",
        options.filename ?? "diagram",
      )
      feedback("SVG download started.")
    } catch (error) {
      feedback(error instanceof Error ? error.message : "SVG export failed.")
    }
  }

  async function downloadPNG(): Promise<void> {
    const diagram = stage.querySelector("svg")
    if (!(diagram instanceof SVGSVGElement)) return
    const background = options.background ?? "#ffffff"
    const filename = options.filename ?? "diagram"
    feedback("Creating PNG…", { exporting: true })
    try {
      const png = await createPngExport(diagram, background)
      if (destroyed) return
      downloadDiagram(png, "png", filename)
      feedback("PNG download started.")
    } catch (error) {
      feedback(error instanceof Error ? error.message : "PNG export failed.")
    } finally {
      publish({ exporting: false })
    }
  }

  document.addEventListener("fullscreenchange", fullscreenChange)
  document.addEventListener("keydown", closeOnEscape, true)
  publish()

  return {
    getState: () => state,
    subscribe(listener) {
      if (destroyed) return () => {}
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    update(next) {
      if (destroyed) return
      const keys = Object.keys({ ...options, ...next }) as (keyof DiagramOptions)[]
      if (keys.every((key) => options[key] === next[key])) return
      const changed = options.svg !== next.svg || options.ready !== next.ready
      options = { ...next }
      publish({}, true)
      if (changed) nextFrame(refresh)
    },
    refresh,
    getAction: (action) => getDiagramAction(state, options, action),
    run(action) {
      if (destroyed || getDiagramAction(state, options, action).disabled) return
      switch (action) {
        case "zoomIn":
          return camera.zoomBy(1.25)
        case "zoomOut":
          return camera.zoomBy(0.8)
        case "fit":
          return camera.setCameraMode("overview")
        case "reset":
          return camera.reset()
        case "fullscreen":
          return toggleFullscreen()
        case "source":
          publish({ showSource: !state.showSource })
          if (!state.showSource) nextFrame(refresh)
          return
        case "copy":
          return copy()
        case "svg":
          return downloadSVG()
        case "png":
          return downloadPNG()
        case "retry":
          return options.retryRender?.()
      }
    },
    destroy() {
      if (destroyed) return
      destroyed = true
      for (const frame of frames) cancelAnimationFrame(frame)
      frames.clear()
      camera.destroy()
      document.removeEventListener("fullscreenchange", fullscreenChange)
      document.removeEventListener("keydown", closeOnEscape, true)
      restoreFallback()
      destroyedOpener = opener
      void releaseDestroyedFullscreen()
      restoreFocus()
      listeners.clear()
    },
  }
}
