import { FileTextIcon } from "@radix-ui/react-icons"
import { Select } from "@radix-ui/themes"
import type { GistDocument } from "../api"

export function GistFilePicker({
  documents,
  selectedIndex,
  onSelect,
}: {
  documents: GistDocument[]
  selectedIndex: number
  onSelect: (index: number) => void
}) {
  const filename = documents[selectedIndex]?.filename ?? documents[0]?.filename

  return (
    <fieldset className="gist-files" aria-label="Gist files">
      <FileTextIcon className="gist-files-icon" aria-hidden="true" />
      {documents.length > 1 ? (
        <Select.Root
          value={String(selectedIndex)}
          onValueChange={(value) => onSelect(Number(value))}
        >
          <Select.Trigger
            className="gist-file-trigger"
            aria-label="Markdown file"
            variant="ghost"
            color="gray"
            title={filename}
          >
            <span className="gist-file-name">{filename}</span>
          </Select.Trigger>
          <Select.Content
            className="gist-file-menu"
            position="popper"
            align="start"
            sideOffset={8}
            collisionPadding={16}
            variant="soft"
            color="gray"
          >
            <Select.Group>
              <Select.Label>Markdown files</Select.Label>
              {documents.map((document, index) => (
                <Select.Item key={document.filename} value={String(index)}>
                  <span className="gist-file-option">{document.filename}</span>
                </Select.Item>
              ))}
            </Select.Group>
          </Select.Content>
        </Select.Root>
      ) : (
        <span className="gist-file-name" title={filename}>
          {filename}
        </span>
      )}
      <span className="gist-file-count">
        {documents.length} {documents.length === 1 ? "file" : "files"}
      </span>
    </fieldset>
  )
}
