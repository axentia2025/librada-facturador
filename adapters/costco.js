// Adapter · COSTCO México  (www3.costco.com.mx/facturacion)
// Portal propio de Costco. Formulario de UNA página en 2 pasos, con IDs limpios.
// Requiere MODO SIGILO en el navegador (Costco no renderiza el form a un browser
// automatizado detectable) — eso lo activa server.js en el launch/context.
//
// Paso 1 (visible): #ticket · #monto · #rfc → botón "Continuar"
// Paso 2 (se revela): #razonSocial · #codigoPostal (suelen autollenar por RFC) ·
//   select #regimenFiscal · select #usoCFDI · #correo · #correoConfirmacion → "Generar"/"Facturar"

const nombre = 'costco';

function matches(host) {
  return host.includes('costco.com'); // www3.costco.com.mx (y variantes)
}

async function facturar(page, { url, ticket, receptor }) {
  if (!/costco/i.test(page.url())) {
    await page.goto(url, { waitUntil: 'domcontentloaded' }).catch(() => {});
  }
  // Esperar a que Costco renderice el formulario (JS). Si no aparece #ticket → probablemente
  // nos bloqueó por bot; devolvemos needs_manual con el detalle.
  const apareceForm = await page.waitForSelector('#ticket', { timeout: 25000 }).then(() => true).catch(() => false);
  if (!apareceForm) {
    return { needs_manual: true, motivo: 'costco_no_renderizo_form (posible bloqueo anti-bot)', form_schema: await snap(page) };
  }

  // ── PASO 1 ──
  await setVal(page, '#ticket', String(ticket.ticket_id || ticket.folio || ticket.referencia || ''));
  await setVal(page, '#monto', String(ticket.monto ?? ''));
  await setVal(page, '#rfc', String(receptor.rfc || ''));
  await clickBtn(page, 'Continuar');
  await page.waitForTimeout(3000); // Costco es pesado; no usamos networkidle (nunca se calma)
  await dismiss(page);

  // ¿Error en el paso 1? (ticket/monto no coincide, ya facturado, etc.)
  const err1 = await textoError(page);
  if (err1) return { needs_manual: true, motivo: err1, form_schema: await snap(page) };

  // ── PASO 2 ──  (esperar a que se revele el correo)
  await page.waitForSelector('#correo', { state: 'visible', timeout: 15000 }).catch(() => {});
  // razonSocial / CP: suelen autollenar por el RFC; si vienen vacíos, los ponemos.
  await fillIfEmpty(page, '#razonSocial', receptor.nombre);
  await fillIfEmpty(page, '#codigoPostal', receptor.cp);
  // Régimen y Uso CFDI (selects) — por valor o por texto que contenga el código.
  await selectSmart(page, '#regimenFiscal', String(receptor.regimen || '612'));
  await selectSmart(page, '#usoCFDI', String(receptor.uso_cfdi || 'G03'));
  // Correo de envío del CFDI (duplicado en confirmación).
  await setVal(page, '#correo', String(receptor.email || ''));
  await setVal(page, '#correoConfirmacion', String(receptor.email || ''));
  await dismiss(page);

  // Captcha de imagen en este paso → lo marca para el resolvedor (2Captcha) del orquestador.
  if (await page.$('img[src*="captcha" i], img[id*="captcha" i]')) {
    return { needs_manual: true, motivo: 'captcha_imagen', form_schema: await snap(page) };
  }

  // ── GENERAR ──
  const gen = (await clickBtn(page, 'Generar')) || (await clickBtn(page, 'Facturar')) || (await clickBtn(page, 'Continuar'));
  await page.waitForTimeout(4000); // sin networkidle (Costco no se calma)
  await dismiss(page);

  // ── RESULTADO ──
  if (await huboExito(page)) {
    const uuid = await uuidFromPage(page);
    return { uuid, nota: 'CFDI generado en Costco; normalmente también llega por correo al email indicado.' };
  }
  const err2 = await textoError(page);
  return { needs_manual: true, motivo: err2 || (gen ? 'no_se_genero' : 'no_encontre_boton_generar'), form_schema: await snap(page) };
}

// ───────── helpers ─────────
async function setVal(page, sel, val) {
  const el = await page.$(sel); if (!el) return false;
  try { await el.fill(val); return true; } catch { try { await el.evaluate((n, v) => { n.value = v; n.dispatchEvent(new Event('input', { bubbles: true })); n.dispatchEvent(new Event('change', { bubbles: true })); }, val); return true; } catch { return false; } }
}
async function fillIfEmpty(page, sel, val) {
  const el = await page.$(sel); if (!el || !val) return;
  const cur = await el.inputValue().catch(() => '');
  if (!cur || !cur.trim()) await setVal(page, sel, String(val));
}
async function selectSmart(page, sel, val) {
  const el = await page.$(sel); if (!el) return false;
  const code = String(val).match(/[A-Za-z]?\d{2,3}/) ? String(val) : val;
  try { await el.selectOption({ value: code }); return true; } catch {}
  try { await el.selectOption({ label: new RegExp(escapeRe(code), 'i') }); return true; } catch {}
  try { // por opción cuyo texto empiece con el código (ej. "G03 - Gastos en general")
    const ok = await el.evaluate((s, c) => {
      const o = Array.from(s.options).find(o => o.value === c || o.text.trim().toUpperCase().startsWith(c.toUpperCase()));
      if (o) { s.value = o.value; s.dispatchEvent(new Event('change', { bubbles: true })); return true; } return false;
    }, code);
    return ok;
  } catch { return false; }
}
async function clickBtn(page, name) {
  try {
    const b = page.getByRole('button', { name: new RegExp(escapeRe(name), 'i') });
    if (await b.count()) { await b.first().click({ timeout: 6000 }); return true; }
  } catch {}
  const el = await page.$(`button:has-text("${name}"), input[type=submit][value*="${name}" i], input[type=button][value*="${name}" i]`).catch(() => null);
  if (el) { try { await el.click({ timeout: 6000 }); return true; } catch {} }
  return false;
}
async function dismiss(page) {
  for (let i = 0; i < 4; i++) {
    const ok = await page.$('button:has-text("Aceptar"), button:has-text("Ok"), button:has-text("Cerrar"), button:has-text("Entendido")');
    if (!ok) break; try { await ok.click(); } catch {} await page.waitForTimeout(300);
  }
}
async function huboExito(page) {
  const html = (await page.content().catch(() => '')) || '';
  const res = await page.$eval('#result', n => n.value || '').catch(() => '');
  return /(Descargar|comprobante generado|factura generada|se gener[oó]|Folio Fiscal|UUID)/i.test(html) ||
    /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/.test(res);
}
async function textoError(page) {
  const html = (await page.content().catch(() => '')) || '';
  const m = html.match(/(no se encontr[oó][^<.]{0,90}|no coincide[^<.]{0,90}|ya (fue|est[aá]) facturad[oa][^<.]{0,90}|ticket (inv[aá]lido|no v[aá]lido)[^<.]{0,90}|RFC (inv[aá]lido|no v[aá]lido)[^<.]{0,90}|monto[^<.]{0,60}no coincide[^<.]{0,60})/i);
  return m ? m[1].replace(/\s+/g, ' ').trim() : null;
}
async function uuidFromPage(page) {
  const html = (await page.content().catch(() => '')) || '';
  const m = html.match(/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/);
  return m ? m[0] : null;
}
async function snap(page) {
  try {
    return await page.evaluate(() => ({
      titulo: document.title, url: location.href,
      campos: Array.from(document.querySelectorAll('input,select,textarea')).filter(e => e.type !== 'hidden').map(e => ({ id: e.id, name: e.name, tag: e.tagName.toLowerCase() })),
      botones: Array.from(document.querySelectorAll('button,input[type=submit]')).map(b => (b.innerText || b.value || '').trim()).filter(Boolean).slice(0, 20),
    }));
  } catch { return null; }
}
function escapeRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

module.exports = { nombre, matches, facturar };
