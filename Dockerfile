# Build stage
FROM node:20-alpine AS build

WORKDIR /usr/src/app

COPY package*.json ./

RUN npm ci --only=production

# Production stage
FROM node:20-alpine

WORKDIR /usr/src/app

COPY --from=build /usr/src/app/node_modules ./node_modules
COPY . .

ENV NODE_ENV=production
ENV PORT=5000

EXPOSE 5000

USER node

CMD ["node", "src/app.js"]
