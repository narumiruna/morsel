# Repository Changesets

All changesets target `@narumitw/morsel`, which represents the whole repository. Do not target the client or viewer packages.

From the repository root:

```sh
npm run changeset -- add patch "Fix share rendering."
npm run changeset -- status
```

Use `minor` for a feature or `major` for a breaking change. Commit the generated Markdown file with the change.

Before release, run `npm run release:version`, review and merge the generated root version, lockfile, changelog, and consumed changesets. Then manually run the **Release** workflow on `main`.

Use the repository commands, not `npx changeset` or `changesets/action`. The stock CLI discovers npm workspaces and does not implement this root-only release policy. No command publishes npm packages or creates package tags.

See [release preparation](../docs/development.md#releases) for the complete process.
