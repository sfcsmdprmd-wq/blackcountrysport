FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg curl ca-certificates tini && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json encoder.mjs ./
USER node
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "encoder.mjs"]
