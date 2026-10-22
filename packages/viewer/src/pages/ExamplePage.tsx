import { Badge } from "@radix-ui/themes"
import { DocumentPage } from "./DocumentPage"
import example from "./example.md?raw"

export function ExamplePage() {
  return (
    <DocumentPage
      content={example}
      filename="morsel-example.md"
      badges={<Badge color="gray">Bundled example · no share views used</Badge>}
    />
  )
}
