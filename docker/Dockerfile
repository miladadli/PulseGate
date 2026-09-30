# PulseGate monorepo — one image, many entrypoints (compose overrides command).
FROM node:20-bookworm-slim AS build

WORKDIR /app

COPY package.json package-lock.json tsconfig.base.json tsconfig.json ./
COPY apps ./apps
COPY libs ./libs
COPY scripts ./scripts

RUN npm ci
RUN npm run build

FROM node:20-bookworm-slim AS runtime

WORKDIR /app
ENV NODE_ENV=production

COPY --from=build /app /app

# Default: API. Compose sets command per service.
CMD ["node", "apps/api/dist/main.js"]
