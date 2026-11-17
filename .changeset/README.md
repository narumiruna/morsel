# Changesets

Changesets can target two releases:

1. `@narumitw/morsel`: the repository version, container, GitHub release, and
   deployment. Server, app, and client changes use this target.
2. `@narumitw/diagram-viewer`: the public npm package version and its changelog.

Do not target the client or private viewer workspace directly. Their versions do
not change. Package versioning updates the viewer's diagram-viewer dependency.

From the repository root:

```sh
npm run changeset -- add patch "Fix share rendering."
npm run changeset -- add patch "Fix diagram controls." --package @narumitw/diagram-viewer
npm run changeset -- status
```

Use `minor` for a feature or `major` for a breaking change. The default target is
`@narumitw/morsel`. Commit the generated `.changeset/*.md` file with the code.
A changeset can name both allowed targets when one change affects both releases.

The **Publish** workflow prepares one version PR for all pending allowed targets.
It updates the selected versions and changelogs, workspace dependency metadata,
and lockfile through `changesets/action@v2` and the repository version command.
Empty release lists do not create a version PR. Review and merge the version PR
before publication.

The **Publish** workflow keeps two publication paths in independent jobs:

1. The Morsel jobs create its `vX.Y.Z` tag, container, GitHub release, and deploy
   that tag. A package-only change does not create a Morsel version or tag.
2. The **Publish diagram-viewer** job publishes only `@narumitw/diagram-viewer` to
   npm. It skips pending package changesets and already published versions. It
   uses GitHub OIDC and needs an owner-configured npm trusted publisher for
   `release.yml`.

Use the repository commands, not the stock `npx changeset` CLI. The stock CLI can
version other workspaces. `npm run release:version` changes local version files
only. `npm run release` and `npm run release:diagram-viewer` are publication
commands, not preview commands. Do not use them for validation.

See [release preparation](../docs/development.md#releases) and
[public npm releases](../docs/development.md#public-npm-releases). Verify the
[maintenance requirements](../docs/deployment.md#multi-account-maintenance-upgrade)
before service deployment.
