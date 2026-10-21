# ---------- Build stage: Piped frontend ----------
FROM node:22-alpine AS build
RUN apk add --no-cache git && corepack enable
WORKDIR /app
RUN git clone --depth 1 https://github.com/TeamPiped/Piped.git .
RUN pnpm install --frozen-lockfile || pnpm install
RUN pnpm build

# Backend (API) instance jo use karna hai - yahan change karo
ARG API_URL=https://pipedapi.kavin.rocks
RUN grep -rl "pipedapi.kavin.rocks" dist | xargs -r sed -i "s|https://pipedapi.kavin.rocks|${API_URL}|g"

# ---------- Serve stage ----------
FROM nginx:alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 8080
CMD ["nginx", "-g", "daemon off;"]
