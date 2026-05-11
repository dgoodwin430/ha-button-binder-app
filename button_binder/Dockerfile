FROM ghcr.io/home-assistant/base:latest

ARG BUILD_VERSION
ARG BUILD_ARCH

LABEL \
  io.hass.version="${BUILD_VERSION}" \
  io.hass.type="app" \
  io.hass.arch="${BUILD_ARCH}"

WORKDIR /app

RUN apk add --no-cache nodejs npm

COPY package*.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY public ./public

EXPOSE 8099

CMD ["node", "src/server.js"]
