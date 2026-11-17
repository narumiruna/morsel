export const minDiagramScale = 0.25
export const maxDiagramScale = 4
const minReadableLabelPixels = 14
const inlineMinHeight = 160
const inlineMaxHeight = 672
const touchDragThreshold = 6
const nativeControlSelector =
  'input, select, textarea, button, a[href], label, summary, [contenteditable]:not([contenteditable="false"])'

export type DiagramCameraMode = "overview" | "readable"

export interface DiagramViewState {
  cameraMode: DiagramCameraMode
  naturalHeight: number
  naturalWidth: number
  scale: number
  userModified: boolean
  x: number
  y: number
}

export interface DiagramPoint {
  x: number
  y: number
}

export interface DiagramViewController {
  destroy(): void
  getState(): Readonly<DiagramViewState>
  refresh(forceCamera?: boolean): void
  reset(): void
  setCameraMode(mode: DiagramCameraMode): void
  zoomBy(factor: number, clientPoint?: DiagramPoint): void
}

interface DiagramViewOptions {
  isExpanded?: () => boolean
  onCameraModeChange?: (mode: DiagramCameraMode) => void
  onCropChange?: (cropped: boolean) => void
  onEscape?: () => boolean
  onScaleChange?: (scale: number, minimumScale: number, maximumScale: number) => void
}

interface PointerPosition {
  clientX: number
  clientY: number
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value))
}

function positive(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? value : fallback
}

function localPoint(viewport: HTMLElement, point: DiagramPoint): DiagramPoint {
  const bounds = viewport.getBoundingClientRect()
  return { x: point.x - bounds.left, y: point.y - bounds.top }
}

function distance(a: PointerPosition, b: PointerPosition): number {
  return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY)
}

function center(a: PointerPosition, b: PointerPosition): DiagramPoint {
  return { x: (a.clientX + b.clientX) / 2, y: (a.clientY + b.clientY) / 2 }
}

/**
 * Mount a camera on host-owned content. Mark selectable SVG nodes with
 * `data-diagram-node` to allow expanded touch pan/pinch while retaining taps.
 * Native controls and editable descendants keep their own gestures. The host
 * owns node accessibility/activation and inline/expanded touch-action CSS.
 */
export function createDiagramView(
  viewport: HTMLElement,
  stage: HTMLElement,
  options: DiagramViewOptions = {},
): DiagramViewController {
  const state: DiagramViewState = {
    cameraMode: "overview",
    naturalHeight: 1,
    naturalWidth: 1,
    scale: 1,
    userModified: false,
    x: 0,
    y: 0,
  }
  const pointers = new Map<number, PointerPosition & { startX: number; startY: number }>()
  const captures = new Map<number, Element>()
  const pendingTouchClicks = new Set<number>()
  let touchMoved = false
  let mousePointerID: number | undefined
  let mouseLast: DiagramPoint | undefined
  let touchLast: DiagramPoint | undefined
  let pinch:
    | {
        distance: number
        scale: number
        world: DiagramPoint
      }
    | undefined
  let minimumScale = minDiagramScale
  let resizeFrame = 0
  let previousWidth = 0
  let previousHeight = 0

  const expanded = () => options.isExpanded?.() === true

  function svg(): SVGSVGElement | undefined {
    const candidate = stage.querySelector("svg")
    return candidate instanceof SVGSVGElement ? candidate : undefined
  }

  function readNaturalSize(): void {
    const diagram = svg()
    if (!diagram) return
    const values = (diagram.getAttribute("viewBox") ?? "")
      .trim()
      .split(/[\s,]+/)
      .map(Number)
    state.naturalWidth = positive(
      diagram.viewBox?.baseVal.width ?? values[2] ?? 0,
      positive(Number.parseFloat(diagram.getAttribute("width") ?? ""), 1),
    )
    state.naturalHeight = positive(
      diagram.viewBox?.baseVal.height ?? values[3] ?? 0,
      positive(Number.parseFloat(diagram.getAttribute("height") ?? ""), 1),
    )
    stage.style.width = `${state.naturalWidth}px`
    stage.style.height = `${state.naturalHeight}px`
  }

  function padding() {
    const style = getComputedStyle(viewport)
    return {
      bottom: Number.parseFloat(style.paddingBottom) || 0,
      left: Number.parseFloat(style.paddingLeft) || 0,
      right: Number.parseFloat(style.paddingRight) || 0,
      top: Number.parseFloat(style.paddingTop) || 0,
    }
  }

  function updateInlineHeight(): void {
    if (expanded()) {
      viewport.style.removeProperty("height")
      return
    }
    const inset = padding()
    const width = Math.max(1, viewport.clientWidth - inset.left - inset.right)
    const fit = Math.min(1, width / state.naturalWidth)
    const desired = state.naturalHeight * fit + inset.top + inset.bottom
    const limit = Math.max(inlineMinHeight, window.innerHeight * 0.75)
    viewport.style.height = `${Math.ceil(clamp(desired, inlineMinHeight, Math.min(inlineMaxHeight, limit)))}px`
  }

  function labelFontSize(): number {
    const diagram = svg()
    if (!diagram) return 16
    const sizes = [...diagram.querySelectorAll("text, foreignObject span, foreignObject p")]
      .map((label) => Number.parseFloat(getComputedStyle(label).fontSize))
      .filter((size) => Number.isFinite(size) && size > 0)
    return sizes.length ? Math.min(...sizes) : 16
  }

  function constrain(): void {
    const inset = padding()
    const width = state.naturalWidth * state.scale
    const height = state.naturalHeight * state.scale
    const innerWidth = Math.max(1, viewport.clientWidth - inset.left - inset.right)
    const innerHeight = Math.max(1, viewport.clientHeight - inset.top - inset.bottom)

    state.x =
      width <= innerWidth
        ? inset.left + (innerWidth - width) / 2
        : clamp(state.x, viewport.clientWidth - inset.right - width, inset.left)
    state.y =
      height <= innerHeight
        ? inset.top + (innerHeight - height) / 2
        : clamp(state.y, viewport.clientHeight - inset.bottom - height, inset.top)
  }

  function apply(): void {
    constrain()
    stage.style.transform = `translate3d(${state.x}px, ${state.y}px, 0) scale(${state.scale})`
    options.onScaleChange?.(state.scale, minimumScale, maxDiagramScale)
    const inset = padding()
    const cropped =
      state.naturalWidth * state.scale > viewport.clientWidth - inset.left - inset.right + 1 ||
      state.naturalHeight * state.scale > viewport.clientHeight - inset.top - inset.bottom + 1
    viewport.dataset.diagramCropped = String(cropped)
    options.onCropChange?.(cropped)
  }

  function showOverview(): void {
    readNaturalSize()
    updateInlineHeight()
    const inset = padding()
    const fit = Math.min(
      (viewport.clientWidth - inset.left - inset.right) / state.naturalWidth,
      (viewport.clientHeight - inset.top - inset.bottom) / state.naturalHeight,
    )
    const limited = expanded() ? fit : Math.min(1, fit)
    state.scale = Math.min(positive(limited, 1), maxDiagramScale)
    minimumScale = Math.min(minDiagramScale, state.scale)
    state.cameraMode = "overview"
    state.userModified = false
    apply()
    previousWidth = viewport.clientWidth
    previousHeight = viewport.clientHeight
    options.onCameraModeChange?.("overview")
  }

  function showReadable(): void {
    readNaturalSize()
    updateInlineHeight()
    const inset = padding()
    state.scale = clamp(
      Math.max(1, minReadableLabelPixels / labelFontSize()),
      minDiagramScale,
      maxDiagramScale,
    )
    minimumScale = minDiagramScale
    state.x = inset.left
    state.y = inset.top
    state.cameraMode = "readable"
    state.userModified = false
    apply()
    previousWidth = viewport.clientWidth
    previousHeight = viewport.clientHeight
    options.onCameraModeChange?.("readable")
  }

  function setScaleAt(next: number, point: DiagramPoint, worldPoint?: DiagramPoint): void {
    const world = worldPoint ?? {
      x: (point.x - state.x) / state.scale,
      y: (point.y - state.y) / state.scale,
    }
    state.scale = clamp(next, minimumScale, maxDiagramScale)
    state.x = point.x - world.x * state.scale
    state.y = point.y - world.y * state.scale
    state.userModified = true
    apply()
  }

  function zoomBy(factor: number, clientPoint?: DiagramPoint): void {
    const point = clientPoint
      ? localPoint(viewport, clientPoint)
      : { x: viewport.clientWidth / 2, y: viewport.clientHeight / 2 }
    setScaleAt(state.scale * factor, point)
  }

  function panBy(x: number, y: number): void {
    state.x += x
    state.y += y
    state.userModified = true
    apply()
  }

  function refresh(forceCamera = false): void {
    const oldWidth = previousWidth || viewport.clientWidth
    const oldHeight = previousHeight || viewport.clientHeight
    const worldCenter = {
      x: (oldWidth / 2 - state.x) / state.scale,
      y: (oldHeight / 2 - state.y) / state.scale,
    }
    readNaturalSize()
    updateInlineHeight()
    if (forceCamera || !state.userModified) {
      if (state.cameraMode === "overview") showOverview()
      else showReadable()
      return
    }
    state.x = viewport.clientWidth / 2 - worldCenter.x * state.scale
    state.y = viewport.clientHeight / 2 - worldCenter.y * state.scale
    previousWidth = viewport.clientWidth
    previousHeight = viewport.clientHeight
    apply()
  }

  function setCameraMode(mode: DiagramCameraMode): void {
    if (mode === "overview") showOverview()
    else showReadable()
  }

  function capture(event: PointerEvent, owner: Element = viewport): void {
    try {
      owner.setPointerCapture(event.pointerId)
      captures.set(event.pointerId, owner)
    } catch {
      // Document-level pointer events still complete the gesture if capture fails.
    }
  }

  function releaseCapture(pointerID: number): void {
    const owner = captures.get(pointerID)
    captures.delete(pointerID)
    try {
      owner?.releasePointerCapture(pointerID)
    } catch {
      // The browser may already have released or cancelled this pointer.
    }
  }

  function isInteractiveTarget(target: EventTarget | null, touchNode?: SVGElement): boolean {
    if (!(target instanceof Element)) return false
    let control = target.closest(`${nativeControlSelector}, [tabindex]`)
    while (control && control !== viewport && viewport.contains(control)) {
      if (control !== touchNode || control.matches(nativeControlSelector)) return true
      control = control.parentElement?.closest(`${nativeControlSelector}, [tabindex]`) ?? null
    }
    return false
  }

  function onPointerDown(event: PointerEvent): void {
    if (pointers.size === 0) pendingTouchClicks.clear()
    const candidate =
      event.pointerType === "touch" && event.target instanceof Element
        ? event.target.closest("[data-diagram-node]")
        : null
    const touchNode =
      candidate instanceof SVGElement && stage.contains(candidate) ? candidate : undefined
    if (isInteractiveTarget(event.target, touchNode)) return
    if (event.pointerType === "touch") {
      if (!expanded() || event.button !== 0) return
      if (pointers.size === 0) touchMoved = false
      pointers.set(event.pointerId, {
        clientX: event.clientX,
        clientY: event.clientY,
        startX: event.clientX,
        startY: event.clientY,
      })
      // Capture on the selectable node so a stationary tap still clicks that node.
      capture(event, touchNode ?? viewport)
      if (pointers.size === 1) {
        touchLast = { x: event.clientX, y: event.clientY }
      } else if (pointers.size === 2) {
        const [first, second] = [...pointers.values()]
        if (!first || !second) return
        const point = localPoint(viewport, center(first, second))
        pinch = {
          distance: Math.max(1, distance(first, second)),
          scale: state.scale,
          world: { x: (point.x - state.x) / state.scale, y: (point.y - state.y) / state.scale },
        }
        touchLast = undefined
      }
      return
    }
    if (event.button !== 0) return
    mousePointerID = event.pointerId
    mouseLast = { x: event.clientX, y: event.clientY }
    capture(event)
    event.preventDefault()
  }

  function onPointerMove(event: PointerEvent): void {
    const pointer = pointers.get(event.pointerId)
    if (event.pointerType === "touch" && pointer) {
      if (
        Math.hypot(event.clientX - pointer.startX, event.clientY - pointer.startY) >
        touchDragThreshold
      ) {
        touchMoved = true
      }
      pointers.set(event.pointerId, { ...pointer, clientX: event.clientX, clientY: event.clientY })
      if (pointers.size === 2 && pinch) {
        const [first, second] = [...pointers.values()]
        if (!first || !second) return
        const point = localPoint(viewport, center(first, second))
        setScaleAt(pinch.scale * (distance(first, second) / pinch.distance), point, pinch.world)
      } else if (pointers.size === 1 && touchLast) {
        panBy(event.clientX - touchLast.x, event.clientY - touchLast.y)
        touchLast = { x: event.clientX, y: event.clientY }
      }
      event.preventDefault()
      return
    }
    if (event.pointerId !== mousePointerID || !mouseLast) return
    panBy(event.clientX - mouseLast.x, event.clientY - mouseLast.y)
    mouseLast = { x: event.clientX, y: event.clientY }
    event.preventDefault()
  }

  function stopPointer(event: PointerEvent): void {
    if (pointers.has(event.pointerId)) {
      if (event.type !== "pointercancel" && touchMoved) pendingTouchClicks.add(event.pointerId)
      pointers.delete(event.pointerId)
      if (pointers.size < 2) pinch = undefined
      const remaining = [...pointers.values()][0]
      touchLast = remaining ? { x: remaining.clientX, y: remaining.clientY } : undefined
    }
    if (event.pointerId === mousePointerID) {
      mousePointerID = undefined
      mouseLast = undefined
    }
    releaseCapture(event.pointerId)
  }

  function onClick(event: MouseEvent): void {
    // Keyboard, assistive technology and programmatic activation are not drag clicks.
    if (event.detail === 0 || pendingTouchClicks.size === 0) return
    if ("pointerId" in event) {
      if (!pendingTouchClicks.delete(event.pointerId as number)) return
    } else {
      // Older browsers emit MouseEvent clicks without pointer identity.
      pendingTouchClicks.clear()
    }
    event.preventDefault()
    event.stopImmediatePropagation()
  }

  function onWheel(event: WheelEvent): void {
    if (isInteractiveTarget(event.target)) return
    if (!event.ctrlKey && !event.metaKey) return
    event.preventDefault()
    zoomBy(event.deltaY < 0 ? 1.1 : 0.9, { x: event.clientX, y: event.clientY })
  }

  function onKeyDown(event: KeyboardEvent): void {
    if (event.key !== "Escape" && isInteractiveTarget(event.target)) return
    if (event.altKey || event.ctrlKey || event.metaKey) return
    switch (event.key) {
      case "ArrowLeft":
        panBy(40, 0)
        break
      case "ArrowRight":
        panBy(-40, 0)
        break
      case "ArrowUp":
        panBy(0, 40)
        break
      case "ArrowDown":
        panBy(0, -40)
        break
      case "+":
      case "=":
        zoomBy(1.25)
        break
      case "-":
        zoomBy(0.8)
        break
      case "0":
        showOverview()
        break
      case "Escape":
        if (!options.onEscape?.()) return
        event.stopPropagation()
        break
      default:
        return
    }
    event.preventDefault()
  }

  viewport.addEventListener("pointerdown", onPointerDown)
  const ownerDocument = viewport.ownerDocument
  ownerDocument.addEventListener("pointermove", onPointerMove, { passive: false })
  ownerDocument.addEventListener("pointerup", stopPointer)
  ownerDocument.addEventListener("pointercancel", stopPointer)
  ownerDocument.addEventListener("lostpointercapture", stopPointer)
  viewport.addEventListener("click", onClick, true)
  viewport.addEventListener("wheel", onWheel, { passive: false })
  viewport.addEventListener("keydown", onKeyDown)

  const resizeObserver =
    typeof ResizeObserver === "function"
      ? new ResizeObserver(() => {
          cancelAnimationFrame(resizeFrame)
          resizeFrame = requestAnimationFrame(() => refresh())
        })
      : undefined
  resizeObserver?.observe(viewport)
  showOverview()

  return {
    destroy() {
      cancelAnimationFrame(resizeFrame)
      resizeObserver?.disconnect()
      pointers.clear()
      mousePointerID = undefined
      mouseLast = undefined
      touchLast = undefined
      pinch = undefined
      pendingTouchClicks.clear()
      for (const pointerID of captures.keys()) releaseCapture(pointerID)
      viewport.removeEventListener("pointerdown", onPointerDown)
      ownerDocument.removeEventListener("pointermove", onPointerMove)
      ownerDocument.removeEventListener("pointerup", stopPointer)
      ownerDocument.removeEventListener("pointercancel", stopPointer)
      ownerDocument.removeEventListener("lostpointercapture", stopPointer)
      viewport.removeEventListener("click", onClick, true)
      viewport.removeEventListener("wheel", onWheel)
      viewport.removeEventListener("keydown", onKeyDown)
    },
    getState: () => state,
    refresh,
    reset: showReadable,
    setCameraMode,
    zoomBy,
  }
}
