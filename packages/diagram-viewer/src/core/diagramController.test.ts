import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  createDiagramController,
  type DiagramController,
  type DiagramOptions,
  getDiagramAction,
  initialDiagramState,
} from "./diagramController.js"
import { createPngExport, downloadDiagram } from "./diagramExport.js"

vi.mock("./diagramExport.js", () => ({
  createPngExport: vi.fn(),
  downloadDiagram: vi.fn(),
}))

const controllers: DiagramController[] = []
let frames: Map<number, FrameRequestCallback>
let fullscreenElement: Element | null

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((accept, fail) => {
    resolve = accept
    reject = fail
  })
  return { promise, resolve, reject }
}

function flushFrames() {
  const pending = [...frames.values()]
  frames.clear()
  for (const callback of pending) callback(0)
}

function fixture(options: DiagramOptions = { source: "source" }) {
  const root = document.createElement("div")
  const button = document.createElement("button")
  const viewport = document.createElement("section")
  viewport.tabIndex = 0
  const stage = document.createElement("div")
  stage.innerHTML = '<svg viewBox="0 0 1000 500"><text style="font-size:10px">Label</text></svg>'
  viewport.append(stage)
  root.append(button, viewport)
  document.body.append(root)
  Object.defineProperties(viewport, {
    clientWidth: { configurable: true, value: 500 },
    clientHeight: { configurable: true, value: 300 },
  })
  const controller = createDiagramController({ root, viewport, stage }, options)
  controllers.push(controller)
  return { controller, root, button, viewport, stage }
}

beforeEach(() => {
  frames = new Map()
  let frameID = 0
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    const id = ++frameID
    frames.set(id, callback)
    return id
  })
  vi.stubGlobal("cancelAnimationFrame", (id: number) => {
    frames.delete(id)
  })
  fullscreenElement = null
  Object.defineProperty(document, "fullscreenElement", {
    configurable: true,
    get: () => fullscreenElement,
  })
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    get: () => ({ writeText: vi.fn() }),
  })
  Reflect.deleteProperty(document, "exitFullscreen")
  vi.mocked(createPngExport).mockResolvedValue(new Blob(["png"]))
  vi.mocked(downloadDiagram).mockReset()
})

afterEach(() => {
  for (const controller of controllers.splice(0)) controller.destroy()
  document.body.replaceChildren()
  document.body.style.cssText = ""
  document.documentElement.style.cssText = ""
})

describe("diagram controller", () => {
  it("publishes stable immutable snapshots and unsubscribes", () => {
    const { controller } = fixture()
    const first = controller.getState()
    expect(first.scale).toBe(0.5)
    expect(Object.isFrozen(first)).toBe(true)
    expect(Object.isFrozen(initialDiagramState)).toBe(true)
    expect(controller.getState()).toBe(first)
    const listener = vi.fn()
    const unsubscribe = controller.subscribe(listener)
    controller.run("zoomIn")
    expect(listener).toHaveBeenCalled()
    expect(first.scale).toBe(0.5)
    expect(controller.getState().scale).toBe(0.625)
    unsubscribe()
    listener.mockClear()
    controller.run("reset")
    expect(listener).not.toHaveBeenCalled()
    expect(controller.getState().scale).toBe(1.4)
  })

  it("does not notify on identical options supplied by a binding after each render", () => {
    const { controller } = fixture({ source: "text", ready: true })
    const listener = vi.fn()
    controller.subscribe(listener)
    const snapshot = controller.getState()
    controller.update({ source: "text", ready: true })
    controller.update({ source: "text", ready: true, background: undefined })
    expect(listener).not.toHaveBeenCalled()
    expect(controller.getState()).toBe(snapshot)
    controller.update({ source: "changed", ready: true })
    expect(listener).toHaveBeenCalledOnce()
  })

  it("guards exact zoom bounds, including fitted scales below the interactive floor", () => {
    const { controller, stage } = fixture()
    stage.innerHTML = '<svg viewBox="0 0 5000 500"></svg>'
    controller.refresh()
    expect(controller.getState()).toMatchObject({ minimum: 0.1, scale: 0.1 })
    expect(controller.getAction("zoomOut").disabled).toBe(true)
    controller.run("zoomOut")
    expect(controller.getState().scale).toBe(0.1)
    expect(controller.getAction("zoomIn").disabled).toBe(false)
    for (let index = 0; index < 100; index++) controller.run("zoomIn")
    expect(controller.getState().scale).toBe(4)
    expect(controller.getAction("zoomIn").disabled).toBe(true)
    controller.run("zoomIn")
    expect(controller.getState().scale).toBe(4)
    controller.run("reset")
    expect(controller.getState()).toMatchObject({ minimum: 0.25, scale: 1 })
    controller.run("fit")
    expect(controller.getState()).toMatchObject({ minimum: 0.1, scale: 0.1 })
  })

  it("keeps loading, source, retry, and refreshing action rules in core", () => {
    const retryRender = vi.fn()
    const { controller } = fixture({ source: "text", ready: false })
    for (const action of ["zoomIn", "zoomOut", "fit", "reset", "svg", "png"] as const) {
      expect(controller.getAction(action).disabled).toBe(true)
      controller.run(action)
    }
    expect(controller.getState().scale).toBe(0.5)
    expect(controller.getAction("retry").disabled).toBe(true)
    controller.run("source")
    expect(controller.getAction("source")).toEqual({
      label: "Show diagram",
      disabled: false,
      pressed: true,
    })
    controller.update({ source: "text", typeLabel: "chart", renderError: "Broken", retryRender })
    expect(controller.getState().status).toBe("Broken")
    expect(controller.getAction("source").label).toBe("Show chart")
    expect(controller.getAction("zoomIn").disabled).toBe(true)
    expect(controller.getAction("svg").disabled).toBe(false)
    controller.run("retry")
    expect(retryRender).toHaveBeenCalledOnce()
    controller.update({
      source: "text",
      typeLabel: "chart",
      renderError: "Broken",
      retryRender,
      refreshing: true,
    })
    expect(controller.getState().status).toBe("Refreshing chart…")
    expect(controller.getAction("retry")).toMatchObject({
      label: "Retry chart",
      disabled: true,
      busy: true,
    })
    controller.run("retry")
    expect(retryRender).toHaveBeenCalledOnce()
    controller.run("source")
    flushFrames()
    expect(controller.getAction("fit").disabled).toBe(false)
  })

  it("refreshes host-owned content without replacing chart children", () => {
    const { controller, stage } = fixture()
    const chart = stage.firstElementChild
    const listener = vi.fn()
    controller.subscribe(listener)
    controller.update({ source: "new", ready: true, svg: "sanitized SVG" })
    flushFrames()
    expect(stage.firstElementChild).toBe(chart)
    expect(listener).toHaveBeenCalled()
    stage.innerHTML = '<svg viewBox="0 0 250 100"></svg>'
    controller.refresh()
    expect(controller.getState().scale).toBe(1)
  })

  it("keeps pure action metadata usable before a mounted controller", () => {
    expect(getDiagramAction(initialDiagramState, { source: "", ready: false }, "zoomIn")).toEqual({
      label: "Zoom in",
      disabled: true,
    })
    expect(
      getDiagramAction(
        { ...initialDiagramState, scale: 4 - Number.EPSILON * 4 },
        { source: "" },
        "zoomIn",
      ).disabled,
    ).toBe(false)
    expect(
      getDiagramAction(
        { ...initialDiagramState, scale: 0.25 + Number.EPSILON },
        { source: "" },
        "zoomOut",
      ).disabled,
    ).toBe(false)
  })

  it("isolates source, camera, and pending clipboard operations between instances", async () => {
    const result = deferred<void>()
    const writeText = vi.fn().mockReturnValue(result.promise)
    vi.spyOn(navigator, "clipboard", "get").mockReturnValue({ writeText } as unknown as Clipboard)
    const first = fixture({ source: "first" }).controller
    const second = fixture({ source: "second" }).controller
    first.run("source")
    expect(second.getState().showSource).toBe(false)
    second.run("zoomIn")
    expect(first.getState().scale).toBe(0.5)
    const operation = first.run("copy")
    first.run("copy")
    expect(first.getAction("copy")).toMatchObject({ disabled: true, busy: true })
    expect(second.getState().copying).toBe(false)
    expect(writeText).toHaveBeenCalledExactlyOnceWith("first")
    first.update({ source: "changed" })
    result.resolve()
    await operation
    expect(first.getState()).toMatchObject({ copying: false, status: "Copied to clipboard." })
    expect(second.getState().status).toBe("")
    writeText.mockRejectedValue(new Error("permission"))
    await second.run("copy")
    expect(second.getState().status).toBe("Copy failed. Check clipboard permissions.")
  })

  it("downloads raw supplied SVG and uses the live SVG only for PNG serialization", async () => {
    const { controller, stage } = fixture({
      source: "text",
      svg: "<svg>raw</svg>",
      background: "#123456",
      filename: "chart",
    })
    controller.run("svg")
    const blob = vi.mocked(downloadDiagram).mock.calls[0]?.[0]
    expect(await blob?.text()).toBe("<svg>raw</svg>")
    expect(downloadDiagram).toHaveBeenCalledWith(expect.any(Blob), "svg", "chart")
    await controller.run("png")
    expect(createPngExport).toHaveBeenCalledWith(stage.querySelector("svg"), "#123456")
    expect(downloadDiagram).toHaveBeenLastCalledWith(expect.any(Blob), "png", "chart")
    expect(controller.getState().status).toBe("PNG download started.")
  })

  it("uses defaults, prevents duplicate PNG work, and reports export failures", async () => {
    const pending = deferred<Blob>()
    vi.mocked(createPngExport).mockReturnValue(pending.promise)
    const { controller, stage } = fixture()
    const operation = controller.run("png")
    expect(controller.getState()).toMatchObject({ exporting: true, status: "Creating PNG…" })
    expect(controller.getAction("png")).toMatchObject({ disabled: true, busy: true })
    controller.run("png")
    expect(createPngExport).toHaveBeenCalledExactlyOnceWith(stage.querySelector("svg"), "#ffffff")
    pending.reject(new Error("Unable to encode PNG export."))
    await operation
    expect(controller.getState()).toMatchObject({
      exporting: false,
      status: "Unable to encode PNG export.",
    })
    vi.mocked(downloadDiagram).mockImplementationOnce(() => {
      throw new Error("Download denied")
    })
    controller.run("svg")
    expect(controller.getState().status).toBe("Download denied")
  })

  it.each(["copy", "png"] as const)("ignores late %s success after destroy", async (action) => {
    const pending = deferred<Blob>()
    vi.mocked(createPngExport).mockReturnValue(pending.promise)
    vi.spyOn(navigator, "clipboard", "get").mockReturnValue({
      writeText: () => pending.promise,
    } as unknown as Clipboard)
    const { controller } = fixture()
    const listener = vi.fn()
    controller.subscribe(listener)
    const operation = controller.run(action)
    controller.destroy()
    const snapshot = controller.getState()
    listener.mockClear()
    pending.resolve(new Blob(["png"]))
    await operation
    expect(controller.getState()).toBe(snapshot)
    expect(listener).not.toHaveBeenCalled()
    expect(downloadDiagram).not.toHaveBeenCalled()
    controller.run("source")
    controller.update({ source: "ignored" })
    controller.refresh()
    expect(controller.getState()).toBe(snapshot)
  })
})

describe("late async rejection", () => {
  it.each(["copy", "png"] as const)("ignores late %s failure after destroy", async (action) => {
    const pending = deferred<Blob>()
    vi.mocked(createPngExport).mockReturnValue(pending.promise)
    vi.spyOn(navigator, "clipboard", "get").mockReturnValue({
      writeText: () => pending.promise,
    } as unknown as Clipboard)
    const { controller } = fixture()
    const operation = controller.run(action)
    controller.destroy()
    const snapshot = controller.getState()
    pending.reject(new Error("Late failure"))
    await operation
    expect(controller.getState()).toBe(snapshot)
    expect(downloadDiagram).not.toHaveBeenCalled()
  })
})

describe("fullscreen lifecycle", () => {
  it("uses native fullscreen on the same live node and restores focus", async () => {
    const { controller, root, button, viewport, stage } = fixture()
    const svg = stage.firstElementChild
    button.focus()
    root.requestFullscreen = vi.fn(async () => {
      fullscreenElement = root
      document.dispatchEvent(new Event("fullscreenchange"))
    })
    document.exitFullscreen = vi.fn(async () => {
      fullscreenElement = null
      document.dispatchEvent(new Event("fullscreenchange"))
    })
    await controller.run("fullscreen")
    flushFrames()
    expect(controller.getState()).toMatchObject({
      expanded: true,
      fallback: false,
      fullscreenPending: false,
    })
    expect(document.activeElement).toBe(viewport)
    expect(stage.firstElementChild).toBe(svg)
    await controller.run("fullscreen")
    flushFrames()
    expect(controller.getState().expanded).toBe(false)
    expect(document.activeElement).toBe(button)
  })

  it("restores fallback isolation, scroll styles, and focus on Escape and destroy", async () => {
    const sibling = document.createElement("button")
    document.body.append(sibling)
    const { controller, root, button, viewport } = fixture()
    const container = document.createElement("div")
    container.style.overflow = "auto"
    container.style.overscrollBehavior = "contain"
    root.before(container)
    container.append(root)
    document.body.style.overflow = "scroll"
    document.documentElement.style.overscrollBehavior = "auto"
    sibling.inert = true
    button.focus()
    root.requestFullscreen = vi.fn().mockRejectedValue(new Error("Unavailable"))
    await controller.run("fullscreen")
    flushFrames()
    expect(controller.getState()).toMatchObject({ expanded: true, fallback: true })
    expect(controller.getState().status).toBe("Using fullscreen fallback.")
    expect(document.body.style.overflow).toBe("hidden")
    expect(container.style.overflow).toBe("hidden")
    expect(document.activeElement).toBe(viewport)
    const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })
    viewport.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)
    flushFrames()
    expect(controller.getState().expanded).toBe(false)
    expect(document.body.style.overflow).toBe("scroll")
    expect(container.style.overflow).toBe("auto")
    expect(container.style.overscrollBehavior).toBe("contain")
    expect(sibling.inert).toBe(true)
    expect(document.activeElement).toBe(button)
    sibling.inert = false
    await controller.run("fullscreen")
    flushFrames()
    expect(sibling.inert).toBe(true)
    controller.destroy()
    expect(sibling.inert).toBe(false)
    expect(document.documentElement.style.overscrollBehavior).toBe("auto")
    expect(document.body.style.overflow).toBe("scroll")
    expect(document.activeElement).toBe(button)
    expect(frames.size).toBe(0)
  })

  it.each(["close", "escape", "destroy"] as const)(
    "restores scroll longhands and priorities on %s",
    async (exit) => {
      const { controller, root, viewport } = fixture()
      const container = document.createElement("div")
      container.style.setProperty("overflow-y", "auto", "important")
      container.style.setProperty("overscroll-behavior-y", "contain", "important")
      root.before(container)
      container.append(root)
      document.body.style.setProperty("overflow-x", "scroll", "important")
      document.body.style.setProperty("overflow-y", "auto")
      document.body.style.setProperty("overscroll-behavior", "contain none", "important")
      document.documentElement.style.setProperty("overscroll-behavior-x", "none", "important")
      const properties = [
        "overflow-x",
        "overflow-y",
        "overscroll-behavior-x",
        "overscroll-behavior-y",
      ]
      const elements = [container, document.body, document.documentElement]
      const snapshot = () =>
        elements.map((element) =>
          properties.map((property) => ({
            value: element.style.getPropertyValue(property),
            priority: element.style.getPropertyPriority(property),
          })),
        )
      const before = snapshot()
      expect(container.style.overflow).toBe("")
      root.requestFullscreen = vi.fn().mockRejectedValue(new Error("Unavailable"))
      await controller.run("fullscreen")
      flushFrames()
      expect(controller.getState().fallback).toBe(true)
      expect(container.style.overflow).toBe("hidden")
      if (exit === "destroy") controller.destroy()
      else if (exit === "escape")
        viewport.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
      else await controller.run("fullscreen")
      flushFrames()
      expect(snapshot()).toEqual(before)
    },
  )

  it("does not focus the hidden viewport while source is shown", async () => {
    const { controller, button, viewport } = fixture()
    button.focus()
    controller.run("source")
    viewport.hidden = true
    await controller.run("fullscreen")
    flushFrames()
    expect(document.activeElement).toBe(button)
  })

  it("rejects duplicate requests and does not open fallback after late rejection", async () => {
    const { controller, root, button } = fixture()
    button.focus()
    const pending = deferred<void>()
    root.requestFullscreen = vi.fn().mockReturnValue(pending.promise)
    const operation = controller.run("fullscreen")
    expect(controller.getAction("fullscreen")).toMatchObject({ disabled: true, busy: true })
    controller.run("fullscreen")
    expect(root.requestFullscreen).toHaveBeenCalledOnce()
    const listener = vi.fn()
    controller.subscribe(listener)
    controller.destroy()
    const snapshot = controller.getState()
    pending.reject(new Error("Late failure"))
    await operation
    expect(controller.getState()).toBe(snapshot)
    expect(document.body.style.overflow).toBe("")
    expect(listener).not.toHaveBeenCalled()
    expect(frames.size).toBe(0)
  })

  it("exits a late native success after destroy without touching a newer session", async () => {
    const first = fixture()
    const second = fixture()
    const pending = deferred<void>()
    first.root.requestFullscreen = vi.fn().mockReturnValue(pending.promise)
    document.exitFullscreen = vi.fn(async () => {
      fullscreenElement = null
    })
    const operation = first.controller.run("fullscreen")
    first.controller.destroy()
    fullscreenElement = second.root
    pending.resolve()
    await operation
    expect(document.exitFullscreen).not.toHaveBeenCalled()

    const third = fixture()
    const later = deferred<void>()
    third.root.requestFullscreen = vi.fn().mockReturnValue(later.promise)
    const lateOperation = third.controller.run("fullscreen")
    third.controller.destroy()
    fullscreenElement = third.root
    later.resolve()
    await lateOperation
    expect(document.exitFullscreen).toHaveBeenCalledOnce()
    expect(fullscreenElement).toBeNull()
    expect(frames.size).toBe(0)
  })

  it("handles exit rejection, missing exit API, and destroy during native fullscreen", async () => {
    const { controller, root, button } = fixture()
    button.focus()
    root.requestFullscreen = vi.fn(async () => {
      fullscreenElement = root
    })
    document.exitFullscreen = vi.fn().mockRejectedValue(new Error("Denied"))
    await controller.run("fullscreen")
    flushFrames()
    await controller.run("fullscreen")
    expect(controller.getState().status).toBe("Unable to exit fullscreen.")
    expect(controller.getState().fullscreenPending).toBe(false)
    Reflect.deleteProperty(document, "exitFullscreen")
    expect(() => controller.destroy()).not.toThrow()
    expect(document.activeElement).toBe(button)
  })

  it("restores an external opener after native exit finishes following unmount", async () => {
    const opener = document.createElement("button")
    const other = document.createElement("button")
    document.body.append(opener, other)
    const { controller, root } = fixture()
    opener.focus()
    root.requestFullscreen = vi.fn(async () => {
      fullscreenElement = root
    })
    const exit = deferred<void>()
    document.exitFullscreen = vi.fn(async () => {
      await exit.promise
      fullscreenElement = null
      // Model the native browser moving focus as fullscreen exits.
      other.focus()
    })
    await controller.run("fullscreen")
    flushFrames()
    root.remove()
    controller.destroy()
    expect(document.activeElement).toBe(opener)
    exit.resolve()
    await vi.mocked(document.exitFullscreen).mock.results[0]?.value
    await vi.waitFor(() => expect(document.activeElement).toBe(opener))
  })

  it("transfers fallback ownership without leaking document locks between instances", async () => {
    const first = fixture()
    const second = fixture()
    await first.controller.run("fullscreen")
    flushFrames()
    await second.controller.run("fullscreen")
    flushFrames()
    expect(first.controller.getState().expanded).toBe(false)
    expect(second.controller.getState().fallback).toBe(true)
    first.controller.destroy()
    expect(document.body.style.overflow).toBe("hidden")
    second.controller.destroy()
    expect(document.body.style.overflow).toBe("")
    expect(first.root.inert).toBeFalsy()
    expect(second.root.inert).toBeFalsy()
  })
})
