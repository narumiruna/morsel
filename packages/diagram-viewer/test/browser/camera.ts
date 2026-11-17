import { createDiagramView } from "@narumitw/diagram-viewer/core"

const viewport = document.querySelector<HTMLElement>("#viewport")
const stage = document.querySelector<HTMLElement>("#stage")
const node = stage?.querySelector<SVGElement>("[data-diagram-node]")
if (!viewport || !stage || !node) throw new Error("Missing camera fixture")
let selections = 0
node.addEventListener("click", () => {
  document.body.dataset.selections = String(++selections)
})
node.addEventListener("keydown", (event) => {
  if (event.key === "Enter" || event.key === " ") event.preventDefault()
  if (event.key === "Enter") node.dispatchEvent(new MouseEvent("click", { bubbles: true }))
})
node.addEventListener("keyup", (event) => {
  if (event.key !== " ") return
  event.preventDefault()
  node.dispatchEvent(new MouseEvent("click", { bubbles: true }))
})
document.querySelector("#nested")?.addEventListener("click", (event) => {
  event.stopPropagation()
  document.body.dataset.control = "activated"
})
const camera = createDiagramView(viewport, stage, {
  isExpanded: () => viewport.hasAttribute("data-expanded"),
})
camera.reset()
document.querySelector("#expand")?.addEventListener("click", () => {
  viewport.setAttribute("data-expanded", "")
  camera.refresh()
})
document.querySelector("#destroy")?.addEventListener("click", () => camera.destroy())
document.querySelector("#readable")?.addEventListener("click", () => camera.reset())
document.body.dataset.selections = "0"
document.body.dataset.ready = "true"
