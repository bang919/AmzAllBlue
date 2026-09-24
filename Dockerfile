FROM node:22-bookworm-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY --chown=node:node . .
USER node

ENV NODE_ENV=production
ENV PORT=8080

EXPOSE 8080
CMD ["npm", "start"]
