// Adapter · MI FACTURACIÓN  (cfdi40.mifacturacion.mx) — plataforma compartida de MUCHOS comercios
// (los tickets traen la URL del comercio, ej. giornale.mx/facturacion, que REDIRIGE a cfdi40.mifacturacion.mx).
// Mapeado en vivo con Giornale (12 ago 2026). Formulario simple + autollenado del receptor por RFC.
//
// Flujo (la página ya viene cargada por server.js tras seguir el redirect):
//   Paso 1: [Su RFC] [Referencia] [Total] → botón "Buscar referencia"
//   (si no la encuentra → "No se encontró la referencia" → needs_manual)
//   Paso 2 (autollena Nombre/CP/Régimen por el RFC): fija Correo + Uso CFDI (G03) → "Generar comprobante"
//   Resultado: "Descargar factura" (Versión PDF / XML) y el CFDI se manda por correo al email dado.

const nombre = 'mifacturacion';

function matches(host) {
  return host.includes('mifacturacion');
}

async function facturar(page, { url, ticket, receptor }) {
  // por si server.js no navegó (defensivo)
  if (!/mifacturacion/i.test(page.url())) {
    await page.goto(url, { waitUntil: 'domcontentloaded' }).catch(() => {});
  }
  await dismissModals(page);

  // ── PASO 1 ── los 3 inputs de texto en orden: RFC, Referencia, Total
  const inp = page.locator('input[type="text"]');
  await inp.nth(0).fill(String(receptor.rfc || ''));
  await inp.nth(1).fill(String(ticket.referencia || ticket.ticket_id || ticket.folio || ''));
  await inp.nth(2).fill(String(ticket.monto ?? ''));
  await clickBtn(page, 'Buscar referencia');
  await page.waitForLoadState('networkidle').catch(() => {});
  await dismissModals(page);

  const html1 = await page.content();
  if (/No se encontró la referencia/i.test(html1)) {
    return { needs_manual: true, motivo: 'referencia_no_encontrada' };
  }

  // ── PASO 2 ── correo (input cuyo value trae "@") + Uso CFDI G03 (Nombre/CP/Régimen ya autollenan)
  if (receptor.email) {
    const texts = await page.$$('input[type="text"]');
    for (const el of texts) {
      const v = await el.inputValue().catch(() => '');
      if (v && v.includes('@')) { await el.fill(receptor.email).catch(() => {}); break; }
    }
  }
  const g03 = await page.$('input[type="radio"][value*="G03" i]');
  if (g03) { await g03.check().catch(() => {}); }
  else { const lbl = await page.$('label:has-text("G03")'); if (lbl) await lbl.click().catch(() => {}); }
  await dismissModals(page);

  await clickBtn(page, 'Generar comprobante');
  await page.waitForLoadState('networkidle').catch(() => {});
  await dismissModals(page);

  // ── RESULTADO ──
  const finalUrl = page.url();
  const html = await page.content();
  const exito = /Descargar factura/i.test(html) || /folio=/i.test(finalUrl);
  if (!exito) {
    // ¿algún error del portal?
    const m = html.match(/(No se encontró[^<.]*|no coincide[^<.]*|no est[aá] permitido[^<.]*)/i);
    return { needs_manual: true, motivo: m ? m[1].trim() : 'no_se_genero' };
  }

  // folio del URL de resultado (ej. ...folio=65749;serie=CT;rfc_emisor=...)
  const folio = (finalUrl.match(/folio=([^;&]+)/) || [])[1] || null;
  const serie = (finalUrl.match(/serie=([^;&]+)/) || [])[1] || null;

  // intento de descarga directa (best-effort; si falla, el CFDI llega por correo → recepción lo archiva)
  const pdf = await grab(page, ['Versión PDF', 'PDF']);
  const xml = await grab(page, ['Versión XML', 'XML']);
  const uuid = xml ? uuidFromB64Xml(xml) : null;

  return { uuid, folio, serie, pdf, xml, nota: 'CFDI también enviado por correo al email indicado' };
}

// ───────── helpers ─────────
async function dismissModals(page) {
  for (let i = 0; i < 5; i++) {
    const ok = await page.$('button:has-text("Ok"), button:has-text("Aceptar")');
    if (!ok) break;
    try { await ok.click(); } catch {}
    await page.waitForTimeout(300);
  }
}
async function clickBtn(page, name) {
  try {
    const b = page.getByRole('button', { name: new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') });
    if (await b.count()) { await b.first().click(); return true; }
  } catch {}
  const el = await page.$(`button:has-text("${name}"), input[type="submit"]`);
  if (el) { await el.click(); return true; }
  return false;
}
// baja un recurso por texto de link/botón; devuelve base64 (o null si no dispara descarga)
async function grab(page, texts) {
  for (const t of texts) {
    const el = await page.$(`a:has-text("${t}"), button:has-text("${t}")`);
    if (!el) continue;
    // 1) intento href directo
    const href = await el.getAttribute('href').catch(() => null);
    if (href && !href.startsWith('javascript')) {
      try {
        const abs = new URL(href, page.url()).toString();
        const r = await page.request.get(abs);
        if (r.ok()) { const buf = await r.body(); return buf.toString('base64'); }
      } catch {}
    }
    // 2) intento evento download
    try {
      const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 8000 }), el.click()]);
      const st = await dl.createReadStream(); if (!st) continue;
      const ch = []; for await (const c of st) ch.push(c);
      return Buffer.concat(ch).toString('base64');
    } catch {}
  }
  return null;
}
function uuidFromB64Xml(b64) {
  try { const xml = Buffer.from(b64, 'base64').toString('utf8'); const m = xml.match(/UUID="([0-9a-fA-F-]{36})"/); return m ? m[1] : null; }
  catch { return null; }
}

module.exports = { nombre, matches, facturar };
