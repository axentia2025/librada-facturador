# Librada · Facturador (microservicio)

Auto-facturación por portal. **Un adapter por PLATAFORMA** → cada uno cubre muchos comercios.
Reutilizable para todos los clientes (sólo cambia el receptor). Se despliega en Easypanel/Hostinger; n8n lo llama.

## Correr local
```bash
cd execution/facturador
npm install            # instala express + playwright (y chromium)
npm start              # levanta en :8080
```

## Probar
```bash
curl -X POST localhost:8080/facturar -H 'Content-Type: application/json' -d '{
  "url":"https://kleins-reforma-ambitpro.facturacion.f-ambit.mx/",
  "ticket":{"ticket_id":"40154","monto":"429.00","fecha":"2026-08-04","rfc_emisor":"KRE240619U9"},
  "receptor":{"rfc":"AACO710113KG7","nombre":"OMAR ANTONIO ARVAYO CASTRO","cp":"11550","regimen":"612","uso_cfdi":"G03"}
}'
```
Respuesta: `{ ok:true, plataforma:"f-ambit", uuid, pdf(base64), xml }` · o `{ ok:false, needs_manual:true, error }`.

## Agregar un portal nuevo
1. Crea `adapters/<plataforma>.js` con `{ nombre, matches(host), facturar(page,{url,ticket,receptor}) }`.
   Si el ticket NO trae URL (portal fijo, tipo Chedraui), agrega también `matchesComercio({comercio,rfc_emisor})`.
2. Regístralo en `adapters/index.js`.
No se toca nada más. Estado: **f-ambit** (selectores por afinar) · **chedraui** (paso 1 confirmado; paso 2 post-captcha por mapear) → lacomer.

## Captcha (algunos portales, ej. Chedraui)
El pipeline NO incluye un resolvedor de captcha. El adapter recibe el código ya resuelto por su
parámetro `captcha`; sin él, regresa `{ needs_manual:true, motivo:'captcha_requerido', captcha_img }`.
De dónde sale ese código es decisión de quien opere Librada:
- **Relevo humano** (WhatsApp): se manda `captcha_img` al cliente y responde 6 chars.
- **Servicio anti-captcha con licencia**: se implementa en `captcha-solver.js` (ver ese archivo; trae
  la interfaz `solveCaptcha(imageBase64)->string` y el ejemplo de orquestación). Esa integración la
  escribe el equipo de Axentia; el harness sólo la invoca.
Portales SIN captcha (f-ambit y varios) corren 100% automáticos sin nada de esto.

## Afinar los selectores de un adapter (una vez por plataforma)
Los `TODO` del adapter (campos del formulario) se confirman inspeccionando el portal real:
```bash
npx playwright codegen "https://<portal-del-ticket>"
```
Haces la facturación a mano una vez, Playwright graba los selectores, y los pegas en el adapter.

## Deploy (Easypanel / Hostinger)
- Servicio Node, `npm install && npm start`, expón `:8080` (interno).
- Variables: `PORT` (opcional). No guarda datos fiscales — los recibe en cada request.
- Sólo genera CFDIs; nunca mueve dinero.

## Integración con n8n (workflow `n8n-autofactura.json`)
Nodos:
1. **Webhook** — recibe del WhatsApp (Meta) la imagen del ticket + `cliente`.
2. **HTTP Request → Claude (visión)** — OCR del ticket → `{comercio, rfc_emisor, monto, fecha, ticket_id/folio, metodo, url_portal}`.
3. **Switch (`metodo`)**:
   - `portal` → **HTTP Request → facturador** `/facturar` (con el receptor de `datos_fiscales` del cliente).
   - `correo` → **Send Email** (plantilla con datos fiscales + adjunta el ticket).
   - `no_aplica` → guarda el recibo y avisa.
4. **Supabase** — sube PDF+XML a Storage (bóveda) + inserta en `librada_cfdi` (liga al movimiento por rfc+monto+fecha).
5. **WhatsApp** — responde: "✅ Factura de {comercio} ${monto} lista".

El receptor (RFC/nombre/CP/régimen/uso) se inyecta desde `clientes/<cliente>/datos_fiscales.json` (o una tabla `librada_datos_fiscales` en Supabase).
