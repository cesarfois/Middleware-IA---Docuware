# ============================================================================
# STAGE 1: Build (Compilação TypeScript)
# ============================================================================
FROM node:22-alpine AS builder

WORKDIR /app

# Copia manifestos de pacotes para aproveitar cache de layers do Docker
COPY package*.json ./

# Instala todas as dependências (incluindo devDependencies para o build)
RUN npm install

# Copia código-fonte e configuração TypeScript
COPY tsconfig.json ./
COPY src ./src

# Compila TypeScript para JavaScript em ./dist e executa suíte de testes automatizados
RUN npm run build && npm test

# Remove devDependencies mantendo apenas pacotes de produção
RUN npm prune --omit=dev

# ============================================================================
# STAGE 2: Runtime de Produção (Imagem enxuta e segura sob usuário não-root)
# ============================================================================
FROM node:22-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000
ENV HOST=0.0.0.0

# Ajusta permissões e executa sob o usuário não-root 'node' nativo do Alpine
COPY --from=builder --chown=node:node /app/package*.json ./
COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/dist ./dist

USER node

EXPOSE 3000

# Healthcheck nativo verificando o endpoint GET /health
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "dist/server.js"]

