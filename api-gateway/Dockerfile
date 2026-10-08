FROM node:24.21.0-alpine3.24

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY src ./src

EXPOSE 3000

CMD ["npm", "start"]
