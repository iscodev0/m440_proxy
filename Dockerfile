FROM oven/bun:1 AS base
WORKDIR /app

COPY package.json bun.lock* ./
RUN bun install --production

COPY src ./src

EXPOSE 3000
CMD ["bun", "src/index.ts"]
