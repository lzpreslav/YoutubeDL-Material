## Fectch binary dependencies
FROM --platform=$BUILDPLATFORM ubuntu:24.04 AS utils
ARG DEBIAN_FRONTEND=noninteractive
# Use script due to local build compatibility
RUN --mount=type=bind,source=docker-utils,target=/scripts \
    sh /scripts/fetch-twitchdownloader.sh && \
    sh /scripts/deno-fetch.sh


FROM --platform=$BUILDPLATFORM ubuntu:24.04 AS base
ARG DEBIAN_FRONTEND=noninteractive
ENV UID=2000
ENV GID=2000
ENV USER=youtube
ENV NO_UPDATE_NOTIFIER=true
ENV ALLOW_CONFIG_MUTATIONS=true
ENV npm_config_cache=/root/.npm

# Install package dependencies
RUN groupadd -g $GID $USER && \
    useradd --system -m -g $USER --uid $UID $USER && \
    apt update && \
    apt install -y --no-install-recommends \
                atomicparsley \
                ca-certificates \
                curl \
                ffmpeg \
                gosu \
                libatomic1 \
                libicu74 \
                python-is-python3 \
                python3-minimal \
                python3-pip \
                tzdata && \
    pip install --break-system-packages \
                pycryptodomex \
                yt-dlp-ejs && \
    apt clean && \
    rm -rf /var/lib/apt/lists/*

# Install NodeJS
ENV NODE_VERSION=24.13.0 \
    NVM_VERSION=0.40.3 \
    NVM_DIR=/usr/local/nvm
ENV PATH="/usr/local/nvm/versions/node/v${NODE_VERSION}/bin/:${PATH}"

RUN mkdir -p "$NVM_DIR" && \
    curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v${NVM_VERSION}/install.sh | bash && \
    . "$NVM_DIR/nvm.sh" && \
    nvm install ${NODE_VERSION} && \
    nvm use v${NODE_VERSION} && \
    nvm alias default v${NODE_VERSION}


FROM base AS frontend
WORKDIR /build
COPY package.json package-lock.json angular.json tsconfig.json ./
COPY src/ ./src/
RUN --mount=type=cache,target=/root/.npm \
    npm install && \
    npm run build && \
    rm -rf node_modules


FROM base AS backend
WORKDIR /app
COPY backend/ ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci --only=production


# Final image
FROM base
WORKDIR /app

COPY --from=utils \
     /usr/local/bin/TwitchDownloaderCLI \
     /usr/local/bin/deno \
     /usr/local/bin/
COPY --from=backend /app/ /app/
COPY --from=frontend /build/backend/public/ /app/public/

EXPOSE 17442
ENTRYPOINT [ "/app/entrypoint.sh" ]
CMD [ "node", "app.js" ]
