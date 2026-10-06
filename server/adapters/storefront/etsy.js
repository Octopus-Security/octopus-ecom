'use strict';
// TODO(M3): Etsy Open API v3 — OAuth2 PKCE, token refresh, listings, receipts.
// Everything about Etsy's endpoints and scopes is assumed, unverified (not read this session);
// verify against developers.etsy.com before M3. Scopes the spec names: listings_r, listings_w,
// transactions_r, shops_r. Must surface a clear "open a shop" message when no shop exists.
const { NotImplemented } = require('../contract');

function createEtsy(/* { http, credentials, keystore, log } */) {
  const ni = n => async () => { throw new NotImplemented(`storefront.etsy.${n} (M3)`); };
  return {
    implemented: false,
    getShop: ni('getShop'), buildAuthUrl: ni('buildAuthUrl'), exchangeCode: ni('exchangeCode'), refreshToken: ni('refreshToken'),
    getListing: ni('getListing'), createListing: ni('createListing'), updateListing: ni('updateListing'), getReceipts: ni('getReceipts'), getListingStats: ni('getListingStats'),
  };
}
module.exports = { createEtsy };
