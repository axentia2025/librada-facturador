// Adapter · CHEDRAUI  (portal masfacturaweb.com.mx/chedraui — PAC Masteredi)
// Plataforma de facturación de Grupo Comercial Chedraui (Súper Chedraui, Selecto, etc.).
//
// A diferencia de F-Ambit, el ticket de Chedraui NO trae URL de facturación: el portal es FIJO
// y se identifica al comercio por el RFC emisor (TCH850701RM1) o comercio="Chedraui".
// Selectores CONFIRMADOS contra el portal real (ago 2026).
//
// ⚠️ CAPTCHA: el paso 1 termina en un código de seguridad (imagen Registro/captcha.aspx, 6 chars).
//    NO se resuelve aquí. Opciones de producto: (a) mandar la imagen del captcha al cliente por
//    WhatsApp para que lo teclee (semi-automático), o (b) integrar un servicio anti-captcha con
//    licencia. Sin captcha resuelto, el flujo se detiene y regresa needs_manual con la imagen.

const nombre = 'chedraui';
const PORTAL = 'https://www.masfacturaweb.com.mx/chedraui/';

function matches(host) {
  return host.includes('masfacturaweb.com.mx');
}
// Enrutamiento por comercio (el ticket no trae URL): úsalo en el router para mandar Chedraui aquí.
function matchesComercio({ comercio = '', rfc_emisor = '' } = {}) {
  return /chedraui/i.test(comercio) || /^TCH850701/i.test(rfc_emisor);
}

async function facturar(page, { ticket, receptor, captcha, tipoVenta }) {
  await page.goto(PORTAL, { waitUntil: 'domcontentloaded' });

  // 0) Cerrar el aviso de bienvenida si aparece
  await clickIfPresent(page, '#btnClose');

  // 1) Entrar a "Crear Factura" (image button ASP.NET)
  await page.click('#imbCrearFactura');
  await page.waitForSelector('#txtRFC', { timeout: 15000 });

  // 2) Paso 1 — RFC (base + homoclave) y número de ticket (19 díg., arriba del código de barras)
  const rfc = String(receptor.rfc || '').toUpperCase().replace(/\s+/g, '');
  await page.fill('#txtRFC', rfc.slice(0, rfc.length - 3)); // base (10 física / 9 moral)
  await page.fill('#txtHomoCve', rfc.slice(-3));            // homoclave (3)
  await page.fill('#txtNumTicket', String(ticket.ticket_id || ticket.folio || '').replace(/\s+/g, ''));
  // chkIne (complemento INE) queda sin marcar.

  // 3) Captcha (6 chars). Si no viene resuelto -> intervención (mandar imagen al cliente / anti-captcha).
  if (!captcha) {
    const img = await captchaImage(page); // base64 png para enviar al cliente
    return { ok: false, needs_manual: true, motivo: 'captcha_requerido', captcha_img: img,
             estado: { rfc: rfc, ticket: ticket.ticket_id }, portal: PORTAL };
  }
  await page.fill('#txtCodigo', String(captcha));
  await page.click('#imgSiguiente');                 // valida captcha -> Paso 2 (datos cliente)
  await page.waitForSelector('#txtNombre, #imgAlta', { timeout: 20000 });

  // 4) Paso 2 — "Modificación de Datos del Cliente". Si el cliente ya facturó antes, Chedraui los
  //    trae PRE-LLENADOS; si no (primera vez), se completan desde `receptor`.
  if (!(await inputVal(page, '#txtNombre'))) {
    await fillIf(page, '#txtNombre', receptor.nombre);
    await fillIf(page, '#txtCalle', receptor.calle);
    await fillIf(page, '#txtExterior', receptor.no_ext);
    await fillIf(page, '#txtInterior', receptor.no_int);
    await fillIf(page, '#txtColonia', receptor.colonia);
    await fillIf(page, '#txtLocalidad', receptor.localidad);
    await fillIf(page, '#txtDelMunicipio', receptor.municipio);
    await fillIf(page, '#txtCodigoPostal', receptor.cp);
    await selectIf(page, '#DdlRegimen', receptor.regimen);        // 612
    await fillIf(page, '#txtEmail', receptor.correo);
    await fillIf(page, '#txtEmail2', receptor.correo);
  }
  await page.click('#imgAlta');                      // Continuar -> Paso final (detalle CFDI 4.0)
  await page.waitForSelector('#imgFacturar', { timeout: 20000 });

  // 5) Paso final — Uso CFDI + tipo de venta -> GENERAR (timbrado, IRREVERSIBLE).
  await selectIf(page, '#ddlUsoCfdi', receptor.uso_cfdi || 'G03');  // instrucción Omar: SIEMPRE G03 (gastos grales)
  await selectIf(page, '#ddlTipoVenta', tipoVenta || 'Otros');       // Motos | Electro | Otros (obligatorio)
  await page.click('#imgFacturar');                  // Generar Factura
  await page.waitForLoadState('networkidle').catch(() => {});

  // 6) Descargar PDF + XML y extraer UUID
  const pdf = await downloadByText(page, ['PDF', 'Descargar PDF']);
  const xml = await downloadByText(page, ['XML', 'Descargar XML']);
  const uuid = await extractUuid(page);
  if (!pdf && !xml && !uuid) return { ok: false, needs_manual: true, motivo: 'revisar_post_generar', portal: PORTAL };
  return { uuid, pdf, xml };
}

// ---------- helpers ----------
async function clickIfPresent(page, sel) { const el = await page.$(sel); if (el) { try { await el.click(); } catch {} } }
async function inputVal(page, sel) { const el = await page.$(sel); return el ? (await el.inputValue().catch(() => '')) : ''; }
async function fillIf(page, sel, val) { if (!val) return; const el = await page.$(sel); if (el) { try { await el.fill(String(val)); } catch {} } }
async function selectIf(page, sel, val) { if (!val) return; const el = await page.$(sel); if (el) { try { await el.selectOption(String(val)); } catch {} } }
async function captchaImage(page) {
  const el = await page.$('#imgNewCap, img[src*="captcha.aspx"]');
  if (!el) return null;
  try { return 'data:image/png;base64,' + (await el.screenshot()).toString('base64'); } catch { return null; }
}
async function downloadByText(page, texts) {
  for (const t of texts) {
    const link = await page.$(`a:has-text("${t}"), input[value*="${t}"], button:has-text("${t}")`);
    if (!link) continue;
    try {
      const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 15000 }), link.click()]);
      const stream = await dl.createReadStream(); if (!stream) continue;
      const chunks = []; for await (const c of stream) chunks.push(c);
      return Buffer.concat(chunks).toString('base64');
    } catch { /* siguiente */ }
  }
  return null;
}
async function extractUuid(page) {
  const html = await page.content();
  const m = html.match(/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/);
  return m ? m[0] : null;
}

module.exports = { nombre, matches, matchesComercio, facturar, PORTAL };
