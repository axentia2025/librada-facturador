// Adapter · GRUPO LA COMER  (La Comer, City Market, Fresko, Sumesa)
// Portal ÚNICO para las 4 marcas: www.lacomer.com.mx/emision-cfdiwebangular/#/lacomer
// App Angular/Material. Mapeado en vivo 20-ago-2026 (factura real Fresko, transacción 67290498).
// CAPTCHA de imagen (2Captcha lo resuelve, igual que Chedraui).
//
// Flujo (3 pasos):
//  1) Modal "Enterado" -> RFC (#clieRfc) + captcha (img[alt=CAPTCHA] -> captchaInput) -> #buscar
//     -> "Información General" (autollena datos fiscales si el RFC ya facturó ahí) -> "Siguiente"
//  2) "Facturar Ticket" -> #ticket (22 caracteres) + Uso CFDI (mat-select#usoCfdi = Gastos en general)
//     + checks (Enviar Correo, Facturar todos los artículos) -> "Enviar"
//  3) Éxito: "Se ha generado la factura con el número de transacción NNNNN".
//
// NOTA CFDI/Bóveda: el portal envía el CFDI al correo registrado del cliente en su perfil
// La Comer (no siempre facturacion@librada.mx). Para que entre a la Bóveda, el cliente puede
// dejar facturacion@librada.mx como su correo en La Comer, o se descarga luego de Consultar.

const { solveCaptcha } = require('../captcha-solver');

const nombre = 'lacomer';
const PORTAL = 'https://www.lacomer.com.mx/emision-cfdiwebangular/#/lacomer';

function matches(host) {
  return /lacomer/i.test(String(host || ''));
}
function matchesComercio({ comercio, rfc_emisor } = {}) {
  return /la\s*comer|city\s*market|fresko|sumesa/i.test(String(comercio || ''));
}

async function facturar(page, { url, ticket, receptor }) {
  if (!/lacomer\.com\.mx\/emision-cfdi/i.test(page.url())) {
    await page.goto(PORTAL, { waitUntil: 'domcontentloaded' }).catch(() => {});
  }
  await page.waitForTimeout(1500); // Angular tarda en montar

  // Modal de avisos SAT → "Enterado"
  await clickTexto(page, 'Enterado');
  await page.waitForTimeout(500);

  // ── PASO 1: RFC + captcha → Buscar ──
  const hayRfc = await page.waitForSelector('#clieRfc', { timeout: 20000 }).then(() => true).catch(() => false);
  if (!hayRfc) return { needs_manual: true, motivo: 'lacomer_sin_form', form_schema: await snap(page) };
  const rfc = String(receptor.rfc || '').toUpperCase().replace(/\s+/g, '');
  await setVal(page, '#clieRfc', rfc);

  // Captcha de imagen: capturar la img, resolver con 2Captcha, escribir el código.
  const cap = await page.$('img[alt="CAPTCHA"]');
  if (cap) {
    try {
      const b64 = (await cap.screenshot()).toString('base64');
      const codigo = await solveCaptcha(b64);
      if (codigo) await setVal(page, 'input[formcontrolname="captchaInput"]', codigo);
    } catch (e) { /* si falla el captcha, seguimos: Buscar dará error y escalamos */ }
  }
  await clickSel(page, '#buscar');

  // Debe pasar a "Información General" (la URL incluye el RFC). Si el captcha/RFC falló, no avanza.
  const enInfo = await page.waitForFunction(
    () => /\/[A-ZÑ&]{3,4}\d{6}[A-Z0-9]{3}(\/|$)/i.test(location.href) || /Informaci[oó]n General/i.test(document.body.innerText),
    { timeout: 20000 }
  ).then(() => true).catch(() => false);
  if (!enInfo) return { needs_manual: true, motivo: 'rfc_o_captcha (paso 1)', form_schema: await snap(page) };
  await page.waitForTimeout(1000);

  // Datos fiscales: para RFC ya registrado se autollenan. Para cliente NUEVO se completan.
  await setValSiVacio(page, 'input[formcontrolname="clieNom"]', receptor.nombre);
  await setValSiVacio(page, 'input[formcontrolname="clieCp"]', String(receptor.cp || ''));

  // Avanzar al paso de ticket.
  await clickTexto(page, 'Siguiente');
  const hayTicket = await page.waitForSelector('#ticket', { timeout: 20000 }).then(() => true).catch(() => false);
  if (!hayTicket) return { needs_manual: true, motivo: 'no_paso_a_ticket', form_schema: await snap(page) };

  // ── PASO 2: ticket (22 chars) + Uso CFDI + Enviar ──
  const numTicket = String(ticket.ticket_id || ticket.referencia || ticket.folio || '').replace(/\s+/g, '');
  await setVal(page, '#ticket', numTicket);
  await elegirMatSelect(page, '#usoCfdi', receptor.uso_cfdi || 'G03');
  // Los checks "Enviar Correo" y "Facturar todos los artículos" vienen marcados por defecto.
  await clickTexto(page, 'Enviar');

  // ── PASO 3: éxito ──
  const exito = await page.waitForFunction(
    () => /Se ha generado la factura|n[uú]mero de transacci[oó]n/i.test(document.body.innerText),
    { timeout: 30000 }
  ).then(() => true).catch(() => false);

  if (exito) {
    const txt = await page.evaluate(() => document.body.innerText).catch(() => '');
    const m = txt.match(/transacci[oó]n\s*(\d+)/i);
    return { ok: true, folio: (m && m[1]) || numTicket,
      nota: 'La Comer generó la factura (transacción ' + ((m && m[1]) || '¿?') + '); el CFDI se envía al correo registrado del cliente en La Comer.',
      receta: { patron: 'lacomer_angular', portal: PORTAL } };
  }
  return { needs_manual: true, motivo: await textoError(page) || 'no_se_genero', form_schema: await snap(page) };
}

// ───────── helpers (Angular Material: fill dispara los eventos que Angular escucha) ─────────
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
    if (!el || !val) return false;
    const cur = await el.inputValue().catch(() => '');
    if (cur && cur.trim()) return true;
    await el.fill(String(val)).catch(() => {});
    return true;
  } catch { return false; }
}
async function clickSel(page, sel) {
  try { const el = await page.$(sel); if (el) { await el.click({ timeout: 6000 }); return true; } } catch {}
  return false;
}
async function clickTexto(page, texto) {
  try {
    const btn = page.getByRole('button', { name: new RegExp('^\\s*' + texto, 'i') });
    if (await btn.count()) { await btn.first().click({ timeout: 6000 }); return true; }
  } catch {}
  const el = await page.$(`button:has-text("${texto}"), a:has-text("${texto}")`).catch(() => null);
  if (el) { try { await el.click({ timeout: 6000 }); return true; } catch {} }
  return false;
}
// Abre un mat-select y elige la opción por el código de Uso CFDI (G03 -> "Gastos en general").
async function elegirMatSelect(page, sel, uso) {
  const MAP = { G01: 'Adquisici', G02: 'Devoluciones', G03: 'Gastos en general', I01: 'Construcc', S01: 'efectos fiscales', CP01: 'Pagos' };
  const texto = MAP[String(uso || 'G03').toUpperCase()] || 'Gastos en general';
  try {
    const el = await page.$(sel); if (!el) return false;
    await el.click();
    await page.waitForTimeout(400);
    const opt = await page.$(`mat-option:has-text("${texto}"), [role="option"]:has-text("${texto}")`);
    if (opt) { await opt.click(); return true; }
    await page.keyboard.press('Escape').catch(() => {});
    return false;
  } catch { return false; }
}
async function textoError(page) {
  try {
    const t = await page.evaluate(() => document.body.innerText).catch(() => '');
    const m = t.match(/(ticket[^.<]{0,60}(no|inv[aá]lid|no existe)[^.<]{0,40}|captcha[^.<]{0,40}|no coincide[^.<]{0,40})/i);
    return m ? m[1].replace(/\s+/g, ' ').trim() : null;
  } catch { return null; }
}
async function snap(page) {
  try {
    const texto = await page.evaluate(() => document.body.innerText.replace(/\s+/g, ' ').slice(0, 1200)).catch(() => '');
    return { url: page.url(), texto };
  } catch { return { url: page.url() }; }
}

module.exports = { nombre, matches, matchesComercio, facturar };
