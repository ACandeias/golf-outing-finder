/**
 * Ads and analytics vars the e2e server runs with (tests/e2e/global-setup.ts), so
 * slots, the consent bootstrap and /ads.txt render as they will in production.
 * The fixtures abort every cross-origin request, so no Google script ever loads;
 * cls.spec.ts serves a stub in its place.
 */
export const E2E_ADSENSE_CLIENT = "ca-pub-0000000000000000";
export const E2E_ADSENSE_SLOT_LIST = "1111111111";
export const E2E_ADSENSE_SLOT_OUTING = "2222222222";
export const E2E_ADSENSE_SLOT_SIDEBAR = "3333333333";
export const E2E_GA4_ID = "G-E2ETEST000";
export const ADSENSE_SCRIPT_URL = `https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${E2E_ADSENSE_CLIENT}`;
