FROM node:20-alpine

WORKDIR /app

# deps (dev deps included: build needs vite/tsc, runtime uses tsx + prisma)
COPY package*.json ./
RUN npm install

# source
COPY . .

# generate the prisma client, then build the frontend (vite → ./dist) + typecheck
RUN npx prisma generate && npm run build

# apply pending migrations on start, then run the API (which also serves ./dist in prod)
CMD ["sh", "-c", "npx prisma migrate deploy && npm run start"]
