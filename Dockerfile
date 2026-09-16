FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY server.js ./
COPY public ./public

# Le dossier data/ contient le fichier db.json — a monter comme volume
# persistant sur Coolify pour ne pas perdre les donnees a chaque deploiement.
RUN mkdir -p /app/data

ENV PORT=3000
EXPOSE 3000

CMD ["node", "server.js"]
