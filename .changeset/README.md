# Repository Changesets

All changesets target `@narumitw/morsel`, which represents the whole repository. Do not target the client or viewer packages.

From the repository root:

```sh
npm run changeset -- add patch "Fix share rendering."
npm run changeset -- status
```

Use `minor` for a feature or `major` for a breaking change. Commit the generated Markdown file with the change.

After changesets reach `main`, the **Publish** workflow checks the root release plan. If the release list is empty, it skips version PR creation without changing files. Otherwise, it prepares the root version and changelog. It then uses `peter-evans/create-pull-request@v8` to create or update a version pull request with the new release notes. Review and merge that pull request to publish the repository tag, container, and GitHub release, then deploy that tag automatically. Verify the [maintenance requirements](../docs/deployment.md#multi-account-maintenance-upgrade) before merging the version pull request.

Use the repository commands, not the stock `npx changeset` CLI. The stock CLI discovers individual npm workspaces. The PR action only commits the prepared repository version files. `npm run release:version` only changes local version files; `npm run release` is a CI command that can push a repository tag. No command publishes npm packages or creates workspace package tags.

See [release preparation](../docs/development.md#releases) for the complete process.
