// ─────────────────────────────────────────────────────────────────────────────
// MEMORIA DE PORTALES — conector a Supabase (tabla librada_facturacion_portales)
// ─────────────────────────────────────────────────────────────────────────────
// Es el "cerebro" compartido de Librada: sabe en qué portales ya aprendió a
// facturar y cómo. Cada facturación (éxito o fallo) se registra aquí para que
// el modelo crezca solo y multi-URL.
//
// Env (Easypanel): SUPABASE_URL, SUPABASE_KEY (service_role). Si faltan, el
// facturador sigue operando con los adapters de código (degradación limpia).

const SB_URL = process.env.SUPABASE_URL || '';
const SB_KEY = process.env.SUPABASE_KEY || '';
const ready = () => Boolean(SB_URL && SB_KEY);
const h = () => ({ apikey: SB_KEY, Authorization: 'Bearer ' + SB_KEY, 'Content-Type': 'application/json' });

// Busca lo que Librada ya sabe de un host (el FINAL, tras redirects).
async function lookupPortal(host) {
  if (!ready() || !host) return null;
  const u = `${SB_URL}/rest/v1/librada_facturacion_portales?host=eq.${encodeURIComponent(host)}&select=*`;
  try {
    const r = await fetch(u, { headers: h() });
    if (!r.ok) return null;
    const rows = await r.json();
    return rows[0] || null;
  } catch { return null; }
}

// Registra el resultado y APRENDE portales nuevos (upsert atómico vía RPC).
async function registrar({ host, ok, plataforma, comercio, error, form_schema }) {
  if (!ready() || !host) return;
  try {
    await fetch(`${SB_URL}/rest/v1/rpc/librada_portal_registrar`, {
      method: 'POST', headers: h(),
      body: JSON.stringify({
        p_host: host, p_ok: !!ok,
        p_plataforma: plataforma || null, p_comercio: comercio || null,
        p_error: error || null, p_form_schema: form_schema || null,
      }),
    });
  } catch { /* la memoria nunca debe tumbar la facturación */ }
}

// Guarda la RECETA aprendida de un portal (cuando quedó resuelto al 100%),
// y opcionalmente los campos_extra que ese portal pide por WhatsApp.
async function guardarReceta(host, { receta, campos_extra, plataforma } = {}) {
  if (!ready() || !host) return;
  const patch = { tipo: 'receta', estado: 'activo' };
  if (receta) patch.receta = receta;
  if (campos_extra) patch.campos_extra = campos_extra;
  if (plataforma) patch.plataforma = plataforma;
  try {
    await fetch(`${SB_URL}/rest/v1/librada_facturacion_portales?host=eq.${encodeURIComponent(host)}`, {
      method: 'PATCH', headers: { ...h(), Prefer: 'return=minimal' }, body: JSON.stringify(patch),
    });
  } catch {}
}

module.exports = { lookupPortal, registrar, guardarReceta, ready };
