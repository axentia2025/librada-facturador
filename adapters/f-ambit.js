// Adapter · F-AMBIT  (*.facturacion.f-ambit.mx) — plataforma de muchos restaurantes.
// Mapeado EN VIVO con Kleins Reforma (12 ago 2026): es un formulario de UNA página en 3 pasos
// (NO es "buscar ticket → luego receptor" como suponía el stub). SIN captcha.
// El portal AUTOLLENA los datos del receptor a partir del RFC (Razón Social, Régimen, domicilio, CP),
// así que sólo hay que capturar: Sucursal, Monto, Ticket Id, RFC, Uso CFDi y el correo de envío.
// Al final descarga PDF+XML y además el portal manda el CFDI por correo al email dado.
//
// Flujo:
//   /#/            Paso 1: Sucursal(select) · Monto Ticket · Ticket Id · Mi R.F.C. → [Siguiente]
//   /#/client_data Paso 2: (autollenado) + Uso CFDi(select G03) + E-mail para envío → [Siguiente]
//   (review)       Paso 3: "VERIFIQUE SUS DATOS" → [Siguiente] (genera)
//   /#/download_links  Resultado: "Reclamo Exitoso" + botones XML / PDF / TICKET

const nombre = 'f-ambit';

function matches(host) {
  return host.includes('f-ambit');
}

async function facturar(page, { url, ticket, receptor }) {
  await page.goto(url, { waitUntil: 'domcontentloaded' });

  // Por si algún f-ambit trajera reCAPTCHA (los mapeados NO tienen) → intervención/servicio.
  if (await page.$('iframe[src*="recaptcha"], .g-recaptcha')) {
    return { needs_manual: true, motivo: 'captcha_requerido' };
  }

  // ── PASO 1 ──
  const sucursal = page.locator('select').first();
  try {
    if (ticket.sucursal) {
      await sucursal.selectOption({ label: new RegExp(escapeRe(ticket.sucursal), 'i') });
    } else {
      const opts = await sucursal.locator('option').count();
      if (opts > 1) await sucursal.selectOption({ index: 1 }); // 1ª opción real (0 = placeholder "?")
    }
  } catch {
    const opts = await sucursal.locator('option').count();
    if (opts > 1) await sucursal.selectOption({ index: 1 });
  }
  await fillByLabel(page, 'Monto Ticket', String(ticket.monto ?? ''));
  await fillByLabel(page, 'Ticket Id', String(ticket.ticket_id || ticket.folio || ''));
  await fillByLabel(page, 'R.F.C', receptor.rfc);
  await clickBtn(page, 'Siguiente');
  await page.waitForLoadState('networkidle').catch(() => {});

  // ── PASO 2 ── (los datos del receptor los autollenó el portal por el RFC)
  await selectByLabel(page, 'Uso CFDi', receptor.uso_cfdi || 'G03');
  await fillByLabel(page, 'E-mail', receptor.email || '');
  await clickBtn(page, 'Siguiente');
  await page.waitForLoadState('networkidle').catch(() => {});

  // ── PASO 3 ── verificación → generar
  await clickBtn(page, 'Siguiente');
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForURL(/download_links|Reclamo|Exitoso/i, { timeout: 30000 }).catch(() => {});

  // ── RESULTADO ── descargar PDF + XML
  const pdf = await download(page, 'PDF');
  const xml = await download(page, 'XML');
  const uuid = xml ? uuidFromB64Xml(xml) : await uuidFromPage(page);
  if (!pdf && !xml && !uuid) throw new Error('no_se_genero_cfdi: revisar flujo/selectores f-ambit');
  return { uuid, pdf, xml };
}

// ───────── helpers ─────────
function escapeRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// Rellena un campo buscando por label; si no, por placeholder/name como respaldo.
async function fillByLabel(page, labelText, value) {
  try {
    const byLabel = page.getByLabel(new RegExp(escapeRe(labelText), 'i'));
    if (await byLabel.count()) { await byLabel.first().fill(value); return true; }
  } catch {}
  const fallbacks = [
    `input[placeholder*="${labelText}" i]`,
    `input[name*="${labelText.replace(/[^a-z]/gi, '')}" i]`,
  ];
  for (const s of fallbacks) { const el = await page.$(s); if (el) { await el.fill(value); return true; } }
  return false;
}

// Selecciona una opción de un <select> por label del campo, eligiendo la opción cuyo texto contenga `value` (ej. "G03").
async function selectByLabel(page, labelText, value) {
  let sel;
  try {
    const byLabel = page.getByLabel(new RegExp(escapeRe(labelText), 'i'));
    if (await byLabel.count()) sel = byLabel.first();
  } catch {}
  if (!sel) return false;
  try { await sel.selectOption({ label: new RegExp(escapeRe(value), 'i') }); return true; }
  catch { try { await sel.selectOption(value); return true; } catch { return false; } }
}

async function clickBtn(page, name) {
  try {
    const b = page.getByRole('button', { name: new RegExp(escapeRe(name), 'i') });
    if (await b.count()) { await b.first().click(); return true; }
  } catch {}
  const el = await page.$(`button:has-text("${name}"), input[type="submit"][value*="${name}" i]`);
  if (el) { await el.click(); return true; }
  return false;
}

// Descarga por texto del botón/enlace ("PDF" / "XML") y devuelve base64.
async function download(page, text) {
  const link = await page.$(`a:has-text("${text}"), button:has-text("${text}")`);
  if (!link) return null;
  try {
    const [dl] = await Promise.all([
      page.waitForEvent('download', { timeout: 20000 }),
      link.click(),
    ]);
    const stream = await dl.createReadStream();
    if (!stream) return null;
    const chunks = [];
    for await (const c of stream) chunks.push(c);
    return Buffer.concat(chunks).toString('base64');
  } catch { return null; }
}

function uuidFromB64Xml(b64) {
  try {
    const xml = Buffer.from(b64, 'base64').toString('utf8');
    const m = xml.match(/UUID="([0-9a-fA-F-]{36})"/);
    return m ? m[1] : null;
  } catch { return null; }
}
async function uuidFromPage(page) {
  const html = await page.content();
  const m = html.match(/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/);
  return m ? m[0] : null;
}

module.exports = { nombre, matches, facturar };
