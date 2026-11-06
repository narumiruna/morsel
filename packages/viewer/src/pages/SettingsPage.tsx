import { Card, Heading, Select, Text } from "@radix-ui/themes"
import { useMermaidLook } from "../markdown/mermaidLook"
import { ThemeControl } from "../theme"
import "../styles/settings.css"

export function SettingsPage() {
  const { look, updateLook } = useMermaidLook()

  return (
    <section className="settings-page" aria-labelledby="settings-heading">
      <Heading as="h1" size="7" id="settings-heading">
        Settings
      </Heading>
      <Text as="p" color="gray">
        Changes are saved automatically in this browser. No account is needed.
      </Text>
      <Card className="settings-card">
        <Heading as="h2" size="4">
          Themes
        </Heading>
        <Text as="p" size="2" color="gray">
          Choose the appearance of Morsel. System follows your device's light or dark mode.
        </Text>
        <ThemeControl />
      </Card>
      <Card className="settings-card">
        <Heading as="h2" size="4">
          Mermaid styles
        </Heading>
        <Text as="p" size="2" color="gray" id="mermaid-style-description">
          Apply one style to all Mermaid diagrams. Source style uses each diagram's own
          configuration without changing Markdown.
        </Text>
        <div className="settings-control">
          <span>Mermaid style</span>
          <Select.Root
            value={look ?? "source"}
            onValueChange={(value) =>
              updateLook(value === "classic" || value === "handDrawn" ? value : undefined)
            }
          >
            <Select.Trigger
              aria-label="Mermaid style"
              aria-describedby="mermaid-style-description"
            />
            <Select.Content>
              <Select.Item value="source">Source style</Select.Item>
              <Select.Item value="classic">Classic</Select.Item>
              <Select.Item value="handDrawn">Hand-drawn</Select.Item>
            </Select.Content>
          </Select.Root>
        </div>
      </Card>
      <Text as="p" size="2" color="gray">
        Preferences apply to this browser and site only. They do not sync across devices.
      </Text>
    </section>
  )
}
