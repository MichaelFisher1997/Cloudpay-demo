FROM oven/bun:1.4.2@sha256:9114c058aeae42162ee16dd5084b95fe9473970bb6bcb5b232ab1630f0546895 AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun run build && bun run typecheck
RUN bun -e "const r=await fetch('https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem');if(!r.ok)throw Error('RDS CA download failed');await Bun.write('/tmp/rds-global-bundle.pem',await r.text())"

FROM oven/bun:1.4.2@sha256:9114c058aeae42162ee16dd5084b95fe9473970bb6bcb5b232ab1630f0546895
WORKDIR /app
ENV NODE_ENV=production NITRO_HOST=0.0.0.0 NITRO_PORT=3000
COPY --from=build /app/.output ./.output
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/src ./src
COPY --from=build /app/scripts ./scripts
COPY --from=build /app/package.json ./package.json
COPY --from=build /tmp/rds-global-bundle.pem /etc/ssl/certs/rds-global-bundle.pem
USER 10001:10001
EXPOSE 3000
CMD ["sh","-c","bun scripts/preflight.ts && exec bun .output/server/index.mjs"]
