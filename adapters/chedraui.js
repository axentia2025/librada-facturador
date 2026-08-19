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
  // 'chedra' tolera errores de OCR de la visión (chedrawi, chedraux, chedrahui…).
  return host.includes('chedra') || host.includes('masfacturaweb');
}

// Enrutado por lo que trae el TICKET cuando la URL viene mal leída o vacía.
// El comercio ("TIENDAS CHEDRAUX S.A. DE C.V.") y el RFC emisor (TCH850701RM1) son
// mucho más confiables que la URL que extrae la visión.
function matchesComercio({ comercio, rfc_emisor } = {}) {
  const c = String(comercio || '').toLowerCase();
  const r = String(rfc_emisor || '').toUpperCase().replace(/\s+/g, '');
  return /chedra/.test(c) || r.startsWith('TCH');
}

async function facturar(page, { url, ticket, receptor }) {
  // La visión a veces extrae la URL sin "/facturacion" (aterriza en la TIENDA, no en el portal).
  // Como ya sabemos que es Chedraui, forzamos el portal correcto (Masteredi/masfacturaweb).
  const PORTAL = 'https://www.masfacturaweb.com.mx/chedraui/chedraui_mfw.aspx';
  if (!/masfacturaweb\.com\.mx\/chedraui/i.test(page.url())) {
    await page.goto(PORTAL, { waitUntil: 'domcontentloaded' }).catch(() => {});
  }
  // Esperar a que el portal esté listo (menú/modal presentes) antes de tocar nada.
  await page.waitForSelector('#imbCrearFactura, #btnClose', { timeout: 15000 }).catch(() => {});
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
  // Núm. de ticket: Chedraui lo imprime en grupos (ej. "2608 1407 2201 3811 0003") pero el
  // campo es numérico → quitamos espacios.
  await setVal(page, '#txtNumTicket', String(ticket.ticket_id || ticket.folio || ticket.referencia || '').replace(/\s+/g, ''));

  // Captcha de imagen → 2Captcha
  try {
    const buf = await page.locator('#imgCaptcha').screenshot();
    const code = await solveCaptcha(buf.toString('base64'));
    await setVal(page, '#txtCodigo', String(code || '').trim());
  } catch (e) {
    return { needs_manual: true, motivo: 'captcha_no_resuelto: ' + (e.message || e), form_schema: await snap(page) };
  }

  // "Continuar" del paso 1 = ImageButton #imgSiguiente (postback ASP.NET → navega al paso 2).
  await clickSiExiste(page, '#imgSiguiente');

  // ── PASO 2 · "Modificación de Datos del Cliente" ──
  // Chedraui AUTOLLENA el receptor por el RFC (si el cliente registró sus datos). Esperamos a que
  // aparezca el campo de correo (señal de que el ticket fue válido y cargó el paso 2).
  const paso2 = await page.waitForSelector('#txtEmail', { timeout: 25000 }).then(() => true).catch(() => false);
  if (!paso2) {
    // No cargó el paso 2 → ticket no encontrado / captcha mal / ya facturado. Reportamos el motivo.
    const err1 = page._lastDialog || await textoError(page);
    return { needs_manual: true, motivo: err1 || 'no_avanzo_a_datos (ticket/captcha)', form_schema: await snap(page) };
  }
  // El CFDI debe llegar a Librada → sobrescribimos el correo (viene pre-lleno con el del cliente).
  await setVal(page, '#txtEmail', String(receptor.email || '').toLowerCase());
  await setVal(page, '#txtEmail2', String(receptor.email || '').toLowerCase());
  // Si el receptor NO estaba registrado (campos vacíos), los llenamos defensivamente.
  await setValSiVacio(page, '#txtNombre', receptor.nombre);
  await setValSiVacio(page, '#txtCP', receptor.cp);
  await elegirSelect(page, /regim/i, receptor.regimen || '612');
  await clickSiExiste(page, '#imgAlta');   // "Continuar" del paso 2 → paso 3

  // ── PASO 3 · "Detalle del Ticket de Compra" ──
  const paso3 = await page.waitForSelector('#ddlTipoVenta', { timeout: 25000 }).then(() => true).catch(() => false);
  if (!paso3) {
    const errm = page._lastDialog || await textoError(page);
    return { needs_manual: true, motivo: errm || 'no_avanzo_a_detalle', form_schema: await snap(page) };
  }
  await elegirSelectVal(page, '#ddlTipoVenta', 'Otros');            // "La venta corresponde a" (obligatorio; súper = Otros)
  await elegirSelectVal(page, '#ddlUsoCfdi', receptor.uso_cfdi || 'G03'); // Uso CFDI (siempre G03 · Gastos en general)
  await clickSiExiste(page, '#imgFacturar');                       // "Generar Factura"

  // ── RESULTADO ── esperar la pantalla "Su factura fue procesada"
  await page.waitForFunction(
    () => /su factura fue procesada|gracias por (su|tu) preferencia|Consultar Factura/i.test(document.body.innerText || ''),
    { timeout: 20000 }
  ).catch(() => {});
  await page.waitForTimeout(1500);

  if (await huboExito(page)) {
    return { uuid: await uuidDePagina(page), nota: 'CFDI de Chedraui generado (Masteredi); enviado al correo indicado → recepción lo archiva en la Bóveda.' };
  }
  const err2 = page._lastDialog || await textoError(page);
  return { needs_manual: true, motivo: err2 || 'no_se_genero', form_schema: await snap(page) };
}
function safeUrl(page) { try { return page.url(); } catch { return ''; } }
// TODOS los helpers usan page.evaluate (JS directo por selector) para NO retener element handles:
// los postbacks de ASP.NET navegan y un handle viejo truena ("adopt element handle from a different document").
async function elegirSelectVal(page, sel, val) {
  try {
    return await page.evaluate(([s, v]) => {
      const el = document.querySelector(s); if (!el) return false;
      const o = Array.from(el.options).find(o => o.value === v || o.text.trim().toUpperCase().startsWith(String(v).toUpperCase()));
      if (o) { el.value = o.value; el.dispatchEvent(new Event('change', { bubbles: true })); return true; } return false;
    }, [sel, String(val)]);
  } catch { return false; }
}
// ───────── helpers ─────────
async function setVal(page, sel, val) {
  try {
    return await page.evaluate(([s, v]) => {
      const e = document.querySelector(s); if (!e) return false;
      e.value = v; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); return true;
    }, [sel, String(val)]);
  } catch { return false; }
}
async function setValSiVacio(page, sel, val) {
  if (!val) return;
  try {
    await page.evaluate(([s, v]) => {
      document.querySelectorAll(s).forEach(e => { if (!e.value || !e.value.trim()) { e.value = v; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); } });
    }, [sel, String(val)]);
  } catch {}
}
async function clickSiExiste(page, sel) {
  // Click por JS directo: dispara el postback sin retener handle (robusto a navegación) y sin
  // problemas de overlay/actionability (los ImageButtons quedan tapados por el modal).
  try {
    return await page.evaluate((s) => { const e = document.querySelector(s); if (e) { e.click(); return true; } return false; }, sel);
  } catch { return false; }
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
  try {
    return await page.evaluate(([re, v]) => {
      const rx = new RegExp(re, 'i');
      for (const s of document.querySelectorAll('select')) {
        if (!rx.test((s.id || '') + ' ' + (s.name || ''))) continue;
        const o = Array.from(s.options).find(o => o.value === v || o.text.trim().toUpperCase().startsWith(String(v).toUpperCase()));
        if (o) { s.value = o.value; s.dispatchEvent(new Event('change', { bubbles: true })); return true; }
      }
      return false;
    }, [idRegex.source, String(valor)]);
  } catch { return false; }
}
async function dismiss(page) {
  for (let i = 0; i < 4; i++) {
    let clicked = false;
    try {
      clicked = await page.evaluate(() => {
        const b = document.querySelector('#btnClose') ||
          Array.from(document.querySelectorAll('button,input[type=button],input[type=submit]')).find(e => /^(aceptar|cerrar|ok)$/i.test((e.value || e.innerText || '').trim()));
        if (b) { b.click(); return true; } return false;
      });
    } catch {}
    if (!clicked) break; await page.waitForTimeout(300);
  }
}
// Texto de la página robusto: innerText por evaluate; si falla (headless a media navegación),
// cae a page.content() sin etiquetas. Así detectamos éxito/errores aunque evaluate truene.
async function textoPagina(page) {
  let t = '';
  try { t = await page.evaluate(() => (document.body && document.body.innerText) || ''); } catch {}
  if (!t || t.length < 5) {
    try { t = (await page.content()).replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' '); } catch {}
  }
  return (t || '').replace(/\s+/g, ' ');
}
async function huboExito(page) {
  const t = await textoPagina(page);
  if (/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/.test(t)) return true;
  return /(factura(ci[oó]n)?\s+(generad|exitos|realizad|emitid|procesad)|comprobante\s+(generad|emitid|procesad)|folio\s+fiscal|CFDI\s+(generad|emitid)|gracias por (su|tu) preferencia|descargar\s+(su|tu)\s+(factura|cfdi))/i.test(t);
}
async function textoError(page) {
  const t = await textoPagina(page);
  const m = t.match(/(no (existe|se encontr[oó])[^\n.]{0,80}|ticket[^\n.]{0,40}(inv[aá]lido|no v[aá]lido|no existe)[^\n.]{0,40}|ya (fue|est[aá]) facturad[oa][^\n.]{0,60}|c[oó]digo[^\n.]{0,20}(incorrecto|inv[aá]lido|no coincide)[^\n.]{0,20}|captcha[^\n.]{0,25}(incorrecto|inv[aá]lido|no coincide)[^\n.]{0,25}|RFC[^\n.]{0,25}(inv[aá]lido|incorrecto|no coincide)[^\n.]{0,25})/i);
  return m ? m[1].replace(/\s+/g, ' ').trim().slice(0, 120) : null;
}
async function uuidDePagina(page) {
  const html = (await page.content().catch(() => '')) || '';
  const m = html.match(/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/);
  return m ? m[0] : null;
}
async function snap(page) {
  try {
    const s = await page.evaluate(() => ({
      titulo: document.title, url: location.href,
      texto: ((document.body && document.body.innerText) || '').replace(/\s+/g, ' ').trim().slice(0, 800),
      // texto de spans/labels visibles (ASP.NET suele meter errores en <span> ocultos que se muestran)
      spans: Array.from(document.querySelectorAll('span,label,td,div')).map(e => (e.innerText || '').trim()).filter(t => t && t.length < 120 && /error|inv[aá]lid|incorrect|no (existe|se encontr|coincide|v[aá]lid)|captcha|ticket|rfc|factur/i.test(t)).slice(0, 12),
      campos: Array.from(document.querySelectorAll('input,select')).filter(e => e.type !== 'hidden').map(e => ({ id: e.id })).slice(0, 30),
      botones: Array.from(document.querySelectorAll('input[type=image],input[type=submit],input[type=button],button,a[id]')).map(b => ({ id: b.id, txt: (b.value || b.alt || b.innerText || '').trim().slice(0, 20) })).filter(b => b.id || b.txt).slice(0, 20),
    }));
    if (!s.texto || s.texto.length < 5) s.texto = (await textoPagina(page)).slice(0, 800); // respaldo por content()
    if (page._lastDialog) s.alert = String(page._lastDialog).slice(0, 200);
    return s;
  } catch {
    return { alert: page._lastDialog ? String(page._lastDialog).slice(0, 200) : null, texto: (await textoPagina(page)).slice(0, 800) };
  }
}
function esc(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

module.exports = { nombre, matches, matchesComercio, facturar };
