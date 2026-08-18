// Librada · Facturador — microservicio de auto-facturación por portal.
// n8n le manda el ticket + datos del receptor; él corre el adapter de la plataforma y
// devuelve el CFDI (uuid, pdf, xml). Reutilizable para TODOS los clientes (sólo cambia el receptor).
//
// AUTO-CONSTRUCCIÓN (el diferenciador): cada facturación consulta y actualiza la MEMORIA
// compartida (Supabase · librada_facturacion_portales). Portales conocidos → adapter afinado;
// portales nuevos → el adapter genérico lo INTENTA y se aprende para el siguiente cliente.
const express = require('express');
// Playwright se carga de forma PEREZOSA dentro de /facturar (no al arrancar).
// Así el servidor HTTP siempre levanta y responde /health aunque Playwright/Chromium
// tuvieran un problema de carga (evita que un require nativo tumbe el contenedor sin logs).
const { pickByHost, adapterByName, generico } = require('./adapters');
const registry = require('./registry');
const { spawn, spawnSync } = require('child_process');

// ── PANTALLA VIRTUAL (Xvfb) — best-effort, para correr Chromium en modo con-pantalla ──
// Portales legacy (ASP.NET: Chedraui/Masteredi) NO completan el paso final de generación en
// headless, pero sí con una pantalla real (aunque sea virtual). Levantamos Xvfb aquí; si no
// existe o falla, seguimos en headless — el arranque del servicio JAMÁS depende de esto.
function iniciarPantallaVirtual() {
  if (process.env.DISPLAY) return true;
  try {
    if (spawnSync('which', ['Xvfb']).status !== 0) return false;
    const x = spawn('Xvfb', [':99', '-screen', '0', '1366x768x24', '-ac', '-nolisten', 'tcp'],
      { stdio: 'ignore', detached: true });
    x.unref();
    process.env.DISPLAY = ':99';
    spawnSync('sleep', ['2']); // darle un momento a Xvfb para levantar antes del primer launch
    return true;
  } catch { return false; }
}
const HAY_PANTALLA = iniciarPantallaVirtual();
console.log('Librada facturador · pantalla virtual (Xvfb):', HAY_PANTALLA ? 'ACTIVA (headed)' : 'no disponible (headless)');

const app = express();
app.use(express.json({ limit: '4mb' }));

// POST /facturar
// body: { url, ticket:{ticket_id|folio|referencia, sucursal?, monto, fecha, rfc_emisor, comercio?},
//         receptor:{rfc, nombre, cp, regimen, uso_cfdi, email} }
app.post('/facturar', async (req, res) => {
  const { url, ticket, receptor } = req.body || {};
  if (!url || !ticket || !receptor)
    return res.status(400).json({ ok: false, error: 'faltan url, ticket o receptor' });

  const comercio = ticket.comercio || null;
  // La visión suele extraer la URL sin protocolo (ej. "www3.cesco.com.mx/facturacion").
  // Playwright exige http(s):// → lo anteponemos.
  let target = String(url || '').trim();
  if (target && !/^https?:\/\//i.test(target)) target = 'https://' + target;

  const { chromium } = require('playwright'); // lazy: solo cuando de verdad vamos a facturar
  // MODO SIGILO: algunos portales (Costco y otros grandes retailers) no renderizan el formulario
  // si detectan un navegador automatizado. Lanzamos con args + user-agent reales y ocultamos
  // las señales típicas de automatización (navigator.webdriver, etc.).
  // MODO CON-PANTALLA (headed) sobre la pantalla virtual (Xvfb). Portales legacy no completan
  // el paso final en headless; con pantalla real (aunque virtual) se comportan como Chrome normal.
  // Si el launch con-pantalla fallara, caemos a headless para no dejar sin servicio a los demás.
  const ARGS = ['--disable-blink-features=AutomationControlled', '--no-sandbox',
                '--disable-dev-shm-usage', '--disable-gpu'];
  let browser;
  try {
    browser = await chromium.launch({ headless: !HAY_PANTALLA, args: ARGS });
  } catch (e) {
    console.log('launch con-pantalla falló, reintentando headless:', String(e.message || e));
    browser = await chromium.launch({ headless: true, args: ARGS });
  }
  let finalHost = '';
  try {
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      viewport: { width: 1366, height: 768 },
      locale: 'es-MX',
      timezoneId: 'America/Mexico_City',
    });
    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      Object.defineProperty(navigator, 'languages', { get: () => ['es-MX', 'es'] });
      Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
    });
    const page = await context.newPage();
    page.setDefaultTimeout(12000); // cada operación de Playwright se acota (evita esperas de 30s que se acumulan)
    // Muchos portales ASP.NET muestran validaciones/errores con alert()/confirm() de JS, que
    // BLOQUEAN a Playwright si no se manejan. Los aceptamos y guardamos el último mensaje.
    page._lastDialog = null;
    page.on('dialog', async (d) => { page._lastDialog = d.message(); try { await d.accept(); } catch {} });

    // Navegamos primero para RESOLVER redirects (muchos comercios tienen URL vanidosa que
    // redirige a una plataforma compartida, ej. giornale.mx → cfdi40.mifacturacion.mx).
    await page.goto(target, { waitUntil: 'domcontentloaded' }).catch(() => {});
    try { finalHost = new URL(page.url()).hostname.toLowerCase(); } catch {}

    // ── Consultar la MEMORIA: ¿ya sabemos facturar en este host? ──
    const memoria = await registry.lookupPortal(finalHost);

    // Elegir cómo facturar:
    //  1) memoria dice adapter de código → úsalo   2) hay adapter que matchea host → úsalo
    //  3) desconocido → adapter GENÉRICO (lo intenta y lo aprendemos)
    let adapter = null;
    if (memoria && memoria.tipo === 'adapter' && memoria.adapter) adapter = adapterByName(memoria.adapter);
    if (!adapter) adapter = pickByHost(finalHost);
    const esNuevo = !adapter;
    if (!adapter) adapter = generico;

    // CANDADO DE TIEMPO DURO: ningún portal puede colgar la petición más de 90s.
    // Si se pasa (página pesada/anti-bot/modales que atoran) → se aborta y se escala limpio.
    const result = await Promise.race([
      adapter.facturar(page, { url: target, ticket, receptor }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout_portal_90s')), 90000)),
    ]);
    const ok = !(result && result.needs_manual);

    // ── APRENDER: registrar el resultado en la memoria (crea el host si es nuevo) ──
    await registry.registrar({
      host: finalHost, ok, comercio,
      plataforma: memoria?.plataforma || (esNuevo ? undefined : adapter.nombre),
      error: ok ? null : (result?.motivo || result?.error || 'no_se_genero'),
      form_schema: result?.form_schema || null,
    });
    // Si el genérico resolvió un portal nuevo al 100%, guarda su receta (queda 'aprendido').
    if (ok && esNuevo && result?.receta) {
      await registry.guardarReceta(finalHost, { receta: result.receta, plataforma: comercio || undefined });
    }

    if (!ok) {
      // No pudo: Librada se disculpa con el cliente y escala un RESUMEN a servicio@ (n8n lo maneja).
      return res.json({
        ok: false, plataforma: adapter.nombre, dominio: finalHost, comercio,
        needs_manual: true, motivo: result?.motivo || result?.error || 'no_se_genero',
        aprendido: esNuevo, // portal nuevo capturado en memoria para que tú y Omar lo afinen
        mensaje_cliente: 'Estoy tramitando tu factura; este comercio tiene un portal que aún estoy '
          + 'aprendiendo. Lo dejo resuelto en las próximas horas y te aviso en cuanto esté lista.',
      });
    }
    return res.json({ ok: true, plataforma: adapter.nombre, dominio: finalHost, ...result });
  } catch (e) {
    await registry.registrar({ host: finalHost, ok: false, comercio: (ticket && ticket.comercio) || null, error: String(e.message || e) });
    return res.json({
      ok: false, dominio: finalHost, needs_manual: true, error: String(e.message || e),
      mensaje_cliente: 'Tuve un problema al generar tu factura. La dejo resuelta en las próximas horas y te aviso.',
    });
  } finally {
    await browser.close();
  }
});

app.get('/health', (_req, res) => res.json({ ok: true, service: 'librada-facturador' }));
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log('Librada facturador escuchando en :' + PORT));
