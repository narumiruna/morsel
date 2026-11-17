// Trusted, local SVG fixtures. No renderer, sanitizer, or network is needed.
export const sequenceSource = `sequenceDiagram
  participant Browser
  participant API
  participant Database
  Browser->>API: Request document
  API->>Database: Query
  Database-->>API: Document
  API-->>Browser: Render diagram
%% Source must remain text: <img src=x onerror="window.sourceExecuted=true">
${Array.from({ length: 60 }, (_, index) => `%% source line ${index + 1}`).join("\n")}`

export const classSource = `classDiagram
  class Document {
    +string title
    +render()
  }
  class Diagram {
    +string source
    +export()
  }
  Document "1" --> "*" Diagram
`

export function sequenceSvg(dark: boolean) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1100" height="500" viewBox="0 0 1100 500" role="img" aria-label="Document request sequence">
  <g fill="${dark ? "#edf2f7" : "#202124"}" font-family="sans-serif" font-size="20" text-anchor="middle">
    <g fill="${dark ? "#273449" : "#eaf2ff"}" stroke="${dark ? "#a9bad1" : "#405572"}">
      <rect x="55" y="20" width="190" height="55" rx="4"/><rect x="455" y="20" width="190" height="55" rx="4"/><rect x="855" y="20" width="190" height="55" rx="4"/>
    </g>
    <text x="150" y="55">Browser</text><text x="550" y="55">API</text><text x="950" y="55">Database</text>
    <g fill="none" stroke="${dark ? "#a9bad1" : "#405572"}" stroke-width="2">
      <path d="M150 75V475M550 75V475M950 75V475" stroke-dasharray="6 6"/>
      <path d="M150 145H550l-12-7m12 7-12 7M550 235H950l-12-7m12 7-12 7M950 325H550l12-7m-12 7 12 7M550 415H150l12-7m-12 7 12 7"/>
    </g>
    <text x="350" y="130">Request document</text><text x="750" y="220">Query</text><text x="750" y="310">Document</text><text x="350" y="400">Render diagram</text>
  </g></svg>`
}

export function classSvg(dark: boolean) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="400" viewBox="0 0 800 400" role="img" aria-label="Document and diagram classes">
  <g font-family="sans-serif" font-size="20" fill="${dark ? "#edf2f7" : "#202124"}">
    <g fill="${dark ? "#273449" : "#eaf2ff"}" stroke="${dark ? "#a9bad1" : "#405572"}" stroke-width="2">
      <rect x="30" y="100" width="280" height="190" rx="4"/><rect x="490" y="100" width="280" height="190" rx="4"/>
      <path d="M30 150H310M30 220H310M490 150H770M490 220H770M310 195H490l-12-7m12 7-12 7" fill="none"/>
    </g>
    <text x="170" y="135" text-anchor="middle">Document</text><text x="630" y="135" text-anchor="middle">Diagram</text>
    <text x="50" y="190">+string title</text><text x="50" y="260">+render()</text>
    <text x="510" y="190">+string source</text><text x="510" y="260">+export()</text>
    <text x="330" y="180">1</text><text x="460" y="180">*</text>
  </g></svg>`
}
