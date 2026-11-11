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

const sanitizeSchema = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    code: [["className", /^language-[\w-]+$/, "math-inline", "math-display"]],
    input: ["type", "checked", "disabled"],
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

export function MarkdownDocument({
  content,
  loadImages = true,
}: {
  content: string
  loadImages?: boolean
}) {
  let mermaidIndex = 0
  let vegaLiteIndex = 0
  return (
    <article className="markdown-document">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[
          // Sanitize authored content before trusted renderers add SVG, MathML, and styles.
          [rehypeSanitize, sanitizeSchema],
          [rehypeKatex, { strict: "error", trust: false, throwOnError: false }],
          [rehypeHighlight, { detect: false, plainText: ["mermaid", "vega-lite"] }],
        ]}
        urlTransform={safeURL}
        components={{
          a: ({ href, children, node, ...props }) => {
            const footnote =
              node?.properties.dataFootnoteRef !== undefined ||
              node?.properties.dataFootnoteBackref !== undefined
            // The sanitizer prefixes footnote IDs, but not their fragment URLs.
            const target =
              footnote && href?.startsWith("#")
                ? `#${sanitizeSchema.clobberPrefix ?? ""}${href.slice(1)}`
                : href
            const external = href?.startsWith("http://") || href?.startsWith("https://")
            return (
              <a
                href={target}
                target={external ? "_blank" : undefined}
                rel={external ? "noopener noreferrer" : undefined}
                {...props}
              >
                {children}
              </a>
            )
          },
          img: ({ alt, node: _node, ...props }) =>
            loadImages ? (
              <img alt={alt ?? ""} loading="lazy" referrerPolicy="no-referrer" {...props} />
            ) : (
              <span>Image not loaded{alt ? `: ${alt}` : ""}</span>
            ),
          code: ({ className, children, node: _node, ...props }) => {
            const source = String(children).replace(/\n$/, "")
            // Mermaid image nodes fetch resources before SVG sanitation.
            // Keep their source inert when administrative inspection blocks images.
            if (className === "language-mermaid" && loadImages) {
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
              <pre
                // biome-ignore lint/a11y/noNoninteractiveTabindex: Code blocks support horizontal keyboard scrolling.
                tabIndex={0}
              >
                {children}
              </pre>
            ),
        }}
      >
        {content}
      </ReactMarkdown>
    </article>
  )
}
