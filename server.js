// Librada · Facturador — microservicio de auto-facturación por portal.
// n8n le manda el ticket + datos del receptor; él corre el adapter de la plataforma y
// devuelve el CFDI (uuid, pdf, xml). Reutilizable para TODOS los clientes (sólo cambia el receptor).
const express = require('express');
const { chromium } = require('playwright');
const { pickAdapter } = require('./adapters');

const app = express();
app.use(express.json({ limit: '4mb' }));

// POST /facturar
// body: { url, ticket:{ticket_id|folio, sucursal?, terminal?, transaccion?, monto, fecha, rfc_emisor},
//         receptor:{rfc, nombre, cp, regimen, uso_cfdi} }
app.post('/facturar', async (req, res) => {
  const { url, ticket, receptor } = req.body || {};
  if (!url || !ticket || !receptor)
    return res.status(400).json({ ok: false, error: 'faltan url, ticket o receptor' });

  const adapter = pickAdapter(url);
  if (!adapter) {
    let host = ''; try { host = new URL(url).hostname; } catch {}
    return res.status(422).json({ ok: false, error: 'plataforma no soportada aún', dominio: host });
  }

  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(30000);
    const result = await adapter.facturar(page, { url, ticket, receptor }); // {uuid, pdf, xml}
    return res.json({ ok: true, plataforma: adapter.nombre, ...result });
  } catch (e) {
    // Si algo falla (captcha, selector, portal caído) → se marca para intervención manual.
    return res.json({ ok: false, plataforma: adapter.nombre, error: String(e.message || e), needs_manual: true });
  } finally {
    await browser.close();
  }
});

app.get('/health', (_req, res) => res.json({ ok: true, service: 'librada-facturador' }));
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log('Librada facturador escuchando en :' + PORT));
