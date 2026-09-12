FROM docker.io/library/node:24-bookworm-slim AS builder

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --legacy-peer-deps

COPY prisma ./prisma
COPY prisma.config.ts ./
RUN npx prisma generate

COPY nest-cli.json tsconfig.json tsconfig.build.json ./
COPY src ./src

RUN npm run build


FROM docker.io/library/node:24-bookworm-slim AS runtime

ENV NODE_ENV=production
WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --legacy-peer-deps \
    && npm cache clean --force \
    && rm -rf /usr/local/lib/node_modules/npm \
              /usr/local/lib/node_modules/corepack \
              /usr/local/bin/npm \
              /usr/local/bin/npx \
              /usr/local/bin/corepack \
              /usr/local/bin/yarn \
              /usr/local/bin/yarnpkg \
              /opt/yarn-v1.22.22

COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder /app/dist ./dist

RUN mkdir -p /app/storage/media

EXPOSE 3000

CMD ["node", "dist/main"]
