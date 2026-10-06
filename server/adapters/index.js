'use strict';
/** adapters/index.js — builds all five adapters. Real HTTP always goes through one shared http client. */
const { makeHttp } = require('./http');

function buildAdapters(deps) {
  const http = deps.http || makeHttp({ log: deps.log });
  const d = { ...deps, http };
  return {
    http,
    imagegen: require('./imagegen').create(d),
    pod: require('./pod').create(d),
    storefront: require('./storefront').create(d),
    trend: require('./trend').create(d),
    listingcopy: require('./listingcopy').create(d),
    describe() { return ['imagegen', 'pod', 'storefront', 'trend', 'listingcopy'].map(k => this[k].describe()); },
  };
}
module.exports = { buildAdapters };
