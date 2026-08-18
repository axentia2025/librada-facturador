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
# Arranca bajo una PANTALLA VIRTUAL (xvfb, ya incluido en la imagen de Playwright) para que
# Chromium corra en modo con-pantalla (headless:false). Portales legacy lo necesitan para
# completar el paso final de generación (Chedraui, Masteredi, etc.).
CMD ["xvfb-run", "--auto-servernum", "--server-args=-screen 0 1366x768x24 -ac", "node", "server.js"]
