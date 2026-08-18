// Adapter · CHEDRAUI  (plataforma Masteredi / masfacturaweb.com.mx)
// El ticket trae www.chedraui.com.mx/facturacion → redirige a
// masfacturaweb.com.mx/chedraui/chedraui_mfw.aspx (ASP.NET, PAC Masteredi).
// Mapeado en vivo (18 ago 2026). Tiene CAPTCHA DE IMAGEN (no reCAPTCHA) → 2Captcha lo resuelve.
//
// Flujo:
//  Bienvenida: modal "Aceptar" (#btnClose) → botón "Crear Factura"
//  Paso 1: #txtRFC (10) + #txtHomoCve (3) · #txtNumTicket · captcha #imgCaptcha→#txtCodigo → "Continuar"
//  Paso 2: (autollena receptor por RFC) correo + Uso CFDI + "Generar/Facturar" → descarga/CFDI por correo
//
// Nota: masfacturaweb aloja a VARIOS comercios con el mismo layout; por eso matcheamos también
// el host de la plataforma (un solo adapter podría cubrir otros comercios de Masteredi).

const { solveCaptcha } = require('../captcha-solver');

const nombre = 'chedraui';

function matches(host) {
  return host.includes('chedraui') || host.includes('masfacturaweb');
}

async function facturar(page, { url, ticket, receptor }) {
  if (!/chedraui|masfacturaweb/i.test(page.url())) {
    await page.goto(url, { waitUntil: 'domcontentloaded' }).catch(() => {});
  }
  await page.waitForTimeout(1500);
  await clickSiExiste(page, '#btnClose');                 // modal "Estimado cliente… Aceptar"
  await page.waitForTimeout(600);
  // "Crear Factura" es un ImageButton de ASP.NET (#imbCrearFactura) → postback que muestra el form.
  if (!(await clickSiExiste(page, '#imbCrearFactura'))) await clickPorTexto(page, 'Crear Factura');
  const hayForm = await page.waitForSelector('#txtRFC', { timeout: 20000 }).then(() => true).catch(() => false);
  if (!hayForm) return { needs_manual: true, motivo: 'chedraui_sin_form', form_schema: await snap(page) };

  // ── PASO 1 ── RFC dividido (últimos 3 = homoclave), ticket, captcha
  const rfc = String(receptor.rfc || '').toUpperCase().replace(/\s+/g, '');
  await setVal(page, '#txtRFC', rfc.slice(0, Math.max(0, rfc.length - 3)));
  await setVal(page, '#txtHomoCve', rfc.slice(-3));
  await setVal(page, '#txtNumTicket', String(ticket.ticket_id || ticket.folio || ticket.referencia || ''));

  // Captcha de imagen → 2Captcha
  try {
    const buf = await page.locator('#imgCaptcha').screenshot();
    const code = await solveCaptcha(buf.toString('base64'));
    await setVal(page, '#txtCodigo', String(code || '').trim());
  } catch (e) {
    return { needs_manual: true, motivo: 'captcha_no_resuelto: ' + (e.message || e), form_schema: await snap(page) };
  }

  // "Continuar" del paso 1 es el ImageButton #imgSiguiente
  if (!(await clickSiExiste(page, '#imgSiguiente'))) await clickPorTexto(page, 'Continuar');
  await page.waitForTimeout(3500);
  await dismiss(page);

  // ¿Error del portal en el paso 1? (ticket no existe, ya facturado, captcha mal, RFC inválido)
  const err1 = await textoError(page);
  if (err1 && !/correo|e-?mail/i.test(err1)) {
    return { needs_manual: true, motivo: err1, form_schema: await snap(page) };
  }

  // ── PASO 2 ── (el portal autollena el receptor por RFC). Fijamos correo + Uso CFDI y generamos.
  await setValSiVacio(page, 'input[id*="correo" i], input[id*="mail" i], input[type=email]', receptor.email);
  await setValSiVacio(page, 'input[id*="confirm" i][id*="correo" i], input[id*="confirm" i][id*="mail" i]', receptor.email);
  await elegirSelect(page, /uso/i, receptor.uso_cfdi || 'G03');
  await elegirSelect(page, /regim/i, receptor.regimen || '612');
  await dismiss(page);

  // Generar/timbrar el paso 2 — ImageButtons de ASP.NET (ids probables) + respaldo por texto
  let genClick = false;
  for (const id of ['#imgFacturar', '#imgGenerar', '#imgTimbrar', '#imgFinalizar', '#imgSiguiente', '#imgEnviar', '#imgContinuar']) {
    if (await clickSiExiste(page, id)) { genClick = true; break; }
  }
  if (!genClick) {
    for (const t of ['Generar', 'Facturar', 'Timbrar', 'Finalizar', 'Continuar', 'Enviar']) {
      if (await clickPorTexto(page, t)) { genClick = true; break; }
    }
  }
  await page.waitForTimeout(4000);
  await dismiss(page);

  if (await huboExito(page)) {
    return { uuid: await uuidDePagina(page), nota: 'CFDI generado en Chedraui (Masteredi); normalmente también llega por correo.' };
  }
  const err2 = await textoError(page);
  return { needs_manual: true, motivo: err2 || 'no_se_genero', form_schema: await snap(page) };
}

// ───────── helpers ─────────
async function setVal(page, sel, val) {
  const el = await page.$(sel); if (!el) return false;
  try { await el.fill(String(val)); return true; } catch { return false; }
}
async function setValSiVacio(page, sel, val) {
  if (!val) return;
  for (const el of await page.$$(sel)) {
    const cur = await el.inputValue().catch(() => '');
    if (!cur || !cur.trim()) { await el.fill(String(val)).catch(() => {}); }
  }
}
async function clickSiExiste(page, sel) {
  const el = await page.$(sel); if (el) { try { await el.click({ timeout: 5000 }); return true; } catch {} } return false;
}
async function clickPorTexto(page, txt) {
  try {
    const b = page.getByRole('button', { name: new RegExp(esc(txt), 'i') });
    if (await b.count()) { await b.first().click({ timeout: 6000 }); return true; }
  } catch {}
  const el = await page.$(`input[type=submit][value*="${txt}" i], input[type=button][value*="${txt}" i], a:has-text("${txt}"), button:has-text("${txt}")`).catch(() => null);
  if (el) { try { await el.click({ timeout: 6000 }); return true; } catch {} }
  return false;
}
async function elegirSelect(page, idRegex, valor) {
  for (const sel of await page.$$('select')) {
    const meta = ((await sel.getAttribute('id')) || '') + ' ' + ((await sel.getAttribute('name')) || '');
    if (!idRegex.test(meta)) continue;
    try {
      const ok = await sel.evaluate((s, v) => {
        const o = Array.from(s.options).find((o) => o.value === v || o.text.trim().toUpperCase().startsWith(String(v).toUpperCase()));
        if (o) { s.value = o.value; s.dispatchEvent(new Event('change', { bubbles: true })); return true; } return false;
      }, String(valor));
      if (ok) return true;
    } catch {}
  }
  return false;
}
async function dismiss(page) {
  for (let i = 0; i < 4; i++) {
    const ok = await page.$('#btnClose, button:has-text("Aceptar"), input[value="Aceptar"], button:has-text("Cerrar")');
    if (!ok) break; try { await ok.click({ timeout: 3000 }); } catch {} await page.waitForTimeout(300);
  }
}
async function huboExito(page) {
  const html = (await page.content().catch(() => '')) || '';
  return /(Descargar|Factura generada|comprobante generado|se gener[oó]|Folio Fiscal|UUID|\.xml|\.pdf)/i.test(html);
}
async function textoError(page) {
  const html = (await page.content().catch(() => '')) || '';
  const m = html.match(/(no (existe|se encontr[oó])[^<.]{0,90}|ticket[^<.]{0,40}(inv[aá]lido|no v[aá]lido|no existe)[^<.]{0,40}|ya (fue|est[aá]) facturad[oa][^<.]{0,60}|c[oó]digo[^<.]{0,30}incorrecto[^<.]{0,30}|captcha[^<.]{0,30}|RFC[^<.]{0,30}(inv[aá]lido|incorrecto)[^<.]{0,30})/i);
  return m ? m[1].replace(/\s+/g, ' ').trim() : null;
}
async function uuidDePagina(page) {
  const html = (await page.content().catch(() => '')) || '';
  const m = html.match(/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/);
  return m ? m[0] : null;
}
async function snap(page) {
  try {
    return await page.evaluate(() => ({
      titulo: document.title, url: location.href,
      campos: Array.from(document.querySelectorAll('input,select')).filter(e => e.type !== 'hidden').map(e => ({ id: e.id, name: e.name })).slice(0, 25),
      botones: Array.from(document.querySelectorAll('input[type=submit],input[type=button],button,a')).map(b => (b.value || b.innerText || '').trim()).filter(Boolean).slice(0, 20),
    }));
  } catch { return null; }
}
function esc(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

module.exports = { nombre, matches, facturar };
