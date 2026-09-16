import type { Appearance } from "../theme"

export const maxPngDimension = 8_192
export const maxPngPixels = 16_000_000
const maxSerializedSvgBytes = 16 * 1024 * 1024

interface NaturalSize {
  height: number
  width: number
  x: number
  y: number
}

function naturalSize(svg: SVGSVGElement): NaturalSize {
  const values = (svg.getAttribute("viewBox") ?? "")
    .trim()
    .split(/[\s,]+/)
    .map(Number)
  const width = svg.viewBox?.baseVal.width || values[2] || 0
  const height = svg.viewBox?.baseVal.height || values[3] || 0
  const x = svg.viewBox?.baseVal.x ?? values[0] ?? 0
  const y = svg.viewBox?.baseVal.y ?? values[1] ?? 0
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new Error("Diagram dimensions are unavailable for export.")
  }
  return { height, width, x, y }
}

export function serializeDiagramSvg(svg: SVGSVGElement, appearance: Appearance): string {
  const clone = svg.cloneNode(true) as SVGSVGElement
  const size = naturalSize(svg)
  clone.setAttribute("xmlns", "http://www.w3.org/2000/svg")
  clone.setAttribute("width", String(size.width))
  clone.setAttribute("height", String(size.height))
  clone.setAttribute("viewBox", `${size.x} ${size.y} ${size.width} ${size.height}`)
  clone.removeAttribute("transform")

  const background = document.createElementNS("http://www.w3.org/2000/svg", "rect")
  background.dataset.exportBackground = "true"
  background.setAttribute("x", String(size.x))
  background.setAttribute("y", String(size.y))
  background.setAttribute("width", String(size.width))
  background.setAttribute("height", String(size.height))
  background.setAttribute("fill", appearance === "dark" ? "#111113" : "#ffffff")
  clone.prepend(background)

  const output = `<?xml version="1.0" encoding="UTF-8"?>\n${new XMLSerializer().serializeToString(clone)}`
  if (new Blob([output]).size > maxSerializedSvgBytes) {
    throw new Error("Exported SVG is too large to process safely.")
  }
  return output
}

function svgDataUrl(source: string): string {
  const bytes = new TextEncoder().encode(source)
  let binary = ""
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000))
  }
  return `data:image/svg+xml;base64,${btoa(binary)}`
}

function loadImage(source: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => {
      image.onload = null
      image.onerror = null
      image.removeAttribute("src")
      reject(new Error("Unable to rasterize this diagram."))
    }
    image.src = svgDataUrl(source)
  })
}

export async function createPngExport(svg: SVGSVGElement, appearance: Appearance): Promise<Blob> {
  const size = naturalSize(svg)
  const preferredScale = Math.max(1, Math.min(2, window.devicePixelRatio || 1))
  const scale = Math.min(
    preferredScale,
    maxPngDimension / size.width,
    maxPngDimension / size.height,
    Math.sqrt(maxPngPixels / (size.width * size.height)),
  )
  if (!Number.isFinite(scale) || scale <= 0) {
    throw new Error("Diagram is too large to export safely.")
  }
  const width = Math.max(1, Math.round(size.width * scale))
  const height = Math.max(1, Math.round(size.height * scale))
  const image = await loadImage(serializeDiagramSvg(svg, appearance))
  try {
    const canvas = document.createElement("canvas")
    canvas.width = width
    canvas.height = height
    const context = canvas.getContext("2d")
    if (!context) throw new Error("PNG export is unavailable in this browser.")
    context.fillStyle = appearance === "dark" ? "#111113" : "#ffffff"
    context.fillRect(0, 0, width, height)
    context.drawImage(image, 0, 0, width, height)
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"))
    if (!blob || blob.size === 0) throw new Error("Unable to encode PNG export.")
    return blob
  } finally {
    image.onload = null
    image.onerror = null
    image.removeAttribute("src")
  }
}

export function downloadDiagram(blob: Blob, extension: "png" | "svg"): void {
  const url = URL.createObjectURL(blob)
  const link = document.createElement("a")
  link.href = url
  link.download = `mermaid-diagram.${extension}`
  link.hidden = true
  document.body.append(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 0)
}
