import { afterEach, describe, expect, it, vi } from "vitest"
import {
  createPngExport,
  downloadDiagram,
  maxPngDimension,
  maxPngPixels,
  serializeDiagramSvg,
} from "./diagramExport"

function svg(markup = '<svg viewBox="0 0 100 50"><text>Diagram</text></svg>') {
  const holder = document.createElement("div")
  holder.innerHTML = markup
  const diagram = holder.querySelector("svg")
  if (!(diagram instanceof SVGSVGElement)) throw new Error("fixture SVG missing")
  document.body.append(diagram)
  return diagram
}

function successfulImage() {
  vi.stubGlobal(
    "Image",
    class {
      onload?: () => void
      onerror?: () => void
      #src = ""
      set src(value: string) {
        this.#src = value
        if (value) queueMicrotask(() => this.onload?.())
      }
      get src() {
        return this.#src
      }
      removeAttribute(name: string) {
        if (name === "src") this.#src = ""
      }
    },
  )
}

afterEach(() => {
  document.body.replaceChildren()
})

describe("diagram export", () => {
  it("serializes natural dimensions and the selected theme background", () => {
    const output = serializeDiagramSvg(svg(), "dark")
    expect(output).toContain('width="100"')
    expect(output).toContain('height="50"')
    expect(output).toContain('fill="#111113"')
    expect(output).toContain("Diagram")
  })

  it("creates a bounded non-empty PNG", async () => {
    successfulImage()
    const context = { drawImage: vi.fn(), fillRect: vi.fn(), fillStyle: "" }
    const getContext = vi
      .spyOn(HTMLCanvasElement.prototype, "getContext")
      .mockReturnValue(context as unknown as CanvasRenderingContext2D)
    vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation((callback) => {
      callback(new Blob(["png"], { type: "image/png" }))
    })
    const diagram = svg('<svg viewBox="0 0 10000 10000"><text>Large</text></svg>')
    const png = await createPngExport(diagram, "light")
    const canvas = getContext.mock.instances[0] as HTMLCanvasElement | undefined
    expect(png).toMatchObject({ size: 3, type: "image/png" })
    expect((canvas?.width ?? 0) * (canvas?.height ?? 0)).toBeLessThanOrEqual(maxPngPixels)
    expect(canvas?.width).toBeLessThanOrEqual(maxPngDimension)
    expect(context.fillRect).toHaveBeenCalled()
    expect(context.drawImage).toHaveBeenCalled()
  })

  it("rejects missing dimensions and decode failures", async () => {
    expect(() => serializeDiagramSvg(svg("<svg></svg>"), "light")).toThrow(
      "Diagram dimensions are unavailable",
    )
    vi.stubGlobal(
      "Image",
      class {
        onload?: () => void
        onerror?: () => void
        set src(value: string) {
          if (value) queueMicrotask(() => this.onerror?.())
        }
        removeAttribute() {}
      },
    )
    await expect(createPngExport(svg(), "light")).rejects.toThrow("Unable to rasterize")
  })

  it("downloads with a stable filename and revokes the URL", () => {
    vi.useFakeTimers()
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {})
    const create = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:diagram")
    const revoke = vi.spyOn(URL, "revokeObjectURL")
    downloadDiagram(new Blob(["svg"]), "png")
    expect(create).toHaveBeenCalledOnce()
    expect(click).toHaveBeenCalledOnce()
    expect((click.mock.instances[0] as HTMLAnchorElement | undefined)?.download).toBe(
      "mermaid-diagram.png",
    )
    vi.runAllTimers()
    expect(revoke).toHaveBeenCalledWith("blob:diagram")
    vi.useRealTimers()
  })
})
