# One container for the public demo (built for a Hugging Face Docker Space, works anywhere Docker runs):
#   web (Next.js)  : port 7860, the only thing the internet can reach
#   dashboard API  : 127.0.0.1:3000 inside the container, read-only (PUBLIC_DEMO=1)
#   keeper + agent : keep the oracle fresh and the demo agent spending
FROM node:22-slim

RUN npm install -g pnpm@12.3.4

WORKDIR /app

# dependencies first, so Docker can cache them
COPY package.json package-lock.json ./
RUN npm ci
COPY web/package.json web/pnpm-lock.yaml web/pnpm-workspace.yaml ./web/
RUN cd web && pnpm install --frozen-lockfile

# the rest of the code, then build the web app
COPY . .
RUN sed -i "s/\r$//" start.sh && cd web && pnpm build

# run as a normal user (Hugging Face runs containers as uid 1000); the app writes small files into /app
RUN chown -R node:node /app
USER node

ENV NODE_ENV=production
EXPOSE 7860
CMD ["bash", "start.sh"]
