# Tandem execution sandbox image.
# Build example:
#   docker build -f docker/executor.Dockerfile -t tandem-executor:local .
# Runtime is launched by the app with --network none, read-only root,
# pid/memory/CPU limits, and a disposable /workspace bind mount.
FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    bash \
    ca-certificates \
    build-essential \
    openjdk-17-jdk-headless \
    python3 \
  && rm -rf /var/lib/apt/lists/*

ENV PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
WORKDIR /workspace
USER nobody:nogroup
