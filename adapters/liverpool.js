// Adapter · LIVERPOOL  (facturacionclientes.liverpool.com.mx · React/MUI)
// Mapeado en vivo 20-ago-2026 (factura real generada, $800, código BRNUIOQQIJRLTOHWQJC0).
// El ticket trae un CÓDIGO DE FACTURACIÓN (alfanumérico ~20 chars) + monto exacto.
// SIN captcha. Portal SPA: campos MUI con `name` estable (billingCode, amount, rfc,
// firstName, paternalName, maternalName, postalCode, email) y dos dropdowns tipo Select
// (#regimen-fiscal, #use-cfdi) que abren un listbox con role=option.
//
// Flujo:
//  1) billingCode + amount -> "Buscar ticket"  (valida el ticket)
//  2) rfc -> "Continuar"  -> si el RFC ya facturó antes, sale un modal "Resultados de
//     búsqueda" con "Seleccionar" (autollena datos). Si no, se llenan a mano.
//  3) régimen (#regimen-fiscal) + uso CFDI (#use-cfdi) + datos personales
//  4) "Continuar" (abajo) -> modal "Confirmación de datos" -> "Generar factura"
//  5) "Confirmación de factura": el CFDI se ENVÍA por correo (3-5 días) al email dado.

const nombre = 'liverpool';

const PORTAL = 'https://facturacionclientes.liverpool.com.mx/generarFactura/&uid=liverpool';

function matches(host) {
  return String(host || '').includes('liverpool');
}
function matchesComercio({ comercio, rfc_emisor } = {}) {
  return /liverpool/i.test(String(comercio || '')) || String(rfc_emisor || '').toUpperCase().startsWith('LIV');
}

// Separa "Omar Antonio Arvayo Castro" -> {nombres, paterno, materno} (heurística:
// últimas 2 palabras = apellidos). Sólo se usa para clientes NUEVos en Liverpool;
// los que ya facturaron ahí se autollenan con el modal "Seleccionar".
function partirNombre(full) {
  const p = String(full || '').trim().split(/\s+/);
  if (p.length >= 4) return { nombres: p.slice(0, p.length - 2).join(' '), paterno: p[p.length - 2], materno: p[p.length - 1] };
  if (p.length === 3) return { nombres: p[0], paterno: p[1], materno: p[2] };
  if (p.length === 2) return { nombres: p[0], paterno: p[1], materno: '' };
  return { nombres: full || '', paterno: '', materno: '' };
}

async function facturar(page, { url, ticket, receptor }) {
  if (!/facturacionclientes\.liverpool/i.test(page.url())) {
    await page.goto(PORTAL, { waitUntil: 'domcontentloaded' }).catch(() => {});
  }
  const codigo = String(ticket.ticket_id || ticket.referencia || ticket.folio || '').trim();
  const monto = String(ticket.monto ?? '').replace(/[^0-9.]/g, '');

  // ── PASO 1: código + monto → Buscar ticket ──
  const hayForm = await page.waitForSelector('input[name="billingCode"]', { timeout: 20000 }).then(() => true).catch(() => false);
  if (!hayForm) return { needs_manual: true, motivo: 'liverpool_sin_form', form_schema: await snap(page) };
  await setVal(page, 'input[name="billingCode"]', codigo);
  await setVal(page, 'input[name="amount"]', monto);
  await clickTexto(page, 'Buscar ticket');
  // Debe aparecer la sección de datos fiscales (RFC). Si el ticket/monto no cuadran, no aparece.
  const okTicket = await page.waitForSelector('input[name="rfc"]', { timeout: 15000 }).then(() => true).catch(() => false);
  if (!okTicket) return { needs_manual: true, motivo: 'ticket_no_encontrado (código/monto)', form_schema: await snap(page) };

  // ── PASO 2: RFC → Continuar ──
  const rfc = String(receptor.rfc || '').toUpperCase().replace(/\s+/g, '');
  await setVal(page, 'input[name="rfc"]', rfc);
  await clickTexto(page, 'Continuar');          // el "Continuar" del bloque de RFC
  await page.waitForTimeout(1800);

  // Si el RFC ya facturó antes, Liverpool ofrece autollenado ("Seleccionar" en un modal).
  const autollenado = await clickTexto(page, 'Seleccionar');
  if (autollenado) await page.waitForTimeout(1200);

  // ── PASO 3: régimen + uso CFDI (dropdowns) ──
  await elegirCombo(page, '#regimen-fiscal', receptor.regimen || '612');
  await elegirCombo(page, '#use-cfdi', receptor.uso_cfdi || 'G03');

  // Datos personales: si no se autollenaron, llenarlos.
  if (!autollenado) {
    const n = partirNombre(receptor.nombre);
    await setValSiVacio(page, 'input[name="firstName"]', n.nombres);
    await setValSiVacio(page, 'input[name="paternalName"]', n.paterno);
    await setValSiVacio(page, 'input[name="maternalName"]', n.materno);
    await setValSiVacio(page, 'input[name="postalCode"]', String(receptor.cp || ''));
  }
  // Correo SIEMPRE al de Librada para que el CFDI entre a la Bóveda.
  await setVal(page, 'input[name="email"]', receptor.email || 'facturacion@librada.mx');

  // ── PASO 4: Continuar (abajo) → modal → Generar factura ──
  await clickUltimo(page, 'Continuar');         // el "Continuar" del pie abre la confirmación
  await page.waitForTimeout(1200);
  const genero = await clickTexto(page, 'Generar factura');
  if (!genero) return { needs_manual: true, motivo: 'no_boton_generar', form_schema: await snap(page) };

  // ── PASO 5: éxito ──
  const exito = await page.waitForFunction(
    () => /Confirmaci[oó]n de factura|proceso de env[ií]o|recibir[aá]s en el correo/i.test(document.body.innerText),
    { timeout: 30000 }
  ).then(() => true).catch(() => false);

  if (exito) {
    return { ok: true, folio: codigo,
      nota: 'Liverpool acepta la factura y ENVÍA el CFDI por correo (3-5 días) a ' + (receptor.email || 'facturacion@librada.mx') + '. Entra a la Bóveda por recepción de correo.',
      receta: { patron: 'liverpool_spa', portal: PORTAL } };
  }
  return { needs_manual: true, motivo: 'no_confirmo_exito', form_schema: await snap(page) };
}

// ───────── helpers (React/MUI: fill dispara los eventos que MUI necesita) ─────────
async function setVal(page, sel, val) {
  try {
    const el = await page.waitForSelector(sel, { timeout: 8000 });
    await el.fill(String(val)).catch(async () => { await el.click(); await el.type(String(val)); });
    return true;
  } catch { return false; }
}
async function setValSiVacio(page, sel, val) {
  try {
    const el = await page.$(sel);
    if (!el) return false;
    const cur = await el.inputValue().catch(() => '');
    if (cur && cur.trim()) return true;
    await el.fill(String(val)).catch(() => {});
    return true;
  } catch { return false; }
}
// Abre el dropdown MUI y elige la opción que empieza con el código (612, G03…).
async function elegirCombo(page, sel, valor) {
  const v = String(valor || '').toUpperCase();
  try {
    const combo = await page.waitForSelector(sel, { timeout: 8000 });
    await combo.click();
    await page.waitForTimeout(400);
    // opciones role=option en el listbox abierto
    const opt = await page.$(`[role="option"] >> text=/^\\s*${v}\\b/i`);
    if (opt) { await opt.click(); return true; }
    // fallback: cualquier opción que contenga el código
    const opt2 = await page.$(`[role="option"]:has-text("${v}")`);
    if (opt2) { await opt2.click(); return true; }
    await page.keyboard.press('Escape').catch(() => {});
    return false;
  } catch { return false; }
}
// Clic en un botón/elemento por su texto visible (primero que aparezca).
async function clickTexto(page, texto) {
  try {
    const btn = page.getByRole('button', { name: new RegExp('^\\s*' + texto, 'i') });
    if (await btn.count()) { await btn.first().click({ timeout: 6000 }); return true; }
  } catch {}
  const el = await page.$(`button:has-text("${texto}"), a:has-text("${texto}")`).catch(() => null);
  if (el) { try { await el.click({ timeout: 6000 }); return true; } catch {} }
  return false;
}
// Clic en el ÚLTIMO botón con ese texto (el "Continuar" del pie, no el del bloque RFC).
async function clickUltimo(page, texto) {
  try {
    const btns = page.getByRole('button', { name: new RegExp('^\\s*' + texto, 'i') });
    const n = await btns.count();
    if (n) { await btns.nth(n - 1).click({ timeout: 6000 }); return true; }
  } catch {}
  return clickTexto(page, texto);
}
async function snap(page) {
  try {
    const texto = await page.evaluate(() => document.body.innerText.replace(/\s+/g, ' ').slice(0, 1200)).catch(() => '');
    return { url: page.url(), texto };
  } catch { return { url: page.url() }; }
}

module.exports = { nombre, matches, matchesComercio, facturar };
