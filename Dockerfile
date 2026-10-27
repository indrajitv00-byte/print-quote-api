FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

# OrcaSlicer (headless, via a virtual display) needs these system libraries
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl xvfb xauth \
      libgtk-3-0t64 libwebkit2gtk-4.1-0 libgl1 libglu1-mesa libegl1 libosmesa6 \
      libxkbcommon0 libdbus-1-3 libsecret-1-0 libnss3 \
    && rm -rf /var/lib/apt/lists/*

# Node.js 20, copied from the official image
COPY --from=node:20-bookworm-slim /usr/local/bin/node /usr/local/bin/node
COPY --from=node:20-bookworm-slim /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm

# OrcaSlicer for Linux (AppImage, unpacked so it does not need FUSE)
ARG ORCA_URL=https://github.com/OrcaSlicer/OrcaSlicer/releases/download/v2.4.2/OrcaSlicer_Linux_AppImage_Ubuntu2404_V2.4.2.AppImage
RUN curl -fL "$ORCA_URL" -o /tmp/orca.AppImage \
    && chmod +x /tmp/orca.AppImage \
    && cd /tmp && ./orca.AppImage --appimage-extract >/dev/null \
    && mv /tmp/squashfs-root /opt/orca \
    && rm /tmp/orca.AppImage

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY src ./src
COPY templates ./templates

ENV PORT=3000 \
    ORCA_PATH=/opt/orca/AppRun \
    USE_XVFB=1 \
    DATA_DIR=/app/data
RUN mkdir -p /app/data
VOLUME ["/app/data"]
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://localhost:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "src/server.js"]
