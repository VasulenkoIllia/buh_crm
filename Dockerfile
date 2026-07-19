FROM node:20-alpine

WORKDIR /app

# deps — npm ci for reproducible installs from the lockfile.
# NOTE: do NOT add --omit=dev: the build stage needs vite/tsc from devDependencies
# (runtime deps tsx/prisma/dotenv live in "dependencies").
COPY package*.json ./
RUN npm ci

# source
COPY . .

# generate the prisma client, then build the frontend (vite → ./dist) + typecheck
RUN npx prisma generate && npm run build

# apply pending migrations on start, then run the API (which also serves ./dist in prod)
CMD ["sh", "-c", "npx prisma migrate deploy && npm run start"]
