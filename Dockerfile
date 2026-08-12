# Librada · Facturador — microservicio Playwright para auto-facturación por portal.
# Imagen oficial de Playwright (Chromium + deps ya incluidos) → deploy directo en Easypanel/Hostinger.
FROM mcr.microsoft.com/playwright:v1.47.0-jammy

WORKDIR /app

# Deps primero (mejor cache)
COPY package*.json ./
RUN npm install --omit=dev

# Código
COPY . .

ENV PORT=8080
EXPOSE 8080

# Sólo genera CFDIs; nunca mueve dinero. Datos fiscales llegan por request (no se guardan).
CMD ["node", "server.js"]
