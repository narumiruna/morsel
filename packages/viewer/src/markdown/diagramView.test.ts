import { afterEach, describe, expect, it, vi } from "vitest"
import { createDiagramView, maxDiagramScale, minDiagramScale } from "./diagramView"

function fixture() {
  const viewport = document.createElement("section")
  const stage = document.createElement("div")
  stage.innerHTML = '<svg viewBox="0 0 1000 500"><text style="font-size: 10px">Label</text></svg>'
  viewport.append(stage)
  document.body.append(viewport)
  Object.defineProperties(viewport, {
    clientWidth: { configurable: true, value: 500 },
    clientHeight: { configurable: true, value: 300 },
  })
  vi.spyOn(viewport, "getBoundingClientRect").mockReturnValue({
    bottom: 300,
    height: 300,
    left: 0,
    right: 500,
    top: 0,
    width: 500,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  })
  return { stage, viewport }
}

afterEach(() => document.body.replaceChildren())

function pointer(type: string, id: number, x: number, y: number): Event {
  const event = new Event(type, { bubbles: true, cancelable: true })
  Object.defineProperties(event, {
    button: { value: 0 },
    clientX: { value: x },
    clientY: { value: y },
    pointerId: { value: id },
    pointerType: { value: "touch" },
  })
  return event
}

describe("diagram view", () => {
  it("fits Overview without upscaling and computes a readable label scale", () => {
    const { stage, viewport } = fixture()
    const modes: string[] = []
    const controller = createDiagramView(viewport, stage, {
      onCameraModeChange: (mode) => modes.push(mode),
    })
    expect(controller.getState()).toMatchObject({ cameraMode: "overview", scale: 0.5 })
    expect(stage.style.transform).toContain("scale(0.5)")

    controller.setCameraMode("readable")
    expect(controller.getState()).toMatchObject({ cameraMode: "readable", scale: 1.4 })
    expect(modes).toEqual(["overview", "readable"])
    controller.destroy()
  })

  it("fits very large diagrams below the interactive zoom floor", () => {
    const { stage, viewport } = fixture()
    stage.innerHTML = '<svg viewBox="0 0 5000 500"><text>Wide</text></svg>'
    const controller = createDiagramView(viewport, stage)
    expect(controller.getState()).toMatchObject({ cameraMode: "overview", scale: 0.1 })
    expect(controller.getState().scale).toBeLessThan(minDiagramScale)
    expect(viewport).toHaveAttribute("data-diagram-cropped", "false")

    controller.zoomBy(0.8)
    expect(controller.getState().scale).toBe(0.1)
    expect(viewport).toHaveAttribute("data-diagram-cropped", "false")
    controller.zoomBy(1.25)
    expect(controller.getState().scale).toBe(0.125)
    controller.zoomBy(0.8)
    expect(controller.getState().scale).toBe(0.1)
    controller.destroy()
  })

  it("bounds zoom and preserves a user-modified scale while refreshing", () => {
    const { stage, viewport } = fixture()
    const controller = createDiagramView(viewport, stage)
    controller.zoomBy(100)
    expect(controller.getState().scale).toBe(maxDiagramScale)
    controller.refresh()
    expect(controller.getState().scale).toBe(maxDiagramScale)
    controller.zoomBy(0.0001)
    expect(controller.getState().scale).toBe(minDiagramScale)
    controller.destroy()
  })

  it("supports keyboard pan, zoom, refit, and removes listeners on destroy", () => {
    const { stage, viewport } = fixture()
    const controller = createDiagramView(viewport, stage)
    viewport.dispatchEvent(new KeyboardEvent("keydown", { key: "+", bubbles: true }))
    expect(controller.getState().scale).toBeCloseTo(0.625)
    viewport.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }))
    expect(controller.getState().userModified).toBe(true)
    viewport.dispatchEvent(new KeyboardEvent("keydown", { key: "0", bubbles: true }))
    expect(controller.getState()).toMatchObject({ cameraMode: "overview", scale: 0.5 })

    controller.destroy()
    viewport.dispatchEvent(new KeyboardEvent("keydown", { key: "+", bubbles: true }))
    expect(controller.getState().scale).toBe(0.5)
  })

  it("cleans up cancelled fullscreen touch pointers", () => {
    const { stage, viewport } = fixture()
    const controller = createDiagramView(viewport, stage, { isExpanded: () => true })
    controller.setCameraMode("readable")
    viewport.dispatchEvent(pointer("pointerdown", 7, 250, 150))
    viewport.dispatchEvent(pointer("pointermove", 7, 150, 150))
    const moved = stage.style.transform
    viewport.dispatchEvent(pointer("pointercancel", 7, 150, 150))
    viewport.dispatchEvent(pointer("pointermove", 7, 50, 150))
    expect(stage.style.transform).toBe(moved)
    controller.destroy()
  })

  it("only consumes modified wheel zoom", () => {
    const { stage, viewport } = fixture()
    const controller = createDiagramView(viewport, stage)
    const ordinary = new WheelEvent("wheel", { cancelable: true, deltaY: -1 })
    viewport.dispatchEvent(ordinary)
    expect(ordinary.defaultPrevented).toBe(false)
    const modified = new WheelEvent("wheel", { cancelable: true, ctrlKey: true, deltaY: -1 })
    viewport.dispatchEvent(modified)
    expect(modified.defaultPrevented).toBe(true)
    expect(controller.getState().scale).toBeCloseTo(0.55)
    controller.destroy()
  })
})
