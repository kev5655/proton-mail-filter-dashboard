# syntax=docker/dockerfile:1
#
# The image the Raspberry Pi runs. See `homelab/` for how it is deployed.
#
# Split across two architectures on purpose. Everything expensive — installing a pnpm workspace,
# compiling TypeScript, bundling with esbuild, building the dashboard with vite — is plain
# JavaScript work that produces plain JavaScript, so it runs **natively on the build machine** and
# costs nothing in emulation. Only the last step runs as arm64, and only because one of the two
# external dependencies is a native module whose binary is per platform and per Node version.
#
# That last step is a download rather than a compile, which is what makes the whole thing quick:
# `better-sqlite3-multiple-ciphers` publishes a prebuilt `linux-arm64` binary for this Node ABI.
# Verified on the target machine — a fresh install there took fourteen seconds and no compiler ran.
# If that ever stops being true, this build gets slow rather than wrong, and the fix is a toolchain
# in the runtime stage.
#
# **Node 24 is pinned, and the major version is load-bearing.** The prebuilt `.node` is compiled
# against one ABI; a different major here fails at the first database open, not at build time.

ARG NODE_VERSION=24-bookworm-slim


# ---------------------------------------------------------------------------
# Stage 1 — the bundle. Native to the builder, never emulated.
# ---------------------------------------------------------------------------
FROM --platform=$BUILDPLATFORM node:${NODE_VERSION} AS build

WORKDIR /src

# The login browser is not wanted here. This stage produces JavaScript; the browser belongs to the
# stage that will actually run one, and downloading an x64 Chromium to throw it away is pure cost.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
ENV CI=1

RUN corepack enable

# Manifests first, so a change to source code does not invalidate the dependency layer.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages packages
COPY apps apps
COPY vendor vendor
COPY scripts scripts
# `tsconfig.base.json` is what the other two extend, including the vendored compiler's own. Leaving
# it out fails at `build:vendor`, several minutes into the build.
COPY tsconfig.base.json tsconfig.json tsconfig.browser.json vite.config.ts ./
COPY LICENSE NOTICE ./

RUN pnpm install --frozen-lockfile

# Vendored declarations, the dashboard, and the server bundle — but not the two external packages.
# Those are installed in the runtime stage, where the architecture is the one they will run on.
RUN node scripts/package-app.mjs --bundle-only


# ---------------------------------------------------------------------------
# Stage 2 — the runtime. This one is the target architecture.
# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION} AS runtime

WORKDIR /app

# Where Playwright keeps the browser it downloads. Outside the home directory, so the image works
# for whichever user ends up running it.
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/playwright

COPY --from=build /src/release/app/package.json ./package.json

# The two dependencies that cannot be bundled, and the browser.
#
# **Shipping a browser contradicts what the downloadable archives do, and the difference is the
# machine.** An archive deliberately ships none, because the login must happen in the user's own
# browser — their password manager's extension is there and their passkey lives in its store. A
# headless server has no such browser and nobody sitting at it, so here the choice is between a
# browser in the image and no way to sign in at all. Headless Chromium still runs Proton's
# anti-abuse script and produces a genuine `Payload`; what is lost is the passkey, which needs an
# authenticator, and that was already lost on a machine with no screen.
# `playwright install` is run from the copy that was just installed, not through `npx`, so the
# browser can never be a different version from the driver that will drive it.
RUN npm install --omit=dev --no-audit --no-fund --install-strategy=hoisted \
    && ./node_modules/.bin/playwright install --with-deps chromium \
    && npm cache clean --force \
    && rm -rf /var/lib/apt/lists/*

COPY --from=build /src/release/app/server.mjs ./server.mjs
COPY --from=build /src/release/app/web ./web

# GPL-3.0, and it contains Proton's own GPL-3.0 code. An image is a form the software is
# distributed in, so the licence travels in it.
COPY --from=build /src/LICENSE /src/NOTICE ./

# `data/` is a mount point. Declared so a container started without one still runs rather than
# failing on its first write — but an unnamed volume loses the mailbox when the container is
# replaced, which is why the compose file binds a real directory.
RUN mkdir -p /app/data && chown -R node:node /app/data /opt/playwright
VOLUME /app/data

ENV PMS_DATA_DIR=/app/data \
    PMS_WEB_ROOT=/app/web \
    PMS_SERVER_PORT=5174 \
    NODE_ENV=production

# The server binds loopback. Inside a container that is the container's own loopback, which is what
# the Tailscale sidecar shares — see `homelab/stacks/proton-mail-sorter/`. Nothing here is published
# to the host by the image itself.
EXPOSE 5174

USER node

# It answers this while still locked, which is the point: the container is healthy long before
# anybody has typed a password, and a health check that needed the mailbox would report a locked
# installation as broken.
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.PMS_SERVER_PORT||5174)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "/app/server.mjs", "--serve"]
