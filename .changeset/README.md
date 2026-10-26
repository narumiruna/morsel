# Repository Changesets

All changesets target `@narumitw/morsel`, which represents the whole repository. Do not target the client or viewer packages.

From the repository root:

```sh
npm run changeset -- add patch "Fix share rendering."
npm run changeset -- status
```

Use `minor` for a feature or `major` for a breaking change. Commit the generated Markdown file with the change.

After changesets reach `main`, the **Publish** workflow uses `changesets/action@v2` with the custom root-only version command to create or update a version pull request. Review and merge that pull request to publish the repository tag, container, and GitHub release automatically. Deployment remains manual.

Use the repository commands, not the stock `npx changeset` CLI. The stock CLI discovers individual npm workspaces. The workflow disables the action's built-in publisher and package tags. `npm run release:version` only changes local version files; `npm run release` is a CI command that can push a repository tag. No command publishes npm packages or creates workspace package tags.

See [release preparation](../docs/development.md#releases) for the complete process.
