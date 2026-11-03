# icefox2000 Mindcraft/Voyager bot. node_modules is copied from the host checkout so the
# hand-patched packages (mineflayer entities.js velocity fix, skin-parse patch, etc.) are kept verbatim;
# only native addons are rebuilt for linux.
FROM node:20-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ pkg-config \
      libcairo2-dev libpango1.0-dev libjpeg-dev libgif-dev librsvg2-dev ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY . .
RUN npm rebuild canvas && (npm rebuild gl || echo "gl rebuild failed (vision is disabled; ignored)") \
    && mkdir -p logs bots && chown -R node:node /app
USER node
ENV MINDSERVER_BIND=0.0.0.0
CMD ["sh","-c","node main.js 2>&1 | tee -a /app/logs/mindcraft.log"]
