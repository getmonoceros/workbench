# Skills

Source of truth for the Claude skills Monoceros ships. Each skill is a folder
with a `SKILL.md` (the only required file), authored here and version-controlled
in this repo - **not** in `docs/private/` (that was scratch).

## monoceros-guide

The onboarding skill a user installs in Claude (claude.ai): it turns an app idea
into the `monoceros init`/`apply`/`run` commands plus a build prompt. It reads
the live component catalog from `getmonoceros.build/catalog.json` at runtime, so
the catalog is not baked in here.

## Publishing (manual, on change)

The skill is distributed as a downloadable zip on the website. There is no
build automation yet - rebuild and copy by hand when `SKILL.md` changes:

```sh
pnpm skill:zip
cp skills/monoceros-guide.zip ../monoceros-web/public/monoceros-guide.zip
# then commit + deploy monoceros-web
```

`pnpm skill:zip` writes `skills/monoceros-guide.zip` (gitignored - it is a build
artifact, the source is what's committed). The zip contains `monoceros-guide/`
with `SKILL.md` inside, which is the shape claude.ai expects on upload.
