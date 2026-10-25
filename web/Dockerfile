FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:22-bookworm-slim
ARG SOURCE_REVISION
LABEL org.opencontainers.image.revision=$SOURCE_REVISION
ENV NODE_ENV=production
ENV MCW_SOURCE_COMMIT=$SOURCE_REVISION
WORKDIR /app
RUN groupadd -g 10001 mcw && useradd -u 10001 -g 10001 -M -s /usr/sbin/nologin mcw
RUN mkdir -p /data && chown mcw:mcw /data
COPY --from=build /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY public ./public
USER 10001:10001
EXPOSE 8080
CMD ["node", "src/server.js"]
