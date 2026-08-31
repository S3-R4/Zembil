# syntax=docker/dockerfile:1.7
#
# Zembil container image. Multi-stage: the `build` stage compiles the
# SvelteKit app; only the final `runtime` stage ships. See
# docs/DECISIONS.md D-012 and docs/CONTRACT.md §3.8 for the deployment
# contract this Dockerfile is built against.
#
# Base image — verified against the registry, not assumed (PLAN.md §7 probe 3,
# checked 2026-08-31): `docker manifest inspect node:26-alpine` lists
# linux/amd64 and linux/arm64/v8, which covers a typical x86 home server as
# well as an arm64 board (Raspberry Pi 4/5 and similar), and the tag currently
# runs Node v26.8.1.
# Alpine's musl libc has no bearing here: node:sqlite (see below) ships
# precompiled inside the Node binary itself, not as a dynamically linked npm
# native addon, so there is nothing in this image that could fail to link
# against musl the way a native addon sometimes does.
#
# node_modules — MEASURED, and the measurement contradicted the assumption.
# @sveltejs/adapter-node does NOT bundle every dependency into build/: this
# project's build output still carries a bare `import ... from
# "@simplewebauthn/server"` in build/server/chunks/. A runtime stage shipping
# no node_modules therefore died on its first line with
# ERR_MODULE_NOT_FOUND — before any of this app's own code ran, so no
# healthcheck and no log line would have explained it. Hence the `deps` stage
# below, which installs production dependencies only and nothing else. Do not
# delete it on the theory that the bundler has covered it; run
# `docker run --rm zembil:latest node build/index.js` and read what happens.

FROM node:26-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

# Production dependencies only, resolved from the same lockfile the build used.
# Separate from `build` so the dev toolchain — vite, svelte, typescript,
# vitest — never reaches the runtime image.
FROM node:26-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

FROM node:26-alpine AS runtime
ENV NODE_ENV=production \
    ZEMBIL_DATA_DIR=/data \
    PORT=3000 \
    HOST=0.0.0.0
WORKDIR /app

# node:26-alpine already ships an unprivileged `node` user (uid/gid 1000);
# reused rather than creating a new one. /data is created and chowned to it
# here, as root, before USER below switches away from root — so that when
# `docker compose up` mounts a brand-new named volume at this path for the
# first time, Docker seeds that volume from the image's existing /data
# directory, permissions included, rather than leaving it root-owned.
# Verified by running, not assumed: on a brand-new named volume the container
# comes up healthy and `ls -l /data` inside it reports zembil.db, -wal and -shm
# all owned by node:node, with no entrypoint-side chown anywhere.
RUN mkdir -p /data && chown -R node:node /data

COPY --from=deps  --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/build ./build
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --chown=node:node scripts/entrypoint.sh ./entrypoint.sh
RUN chmod +x ./entrypoint.sh

# The lockout-recovery tool (CONTRACT.md §3.8), not part of startup. It ships
# in the image because the shape README.md documents for running it is
# `docker compose run --rm --entrypoint node zembil scripts/bootstrap-admin.js`,
# and that needs the file to exist here. Plain JavaScript by design: no build
# step, no TypeScript loader, nothing this runtime stage lacks.
COPY --chown=node:node scripts/bootstrap-admin.js ./scripts/bootstrap-admin.js

USER node
EXPOSE 3000
VOLUME ["/data"]

# No curl, no wget: Node has shipped a global `fetch` since v18, so this
# healthcheck needs nothing this image doesn't already have. GET /api/health
# is the one unauthenticated endpoint in the app (CONTRACT.md §3.8): 200
# while a trivial query answers, 503 the moment the database doesn't, which
# is what makes this healthcheck worth having rather than decorative.
# docker-compose.yml defines the same check for `docker compose up`; this one
# covers `docker run` used directly, without compose.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["./entrypoint.sh"]
