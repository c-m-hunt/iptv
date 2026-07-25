# IPTV Player Grid — API + static frontend in one small image.
FROM node:20-alpine

# `sqlite` provides the sqlite3 CLI used to read a mounted IPTV-app
# localStorage file (when credentials aren't supplied via env vars).
# `ffmpeg` remuxes the MKV/AVI films browsers can't open. Without it the app
# still runs, but roughly half the film catalogue becomes browse-only.
RUN apk add --no-cache sqlite ffmpeg

WORKDIR /app

# Install server deps first for better layer caching.
COPY server/package*.json ./server/
RUN cd server && npm install --omit=dev && npm cache clean --force

# App code
COPY server ./server
COPY public ./public

# Catalogue cache lives on a volume so it survives container restarts.
ENV CACHE_DIR=/cache \
    PORT=8080 \
    HOST=0.0.0.0
RUN mkdir -p /cache
VOLUME ["/cache"]

EXPOSE 8080
WORKDIR /app/server
CMD ["node", "index.js"]
