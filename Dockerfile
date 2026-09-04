FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY server ./server
COPY public ./public
RUN mkdir -p uploads
EXPOSE 3180
CMD ["npm","start"]
