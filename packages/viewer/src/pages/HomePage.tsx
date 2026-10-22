import { FileTextIcon } from "@radix-ui/react-icons"
import { Button, Card, Heading, Link, Text } from "@radix-ui/themes"
import { type FormEvent, useRef, useState } from "react"
import { parseDocumentUrl } from "../documentUrl"
import "../styles/home.css"

export function HomePage() {
  const [value, setValue] = useState("")
  const [invalid, setInvalid] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  const opening = useRef(false)

  function openDocument(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (opening.current) return
    const path = parseDocumentUrl(value, window.location.origin)
    if (!path) {
      setInvalid(true)
      input.current?.focus()
      return
    }
    opening.current = true
    // Route once, without a validation read or a full page reload.
    window.history.pushState({}, "", path)
    window.dispatchEvent(new PopStateEvent("popstate"))
  }

  return (
    <Card className="home-page">
      <FileTextIcon className="home-icon" width="32" height="32" aria-hidden="true" />
      <Heading as="h1" size="7">
        Open a document
      </Heading>
      <Text as="p" color="gray">
        Read a Morsel share or a GitHub Gist in your browser.
      </Text>
      <form className="document-entry" method="post" noValidate onSubmit={openDocument}>
        <label htmlFor="document-url">Document URL</label>
        <input
          ref={input}
          id="document-url"
          type="text"
          inputMode="url"
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          value={value}
          aria-invalid={invalid}
          aria-describedby={invalid ? "document-url-hint document-url-error" : "document-url-hint"}
          onChange={(event) => {
            setValue(event.target.value)
            setInvalid(false)
          }}
        />
        <Text as="p" id="document-url-hint" size="2" color="gray">
          Use a share URL from this site (<code>/s/token</code> or <code>/#/s/token</code>), a
          viewer URL (<code>/gist/#id</code>), or <code>https://gist.github.com/owner/id</code>.
        </Text>
        {invalid && (
          <Text as="p" id="document-url-error" className="document-entry-error" role="alert">
            Enter a supported document URL. Check the complete share token or Gist ID, use this
            site's share address or HTTPS gist.github.com, and remove extra paths, queries, or
            fragments.
          </Text>
        )}
        <div className="document-entry-actions">
          <Button type="submit" size="3">
            Open document
          </Button>
          <Link href="/example">View example</Link>
        </div>
      </form>
      <Text as="p" size="2" color="gray">
        The example is bundled with Morsel. No account or share link is needed.
      </Text>
    </Card>
  )
}
