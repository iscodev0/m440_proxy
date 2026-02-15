FROM oven/bun:1
WORKDIR /app

RUN apt-get update && apt-get install -y ca-certificates && rm -rf /var/lib/apt/lists/*

COPY package.json bun.lock* ./
RUN bun install --production

COPY src ./src

EXPOSE 3000
CMD ["bun", "src/index.ts"]
