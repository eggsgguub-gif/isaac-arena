# ── сборка ───────────────────────────────────────────────────────────────────
FROM node:20-alpine AS build
WORKDIR /app
COPY . .
# postinstall = tools/build.mjs: атлас + esbuild-бандл в public/
# --omit=optional: uWebSockets.js не собран под musl, сервер использует
# встроенный RFC6455-транспорт (см. server/index.js)
RUN npm install --omit=optional --no-audit --no-fund

# ── рантайм ──────────────────────────────────────────────────────────────────
# Голый alpine + nodejs из репозитория: образ ~55 МБ против ~135 МБ у node:20-alpine.
# Рантайму не нужен ни один npm-пакет: сервер на чистых node-модулях.
FROM alpine:3.20 AS run
RUN apk add --no-cache nodejs \
 && addgroup -S app && adduser -S app -G app
WORKDIR /app
COPY --from=build --chown=app:app /app/public ./public
COPY --from=build --chown=app:app /app/server ./server
COPY --from=build --chown=app:app /app/shared ./shared
COPY --from=build --chown=app:app /app/package.json ./package.json
USER app
ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD wget -qO- "http://127.0.0.1:${PORT}/health" >/dev/null || exit 1
CMD ["node", "server/index.js"]
