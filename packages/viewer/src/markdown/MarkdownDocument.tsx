import "katex/dist/katex.min.css"
import { isValidElement } from "react"
import ReactMarkdown, { defaultUrlTransform } from "react-markdown"
import rehypeHighlight from "rehype-highlight"
import rehypeKatex from "rehype-katex"
import rehypeSanitize, { defaultSchema } from "rehype-sanitize"
import remarkGfm from "remark-gfm"
import remarkMath from "remark-math"
import { MermaidDiagram } from "./MermaidDiagram"
import { VegaLiteChart } from "./VegaLiteChart"

const mathTags = [
  "math",
  "menclose",
  "merror",
  "mfenced",
  "mfrac",
  "mi",
  "mlongdiv",
  "mmultiscripts",
  "mn",
  "mo",
  "mover",
  "mpadded",
  "mphantom",
  "mroot",
  "mrow",
  "ms",
  "mscarries",
  "mscarry",
  "msgroup",
  "msline",
  "mspace",
  "msqrt",
  "msrow",
  "mstack",
  "mstyle",
  "msub",
  "msubsup",
  "msup",
  "mtable",
  "mtd",
  "mtext",
  "mtr",
  "munder",
  "munderover",
  "semantics",
  "annotation",
]

const sanitizeSchema = {
  ...defaultSchema,
  tagNames: [...(defaultSchema.tagNames ?? []), ...mathTags],
  attributes: {
    ...defaultSchema.attributes,
    div: [...(defaultSchema.attributes?.div ?? []), ["className", "math", "math-display"]],
    span: [
      ...(defaultSchema.attributes?.span ?? []),
      ["className", /^[A-Za-z0-9_-]+$/],
      "style",
      "ariaHidden",
    ],
    code: [["className", "hljs", /^language-[\w-]+$/]],
    input: ["type", "checked", "disabled"],
    math: ["xmlns", "display"],
    annotation: ["encoding"],
    mstyle: ["mathcolor", "mathbackground", "scriptlevel", "displaystyle"],
    mspace: ["width", "height", "depth"],
    mo: ["fence", "separator", "stretchy", "symmetric", "largeop", "movablelimits", "form"],
    mtable: ["columnalign", "rowalign", "columnspacing", "rowspacing"],
    mtd: ["columnalign", "rowalign", "columnspan", "rowspan"],
  },
  protocols: {
    ...defaultSchema.protocols,
    href: ["http", "https", "mailto"],
    src: ["http", "https", "data"],
  },
}

function safeURL(url: string, key: string, node: { tagName: string }): string {
  if (url.startsWith("#") || url.startsWith("/")) return defaultUrlTransform(url)
  if (
    key === "src" &&
    node.tagName === "img" &&
    /^data:image\/(?:png|gif|jpeg|webp);base64,/i.test(url)
  ) {
    return url
  }
  try {
    const parsed = new URL(url)
    if (parsed.protocol === "https:" || parsed.protocol === "http:") return url
    if (key === "href" && parsed.protocol === "mailto:") return url
  } catch {
    return ""
  }
  return ""
}

export function MarkdownDocument({ content }: { content: string }) {
  let mermaidIndex = 0
  let vegaLiteIndex = 0
  return (
    <article className="markdown-document">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[
          [rehypeKatex, { strict: "error", trust: false, throwOnError: false }],
          [rehypeHighlight, { detect: false, plainText: ["mermaid", "vega-lite"] }],
          [rehypeSanitize, sanitizeSchema],
        ]}
        urlTransform={safeURL}
        components={{
          a: ({ href, children, node: _node, ...props }) => {
            const external = href?.startsWith("http://") || href?.startsWith("https://")
            return (
              <a
                href={href}
                target={external ? "_blank" : undefined}
                rel={external ? "noopener noreferrer" : undefined}
                {...props}
              >
                {children}
              </a>
            )
          },
          img: ({ alt, node: _node, ...props }) => (
            <img alt={alt ?? ""} loading="lazy" referrerPolicy="no-referrer" {...props} />
          ),
          code: ({ className, children, node: _node, ...props }) => {
            const source = String(children).replace(/\n$/, "")
            if (className === "language-mermaid") {
              return <MermaidDiagram source={source} index={mermaidIndex++} />
            }
            if (className === "language-vega-lite") {
              return <VegaLiteChart source={source} index={vegaLiteIndex++} />
            }
            return (
              <code className={className} {...props}>
                {children}
              </code>
            )
          },
          pre: ({ children }) =>
            isValidElement(children) &&
            (children.type === MermaidDiagram || children.type === VegaLiteChart) ? (
              children
            ) : (
              <pre>{children}</pre>
            ),
        }}
      >
        {content}
      </ReactMarkdown>
    </article>
  )
}
