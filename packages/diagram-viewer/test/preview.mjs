import { stripVTControlCharacters } from "node:util"

/** Wait for a complete preview URL even with forced color or split output. */
export function previewURL(output) {
  return stripVTControlCharacters(output).match(/http:\/\/127\.0\.0\.1:\d+\//)?.[0]
}
