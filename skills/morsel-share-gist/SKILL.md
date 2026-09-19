---
name: morsel-share-gist
description: Publish Markdown as a GitHub Gist with the GitHub CLI and return a clickable Morsel viewer link; use when the user asks to share Markdown through a Gist, view Markdown in Morsel without its share API, or turn Markdown text or a file into a Morsel Gist URL.
---

# Share Markdown Through a Gist

## Safety

Treat an explicit request to publish or share through a Gist as authorization to create one Gist.
Do not create a Gist when the user only asks to draft or revise Markdown.
Publish only the requested Markdown, and never add unrelated files or local secrets.
If the Markdown appears to contain credentials or private keys, stop and ask before publishing it.
Create a secret Gist by default, and use `--public` only when the user explicitly requests a publicly listed Gist.
Tell the user that a secret Gist is unlisted rather than private and is readable by anyone who knows its ID.
Do not retry a failed or interrupted creation automatically because the first request may have succeeded.

## Prepare the Markdown

Preserve the requested content and language in UTF-8.
Publish exactly one Gist file named `morsel.md` so Morsel recognizes it as Markdown.
Use the requested local file only as the content source when it exists; otherwise, write the final Markdown to a temporary file and remove that file after the command finishes.
Do not publish a directory, glob, or additional file.

## Create the Gist

Require `gh` and an authenticated GitHub account by running these checks before creation:

```sh
command -v gh
gh auth status --hostname github.com
```

If either check fails, report the problem and stop without attempting installation or authentication.
Create the default secret Gist from the Markdown file through standard input so the Gist filename is always recognized as Markdown:

```sh
gist_url="$(GH_HOST=github.com gh gist create --filename morsel.md - < "$markdown_file")"
```

Add `--desc "$description"` only when the user requests a description.
Add `--public` only when the user explicitly requests public listing.
Do not use `--web` because it opens the GitHub Gist instead of the Morsel viewer.
Require a successful exit status and a `https://gist.github.com/.../<id>` URL from standard output.
Extract the final URL path segment as the Gist ID and require it to contain 1 through 64 hexadecimal characters.
If the command or validation fails, report that creation was not confirmed and do not retry automatically.

## Return the Morsel Link

Construct the viewer URL as `https://morsel.narumi.dev/gist/#<id>`.
Keep the Gist ID in the fragment after `/gist/#` so it is not sent to the Morsel server or intermediaries.
Return a clickable link in this form:

```markdown
[Open the Markdown in Morsel](https://morsel.narumi.dev/gist/#<id>)
```

Do not fetch the Gist or Morsel URL merely to verify it.
Do not open a browser unless the user explicitly asks and a browser-opening tool is available.
Stop after reporting the Morsel link and whether the Gist is secret or public.
