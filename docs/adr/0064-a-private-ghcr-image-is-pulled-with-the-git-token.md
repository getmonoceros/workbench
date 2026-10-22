# ADR 0064: A private GHCR image is pulled with the git token

- Status: accepted
- Date: 2026-10-22
- Relates to: [ADR 0031](0031-pat-based-repo-auth.md) (the token
  cascade), [ADR 0052](0052-upgrade-carries-a-service-image-fix-to-an-existing-workbench.md) and
  [ADR 0054](0054-apply-delivers-current-tools-upgrade-moves-the-services.md) (when service images
  are pulled), [ADR 0063](0063-a-builder-can-keep-their-own-service-descriptors.md)
  (the builder's own services)

## Context

A team publishes its own service image to a private GitHub package, a
LibreOffice with the company fonts say, as `ghcr.io/<owner>/<repo>/<name>`.
`apply` already resolves a token for `github.com/<owner>`, clones the
owner's private repos with it and logs in `gh` with it. The service image was
still pulled by `docker compose`, which only has the Docker login of the
host. Without one, compose answered "unauthorized" and `apply` failed, while
its own log said it was using a token for that very owner.

## Decision

**A service image under `ghcr.io/<owner>/` is pulled by `apply` itself, with
the token the repo cascade gives `https://github.com/<owner>`**:
`GITHUB_API_TOKEN` → `GIT_TOKEN__GITHUB_<OWNER>` → `GIT_TOKEN__GITHUB`. The
builder keeps one token per owner, the one they already have.

**The pull goes through a throwaway Docker config** that holds only this
credential, with the current context's endpoint passed as `--host`. Nothing
is written to the builder's Docker login, the token never appears on a
command line, and the directory is removed after the pull. The pull itself
is the compose pull of that one service, so it reports progress like every
other image (#137); the config names the compose plugin's directory in
`cliPluginsExtraDirs`, because Docker looks for plugins under the config dir.

**It is pulled exactly when compose would pull it**: on the first apply, on
`upgrade`, and whenever the image is not cached. The compose pull of
`upgrade` then skips these services. A failed pull with a cached image warns
and starts from the cache; with nothing cached `apply` stops and names the
image, the token variable and the registry's answer.

**GHCR only.** An image on another registry, or under an owner without a
token, is left to Docker as before. Docker's own login still applies to it.

## Consequences

- The token needs `read:packages`. A classic token with `write:packages` has
  it implicitly.
- A deferred service ([ADR 0025](0025-deferred-service-start.md)) is pulled before the first wave like every
  other one, so the second wave finds its image locally.
- GitLab's registry is not covered: its pull needs `read_registry`, which a
  token made for cloning often lacks. It gets the same treatment when someone
  needs it.
