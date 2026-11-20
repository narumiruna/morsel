# Changesets

Use `@narumitw/morsel` for server, app, and client changes. This target controls
the repository version, container, GitHub release, and deployment. Do not target
the client or private viewer workspace directly.

From the repository root:

```sh
npm run changeset -- add patch "Fix share rendering."
npm run changeset -- status
```

Use `minor` for a feature or `major` for a breaking change. Commit the generated
`.changeset/*.md` file with the code.

The **Publish** workflow prepares a version PR for pending changesets. It updates
the root version, changelog, and lockfile. Empty release lists do not create a
version PR. Review and merge the version PR before publication.

Use the repository commands, not the stock `npx changeset` CLI. The stock CLI can
version other workspaces. `npm run release:version` changes local version files
only. `npm run release` is a publication command; do not use it for validation.

See [release preparation](../docs/development.md#releases) and verify the
[maintenance requirements](../docs/deployment.md#multi-account-maintenance-upgrade)
before service deployment.
