// ─────────────────────────────────────────────────────────────────────────────
// RESOLVEDOR DE CAPTCHA — 2Captcha (image/normal captcha, 6 chars)
// ─────────────────────────────────────────────────────────────────────────────
// Contrato: solveCaptcha(imageBase64) -> Promise<string>  (el texto del captcha)
//   - entrada: PNG en base64 (data URI "data:image/png;base64,...." o base64 puro).
//   - salida:  el código que se escribe en el campo (ej. "GOJQHC").
//
// Config (.env):
//   CAPTCHA_PROVIDER=2captcha        (por ahora solo 2captcha; swappable)
//   CAPTCHA_API_KEY=<tu api key de 2captcha>
//
// Costo referencia 2Captcha: ~$0.5–1 USD / 1000 captchas de imagen.
// Docs: https://2captcha.com/2captcha-api
//
// Uso desde el orquestador (server/adapter):
//   const { solveCaptcha } = require('./captcha-solver');
//   let r = await adapter.facturar(page, { url, ticket, receptor });
//   if (r.needs_manual && r.motivo === 'captcha_requerido') {
//     const code = await solveCaptcha(r.captcha_img);
//     r = await adapter.facturar(page, { url, ticket, receptor, captcha: code });
//   }

const API_KEY = process.env.CAPTCHA_API_KEY || '';
const IN_URL = 'https://2captcha.com/in.php';
const RES_URL = 'https://2captcha.com/res.php';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Quita el prefijo data-URI si viene incluido.
function toBase64(img) {
  const s = String(img || '');
  const i = s.indexOf('base64,');
  return i >= 0 ? s.slice(i + 7) : s;
}

async function solveCaptcha(imageBase64) {
  if (!API_KEY) {
    throw new Error('CAPTCHA_API_KEY no configurada (.env). Alta una cuenta en 2captcha, pon la llave y reintenta.');
  }
  const body = toBase64(imageBase64);

  // 1) Enviar el captcha
  const form = new URLSearchParams({ key: API_KEY, method: 'base64', body, json: '1' });
  const inRes = await fetch(IN_URL, { method: 'POST', body: form });
  const inJson = await inRes.json();
  if (inJson.status !== 1) {
    throw new Error('2captcha in.php: ' + (inJson.request || 'error'));
  }
  const id = inJson.request;

  // 2) Esperar y sondear el resultado (máx ~2 min)
  const deadline = Date.now() + 120000;
  await sleep(8000); // el reconocimiento tarda ~5-15s
  while (Date.now() < deadline) {
    const q = new URLSearchParams({ key: API_KEY, action: 'get', id, json: '1' });
    const r = await fetch(`${RES_URL}?${q.toString()}`);
    const j = await r.json();
    if (j.status === 1) return String(j.request).trim();
    if (j.request !== 'CAPCHA_NOT_READY') {
      throw new Error('2captcha res.php: ' + j.request);
    }
    await sleep(5000);
  }
  throw new Error('2captcha: timeout esperando el código');
}

module.exports = { solveCaptcha };
