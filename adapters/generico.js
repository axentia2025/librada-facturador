// ─────────────────────────────────────────────────────────────────────────────
// ADAPTER GENÉRICO — el que INTENTA un portal NUEVO por sí solo.
// ─────────────────────────────────────────────────────────────────────────────
// La mayoría de los portales CFDI son el mismo patrón: unos campos (RFC, folio/
// referencia, total, correo), un Uso CFDI (G03) y un botón para generar. Este
// adapter mapea los campos por su etiqueta/placeholder/nombre y lo intenta.
//
// Devuelve SIEMPRE un form_schema (foto del formulario) para que Librada APRENDA
// el portal aunque falle: con eso se documenta y, si hizo falta, lo afinamos.
//
// No sustituye a los adapters de código (f-ambit, mifacturacion…) — esos son las
// recetas afinadas a mano. Éste es el primer intento para lo que aún no conoce.

const nombre = 'generico';

// Palabras clave por campo (es-MX). Se prueban contra label+placeholder+name+id.
const CLAVES = {
  rfc:        [/\brfc\b/i, /r\.f\.c/i, /registro federal/i],
  referencia: [/referen/i, /folio/i, /ticket/i, /transacc/i, /web ?id/i, /n[uú]mero de (nota|ticket|factura)/i, /consecutivo/i],
  total:      [/total/i, /monto/i, /importe/i, /\$\s*$/],
  correo:     [/correo/i, /e-?mail/i, /@/],
};

async function facturar(page, { url, ticket, receptor }) {
  if (!/^https?:/i.test(page.url())) {
    await page.goto(url, { waitUntil: 'domcontentloaded' }).catch(() => {});
  }
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  // Muchos portales (ej. Costco) renderizan el formulario con JavaScript UNOS SEGUNDOS DESPUÉS.
  // Esperamos a que aparezca un campo de texto real (o a que la red se calme) antes de mirar/llenar,
  // si no capturaríamos 0 campos. Damos un respiro extra para que termine de pintar.
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForSelector(
    'input:not([type=hidden]):not([type=submit]):not([type=button]), textarea',
    { timeout: 15000 }
  ).catch(() => {});
  await page.waitForTimeout(1500);

  // Si hay captcha de imagen, el orquestador lo resuelve con el servicio (2Captcha).
  // (reCAPTCHA v2/invisible aún no se auto-resuelve → se marca para revisión.)
  if (await page.$('iframe[src*="recaptcha"], .g-recaptcha')) {
    const form_schema = await captureForm(page);
    return { needs_manual: true, motivo: 'recaptcha', form_schema };
  }

  const valores = {
    rfc: String(receptor.rfc || ''),
    referencia: String(ticket.referencia || ticket.ticket_id || ticket.folio || ''),
    total: String(ticket.monto ?? ''),
    correo: String(receptor.email || ''),
  };

  // ── 1) Llenar los campos de texto que reconozcamos ──
  const rellenados = {};
  const campos = await page.$$('input:not([type=hidden]):not([type=radio]):not([type=checkbox]):not([type=submit]):not([type=button]), textarea');
  for (const el of campos) {
    const meta = await fieldMeta(el);
    const clave = clasificar(meta);
    if (clave && valores[clave] && !rellenados[clave]) {
      await el.fill(valores[clave]).catch(() => {});
      rellenados[clave] = true;
    }
  }

  // ── 2) Uso CFDI = G03 (select, radio o label) ──
  await elegirUsoCFDI(page, receptor.uso_cfdi || 'G03');

  // ── 3) Avanzar por los botones típicos, en orden, hasta llegar a un resultado ──
  const secuencia = ['Buscar', 'Continuar', 'Siguiente', 'Facturar', 'Generar', 'Aceptar'];
  for (const nombreBtn of secuencia) {
    const hecho = await clickBtn(page, nombreBtn);
    if (hecho) {
      await page.waitForLoadState('networkidle').catch(() => {});
      await page.waitForTimeout(600);
      // ¿el portal pidió más datos que ya tenemos? re-llenamos correo/G03 en la 2ª pantalla
      await rellenarCorreoSiFalta(page, valores.correo);
      await elegirUsoCFDI(page, receptor.uso_cfdi || 'G03');
      if (await hayError(page)) break;
      if (await huboExito(page)) break;
    }
  }

  const form_schema = await captureForm(page);

  // ── 4) ¿Se generó? ──
  if (await huboExito(page)) {
    const finalUrl = page.url();
    const folio = (finalUrl.match(/folio=([^;&]+)/i) || [])[1] || null;
    const receta = { patron: 'cfdi_estandar', campos: Object.keys(rellenados), secuencia };
    return { ok: true, folio, receta, form_schema,
      nota: 'Portal resuelto por el adapter genérico; CFDI normalmente también llega por correo.' };
  }

  const err = await textoError(page);
  return { needs_manual: true, motivo: err || 'no_se_genero', form_schema };
}

// ───────── captura del formulario (para APRENDER el portal) ─────────
async function captureForm(page) {
  try {
    return await page.evaluate(() => {
      const txt = (s) => (s || '').replace(/\s+/g, ' ').trim().slice(0, 90);
      const labelDe = (el) => {
        if (el.id) { const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`); if (l) return txt(l.innerText); }
        const w = el.closest('label'); if (w) return txt(w.innerText);
        return txt(el.getAttribute('placeholder') || el.getAttribute('aria-label') || el.name || '');
      };
      const campos = Array.from(document.querySelectorAll('input,textarea,select'))
        .filter((el) => el.type !== 'hidden')
        .map((el) => ({
          tag: el.tagName.toLowerCase(), type: el.type || null, name: el.name || null, id: el.id || null,
          placeholder: el.placeholder || null, label: labelDe(el),
          opciones: el.tagName === 'SELECT' ? Array.from(el.options).map((o) => txt(o.text)).slice(0, 40) : undefined,
        }));
      const botones = Array.from(document.querySelectorAll('button,input[type=submit],input[type=button],a[role=button],a.btn'))
        .map((b) => txt(b.innerText || b.value)).filter(Boolean).slice(0, 30);
      return { titulo: document.title, url: location.href, campos, botones };
    });
  } catch { return null; }
}

// ───────── helpers ─────────
async function fieldMeta(el) {
  const [name, id, ph, aria] = await Promise.all([
    el.getAttribute('name').catch(() => ''), el.getAttribute('id').catch(() => ''),
    el.getAttribute('placeholder').catch(() => ''), el.getAttribute('aria-label').catch(() => ''),
  ]);
  let label = '';
  try {
    label = await el.evaluate((node) => {
      if (node.id) { const l = document.querySelector(`label[for="${CSS.escape(node.id)}"]`); if (l) return l.innerText; }
      const w = node.closest('label'); return w ? w.innerText : '';
    });
  } catch {}
  return [label, ph, aria, name, id].filter(Boolean).join(' ').toLowerCase();
}
function clasificar(meta) {
  for (const [clave, pats] of Object.entries(CLAVES)) {
    if (pats.some((re) => re.test(meta))) return clave;
  }
  return null;
}
async function rellenarCorreoSiFalta(page, correo) {
  if (!correo) return;
  const els = await page.$$('input:not([type=hidden])');
  for (const el of els) {
    const t = await el.getAttribute('type').catch(() => '');
    const meta = await fieldMeta(el);
    const v = await el.inputValue().catch(() => '');
    if ((t === 'email' || /correo|e-?mail|@/.test(meta) || (v && v.includes('@'))) && v !== correo) {
      await el.fill(correo).catch(() => {}); return;
    }
  }
}
async function elegirUsoCFDI(page, uso) {
  // 1) select cuyo option contenga G03
  for (const sel of await page.$$('select')) {
    const has = await sel.$(`option:has-text("${uso}")`).catch(() => null);
    if (has) { try { await sel.selectOption({ label: new RegExp(uso, 'i') }); return; } catch {} }
  }
  // 2) radio value G03
  const radio = await page.$(`input[type="radio"][value*="${uso}" i]`).catch(() => null);
  if (radio) { await radio.check().catch(() => {}); return; }
  // 3) label con el texto
  const lbl = await page.$(`label:has-text("${uso}")`).catch(() => null);
  if (lbl) { await lbl.click().catch(() => {}); }
}
async function clickBtn(page, name) {
  try {
    const b = page.getByRole('button', { name: new RegExp(name, 'i') });
    if (await b.count()) { await b.first().click({ timeout: 5000 }); return true; }
  } catch {}
  const el = await page.$(`button:has-text("${name}"), input[type=submit][value*="${name}" i], a:has-text("${name}")`).catch(() => null);
  if (el) { try { await el.click({ timeout: 5000 }); return true; } catch {} }
  return false;
}
async function huboExito(page) {
  if (/folio=/i.test(page.url())) return true;
  const html = (await page.content().catch(() => '')) || '';
  return /(Descargar factura|Reclamo Exitoso|Factura generada|comprobante generado|Descargar (PDF|XML)|UUID)/i.test(html);
}
async function hayError(page) { return Boolean(await textoError(page)); }
async function textoError(page) {
  const html = (await page.content().catch(() => '')) || '';
  const m = html.match(/(No se encontr[oó][^<.]{0,80}|no coincide[^<.]{0,80}|no est[aá] permitid[oa][^<.]{0,80}|RFC (inv[aá]lido|no v[aá]lido)[^<.]{0,80}|ya (fue|est[aá]) facturad[oa][^<.]{0,80})/i);
  return m ? m[1].replace(/\s+/g, ' ').trim() : null;
}

module.exports = { nombre, facturar, captureForm };
