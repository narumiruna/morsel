import { afterEach, describe, expect, it, vi } from "vitest"
import {
  createPngExport,
  downloadDiagram,
  maxPngDimension,
  maxPngPixels,
  serializeDiagramSvg,
} from "./diagramExport.js"

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
  vi.useRealTimers()
})

describe("diagram export", () => {
  it("serializes natural dimensions and the explicit background color", () => {
    const output = serializeDiagramSvg(svg(), "#111113")
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
    const png = await createPngExport(diagram)
    const canvas = getContext.mock.instances[0] as HTMLCanvasElement | undefined
    expect(png).toMatchObject({ size: 3, type: "image/png" })
    expect((canvas?.width ?? 0) * (canvas?.height ?? 0)).toBeLessThanOrEqual(maxPngPixels)
    expect(canvas?.width).toBeLessThanOrEqual(maxPngDimension)
    expect(context.fillRect).toHaveBeenCalled()
    expect(context.drawImage).toHaveBeenCalled()
  })

  it("rejects missing dimensions and decode failures", async () => {
    expect(() => serializeDiagramSvg(svg("<svg></svg>"))).toThrow(
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
    await expect(createPngExport(svg())).rejects.toThrow("Unable to rasterize")
  })

  it("defaults to white and preserves a nonzero viewBox without changing the live SVG", () => {
    const diagram = svg(
      '<svg viewBox="-10 20 100 50" transform="scale(2)"><text>Original</text></svg>',
    )
    const original = diagram.outerHTML
    const output = serializeDiagramSvg(diagram)
    expect(output).toContain('viewBox="-10 20 100 50"')
    expect(output).toContain('fill="#ffffff"')
    expect(output).toContain('x="-10"')
    expect(output).toContain('y="20"')
    expect(output).not.toContain('transform="scale(2)"')
    expect(diagram.outerHTML).toBe(original)
  })

  it("rejects serialized SVG over 16 MiB before creating an image", async () => {
    const diagram = svg()
    diagram.append(document.createTextNode("x".repeat(16 * 1024 * 1024)))
    const image = vi.fn()
    vi.stubGlobal("Image", image)
    expect(() => serializeDiagramSvg(diagram)).toThrow("Exported SVG is too large")
    await expect(createPngExport(diagram)).rejects.toThrow("Exported SVG is too large")
    expect(image).not.toHaveBeenCalled()
  })

  it.each(["0 0 0 50", "0 0 -1 50", "0 0 Infinity 50", "0 0 NaN 50"])(
    "rejects invalid dimensions: %s",
    async (viewBox) => {
      await expect(createPngExport(svg(`<svg viewBox="${viewBox}"></svg>`))).rejects.toThrow(
        "Diagram dimensions are unavailable",
      )
    },
  )

  it.each([
    [100000, 10],
    [10, 100000],
    [4101, 4319],
  ])("enforces both dimension and pixel limits for %s × %s", async (width, height) => {
    successfulImage()
    vi.stubGlobal("devicePixelRatio", 4)
    const context = { drawImage: vi.fn(), fillRect: vi.fn(), fillStyle: "" }
    const getContext = vi
      .spyOn(HTMLCanvasElement.prototype, "getContext")
      .mockReturnValue(context as unknown as CanvasRenderingContext2D)
    vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation((callback) =>
      callback(new Blob(["png"])),
    )
    await createPngExport(svg(`<svg viewBox="0 0 ${width} ${height}"></svg>`), "rebeccapurple")
    const canvas = getContext.mock.instances[0] as HTMLCanvasElement
    expect(canvas.width).toBeLessThanOrEqual(maxPngDimension)
    expect(canvas.height).toBeLessThanOrEqual(maxPngDimension)
    expect(canvas.width * canvas.height).toBeLessThanOrEqual(maxPngPixels)
    expect(canvas.width).toBeGreaterThan(0)
    expect(canvas.height).toBeGreaterThan(0)
    expect(context.fillStyle).toBe("rebeccapurple")
  })

  it.each(["context", "empty", "null", "throw"])(
    "cleans up decoded images when PNG export fails: %s",
    async (failure) => {
      const remove = vi.fn()
      const images: { onload: (() => void) | null; onerror: (() => void) | null }[] = []
      vi.stubGlobal(
        "Image",
        class {
          onload: (() => void) | null = null
          onerror: (() => void) | null = null
          constructor() {
            images.push(this)
          }
          set src(_value: string) {
            queueMicrotask(() => this.onload?.())
          }
          removeAttribute(name: string) {
            remove(name)
          }
        },
      )
      const context = { drawImage: vi.fn(), fillRect: vi.fn(), fillStyle: "" }
      vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
        failure === "context" ? null : (context as unknown as CanvasRenderingContext2D),
      )
      vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation((callback) => {
        if (failure === "throw") throw new Error("Canvas encoding failed")
        callback(failure === "null" ? null : new Blob([]))
      })
      await expect(createPngExport(svg())).rejects.toThrow(
        failure === "context"
          ? "PNG export is unavailable"
          : failure === "throw"
            ? "Canvas encoding failed"
            : "Unable to encode PNG export",
      )
      expect(remove).toHaveBeenCalledWith("src")
      expect(images[0]?.onload).toBeNull()
      expect(images[0]?.onerror).toBeNull()
    },
  )

  it("cleans up image handlers and source on decode failure", async () => {
    const remove = vi.fn()
    let image: { onload: (() => void) | null; onerror: (() => void) | null } | undefined
    vi.stubGlobal(
      "Image",
      class {
        onload: (() => void) | null = null
        onerror: (() => void) | null = null
        constructor() {
          image = this
        }
        set src(_value: string) {
          queueMicrotask(() => this.onerror?.())
        }
        removeAttribute(name: string) {
          remove(name)
        }
      },
    )
    await expect(createPngExport(svg())).rejects.toThrow("Unable to rasterize")
    expect(remove).toHaveBeenCalledWith("src")
    expect(image?.onload).toBeNull()
    expect(image?.onerror).toBeNull()
  })

  it("removes the download anchor and revokes its URL even when activation fails", () => {
    vi.useFakeTimers()
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {
      throw new Error("Denied")
    })
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:failed-download")
    const revoke = vi.spyOn(URL, "revokeObjectURL")
    expect(() => downloadDiagram(new Blob(["svg"]), "svg", "custom")).toThrow("Denied")
    expect(document.querySelector("a")).toBeNull()
    vi.runAllTimers()
    expect(revoke).toHaveBeenCalledWith("blob:failed-download")
  })

  it("downloads with a stable filename and revokes the URL", () => {
    vi.useFakeTimers()
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {})
    const create = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:diagram")
    const revoke = vi.spyOn(URL, "revokeObjectURL")
    downloadDiagram(new Blob(["svg"]), "png")
    expect(create).toHaveBeenCalledOnce()
    expect(click).toHaveBeenCalledOnce()
    expect((click.mock.instances[0] as HTMLAnchorElement | undefined)?.download).toBe("diagram.png")
    vi.runAllTimers()
    expect(revoke).toHaveBeenCalledWith("blob:diagram")
    vi.useRealTimers()
  })
})
