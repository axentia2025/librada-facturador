// Librada · Facturador — microservicio de auto-facturación por portal.
// n8n le manda el ticket + datos del receptor; él corre el adapter de la plataforma y
// devuelve el CFDI (uuid, pdf, xml). Reutilizable para TODOS los clientes (sólo cambia el receptor).
const express = require('express');
const { chromium } = require('playwright');
const { pickAdapter, pickByHost } = require('./adapters');

const app = express();
app.use(express.json({ limit: '4mb' }));

// POST /facturar
// body: { url, ticket:{ticket_id|folio, sucursal?, terminal?, transaccion?, monto, fecha, rfc_emisor},
//         receptor:{rfc, nombre, cp, regimen, uso_cfdi} }
app.post('/facturar', async (req, res) => {
  const { url, ticket, receptor } = req.body || {};
  if (!url || !ticket || !receptor)
    return res.status(400).json({ ok: false, error: 'faltan url, ticket o receptor' });

  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(30000);
    // Navegamos primero: muchos comercios tienen una URL vanidosa que REDIRIGE a una plataforma
    // compartida (ej. giornale.mx → cfdi40.mifacturacion.mx). Elegimos el adapter por el host FINAL.
    await page.goto(url, { waitUntil: 'domcontentloaded' }).catch(() => {});
    let finalHost = ''; try { finalHost = new URL(page.url()).hostname.toLowerCase(); } catch {}
    const adapter = pickByHost(finalHost) || pickAdapter(url);
    if (!adapter) {
      return res.status(422).json({ ok: false, error: 'plataforma no soportada aún', dominio: finalHost });
    }
    const result = await adapter.facturar(page, { url, ticket, receptor }); // {uuid, pdf, xml} o {needs_manual}
    const ok = !(result && result.needs_manual);
    return res.json({ ok, plataforma: adapter.nombre, ...result });
  } catch (e) {
    // Si algo falla (captcha, selector, portal caído) → se marca para intervención manual.
    return res.json({ ok: false, error: String(e.message || e), needs_manual: true });
  } finally {
    await browser.close();
  }
});

app.get('/health', (_req, res) => res.json({ ok: true, service: 'librada-facturador' }));
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log('Librada facturador escuchando en :' + PORT));
