# Stage 1: build the Vite panel (devDependencies live only here).
FROM node:22-alpine AS builder
WORKDIR /app
RUN apk upgrade --no-cache
COPY package*.json ./
# The optional auth-client is skipped here (no token needed to build the panel).
RUN npm install --no-audit --no-fund
COPY client/ ./client/
RUN npm run build

# Stage 2: runtime. No npm in the final image (estate rule: nothing runs npm, and
# its bundled tree only adds scanner findings).
FROM node:22-alpine
WORKDIR /app
RUN apk upgrade --no-cache

# NPM_TOKEN is a GitHub Packages token for @octopus-security/auth-client. The .npmrc
# is written and removed inside ONE layer so no registry credential is baked into
# the image. Without the token the optional dependency is skipped and the app
# REFUSES to boot in sso mode (server/auth.js) rather than run without auth.
ARG NPM_TOKEN
COPY package*.json ./
RUN if [ -n "$NPM_TOKEN" ]; then \
      printf '@octopus-security:registry=https://npm.pkg.github.com/\n//npm.pkg.github.com/:_authToken=%s\n' "$NPM_TOKEN" > .npmrc; \
    fi && \
    npm install --omit=dev --no-audit --no-fund && \
    rm -f .npmrc && \
    rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx

COPY server/ ./server/
COPY --from=builder /app/client/dist ./client/dist
RUN mkdir -p /app/data && chown -R node:node /app/data
USER node

ENV NODE_ENV=production PORT=3050 DATA_DIR=/app/data
EXPOSE 3050
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:3050/healthz || exit 1
CMD ["node", "server/index.js"]
