// Router de adapters. Dos formas de enrutar:
//  1) por DOMINIO de la URL del ticket (F-Ambit y similares que traen liga en el ticket).
//  2) por COMERCIO/RFC emisor (Chedraui y tiendas cuyo ticket NO trae URL; portal fijo).
// Agregar un portal nuevo = agregar su archivo adapter aquí, sin tocar el resto.
const fAmbit = require('./f-ambit');
const chedraui = require('./chedraui');
// const laComer = require('./lacomer');

const ADAPTERS = [fAmbit, chedraui /*, laComer */];

function pickAdapter(url) {
  let host = '';
  try { host = new URL(url).hostname.toLowerCase(); } catch { return null; }
  return ADAPTERS.find(a => typeof a.matches === 'function' && a.matches(host)) || null;
}

// Elige adapter con lo que traiga el ticket: primero por URL, luego por comercio/RFC emisor.
function pickForTicket({ url, comercio, rfc_emisor } = {}) {
  if (url) { const byUrl = pickAdapter(url); if (byUrl) return byUrl; }
  return ADAPTERS.find(a => typeof a.matchesComercio === 'function'
    && a.matchesComercio({ comercio, rfc_emisor })) || null;
}

module.exports = { pickAdapter, pickForTicket, ADAPTERS };
