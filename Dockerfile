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
# El server levanta por sí mismo una pantalla virtual (Xvfb, incluido en la imagen de Playwright)
# de forma best-effort; si no puede, cae a headless. Así el arranque NUNCA se cae.
CMD ["node", "server.js"]
