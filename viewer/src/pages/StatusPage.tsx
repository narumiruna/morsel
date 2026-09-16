import { ExclamationTriangleIcon, FileTextIcon } from "@radix-ui/react-icons"
import { Callout, Card, Flex, Heading, Spinner, Text } from "@radix-ui/themes"

export function HomePage() {
  return (
    <Card className="status-card">
      <Flex direction="column" align="center" gap="3">
        <FileTextIcon width="32" height="32" aria-hidden="true" />
        <Heading>Morsel</Heading>
        <Text align="center" color="gray">
          Open a Morsel share URL to read a Markdown document.
        </Text>
      </Flex>
    </Card>
  )
}

export function LoadingPage() {
  return (
    <div className="status-card" role="status" aria-label="Loading share">
      <Spinner size="3" />
      <span>Loading share…</span>
    </div>
  )
}

const messages = {
  "invalid-share": [
    "Invalid share link",
    "This URL does not contain a valid Morsel capability token.",
  ],
  "not-found": ["Share not found", "This share does not exist, or the URL is incorrect."],
  expired: ["Share expired", "This share has passed its expiration time."],
  revoked: ["Share revoked", "The owner revoked this share."],
  view_limit_exhausted: ["View limit reached", "This share has no views remaining."],
  generic: ["Unable to load share", "The service could not load this share. Try again later."],
} as const

export type StatusKind = keyof typeof messages

export function ErrorPage({ kind }: { kind: StatusKind }) {
  const [title, description] = messages[kind]
  return (
    <Callout.Root color="red" size="3" className="status-card" role="alert">
      <Callout.Icon>
        <ExclamationTriangleIcon />
      </Callout.Icon>
      <div>
        <Heading as="h1" size="5">
          {title}
        </Heading>
        <Text as="p">{description}</Text>
      </div>
    </Callout.Root>
  )
}
