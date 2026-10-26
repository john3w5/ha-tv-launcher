FROM node:22.23.2-alpine
WORKDIR /opt/home-tv-launcher
COPY runtime/ ./
COPY startup.mjs ./startup.mjs
# Supervisor mounts private persistent /data; credentials are supplied at runtime.
ENV NODE_ENV=production
EXPOSE 4317/tcp
CMD ["node", "/opt/home-tv-launcher/startup.mjs"]
