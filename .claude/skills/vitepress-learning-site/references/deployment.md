# Phase 9: Deployment (Optional)

Only run this phase if Phase 1 decided the site will be deployed. Otherwise skip.

## Deployment-target-agnostic essentials

The site is a static build; the output directory is `docs/.vitepress/dist`. Every host just needs to know:

1. The **install command** — restore dependencies from the lockfile
2. The **build command** — produce `docs/.vitepress/dist` on disk
3. The **output directory** — `docs/.vitepress/dist`

## Vercel

See `assets/vercel.json.template` for a starting configuration.

Key points:

- Vercel auto-detects `scripts.build` in package.json. If the project's build script is named something else (`docs:build`) or uses a *globally-installed CLI wrapper*, Vercel won't find or run it correctly. Set `buildCommand` explicitly in `vercel.json`.
- `framework: null` disables Vercel's framework preset — VitePress isn't on their preset list, and null explicit is safer than wrong.
- `outputDirectory: "docs/.vitepress/dist"`.
- `installCommand`: pick the project's package manager. If `"packageManager": "pnpm@..."` is in package.json, Vercel enables corepack automatically and `pnpm install --frozen-lockfile` works; similarly for yarn/bun.

### The globally-installed-CLI gotcha

Some toolchains use a global CLI as their task runner (VitePlus's `vp`, some internal wrappers). The global CLI is **not** installed on Vercel build runners. A `package.json` script like:

```json
"docs:build": "vp exec vitepress build docs"
```

...will fail on Vercel because `vp` is not on PATH. Fix in `vercel.json`:

```json
"buildCommand": "pnpm exec vitepress build docs"
```

Going through the project's actual package-manager's `exec` facility (rather than the global wrapper) bypasses the missing CLI. `pnpm exec`, `npm exec`, `yarn dlx`, `bun x` all work; pick whichever matches the project's package manager.

This is the single VitePlus-specific interaction with VitePress deployment worth flagging — outside of it, the toolchain layers are independent.

## GitHub Pages

Use the VitePress-recommended action approach (`.github/workflows/deploy.yml`) with the project's package manager. The workflow:

1. Checks out the repo
2. Sets up Node (and enables corepack if pnpm/yarn is in packageManager)
3. Installs dependencies
4. Runs the build
5. Uploads `docs/.vitepress/dist` as a Pages artifact
6. Deploys

If the project uses a global CLI wrapper, the workflow's build step should invoke the underlying tool (e.g., `pnpm exec vitepress build docs`) rather than the wrapper, same principle as Vercel.

## Netlify

`netlify.toml`:

```toml
[build]
  command = "pnpm exec vitepress build docs"
  publish = "docs/.vitepress/dist"

[build.environment]
  NODE_VERSION = "22"
```

Substitute the correct package manager in the command.

## Cloudflare Pages

Similar to Vercel; set the build command to `pnpm exec vitepress build docs` and output directory to `docs/.vitepress/dist`. Use Cloudflare's environment variable system for any secrets.

## Self-hosted (nginx / static server)

After a build:

```
docs/.vitepress/dist/
```

...contains the full static site. Serve it with any HTTP server that supports:

- `try_files` to handle `cleanUrls` (requests to `/foo` should serve `/foo.html` if present)
- Gzip/brotli for text files

Sample nginx config fragment:

```nginx
location / {
  try_files $uri $uri.html $uri/ =404;
}
```

## Preview deployments

VitePress has a built-in preview mode that serves the production build locally:

```
<your package manager's exec> vitepress preview docs
```

Useful for validating the final bundle before shipping.

## Verification after first deployment

- Load the deployed URL in a browser
- Check console — same probes as Phase 7 browser verification. Production should be cleaner than dev (no Mermaid/dayjs dev quirks), but CSP or CDN issues can surface here for the first time.
- Check at least one chapter page with math and one with diagrams; these are the historical failure points.
- Share the deployed URL with the user for their own click-through.
