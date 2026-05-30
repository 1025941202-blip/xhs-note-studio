FROM node:20-alpine

WORKDIR /app

COPY package.json ./
COPY index.html styles.css app.js server.mjs ./

ENV APP_MODE=web
ENV HOST=0.0.0.0
ENV PORT=4173

EXPOSE 4173

CMD ["node", "server.mjs"]
