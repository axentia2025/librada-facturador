// Router de adapters. Dos formas de enrutar:
//  1) por DOMINIO de la URL del ticket (F-Ambit y similares que traen liga en el ticket).
//  2) por COMERCIO/RFC emisor (Chedraui y tiendas cuyo ticket NO trae URL; portal fijo).
// Agregar un portal nuevo = agregar su archivo adapter aquí, sin tocar el resto.
const fAmbit = require('./f-ambit');
const mifacturacion = require('./mifacturacion');
const chedraui = require('./chedraui');
const generico = require('./generico'); // intento para portales NUEVOS (no va en ADAPTERS: no matchea por host)
// const laComer = require('./lacomer');

const ADAPTERS = [fAmbit, mifacturacion, chedraui /*, laComer */];

// Busca un adapter de código por su `nombre` (lo que guarda la memoria en la columna `adapter`).
function adapterByName(name) {
  return ADAPTERS.find(a => a.nombre === name) || null;
}

function pickAdapter(url) {
  let host = '';
  try { host = new URL(url).hostname.toLowerCase(); } catch { return null; }
  return pickByHost(host);
}

// Elige adapter por HOST (útil para el host FINAL tras seguir redirects: muchos comercios
// tienen una URL vanidosa que redirige a una plataforma compartida, ej. giornale.mx → mifacturacion.mx).
function pickByHost(host) {
  host = String(host || '').toLowerCase();
  return ADAPTERS.find(a => typeof a.matches === 'function' && a.matches(host)) || null;
}

// Elige adapter con lo que traiga el ticket: primero por URL, luego por comercio/RFC emisor.
function pickForTicket({ url, comercio, rfc_emisor } = {}) {
  if (url) { const byUrl = pickAdapter(url); if (byUrl) return byUrl; }
  return ADAPTERS.find(a => typeof a.matchesComercio === 'function'
    && a.matchesComercio({ comercio, rfc_emisor })) || null;
}

module.exports = { pickAdapter, pickByHost, pickForTicket, adapterByName, generico, ADAPTERS };
