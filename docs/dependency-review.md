# Dependency review

Reviewed for the Morsel v1 release candidate on 2026-09-16.

## Production licenses

The direct Go runtime modules use licenses compatible with this MIT-licensed project:

| Module | Version | License |
| --- | --- | --- |
| `github.com/go-chi/chi/v5` | 5.3.2 | MIT |
| `github.com/google/uuid` | 1.6.0 | BSD-3-Clause |
| `github.com/jackc/pgx/v5` | 5.11.0 | MIT |
| `github.com/oapi-codegen/runtime` | 1.7.0 | Apache-2.0 |

All direct viewer runtime packages are MIT except DOMPurify, which is dual-licensed under MPL-2.0 or Apache-2.0. The Apache-2.0 option is compatible with distribution here. Transitive viewer packages report only MIT, Apache-2.0, BSD, ISC, BlueOak-1.0.0, CC0-1.0, Unlicense, MPL-2.0, and compatible dual-license expressions. No copyleft-only or unknown production license was found.

## Vulnerability evidence

```sh
cd api
go run golang.org/x/vuln/cmd/govulncheck@v1.8.0 ./...
# No vulnerabilities found.

cd viewer
npm audit --omit=dev
# found 0 vulnerabilities

docker run --rm -v /var/run/docker.sock:/var/run/docker.sock \
  aquasec/trivy:0.69.3 image --skip-version-check --scanners vuln \
  --severity HIGH,CRITICAL --exit-code 1 morsel-api:test
# Debian packages, /usr/local/bin/migrate, and /usr/local/bin/server: 0 findings.
```

The first container scan found Go standard-library vulnerabilities in the original Go 1.25.5 builder. The builder was upgraded to Go 1.26.6 and the image was rebuilt before the clean result above. DOMPurify was upgraded to 3.4.15, Mermaid was pinned to 11.17.2, and the lockfile's `lodash-es` was updated to 4.18.1 to resolve all production npm advisories.
