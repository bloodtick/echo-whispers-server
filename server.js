// server.js
// Echo Whispers
//
// Single-file Express server for Alexa cookie login, refresh, direct REST speak,
// and Hubitat Echo Speaks compatibility.
//
// Notes:
// - Persistent config is stored in CONFIG_FILE, default ./config.json.
// - UI images are served from ./images.
// - Amazon device registration name is stored/displayed as config.deviceName.
// - deviceCreated gates destructive auth actions such as Clear Login and Refresh Cookie.

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { URL } = require('url');
const express = require('express');
const bodyParser = require('body-parser');
const https = require('https');
const http = require('http');
const AlexaRemote = require('alexa-remote2');

let AlexaCookie;
try {
  AlexaCookie = require('alexa-cookie2');
} catch (err) {
  AlexaCookie = require('alexa-remote2/node_modules/alexa-cookie2');
}

const app = express();
const STATIC_IMAGES_DIR = path.join(__dirname, 'images');
app.use('/images', express.static(STATIC_IMAGES_DIR));
const PORT = Number(process.env.PORT || 8585);
const DEFAULT_PROXY_PORT = PORT + 1;
const APP_VERSION = '1.0.0';
const APP_AUTHOR = 'Bloodtick Jones';
const APP_COPYRIGHT = `© 2026 ${APP_AUTHOR}`;
const COLOR_DARK_BLUE = '#1A77C9';

const LEGACY_DEFAULT_PORT = 8092;
const LEGACY_DEFAULT_PROXY_PORT = LEGACY_DEFAULT_PORT + 1;
const CONFIG_FILE = process.env.CONFIG_FILE || path.join(__dirname, 'config.json');

const DEFAULT_ECHO_SPEAKS_VERSION = '2.8.0';
const APP_NAME = 'Echo Whispers';
const REQUEST_TIMEOUT_MS = 15000;
const MAX_DEBUG_RESPONSE_CHARS = 2000;


let alexa = new AlexaRemote();
let config = loadConfig();
let isInitialized = false;
let isInitializing = false;
let isLoginProxyRunning = false;
let lastError = null;
let lastInitAt = null;
let devicesCache = [];
let defaultDevice = null;

let lastCapturedRegistrationDeviceName = '';

function captureRegistrationDeviceNameFromLog(args) {
  const text = args.map(a => (typeof a === 'string' ? a : '')).join(' ');
  const marker = 'Register App Response:';
  const idx = text.indexOf(marker);
  if (idx < 0) return;

  const jsonText = text.slice(idx + marker.length).trim();
  if (!jsonText || jsonText[0] !== '{') return;

  const parsed = JSON.parse(jsonText);
  const name =
    parsed &&
    parsed.response &&
    parsed.response.success &&
    parsed.response.success.extensions &&
    parsed.response.success.extensions.device_info &&
    parsed.response.success.extensions.device_info.device_name;

  if (name) {
    lastCapturedRegistrationDeviceName = String(name);
  }
}

const originalConsoleLog = console.log.bind(console);
console.log = (...args) => {
  try {
    captureRegistrationDeviceNameFromLog(args);
  } catch (err) {
    // Do not let log parsing affect normal operation.
  }
  originalConsoleLog(...args);
};


app.use(bodyParser.json({ limit: '2mb' }));
app.use(bodyParser.urlencoded({ extended: true }));

function defaultConfig() {
  return {
    port: PORT,
    deviceAppName: 'Echo Whispers',
    amazonPage: process.env.AMAZON_PAGE || 'amazon.com',
    acceptLanguage: process.env.ACCEPT_LANGUAGE || 'en-US,en;q=0.9',
    alexaServiceHost: process.env.ALEXA_SERVICE_HOST || 'pitangui.amazon.com',
    amazonPageProxyLanguage: process.env.AMAZON_PAGE_PROXY_LANGUAGE || 'en_US',
    proxyPort: Number(process.env.PROXY_PORT || DEFAULT_PROXY_PORT),
    proxyOwnIp: process.env.PROXY_OWN_IP || 'localhost',
    proxyListenBind: process.env.PROXY_LISTEN_BIND || '0.0.0.0',
    refreshToken: process.env.REFRESH_TOKEN || '',
    cookie: '',
    localCookie: '',
    loginCookie: '',
    csrf: '',
    macDms: null,
    registrationData: null,
    deviceName: '',
    tokenDate: null,
    deviceCreated: null,
    cookieCreated: null,
    cookieTtlSeconds: null,
    cookieExpires: null,
    apiKey: process.env.API_KEY || '',
    hubitatCompatEnabled: false,
    hubitatCallbackUrl: '',
    hubitatServerUrl: '',
    echoSpeaksVersion: DEFAULT_ECHO_SPEAKS_VERSION,
    hubitatLastSyncAt: null,
    hubitatLastSyncStatus: null,
    hubitatLastSyncError: null,
    hubitatLastAction: null,
    hubitatLastEndpoint: null,
    hubitatLastResponseStatusCode: null,
    hubitatLastResponseBody: null
  };
}


function cloneJson(value) {
  if (!value || typeof value !== 'object') return value;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch (err) {
    return Object.assign({}, value);
  }
}

function getRegistrationMaterial(value) {
  if (!value || typeof value !== 'object') return null;

  const direct = value.device_private_key && value.adp_token
    ? value
    : null;

  const nested = value.macDms && typeof value.macDms === 'object' &&
    value.macDms.device_private_key && value.macDms.adp_token
    ? value.macDms
    : null;

  const source = direct || nested;
  if (!source) return null;

  return {
    device_private_key: source.device_private_key,
    adp_token: source.adp_token
  };
}

function cleanRegistrationData(value) {
  if (!value || typeof value !== 'object') return null;

  const material = getRegistrationMaterial(value);
  if (!material) return null;

  // Keep the full object. Reusing only device_private_key/adp_token can still
  // make Amazon/alexa-cookie2 treat the next login like a new device.
  const cleaned = cloneJson(value);
  if (!cleaned.macDms) cleaned.macDms = material;

  return cleaned;
}

function cleanAuthRegistrationFields(obj) {
  if (!obj || typeof obj !== 'object') return obj;

  const cleanedRegistration =
    cleanRegistrationData(obj.registrationData) ||
    cleanRegistrationData(obj.macDms);

  const material =
    getRegistrationMaterial(obj.macDms) ||
    getRegistrationMaterial(cleanedRegistration);

  if (cleanedRegistration) {
    obj.registrationData = cleanedRegistration;
  } else if ('registrationData' in obj) {
    obj.registrationData = null;
  }

  if (material) {
    obj.macDms = material;
  } else if ('macDms' in obj) {
    obj.macDms = null;
  }

  return obj;
}

function cleanupStoredRegistrationDataIfNeeded() {
  const cleanedRegistration =
    cleanRegistrationData(config.registrationData) ||
    cleanRegistrationData(config.macDms);

  const material =
    getRegistrationMaterial(config.macDms) ||
    getRegistrationMaterial(cleanedRegistration);

  if (!cleanedRegistration && !material) return false;

  const patch = {};
  if (cleanedRegistration) patch.registrationData = cleanedRegistration;
  if (material) patch.macDms = material;

  const currentRegistration = JSON.stringify(config.registrationData || null);
  const nextRegistration = JSON.stringify(patch.registrationData || null);
  const currentMac = JSON.stringify(config.macDms || null);
  const nextMac = JSON.stringify(patch.macDms || null);

  if (currentRegistration === nextRegistration && currentMac === nextMac) return false;

  saveConfig(patch);
  console.log('[CONFIG] normalized registrationData/macDms while preserving full registrationData');

  return true;
}


function normalizeConfig(cfg) {
  const d = defaultConfig();
  const out = Object.assign({}, d, cfg || {});

  // Migrate old config.json key to the new clearer name.
  if (!out.registrationData && cfg && cfg['formerRegistrationData']) {
    out.registrationData = cfg['formerRegistrationData'];
  }
  if (Object.prototype.hasOwnProperty.call(out, 'formerRegistrationData')) {
    delete out.formerRegistrationData;
  }


  if (!process.env.PORT && Number(out.port) === LEGACY_DEFAULT_PORT && PORT !== LEGACY_DEFAULT_PORT) {
    out.port = PORT;
  }

  out.amazonPage = out.amazonPage || d.amazonPage;
  out.acceptLanguage = out.acceptLanguage || d.acceptLanguage;
  out.alexaServiceHost = out.alexaServiceHost || d.alexaServiceHost;
  out.amazonPageProxyLanguage = out.amazonPageProxyLanguage || d.amazonPageProxyLanguage;
  out.proxyPort = Number(out.proxyPort || DEFAULT_PROXY_PORT);
  if (!process.env.PROXY_PORT && Number(out.proxyPort) === LEGACY_DEFAULT_PROXY_PORT && DEFAULT_PROXY_PORT !== LEGACY_DEFAULT_PROXY_PORT) {
    out.proxyPort = DEFAULT_PROXY_PORT;
  }
  out.proxyOwnIp = out.proxyOwnIp || d.proxyOwnIp;
  out.proxyListenBind = out.proxyListenBind || d.proxyListenBind;

  if (!out.cookie && out.localCookie) out.cookie = out.localCookie;
  if (!out.cookie && out.loginCookie) out.cookie = out.loginCookie;

  // Preserve both names. alexa-cookie2/alexa-remote2 may return either.
  if (!out.registrationData && out.formerRegistrationData) out.registrationData = out.formerRegistrationData;
  delete out.formerRegistrationData;

  if (!out.macDms && out.registrationData) out.macDms = getRegistrationMaterial(out.registrationData) || out.registrationData;
  if (!out.registrationData && out.macDms) out.registrationData = out.macDms;

  cleanAuthRegistrationFields(out);
  out.deviceAppName = String(out.deviceAppName || 'Echo Whispers').trim() || 'Echo Whispers';
  if (out.deviceAppName === 'Alexa Speaks') out.deviceAppName = 'Echo Whispers';

  out.hubitatCompatEnabled = out.hubitatCompatEnabled === true || String(out.hubitatCompatEnabled).toLowerCase() === 'true';
  out.hubitatCallbackUrl = asTrimmedString(out.hubitatCallbackUrl);
  out.hubitatServerUrl = asTrimmedString(out.hubitatServerUrl);
  out.echoSpeaksVersion = asTrimmedString(out.echoSpeaksVersion, DEFAULT_ECHO_SPEAKS_VERSION);

  return out;
}

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      return normalizeConfig(JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')));
    }
  } catch (err) {
    console.error('[CONFIG] load error:', err);
  }
  return normalizeConfig({});
}

function firstNonEmpty(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && String(value).trim() !== '') {
      return value;
    }
  }
  return '';
}

function normalizeRefreshResult(result) {
  result = result || {};
  const cookieData = result.cookieData || {};

  const refreshedCookie = firstNonEmpty(
    result.localCookie,
    result.cookie,
    cookieData.localCookie,
    cookieData.cookie
  );

  const refreshedLoginCookie = firstNonEmpty(
    result.loginCookie,
    cookieData.loginCookie,
    refreshedCookie
  );

  const refreshedCsrf = firstNonEmpty(
    result.csrf,
    cookieData.csrf,
    extractCsrf(refreshedCookie),
    extractCsrf(refreshedLoginCookie)
  );

  const refreshedRefreshToken = firstNonEmpty(
    result.refreshToken,
    result.refresh_token,
    cookieData.refreshToken,
    cookieData.refresh_token,
    config.refreshToken
  );

  const refreshedMacDms = firstNonEmpty(
    result.macDms,
    result.registrationData,
    cookieData.macDms,
    cookieData.registrationData,
    config.macDms,
    config.registrationData
  );

  const now = new Date().toISOString();
  const ttlSeconds = Number(firstNonEmpty(
    result.cookieTtlSeconds,
    result.website_cookies_ttl,
    cookieData.cookieTtlSeconds,
    config.cookieTtlSeconds,
    2592000
  ));

  const cookieCreated = firstNonEmpty(result.cookieCreated, cookieData.cookieCreated, now);
  const cookieExpires = firstNonEmpty(
    result.cookieExpires,
    cookieData.cookieExpires,
    Number.isFinite(ttlSeconds) && ttlSeconds > 0
      ? new Date(Date.now() + ttlSeconds * 1000).toISOString()
      : config.cookieExpires
  );

  const patch = {
    cookie: refreshedCookie,
    localCookie: refreshedCookie,
    loginCookie: refreshedLoginCookie,
    csrf: refreshedCsrf,
    refreshToken: refreshedRefreshToken,
    macDms: refreshedMacDms,
    registrationData: refreshedMacDms,
    tokenDate: firstNonEmpty(result.tokenDate, cookieData.tokenDate, Date.now()),
    frc: firstNonEmpty(result.frc, cookieData.frc, config.frc),
    'map-md': firstNonEmpty(result['map-md'], result.mapMd, cookieData['map-md'], config['map-md']),
    deviceId: firstNonEmpty(result.deviceId, cookieData.deviceId, config.deviceId),
    deviceSerial: firstNonEmpty(result.deviceSerial, cookieData.deviceSerial, config.deviceSerial),
    deviceName: firstNonEmpty(lastCapturedRegistrationDeviceName, result.deviceName, result.device_name, cookieData.deviceName, config.deviceName),
    dataVersion: firstNonEmpty(result.dataVersion, cookieData.dataVersion, config.dataVersion),
    cookieCreated,
    cookieTtlSeconds: Number.isFinite(ttlSeconds) && ttlSeconds > 0 ? ttlSeconds : config.cookieTtlSeconds,
    cookieExpires,
    amazonPage: firstNonEmpty(result.amazonPage, cookieData.amazonPage, config.amazonPage || 'amazon.com'),
  };

  Object.keys(patch).forEach(key => {
    if (patch[key] === undefined || patch[key] === null || String(patch[key]).trim() === '') {
      delete patch[key];
    }
  });

  return patch;
}

function saveRefreshResult(result, label = 'REFRESH_COOKIE') {
  const patch = normalizeRefreshResult(result || {});
  saveConfig(patch);

  console.log(`[${label}] saved refreshed auth fields: ` + Object.keys(patch).join(', '));
  console.log(`[${label}] cookie/localCookie aligned =`, patch.cookie === patch.localCookie);
  console.log(`[${label}] refresh token present =`, !!config.refreshToken);

  return patch;
}

function saveConfig(patch) {
  config = normalizeConfig(Object.assign({}, config || {}, patch || {}));
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf8');
  console.log('[CONFIG] saved', CONFIG_FILE);
}

function asTrimmedString(value, fallback = '') {
  const result = String(value === undefined || value === null ? fallback : value).trim();
  return result || fallback;
}

function boolValue(value) {
  return value === true || value === 'true' || value === 1 || value === '1';
}

function responseBody(response) {
  return response && response.body !== undefined ? response.body : response;
}

function safeError(err) {
  if (!err) return null;
  return err.message || String(err);
}

function getSavedCookie() {
  return config.cookie || config.localCookie || config.loginCookie || '';
}

function getHostFromRequest(req) {
  let host = String(req.headers['x-forwarded-host'] || req.headers.host || '');

  if (host.includes(']')) {
    const idx = host.lastIndexOf(']');
    host = host.substring(0, idx + 1);
  } else if (host.includes(':')) {
    host = host.split(':')[0];
  }

  if (!host || host === '0.0.0.0') return 'localhost';
  return host;
}

function getConfiguredApiKey() {
  return config.apiKey ? String(config.apiKey) : '';
}

function getSuppliedApiKey(req) {
  return String(
    req.headers['x-api-key'] ||
    req.query.apiKey ||
    (req.body && req.body.apiKey) ||
    (req.body && req.body.currentApiKey) ||
    ''
  );
}

function requireApiKey(req, res, next) {
  const expected = getConfiguredApiKey();
  if (!expected) return next();

  if (getSuppliedApiKey(req) !== expected) {
    return res.status(401).json({
      ok: false,
      error: 'Invalid API key',
      hint: 'Supply the API key with x-api-key, ?apiKey=, or the API Key field in the UI.'
    });
  }

  next();
}

function baseAlexaOptions() {
  return {
    amazonPage: config.amazonPage || 'amazon.com',
    acceptLanguage: config.acceptLanguage || 'en-US,en;q=0.9',
    alexaServiceHost: config.alexaServiceHost || 'pitangui.amazon.com',
    deviceAppName: config.deviceAppName || 'Echo Whispers',
    amazonPageProxyLanguage: config.amazonPageProxyLanguage || 'en_US',
    proxyLanguage: config.amazonPageProxyLanguage || 'en_US',
    language: config.amazonPageProxyLanguage || 'en_US',

    userAgent: config.userAgent ||
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',

    bluetooth: false,
    useWsMqtt: false,
    logger: (msg) => console.log('[ALEXA]', msg)
  };
}

function buildFormerRegistrationDataForAlexaCookie() {
  const registration = cleanRegistrationData(config.registrationData) || {};
  const material = getRegistrationMaterial(config.macDms) ||
    getRegistrationMaterial(registration.macDms) ||
    getRegistrationMaterial(registration);

  const former = Object.assign({}, registration);

  if (config.deviceSerial) former.deviceSerial = config.deviceSerial;
  if (config.refreshToken) former.refreshToken = config.refreshToken;
  if (config.loginCookie) former.loginCookie = config.loginCookie;
  if (config.localCookie) former.localCookie = config.localCookie;
  if (config.cookie) former.cookie = config.cookie;
  if (config.csrf) former.csrf = config.csrf;
  if (config.amazonPage) former.amazonPage = config.amazonPage;
  if (material) former.macDms = material;

  return former.deviceSerial || former.refreshToken || former.loginCookie || former.macDms
    ? former
    : null;
}

function buildAlexaOptions(mode, reqHost) {
  const savedCookie = getSavedCookie();
  const base = baseAlexaOptions();
  const existingRegistrationData = cleanRegistrationData(config.registrationData) || cleanRegistrationData(config.macDms);
  const existingRegistrationMaterial = getRegistrationMaterial(config.macDms) || getRegistrationMaterial(existingRegistrationData);
  const formerData = buildFormerRegistrationDataForAlexaCookie();

  if (mode === 'proxy') {
    const proxyOptions = {
      authMethod: 'proxy',
      useProxy: true,
      proxyOnlyLogin: false,
      proxyOwnIp: reqHost || config.proxyOwnIp || 'localhost',
      proxyPort: getProxyPort(),
      proxyListenBind: config.proxyListenBind || '0.0.0.0',
      proxyLogLevel: config.proxyLogLevel || 'info'
    };

    if (formerData || existingRegistrationData || existingRegistrationMaterial) {
      // alexa-cookie2 specifically checks formerRegistrationData.deviceSerial.
      // Do not only pass macDms. It will generate a new device if deviceSerial is missing.
      proxyOptions.registrationData = formerData || existingRegistrationData || existingRegistrationMaterial;
      proxyOptions.formerRegistrationData = formerData || existingRegistrationData || existingRegistrationMaterial;
      proxyOptions.macDms = existingRegistrationMaterial || (formerData && formerData.macDms) || (existingRegistrationData && existingRegistrationData.macDms) || existingRegistrationData;
      if (config.deviceSerial) proxyOptions.deviceSerial = config.deviceSerial;
      console.log('[LOGIN] reusing existing Amazon registration data deviceSerial =', config.deviceSerial ? config.deviceSerial.slice(0, 8) + '...' : 'missing');
    } else {
      console.log('[LOGIN] no saved Amazon registration data. First login may register device.');
    }

    return Object.assign(base, proxyOptions);
  }

  if (mode === 'refresh') {
    if (!config.refreshToken) throw new Error('Missing refreshToken. Use Full Reauth first.');
    return Object.assign(base, {
      refreshToken: config.refreshToken,
      cookie: savedCookie || undefined,
      csrf: config.csrf || undefined,
      formerRegistrationData: existingRegistrationData || existingRegistrationMaterial || undefined,
      useProxy: false,
      proxyOnlyLogin: false
    });
  }

  if (savedCookie) {
    return Object.assign(base, {
      cookie: savedCookie,
      csrf: config.csrf || undefined,
      useProxy: false,
      proxyOnlyLogin: false
    });
  }

  if (config.refreshToken) {
    return Object.assign(base, {
      refreshToken: config.refreshToken,
      formerRegistrationData: existingRegistrationData || existingRegistrationMaterial || undefined,
      useProxy: false,
      proxyOnlyLogin: false
    });
  }

  throw new Error('Missing auth. Use Amazon Login first.');
}


function extractAuthFromAlexaInstance(instance) {
  const patch = {};
  if (!instance) return patch;

  const opts = instance._options || instance.options || {};

  const cookie =
    instance.cookie ||
    opts.cookie ||
    opts.localCookie ||
    opts.loginCookie ||
    null;

  const csrf =
    instance.csrf ||
    opts.csrf ||
    parseCsrfFromCookie(cookie) ||
    null;

  if (cookie) {
    patch.cookie = cookie;
    patch.localCookie = cookie;
  }

  if (csrf) patch.csrf = String(csrf);

  if (opts.loginCookie) patch.loginCookie = opts.loginCookie;
  if (opts.refreshToken) patch.refreshToken = opts.refreshToken;

  const reg = cleanRegistrationData(opts.registrationData || opts.formerRegistrationData || instance.registrationData || instance.formerRegistrationData || opts.macDms || instance.macDms);
  if (reg) {
    patch.macDms = reg;
    patch.registrationData = reg;
  }

  if (opts.frc) patch.frc = opts.frc;
  if (opts['map-md']) patch['map-md'] = opts['map-md'];
  if (opts.deviceId) patch.deviceId = opts.deviceId;
  if (opts.deviceSerial) patch.deviceSerial = opts.deviceSerial;
  if (lastCapturedRegistrationDeviceName) patch.deviceName = lastCapturedRegistrationDeviceName;
  if (opts.deviceName) patch.deviceName = opts.deviceName;
  if (opts.dataVersion) patch.dataVersion = opts.dataVersion;

  return patch;
}

function parseCsrfFromCookie(cookie) {
  const m = String(cookie || '').match(/(?:^|;\s*)csrf=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

function extractCsrf(cookie) {
  return parseCsrfFromCookie(cookie);
}


function extractAuth(src) {
  const out = {};
  if (!src || typeof src !== 'object') return out;

  [
    'refreshToken', 'cookie', 'loginCookie', 'localCookie', 'csrf', 'macDms',
    'registrationData', 'formerRegistrationData', 'tokenDate', 'frc', 'map-md', 'deviceId', 'deviceSerial', 'dataVersion'
  ].forEach(k => {
    if (src[k]) out[k] = src[k];
  });

  if (!out.cookie && out.localCookie) out.cookie = out.localCookie;
  if (!out.cookie && out.loginCookie) out.cookie = out.loginCookie;

  // Preserve both names. alexa-cookie2/alexa-remote2 may return either.
  if (!out.registrationData && out.formerRegistrationData) out.registrationData = out.formerRegistrationData;
  delete out.formerRegistrationData;

  if (!out.macDms && out.registrationData) out.macDms = getRegistrationMaterial(out.registrationData) || out.registrationData;
  if (!out.registrationData && out.macDms) out.registrationData = out.macDms;

  return out;
}

function mergeAndSaveAuth(newConfig) {
  const patch = Object.assign(
    {},
    extractAuth(newConfig),
    extractAuth(alexa.cookieData)
  );

  if (patch.cookie || patch.localCookie || patch.loginCookie) {
    Object.assign(patch, buildCookieTimingPatch(newConfig || patch));
  }

  if (!config.deviceCreated) patch.deviceCreated = new Date().toISOString();

  if (lastCapturedRegistrationDeviceName) patch.deviceName = lastCapturedRegistrationDeviceName;

  cleanAuthRegistrationFields(patch);
  saveConfig(patch);
  console.log('[AUTH] saved fields:', Object.keys(patch).join(', '));
}

function buildFormerRegistrationDataForRefresh() {
  const former = {};

  if (config.registrationData && typeof config.registrationData === 'object') {
    Object.assign(former, config.registrationData);
  }

  //
  // Important:
  // alexa-cookie2.refreshAlexaCookie() does NOT want only macDms.
  // It requires registrationData.loginCookie and registrationData.refreshToken.
  //
  former.refreshToken = config.refreshToken || former.refreshToken || '';
  former.loginCookie = config.loginCookie || former.loginCookie || config.cookie || config.localCookie || '';
  former.localCookie = config.localCookie || former.localCookie || config.cookie || '';
  former.cookie = config.cookie || former.cookie || config.localCookie || config.loginCookie || '';
  former.csrf = config.csrf || former.csrf || '';
  former.amazonPage = config.amazonPage || former.amazonPage || 'amazon.com';

  if (config.macDms) former.macDms = config.macDms;
  if (config.tokenDate) former.tokenDate = config.tokenDate;
  if (config.frc) former.frc = config.frc;
  if (config['map-md']) former['map-md'] = config['map-md'];
  if (config.deviceId) former.deviceId = config.deviceId;
  if (config.deviceSerial) former.deviceSerial = config.deviceSerial;
  if (config.dataVersion) former.dataVersion = config.dataVersion;

  if (!former.refreshToken) throw new Error('Missing refreshToken. Use Full Reauth first.');
  if (!former.loginCookie) throw new Error('Missing loginCookie. Use Full Reauth first.');

  return former;
}


function parseCookieString(cookie) {
  const out = {};
  String(cookie || '').split(';').forEach(part => {
    const idx = part.indexOf('=');
    if (idx <= 0) return;
    const name = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (name) out[name] = value;
  });
  return out;
}

function extractCookieValue(cookieString, name) {
  const parsed = parseCookieString(cookieString || '');
  return parsed[name] || '';
}

function getCsrfFromCookieString(cookieString) {
  return extractCookieValue(cookieString, 'csrf');
}

function getBestLoginCookieFromAuth(auth) {
  if (!auth || typeof auth !== 'object') return '';

  return auth.cookie ||
    auth.localCookie ||
    auth.loginCookie ||
    auth.result && (auth.result.cookie || auth.result.localCookie || auth.result.loginCookie) ||
    '';
}

function buildProxyAuthPatch(auth) {
  const patch = extractAuthFromAlexaInstance(auth || {}, {});
  const cookie =
    auth.cookie ||
    auth.loginCookie ||
    auth.localCookie ||
    patch.cookie ||
    patch.loginCookie ||
    patch.localCookie ||
    '';

  const csrf =
    auth.csrf ||
    patch.csrf ||
    getCsrfFromCookieString(cookie) ||
    getCsrfFromCookieString(auth.loginCookie || '') ||
    getCsrfFromCookieString(auth.localCookie || '');

  if (cookie) {
    patch.cookie = cookie;
    patch.localCookie = cookie;
    patch.loginCookie = auth.loginCookie || cookie;
  }

  if (csrf) patch.csrf = csrf;

  patch.deviceCreated = patch.deviceCreated || new Date().toISOString();
  patch.cookieCreated = patch.cookieCreated || new Date().toISOString();
  patch.fullReauthRequired = false;
  patch.lastRefreshError = null;
  patch.lastRefreshErrorCode = null;
  patch.lastRefreshErrorAt = null;

  return cleanAuthRegistrationFields(patch);
}

function proxyAuthLooksUsable(auth) {
  const patch = buildProxyAuthPatch(auth || {});
  return !!(patch.cookie && patch.csrf && patch.refreshToken);
}

function saveProxyAuthResult(auth, label = 'LOGIN') {
  const patch = buildProxyAuthPatch(auth || {});
  if (!patch.cookie || !patch.csrf) {
    throw new Error('Proxy login did not return a usable cookie/csrf');
  }

  saveConfig(patch);
  console.log(`[${label}] saved proxy login result with cookie/csrf/registrationData`);

  return patch;
}

function cookieMapToString(map) {
  return Object.keys(map || {})
    .filter(name => map[name] !== undefined && map[name] !== null && String(map[name]) !== '')
    .map(name => `${name}=${map[name]}`)
    .join('; ');
}

function mergeSetCookieHeaders(cookie, setCookieHeaders) {
  const map = parseCookieString(cookie);

  (Array.isArray(setCookieHeaders) ? setCookieHeaders : [setCookieHeaders]).filter(Boolean).forEach(header => {
    const first = String(header).split(';')[0];
    const idx = first.indexOf('=');
    if (idx <= 0) return;

    const name = first.slice(0, idx).trim();
    const value = first.slice(idx + 1).trim();
    if (name) map[name] = value;
  });

  return cookieMapToString(map);
}

function cookieStringFromAmazonCookieList(cookies, existingCookie) {
  const map = parseCookieString(existingCookie);

  (cookies || []).forEach(cookie => {
    if (!cookie || !cookie.Name) return;

    map[cookie.Name] = String(cookie.Value || '').replace(/^"|"$/g, '');

    if (cookie.Name === 'session-id' && cookie.Expires && !map['session-id-time']) {
      const expiresMs = Date.parse(cookie.Expires);
      if (Number.isFinite(expiresMs)) {
        map['session-id-time'] = `${Math.floor(expiresMs / 1000)}l`;
      }
    }
  });

  return cookieMapToString(map);
}

function httpsTextRequest(options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(Object.assign({ timeout: REQUEST_TIMEOUT_MS }, options), res => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode,
          headers: res.headers || {},
          body: data
        });
      });
    });

    req.on('timeout', () => req.destroy(new Error(`${options.method || 'GET'} ${options.host}${options.path || '/'} timed out`)));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function postAmazonForm(host, requestPath, form, cookie) {
  const body = new URLSearchParams(form).toString();

  const response = await httpsTextRequest({
    host,
    path: requestPath,
    method: 'POST',
    headers: {
      'User-Agent': 'AmazonWebView/Amazon Alexa/2.2.651540.0/iOS/18.3.1/iPhone',
      'Accept-Language': config.acceptLanguage || 'en-US,en;q=0.9',
      'Accept-Charset': 'utf-8',
      'Connection': 'keep-alive',
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(body),
      'Cookie': cookie || '',
      'Accept': host === `www.${config.amazonPage || 'amazon.com'}` ? '*/*' : 'application/json',
      'x-amzn-identity-auth-domain': 'api.amazon.com'
    }
  }, body);

  let parsed = {};
  try {
    parsed = response.body ? JSON.parse(response.body) : {};
  } catch (err) {
    const parseErr = new Error(`Amazon ${host}${requestPath} returned non-JSON response`);
    parseErr.statusCode = response.statusCode;
    parseErr.body = response.body;
    throw parseErr;
  }

  if (response.statusCode < 200 || response.statusCode >= 300) {
    const err = new Error(`Amazon ${host}${requestPath} failed: HTTP ${response.statusCode}`);
    err.statusCode = response.statusCode;
    err.body = parsed;
    throw err;
  }

  return parsed;
}

async function getCsrfCookie(cookie) {
  const amazonPage = config.amazonPage || 'amazon.com';
  const headers = {
    'DNT': '1',
    'User-Agent': config.userAgent ||
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    'Connection': 'keep-alive',
    'Referer': `https://alexa.${amazonPage}/spa/index.html`,
    'Origin': `https://alexa.${amazonPage}`,
    'Accept': '*/*',
    'Cookie': cookie
  };

  const paths = [
    '/api/users/me?platform=ios&version=2.2.651540.0',
    '/spa/index.html',
    '/'
  ];

  let currentCookie = cookie;
  for (const requestPath of paths) {
    const response = await httpsTextRequest({
      host: `alexa.${amazonPage}`,
      path: requestPath,
      method: 'GET',
      headers: Object.assign({}, headers, { Cookie: currentCookie })
    });

    currentCookie = mergeSetCookieHeaders(currentCookie, response.headers['set-cookie']);
    const csrf =
      parseCsrfFromCookie(currentCookie) ||
      (String(response.body || '').match(/csrf["']?\s*[:=]\s*["']?(-?\d+)/i) || [])[1];

    if (csrf) {
      const map = parseCookieString(currentCookie);
      map.csrf = csrf;
      return cookieMapToString(map);
    }
  }

  return currentCookie;
}

function saveCookieRefreshResult(result) {
  if (!result || typeof result !== 'object') {
    throw new Error('Cookie refresh returned no result');
  }

  const refreshedCookie = result.localCookie || result.cookie || result.loginCookie || config.localCookie || config.cookie || '';
  const refreshedLoginCookie = result.loginCookie || refreshedCookie || config.loginCookie || '';
  const refreshedCsrf = result.csrf || parseCsrfFromCookie(refreshedCookie) || parseCsrfFromCookie(refreshedLoginCookie) || config.csrf || '';

  const patch = Object.assign({}, buildCookieTimingPatch(result));

  patch.refreshToken = result.refreshToken || result.refresh_token || config.refreshToken || '';
  patch.cookie = refreshedCookie;
  patch.localCookie = refreshedCookie;
  patch.loginCookie = refreshedLoginCookie;
  patch.csrf = refreshedCsrf;

  // Refresh must not re-register or overwrite durable registration data.
  patch.macDms = config.macDms || null;
  patch.registrationData = config.registrationData || config.macDms || null;

  if (result.accessToken) patch.accessToken = result.accessToken;
  if (result.tokenDate) patch.tokenDate = result.tokenDate;
  if (result.amazonPage) patch.amazonPage = result.amazonPage;
  if (!config.deviceCreated) patch.deviceCreated = new Date().toISOString();
  patch.fullReauthRequired = false;
  patch.lastRefreshErrorCode = null;
  patch.lastRefreshError = null;
  patch.lastRefreshErrorAt = null;

  saveConfig(patch);
  console.log('[REFRESH_COOKIE] saved refreshed cookie fields:', Object.keys(patch).join(', '));
  console.log('[REFRESH_COOKIE] cookie/localCookie aligned =', patch.cookie === patch.localCookie);
  console.log('[REFRESH_COOKIE] app registration preserved =', !!(patch.registrationData || patch.macDms));
}


function getRegisteredDeviceName() {
  return config.deviceName ? String(config.deviceName) : '';
}


function shortHash(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex').slice(0, 12);
}

function cookiePart(cookie, name) {
  const parts = String(cookie || '').split(';');
  for (const part of parts) {
    const idx = part.indexOf('=');
    if (idx <= 0) continue;
    if (part.slice(0, idx).trim() === name) return part.slice(idx + 1).trim();
  }
  return '';
}

function cookieRefreshDebug(cookie, csrf) {
  return {
    cookieHash: shortHash(cookie),
    sessionTokenHash: shortHash(cookiePart(cookie, 'session-token')),
    atMainHash: shortHash(cookiePart(cookie, 'at-main')),
    csrfHash: shortHash(csrf || parseCsrfFromCookie(cookie)),
    hasCookie: !!cookie,
    hasSessionToken: !!cookiePart(cookie, 'session-token'),
    hasAtMain: !!cookiePart(cookie, 'at-main'),
    hasCsrf: !!(csrf || parseCsrfFromCookie(cookie))
  };
}

async function getNewWebsiteCookieFromRefreshToken(refreshToken, existingCookie) {
  const amazonPage = config.amazonPage || 'amazon.com';

  console.log('[REFRESH_COOKIE] requesting new access token from /auth/token');

  const tokenResponse = await postAmazonForm('api.amazon.com', '/auth/token', {
    app_name: config.deviceAppName || 'Echo Whispers',
    app_version: '2.2.651540.0',
    'di.sdk.version': '6.12.4',
    source_token: refreshToken,
    package_name: 'com.amazon.echo',
    'di.hw.version': 'iPhone',
    platform: 'iOS',
    requested_token_type: 'access_token',
    source_token_type: 'refresh_token',
    'di.os.name': 'iOS',
    'di.os.version': '16.6',
    current_version: '6.12.4'
  }, existingCookie);

  const accessToken = tokenResponse.access_token || tokenResponse.response && tokenResponse.response.token;
  if (!accessToken) throw new Error('No access token returned from refresh token response');

  console.log('[REFRESH_COOKIE] access token refreshed');
  console.log('[REFRESH_COOKIE] requesting new website cookies from /ap/exchangetoken/cookies');

  const exchangeResponse = await postAmazonForm(`www.${amazonPage}`, '/ap/exchangetoken/cookies', {
    'di.os.name': 'iOS',
    app_version: '2.2.651540.0',
    domain: `.${amazonPage}`,
    source_token: refreshToken,
    requested_token_type: 'auth_cookies',
    source_token_type: 'refresh_token',
    'di.hw.version': 'iPhone',
    'di.sdk.version': '6.12.4',
    app_name: config.deviceAppName || 'Echo Whispers',
    'di.os.version': '16.6'
  }, '');

  const cookieList =
    exchangeResponse &&
    exchangeResponse.response &&
    exchangeResponse.response.tokens &&
    exchangeResponse.response.tokens.cookies &&
    exchangeResponse.response.tokens.cookies[`.${amazonPage}`];

  if (!Array.isArray(cookieList) || cookieList.length === 0) {
    throw new Error('No website cookies returned from exchange token response');
  }

  const newCookie = cookieStringFromAmazonCookieList(cookieList, existingCookie);

  return {
    accessToken,
    newCookie,
    websiteCookieTtlSeconds: exchangeResponse.response && exchangeResponse.response.tokens && exchangeResponse.response.tokens.ttl,
    exchangeResponse
  };
}

async function refreshCookieFromRefreshToken() {
  if (!config.refreshToken) throw new Error('Missing refreshToken. Use Full Reauth first.');

  const amazonPage = config.amazonPage || 'amazon.com';
  const existingCookie = config.loginCookie || config.cookie || config.localCookie || '';
  const refreshToken = config.refreshToken;
  const before = cookieRefreshDebug(config.cookie || config.localCookie || '', config.csrf);

  console.log('[REFRESH_COOKIE] light refresh start');
  console.log('[REFRESH_COOKIE] has refreshToken =', !!refreshToken);
  console.log('[REFRESH_COOKIE] has existing cookie =', !!existingCookie);
  console.log('[REFRESH_COOKIE] app registration will not be attempted');
  console.log('[REFRESH_COOKIE] before =', JSON.stringify(before));

  const cookieResponse = await getNewWebsiteCookieFromRefreshToken(refreshToken, existingCookie);

  let refreshedCookie = cookieResponse.newCookie;
  refreshedCookie = await getCsrfCookie(refreshedCookie);

  const csrf = parseCsrfFromCookie(refreshedCookie);
  if (!csrf) throw new Error('No csrf returned after cookie refresh');

  const after = cookieRefreshDebug(refreshedCookie, csrf);
  const cookieChanged =
    before.cookieHash !== after.cookieHash ||
    before.sessionTokenHash !== after.sessionTokenHash ||
    before.atMainHash !== after.atMainHash ||
    before.csrfHash !== after.csrfHash;

  console.log('[REFRESH_COOKIE] after =', JSON.stringify(after));
  console.log('[REFRESH_COOKIE] cookie changed =', cookieChanged);

  const result = {
    refreshToken,
    accessToken: cookieResponse.accessToken,
    cookie: refreshedCookie,
    localCookie: refreshedCookie,
    loginCookie: refreshedCookie,
    csrf,
    macDms: config.macDms,
    registrationData: config.registrationData || config.macDms,
    tokenDate: Date.now(),
    amazonPage,
    website_cookies_ttl: cookieResponse.websiteCookieTtlSeconds,
    cookieChanged,
    before,
    after
  };

  saveCookieRefreshResult(result);
  return result;
}


function getCsrf() {
  if (config.csrf) return String(config.csrf);
  const cookie = getSavedCookie();
  const match = cookie.match(/(?:^|;\s*)csrf=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : '';
}

function cookieHeaders(extra) {
  const cookie = getSavedCookie();
  if (!cookie) throw new Error('Missing saved cookie. Use Amazon Login first.');

  const amazonPage = config.amazonPage || 'amazon.com';

  const headers = Object.assign({
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': config.acceptLanguage || 'en-US,en;q=0.9',
    'Cookie': cookie,
    'Origin': `https://alexa.${amazonPage}`,
    'Referer': `https://alexa.${amazonPage}/spa/index.html`,
    'DNT': '1',
    'Connection': 'keep-alive',
    'User-Agent': config.userAgent ||
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
  }, extra || {});

  const csrf = getCsrf();
  if (csrf) headers.csrf = csrf;

  return headers;
}

function directRequest(method, requestPath, body) {
  const host = config.alexaServiceHost || 'pitangui.amazon.com';
  const payload = body === undefined || body === null ? null : JSON.stringify(body);

  const headers = cookieHeaders(payload ? {
    'Content-Type': 'application/json; charset=UTF-8',
    'Content-Length': Buffer.byteLength(payload)
  } : undefined);

  return new Promise((resolve, reject) => {
    const req = https.request({
      host,
      path: requestPath,
      method,
      timeout: REQUEST_TIMEOUT_MS,
      headers
    }, res => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        let parsed = data;
        try { parsed = data ? JSON.parse(data) : {}; } catch (e) {}

        if (res.statusCode < 200 || res.statusCode >= 300) {
          const err = new Error(`Alexa REST ${method} ${requestPath} failed: HTTP ${res.statusCode}`);
          err.statusCode = res.statusCode;
          err.body = parsed;
          err.retryAfter = res.headers && res.headers['retry-after'] ? res.headers['retry-after'] : null;
          return reject(err);
        }

        resolve(parsed);
      });
    });

    req.on('timeout', () => req.destroy(new Error(`Alexa REST ${method} ${requestPath} timed out`)));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}


function getEchoSpeaksVersion() {
  return asTrimmedString(config.echoSpeaksVersion, DEFAULT_ECHO_SPEAKS_VERSION);
}

function getHubitatReceiveUrl() {
  return String(config.hubitatCallbackUrl || '').trim();
}

function getHubitatEndpointUrl() {
  const url = getHubitatReceiveUrl();
  if (!url) return '';

  // Echo Speaks app gives a /receiveData callback URL.
  // Cookie exchange uses the same app endpoint with /cookie.
  if (url.includes('/receiveData?')) return url.replace('/receiveData?', '/cookie?');
  if (url.includes('/receiveData')) return url.replace('/receiveData', '/cookie');

  return url;
}

function getLocalIpv4Address() {
  const interfaces = os.networkInterfaces();

  for (const addresses of Object.values(interfaces)) {
    for (const addr of addresses || []) {
      if (addr.family === 'IPv4' && !addr.internal) {
        return addr.address;
      }
    }
  }

  return '127.0.0.1';
}

function getServerPort() {
  const rawPort = process.env.PORT || config.port || PORT;
  const serverPort = Number(rawPort);
  return Number.isFinite(serverPort) && serverPort > 0 && serverPort <= 65535 ? serverPort : PORT;
}

function getAutoServerUrl() {
  return `http://${getLocalIpv4Address()}:${getServerPort()}/`;
}

function getProxyPort() {
  const rawProxyPort = config && config.proxyPort !== undefined && config.proxyPort !== null && config.proxyPort !== ''
    ? config.proxyPort
    : DEFAULT_PROXY_PORT;

  const proxyPort = Number(rawProxyPort);
  return Number.isFinite(proxyPort) && proxyPort > 0 && proxyPort <= 65535 ? proxyPort : DEFAULT_PROXY_PORT;
}

function getHubitatServerUrl() {
  const configured = asTrimmedString(config.hubitatServerUrl);
  return configured || getAutoServerUrl();
}

function httpJsonRequest(method, targetUrl, body) {
  if (!targetUrl) throw new Error('Missing Hubitat URL');

  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(targetUrl);
    } catch (err) {
      return reject(new Error(`Invalid Hubitat URL: ${targetUrl}`));
    }

    const isHttps = u.protocol === 'https:';
    const client = isHttps ? https : http;
    const payload = body === undefined || body === null ? null : JSON.stringify(body);

    const headers = {
      'Accept': 'application/json, text/plain, */*',
      'User-Agent': config.userAgent ||
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
    };

    if (payload) {
      headers['Content-Type'] = 'application/json; charset=UTF-8';
      headers['Content-Length'] = Buffer.byteLength(payload);
    }

    const req = client.request({
      protocol: u.protocol,
      hostname: u.hostname,
      port: u.port || (isHttps ? 443 : 80),
      path: `${u.pathname}${u.search}`,
      method,
      timeout: REQUEST_TIMEOUT_MS,
      headers
    }, res => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        let parsed = data;
        try { parsed = data ? JSON.parse(data) : {}; } catch (e) {}

        const result = {
          statusCode: res.statusCode,
          headers: res.headers || {},
          body: parsed,
          rawBody: data
        };

        if (res.statusCode < 200 || res.statusCode >= 300) {
          const err = new Error(`Hubitat ${method} ${targetUrl} failed: HTTP ${res.statusCode}`);
          err.statusCode = res.statusCode;
          err.body = parsed;
          err.rawBody = data;
          err.response = result;
          return reject(err);
        }

        resolve(result);
      });
    });

    req.on('timeout', () => req.destroy(new Error(`Hubitat ${method} ${targetUrl} timed out`)));
    req.on('error', reject);

    if (payload) req.write(payload);
    req.end();
  });
}


function buildHubitatCookiePayload(reqHost) {
  const savedCookie = getSavedCookie();

  return {
    cookieData: {
      localCookie: config.localCookie || savedCookie || '',
      cookie: config.cookie || savedCookie || '',
      loginCookie: config.loginCookie || savedCookie || '',
      csrf: getCsrf(),
      refreshToken: config.refreshToken || '',
      macDms: config.macDms || null,
      registrationData: config.registrationData || config.macDms || null,
      tokenDate: config.tokenDate || null,
      amazonPage: config.amazonPage || 'amazon.com',
      cookieCreated: config.cookieCreated || null,
      cookieExpires: config.cookieExpires || null,
      cookieTtlSeconds: config.cookieTtlSeconds || null
    },
    version: getEchoSpeaksVersion(),
    serverName: APP_NAME,
    onHeroku: false,
    isLocal: true,
    serverUrl: getHubitatServerUrl()
  };
}

function buildHubitatServerPayload(reqHost) {
  return {
    version: getEchoSpeaksVersion(),
    serverName: APP_NAME,
    onHeroku: false,
    isLocal: true,
    serverUrl: getHubitatServerUrl()
  };
}

function redactHubitatDebugValue(value) {
  if (value === undefined || value === null) return value;

  if (Array.isArray(value)) {
    return value.map(redactHubitatDebugValue);
  }

  if (typeof value === 'object') {
    const out = {};
    for (const [key, val] of Object.entries(value)) {
      if (/cookie|token|csrf|macDms|registration|private_key|registrationData|rawBody/i.test(key)) {
        if (typeof val === 'string') {
          out[key] = `[redacted ${val.length} chars]`;
        } else {
          out[key] = '[redacted]';
        }
      } else {
        out[key] = redactHubitatDebugValue(val);
      }
    }
    return out;
  }

  if (typeof value === 'string' && value.length > 300) {
    return `${value.substring(0, 120)}... [truncated ${value.length} chars]`;
  }

  return value;
}

function sanitizeHubitatResponseBody(value) {
  if (value === undefined || value === null) return null;

  const redacted = redactHubitatDebugValue(value);

  let textValue;
  if (typeof redacted === 'string') {
    textValue = redacted;
  } else {
    try {
      textValue = JSON.stringify(redacted);
    } catch (err) {
      textValue = String(redacted);
    }
  }

  if (textValue.length > MAX_DEBUG_RESPONSE_CHARS) {
    return textValue.substring(0, MAX_DEBUG_RESPONSE_CHARS) + '... [truncated]';
  }

  return textValue;
}

function saveHubitatSyncStatus(status, err, detail) {
  detail = detail || {};

  saveConfig({
    hubitatLastSyncAt: new Date().toISOString(),
    hubitatLastSyncStatus: status || null,
    hubitatLastSyncError: err ? safeError(err) : null,
    hubitatLastAction: detail.action || null,
    hubitatLastEndpoint: detail.endpoint || null,
    hubitatLastResponseStatusCode: detail.response && detail.response.statusCode !== undefined ? detail.response.statusCode : null,
    hubitatLastResponseBody: detail.response ? sanitizeHubitatResponseBody(detail.response.body !== undefined ? detail.response.body : detail.response.rawBody) : null
  });
}

async function sendServerDataToHubitat(reqHost) {
  if (!config.hubitatCompatEnabled) return { skipped: true, reason: 'Hubitat compatibility disabled' };

  const url = getHubitatReceiveUrl();
  if (!url) return { skipped: true, reason: 'Missing Hubitat callback URL' };

  try {
    const result = await httpJsonRequest('POST', url, buildHubitatServerPayload(reqHost));
    console.log('[HUBITAT] send server data response:', JSON.stringify(redactHubitatDebugValue(result)));
    saveHubitatSyncStatus('server_data_sent', null, { action: 'send_server_data', endpoint: url, response: result });
    return result;
  } catch (err) {
    saveHubitatSyncStatus('server_data_failed', err, { action: 'send_server_data', endpoint: url, response: err && err.body ? { statusCode: err.statusCode, body: err.body } : null });
    throw err;
  }
}

async function sendCookiesToHubitat(reqHost) {
  if (!config.hubitatCompatEnabled) return { skipped: true, reason: 'Hubitat compatibility disabled' };

  const url = getHubitatEndpointUrl();
  if (!url) return { skipped: true, reason: 'Missing Hubitat Echo Speaks app callback URL' };

  try {
    const result = await httpJsonRequest('POST', url, buildHubitatCookiePayload(reqHost));
    console.log('[HUBITAT] send cookie response:', JSON.stringify(redactHubitatDebugValue(result)));
    saveHubitatSyncStatus('cookie_sent', null, { action: 'send_cookie', endpoint: url, response: result });
    return result;
  } catch (err) {
    saveHubitatSyncStatus('cookie_send_failed', err, { action: 'send_cookie', endpoint: url, response: err && err.body ? { statusCode: err.statusCode, body: err.body } : null });
    throw err;
  }
}

async function pullCookiesFromHubitat() {
  if (!config.hubitatCompatEnabled) return { skipped: true, reason: 'Hubitat compatibility disabled' };

  const url = getHubitatEndpointUrl();
  if (!url) return { skipped: true, reason: 'Missing Hubitat Echo Speaks app callback URL' };

  try {
    const data = await httpJsonRequest('GET', url);
    console.log('[HUBITAT] pull cookie response:', JSON.stringify(redactHubitatDebugValue(data)));
    const responseBody = data && data.body !== undefined ? data.body : data;
    const cookieData = responseBody && responseBody.cookieData ? responseBody.cookieData : responseBody;

    if (!cookieData || typeof cookieData !== 'object') {
      throw new Error('Hubitat returned no cookieData');
    }

    const cookie = cookieData.localCookie || cookieData.cookie || cookieData.loginCookie || '';
    const csrf = cookieData.csrf || parseCsrfFromCookie(cookie) || '';

    if (!cookie || !csrf) {
      throw new Error('Hubitat cookieData did not include cookie and csrf');
    }

    const patch = {
      cookie,
      localCookie: cookieData.localCookie || cookie,
      loginCookie: cookieData.loginCookie || cookie,
      csrf,
      refreshToken: cookieData.refreshToken || config.refreshToken || '',
      macDms: cookieData.macDms || config.macDms || null,
      registrationData: cookieData.registrationData || cookieData.macDms || config.registrationData || null,
      tokenDate: cookieData.tokenDate || config.tokenDate || null,
      cookieCreated: cookieData.cookieCreated || config.cookieCreated || null,
      cookieExpires: cookieData.cookieExpires || config.cookieExpires || null,
      cookieTtlSeconds: cookieData.cookieTtlSeconds || config.cookieTtlSeconds || null
    };

    if (!config.deviceCreated) patch.deviceCreated = new Date().toISOString();

    cleanAuthRegistrationFields(patch);
    saveConfig(patch);
    saveHubitatSyncStatus('cookie_pulled', null, { action: 'pull_cookie', endpoint: url, response: data });

    return { ok: true, cookieData: Object.assign({}, cookieData, { localCookie: '[redacted]', cookie: '[redacted]', loginCookie: '[redacted]' }) };
  } catch (err) {
    saveHubitatSyncStatus('cookie_pull_failed', err, { action: 'pull_cookie', endpoint: url, response: err && err.body ? { statusCode: err.statusCode, body: err.body } : null });
    throw err;
  }
}

async function clearHubitatCookie() {
  if (!config.hubitatCompatEnabled) return { skipped: true, reason: 'Hubitat compatibility disabled' };

  const url = getHubitatEndpointUrl();
  if (!url) return { skipped: true, reason: 'Missing Hubitat Echo Speaks app callback URL' };

  try {
    const result = await httpJsonRequest('DELETE', url);
    console.log('[HUBITAT] clear cookie response:', JSON.stringify(redactHubitatDebugValue(result)));
    saveHubitatSyncStatus('cookie_cleared', null, { action: 'clear_cookie', endpoint: url, response: result });
    return result;
  } catch (err) {
    saveHubitatSyncStatus('cookie_clear_failed', err, { action: 'clear_cookie', endpoint: url, response: err && err.body ? { statusCode: err.statusCode, body: err.body } : null });
    throw err;
  }
}

async function safeHubitatAction(label, fn) {
  try {
    const result = await fn();
    console.log(`[HUBITAT] ${label} complete`);
    return { ok: true, result };
  } catch (err) {
    console.warn(`[HUBITAT] ${label} failed:`, safeError(err));
    return { ok: false, error: safeError(err) };
  }
}


async function initRuntimeDirect(force = false) {
  if (isInitialized && !force) return;
  if (isInitializing) throw new Error('Initialization already in progress');

  if (!getSavedCookie() && config.hubitatCompatEnabled) {
    await safeHubitatAction('pull cookie before runtime init', () => pullCookiesFromHubitat());
  }

  if (!getSavedCookie()) throw new Error('Missing saved cookie. Use Amazon Login first.');

  isInitializing = true;
  lastError = null;

  try {
    console.log('[RUNTIME] direct cookie init');
    console.log('[RUNTIME] has cookie =', !!getSavedCookie());
    console.log('[RUNTIME] has csrf =', !!getCsrf());
    console.log('[RUNTIME] refresh token preserved =', !!config.refreshToken);

    await directRequest('GET', '/api/customer-status');

    isInitialized = true;
    lastInitAt = new Date().toISOString();

    await refreshDevices();
    lastError = null;
  } catch (err) {
    isInitialized = false;
    lastError = err;
    throw err;
  } finally {
    isInitializing = false;
  }
}

async function restartDirectRuntimeAfterSavedProxyLogin(reqHost) {
  alexa = new AlexaRemote();
  isInitialized = false;
  isInitializing = false;
  devicesCache = [];
  defaultDevice = null;

  try {
    await initAlexa(false, 'direct', reqHost);
  } catch (err) {
    console.error('[LOGIN] direct runtime restart after proxy login failed:', err);
  }
}

let amazonRegisterReusePatchInstalled = false;
const originalHttpsRequestForRegisterReuse = https.request;

function installAmazonRegisterReusePatch() {
  if (amazonRegisterReusePatchInstalled) return;
  amazonRegisterReusePatchInstalled = true;

  https.request = function patchedHttpsRequest(options, callback) {
    const req = originalHttpsRequestForRegisterReuse.call(https, options, callback);

    try {
      const host = String((options && (options.host || options.hostname)) || '');
      const requestPath = String((options && options.path) || '');
      const method = String((options && options.method) || 'GET').toUpperCase();
      const isRegisterCall =
        method === 'POST' &&
        host === 'api.amazon.com' &&
        requestPath === '/auth/register';

      if (!isRegisterCall) return req;

      const savedDeviceSerial = asTrimmedString(config.deviceSerial);
      const hasRegisteredDevice = !!(config.registrationData || config.macDms);

      if (!hasRegisteredDevice || !savedDeviceSerial) {
        return req;
      }

      const originalWrite = req.write;
      req.write = function patchedRegisterWrite(chunk, encoding, cb) {
        try {
          const input = Buffer.isBuffer(chunk) ? chunk.toString(encoding || 'utf8') : String(chunk || '');
          const body = JSON.parse(input);

          body.registration_data = body.registration_data || {};
          body.auth_data = body.auth_data || {};

          const oldSerial = body.registration_data.device_serial;
          body.registration_data.device_serial = savedDeviceSerial;

          const output = JSON.stringify(body);

          if (options.headers) {
            options.headers['Content-Length'] = Buffer.byteLength(output);
            options.headers['content-length'] = Buffer.byteLength(output);
          }

          console.log('[LOGIN] reused registered Amazon device serial for /auth/register',
            oldSerial && oldSerial !== savedDeviceSerial ? `${String(oldSerial).slice(0, 8)}... -> ${savedDeviceSerial.slice(0, 8)}...` : savedDeviceSerial.slice(0, 8) + '...'
          );

          return originalWrite.call(req, output, encoding, cb);
        } catch (err) {
          console.error('[LOGIN] failed to rewrite /auth/register payload:', err);
          return originalWrite.call(req, chunk, encoding, cb);
        }
      };

      return req;
    } catch (err) {
      console.error('[LOGIN] register reuse patch error:', err);
      return req;
    }
  };
}

function uninstallAmazonRegisterReusePatch() {
  if (!amazonRegisterReusePatchInstalled) return;
  https.request = originalHttpsRequestForRegisterReuse;
  amazonRegisterReusePatchInstalled = false;
}

function initAlexa(force = false, mode = 'runtime', reqHost = null) {
  if (mode === 'runtime') {
    return initRuntimeDirect(force);
  }

  if (isInitialized && !force) return Promise.resolve();
  if (isInitializing) return Promise.reject(new Error('Initialization already in progress'));

  if (force) {
    alexa = new AlexaRemote();
    isInitialized = false;
    devicesCache = [];
    defaultDevice = null;
  }

  const options = buildAlexaOptions(mode, reqHost);
  let proxyAuthSaved = false;

  console.log('[INIT] starting mode =', mode);
  console.log('[INIT] amazonPage =', options.amazonPage);
  console.log('[INIT] acceptLanguage =', options.acceptLanguage);
  console.log('[INIT] alexaServiceHost =', options.alexaServiceHost);
  console.log('[INIT] amazonPageProxyLanguage =', options.amazonPageProxyLanguage);
  console.log('[INIT] has saved cookie =', !!getSavedCookie());
  console.log('[INIT] has refresh token =', !!config.refreshToken);
  console.log('[INIT] will pass cookie =', !!options.cookie);
  console.log('[INIT] will pass refreshToken =', !!options.refreshToken);
  console.log('[INIT] will pass registrationData =', !!(options.registrationData || options.formerRegistrationData || options.macDms));

  options.cookieRefreshCallback = auth => {
    try {
      if (auth && proxyAuthLooksUsable(auth)) {
        saveProxyAuthResult(auth, mode === 'proxy' ? 'LOGIN' : 'REFRESH');
        proxyAuthSaved = true;
      }
    } catch (err) {
      console.error('[LOGIN] failed to save proxy auth callback:', err);
    }
  };

  if (mode === 'proxy') console.log('[INIT] proxyOwnIp =', options.proxyOwnIp, 'proxyPort =', options.proxyPort);

  if (mode === 'proxy') {
    installAmazonRegisterReusePatch();
  }

  isInitializing = true;
  lastError = null;

  return new Promise((resolve, reject) => {
    alexa.init(options, async (err, newConfig) => {
      isInitializing = false;
      isLoginProxyRunning = false;

      if (err) {
        
          const errMsg = String(err && (err.message || err.code || err) || '');
          if (mode === 'proxy' && (proxyAuthSaved || (config.cookie && config.csrf && config.refreshToken)) &&
              (errMsg.includes('no csrf') || errMsg.includes('ECONNRESET') || errMsg.includes('retrieving cookies'))) {
            console.warn('[LOGIN] proxy auth was saved before init error. Continuing with direct runtime.');
            isLoginProxyRunning = false;
            await restartDirectRuntimeAfterSavedProxyLogin(reqHost);
            resolve(publicStatus());
            return;
          }
lastError = err;
        console.error('[INIT] error:', err);
        return reject(err);
      }

      console.log('[INIT] complete');
      const rawInstanceAuthPatch = extractAuthFromAlexaInstance(alexa);
      const instanceAuthPatch = Object.assign(
        {},
        rawInstanceAuthPatch,
        rawInstanceAuthPatch.cookie ? buildCookieTimingPatch(rawInstanceAuthPatch) : {}
      );

      if (Object.keys(instanceAuthPatch).length) {
        if (lastCapturedRegistrationDeviceName) instanceAuthPatch.deviceName = lastCapturedRegistrationDeviceName;
        cleanAuthRegistrationFields(instanceAuthPatch);
        if (!config.deviceCreated) instanceAuthPatch.deviceCreated = new Date().toISOString();
        instanceAuthPatch.fullReauthRequired = false;
        instanceAuthPatch.lastRefreshError = null;
        instanceAuthPatch.lastRefreshErrorCode = null;
        instanceAuthPatch.lastRefreshErrorAt = null;
        saveConfig(instanceAuthPatch);
        console.log('[AUTH] saved instance fields:', Object.keys(instanceAuthPatch).join(', '));
      }

      mergeAndSaveAuth(newConfig);

      isInitialized = true;
      lastInitAt = new Date().toISOString();

      try {
        await initRuntimeDirect(true);
        if (config.hubitatCompatEnabled) {
          await safeHubitatAction('send server data after login', () => sendServerDataToHubitat(reqHost));
          await safeHubitatAction('send cookie after login', () => sendCookiesToHubitat(reqHost));
        }
        lastError = null;
      } catch (devErr) {
        lastError = devErr;
        console.error('[DEVICES] refresh after init failed:', devErr);
      }

      resolve();
    });
  });
}

function pickDefaultDevice(devices) {
  if (!devices || !Array.isArray(devices)) return null;

  if (config.defaultSerialNumber && config.defaultDeviceType) {
    const saved = devices.find(d => d.serialNumber === config.defaultSerialNumber && d.deviceType === config.defaultDeviceType);
    if (saved) return saved;
  }

  const preferredFamilies = ['ECHO', 'KNIGHT', 'WHA', 'VOX', 'TABLET'];
  for (const fam of preferredFamilies) {
    const d = devices.find(dev => dev.online && dev.deviceFamily === fam && dev.serialNumber && dev.deviceType);
    if (d) return d;
  }

  return devices.find(d => d.online && d.serialNumber && d.deviceType) || null;
}

function refreshDevices() {
  if (!isInitialized) return Promise.reject(new Error('Not initialized'));

  return directRequest('GET', `/api/devices-v2/device?cached=true&_=${Date.now()}`)
    .then(res => {
      devicesCache = res && Array.isArray(res.devices) ? res.devices : [];
      defaultDevice = pickDefaultDevice(devicesCache);
      console.log('[DEVICES] found', devicesCache.length, 'default:', defaultDevice ? defaultDevice.accountName : 'none');
      return devicesCache;
    })
    .catch(err => {
      lastError = err;
      console.error('[DEVICES] error:', err);
      throw err;
    });
}


async function getDevicePreferenceDataForSpeak(target) {
  const serial = target && (target.serialNumber || target.deviceSerialNumber || target.serial);

  try {
    const prefs = await directRequest('GET', `/api/device-preferences?cached=true&_=${Date.now()}`);
    const list = prefs && Array.isArray(prefs.devicePreferences) ? prefs.devicePreferences : [];

    const matched = serial
      ? list.find(p => String(p.deviceSerialNumber || p.serialNumber || '') === String(serial)) || null
      : null;

    const accountPreference = list.find(p => p && p.searchCustomerId) || null;

    return {
      matched,
      accountPreference,
      list
    };
  } catch (err) {
    console.warn('[SPEAK] device-preferences lookup failed:', err && err.message ? err.message : String(err));
    return {
      matched: null,
      accountPreference: null,
      list: []
    };
  }
}

function normalizeLocaleForSpeak(value) {
  const locale = String(value || config.acceptLanguage || 'en-US').split(',')[0].replace('_', '-');
  if (!locale) return 'en-US';

  const parts = locale.split('-');
  if (parts.length === 2) return `${parts[0].toLowerCase()}-${parts[1].toUpperCase()}`;
  return locale;
}

function getCustomerIdFromPreferences(preferenceData) {
  if (!preferenceData) return '';

  return (
    (preferenceData.matched && preferenceData.matched.searchCustomerId) ||
    (preferenceData.accountPreference && preferenceData.accountPreference.searchCustomerId) ||
    ''
  );
}

async function speakDirect(target, text) {
  const preferenceData = await getDevicePreferenceDataForSpeak(target);
  const preference = preferenceData.matched;
  const accountPreference = preferenceData.accountPreference;

  const serial =
    (target && (target.serialNumber || target.deviceSerialNumber || target.serial)) ||
    (preference && preference.deviceSerialNumber);

  const type =
    (target && (target.deviceType || target.deviceTypeId || target.type)) ||
    (preference && preference.deviceType);

  const customerId =
    (target && target.customerId) ||
    (target && target.searchCustomerId) ||
    getCustomerIdFromPreferences(preferenceData) ||
    config.searchCustomerId ||
    config.customerId ||
    '';

  const locale = normalizeLocaleForSpeak(
    (preference && preference.locale) ||
    (accountPreference && accountPreference.locale) ||
    (target && target.locale) ||
    config.acceptLanguage ||
    'en-US'
  );

  if (!serial || !type) {
    throw new Error('Missing device serialNumber or deviceType for speak');
  }

  if (!customerId) {
    throw new Error('Missing customerId/searchCustomerId for speak');
  }

  const sequenceJson = JSON.stringify({
    '@type': 'com.amazon.alexa.behaviors.model.Sequence',
    startNode: {
      '@type': 'com.amazon.alexa.behaviors.model.OpaquePayloadOperationNode',
      type: 'Alexa.Speak',
      operationPayload: {
        deviceType: type,
        deviceSerialNumber: serial,
        locale,
        customerId,
        textToSpeak: String(text || '')
      }
    }
  });

  const body = {
    behaviorId: 'PREVIEW',
    sequenceJson,
    status: 'ENABLED'
  };

  console.log('[SPEAK] behavior payload:', JSON.stringify({
    behaviorId: body.behaviorId,
    status: body.status,
    deviceFamily: target && target.deviceFamily,
    deviceType: type,
    deviceSerialNumber: serial,
    locale,
    hasMatchedPreference: Boolean(preference),
    usedAccountPreference: Boolean(!preference && accountPreference),
    hasCustomerId: Boolean(customerId),
    textLength: String(text || '').length
  }));

  return directRequest('POST', '/api/behaviors/preview', body);
}


function deviceSummary(d) {
  if (!d) return null;
  return {
    accountName: d.accountName,
    deviceFamily: d.deviceFamily,
    deviceType: d.deviceType,
    serialNumber: d.serialNumber,
    online: d.online
  };
}


function findTarget(body) {
  body = body || {};

  const serial =
    body.serialNumber ||
    body.deviceSerialNumber ||
    body.serial ||
    null;

  const type =
    body.deviceType ||
    body.deviceTypeId ||
    body.type ||
    null;

  const name =
    body.device ||
    body.deviceName ||
    body.name ||
    body.accountName ||
    body.friendlyName ||
    null;

  if (serial) {
    const found = devicesCache.find(d => {
      const dSerial = d.serialNumber || d.deviceSerialNumber || d.serial;
      const dType = d.deviceType || d.deviceTypeId || d.type;

      if (String(dSerial || '') !== String(serial)) return false;
      if (type && String(dType || '') !== String(type)) return false;

      return true;
    });

    if (found) return found;

    if (type) {
      return {
        accountName: 'Provided device',
        serialNumber: serial,
        deviceType: type
      };
    }
  }

  if (name) {
    const wanted = String(name).trim().toLowerCase();

    const found = devicesCache.find(d =>
      String(d.accountName || '').trim().toLowerCase() === wanted ||
      String(d.friendlyName || '').trim().toLowerCase() === wanted ||
      String(d.name || '').trim().toLowerCase() === wanted
    );

    if (found) return found;
  }

  if (defaultDevice) return defaultDevice;

  if (config.defaultSerialNumber && config.defaultDeviceType) {
    return {
      accountName: 'Configured default',
      serialNumber: config.defaultSerialNumber,
      deviceType: config.defaultDeviceType
    };
  }

  return null;
}


function isoFromMs(ms) {
  if (!ms || !Number.isFinite(ms)) return null;
  return new Date(ms).toISOString();
}

function getCookieCreatedMs() {
  const fromCookieCreated = Date.parse(config.cookieCreated || '');
  if (Number.isFinite(fromCookieCreated)) return fromCookieCreated;

  const fromAuthCreated = Date.parse(config.deviceCreated || '');
  if (Number.isFinite(fromAuthCreated)) return fromAuthCreated;

  return null;
}

function getCookieExpiresMs() {
  const fromCookieExpires = Date.parse(config.cookieExpires || '');
  if (Number.isFinite(fromCookieExpires)) return fromCookieExpires;

  const createdMs = getCookieCreatedMs();
  const ttl = Number(config.cookieTtlSeconds || 0);
  if (createdMs && ttl > 0) return createdMs + ttl * 1000;

  return null;
}

function getCookieDaysRemaining() {
  const expiresMs = getCookieExpiresMs();
  if (!expiresMs) return null;

  const remainingMs = expiresMs - Date.now();
  return Math.max(0, Math.round((remainingMs / 86400000) * 10) / 10);
}

function getCookieAgeDays() {
  const createdMs = getCookieCreatedMs();
  if (!createdMs) return null;

  const ageMs = Date.now() - createdMs;
  return Math.max(0, Math.round((ageMs / 86400000) * 10) / 10);
}

function extractCookieTtlSeconds(result) {
  const candidates = [
    result && result.website_cookies_ttl,
    result && result.cookieTtlSeconds,
    result && result.tokens && result.tokens.website_cookies_ttl,
    result && result.tokens && result.tokens.ttl,
    result && result.response && result.response.tokens && result.response.tokens.ttl,
    result && result.response && result.response.success && result.response.success.tokens && result.response.success.tokens.website_cookies_ttl
  ];

  for (const v of candidates) {
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) return n;
  }

  return 2592000;
}

function buildCookieTimingPatch(result, createdDate = new Date()) {
  const ttl = extractCookieTtlSeconds(result || {});
  const createdMs = createdDate.getTime();
  const expiresMs = createdMs + ttl * 1000;

  return {
    cookieCreated: new Date(createdMs).toISOString(),
    cookieTtlSeconds: ttl,
    cookieExpires: new Date(expiresMs).toISOString()
  };
}

function backfillCookieTimingIfNeeded() {
  if (!(config.cookie || config.localCookie || config.loginCookie)) return;
  if (config.cookieCreated && config.cookieTtlSeconds && config.cookieExpires) return;

  const created = config.legacyAuthUpdatedRemoved || config.deviceCreated || new Date().toISOString();
  const ttl = Number(config.cookieTtlSeconds || 2592000);
  const createdMs = Date.parse(created);
  if (!Number.isFinite(createdMs)) return;

  const patch = {
    cookieCreated: new Date(createdMs).toISOString(),
    cookieTtlSeconds: ttl,
    cookieExpires: new Date(createdMs + ttl * 1000).toISOString()
  };

  saveConfig(patch);
}


function classifyAuthRefreshError(err) {
  const message = err && err.message ? String(err.message) : String(err || '');
  const stack = err && err.stack ? String(err.stack) : '';
  const combined = `${message}\n${stack}`;

  const invalidRefreshToken =
    /source_token/i.test(combined) ||
    /invalid parameter/i.test(combined) ||
    /InvalidValue/i.test(combined) ||
    /InvalidToken/i.test(combined) ||
    /No new access token in Refresh Token response/i.test(combined);

  if (invalidRefreshToken) {
    return {
      code: 'REFRESH_TOKEN_INVALID',
      message: 'Saved Amazon refresh token is no longer valid. Full Reauth is required.',
      action: 'full_reauth_required',
      fullReauthRequired: true
    };
  }

  return {
    code: 'REFRESH_FAILED',
    message: message || 'Refresh failed',
    action: 'retry_or_full_reauth',
    fullReauthRequired: false
  };
}

function buildRefreshErrorResponse(err) {
  const classified = classifyAuthRefreshError(err);

  return {
    ok: false,
    error: classified.message,
    code: classified.code,
    action: classified.action,
    fullReauthRequired: classified.fullReauthRequired
  };
}

function saveRefreshFailureState(err) {
  const classified = classifyAuthRefreshError(err);

  saveConfig({
    lastRefreshError: classified.message,
    lastRefreshErrorCode: classified.code,
    lastRefreshErrorAt: new Date().toISOString(),
    fullReauthRequired: classified.fullReauthRequired
  });

  return classified;
}


function publicStatus() {
  cleanupStoredRegistrationDataIfNeeded();
  backfillCookieTimingIfNeeded();

  const savedCookie = getSavedCookie();

  return {
    ok: true,
    runtimeMode: 'direct-cookie-rest',

    initialized: isInitialized,
    initializing: isInitializing,
    loginProxyRunning: isLoginProxyRunning,
    lastInitAt,
    lastError: safeError(lastError),

    port: getServerPort(),
    proxyPort: getProxyPort(),
    proxyOwnIp: config.proxyOwnIp || 'localhost',

    deviceAppName: config.deviceAppName || APP_NAME,
    amazonPage: config.amazonPage || 'amazon.com',
    acceptLanguage: config.acceptLanguage || 'en-US,en;q=0.9',
    alexaServiceHost: config.alexaServiceHost || 'pitangui.amazon.com',
    amazonPageProxyLanguage: config.amazonPageProxyLanguage || 'en_US',

    deviceName: getRegisteredDeviceName(),
    deviceCreated: config.deviceCreated || null,
    authAgeDays: config.deviceCreated
      ? Math.floor((Date.now() - new Date(config.deviceCreated).getTime()) / 86400000)
      : null,

    hasRefreshToken: !!config.refreshToken,
    hasCookie: !!savedCookie,
    hasLoginCookie: !!config.loginCookie,
    hasRegistrationData: !!(config.registrationData || config.macDms),
    hasMacDms: !!config.macDms,
    hasCsrf: !!getCsrf(),
    cookieHash: savedCookie ? shortHash(savedCookie) : null,
    cookieCreated: config.cookieCreated || null,
    cookieExpires: config.cookieExpires || null,
    cookieTtlSeconds: Number(config.cookieTtlSeconds || 0) || null,
    cookieTtlDays: config.cookieTtlSeconds
      ? Math.round((Number(config.cookieTtlSeconds) / 86400) * 10) / 10
      : null,
    cookieAgeDays: getCookieAgeDays(),
    cookieDaysRemaining: getCookieDaysRemaining(),

    fullReauthRequired: Boolean(config.fullReauthRequired),
    lastRefreshErrorCode: config.lastRefreshErrorCode || null,
    lastRefreshError: config.lastRefreshError || null,
    lastRefreshErrorAt: config.lastRefreshErrorAt || null,

    deviceCount: devicesCache.length,
    defaultDevice: deviceSummary(defaultDevice),

    apiKeyEnabled: !!config.apiKey,

    echoSpeaksVersion: getEchoSpeaksVersion(),
    hubitatCompatEnabled: !!config.hubitatCompatEnabled,
    hubitatCallbackConfigured: !!config.hubitatCallbackUrl,
    hubitatCallbackUrl: config.hubitatCallbackUrl || '',
    hubitatServerUrl: config.hubitatServerUrl || getAutoServerUrl(),
    hubitatLastSyncAt: config.hubitatLastSyncAt || null,
    hubitatLastSyncStatus: config.hubitatLastSyncStatus || null,
    hubitatLastSyncError: config.hubitatLastSyncError || null,
    hubitatLastAction: config.hubitatLastAction || null,
    hubitatLastEndpoint: config.hubitatLastEndpoint || null,
    hubitatLastResponseStatusCode: config.hubitatLastResponseStatusCode || null,
    hubitatLastResponseBody: config.hubitatLastResponseBody || null
  };
}

function clearSessionAuthOnly() {
  const keep = Object.assign({}, config || loadConfig());

  delete keep.cookie;
  delete keep.localCookie;
  delete keep.loginCookie;
  delete keep.csrf;
  delete keep.refreshToken;
  delete keep.accessToken;
  delete keep.tokenDate;
  delete keep.cookieCreated;
  delete keep.cookieTtlSeconds;
  delete keep.cookieExpires;
  delete keep.fullReauthRequired;
  delete keep.lastRefreshError;
  delete keep.lastRefreshErrorCode;
  delete keep.lastRefreshErrorAt;
  delete keep.authUpdated;
  delete keep.deviceCreated;

  // Clear all saved Amazon device registration material.
  // Next Amazon Login will register as a brand new Amazon device.
  delete keep.registrationData;
  delete keep.macDms;
  delete keep.deviceSerial;
  delete keep.deviceRegisteredName;
  delete keep.deviceName;
  delete keep.deviceId;
  delete keep.frc;
  delete keep['map-md'];

  config = normalizeConfig(keep);
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf8');
  console.log('[CONFIG] saved', CONFIG_FILE);
  return config;
}

function clearAuthOnly() {
  clearSessionAuthOnly();
}

function clearAllAuthAndRegistration() {
  saveConfig({
    refreshToken: '',
    cookie: '',
    localCookie: '',
    loginCookie: '',
    csrf: '',
    macDms: null,
    registrationData: null,
    deviceName: '',
    tokenDate: null,
    deviceCreated: null,
    cookieCreated: null,
    cookieTtlSeconds: null,
    cookieExpires: null,
    fullReauthRequired: false,
    lastRefreshError: null,
    lastRefreshErrorCode: null,
    lastRefreshErrorAt: null
  });
}

// -----------------------------------------------------------------------------
// Web UI
// -----------------------------------------------------------------------------

app.get('/', (req, res) => {
  const deviceRegistered = !!(config.registrationData || config.macDms);
  const registrationLocked = deviceRegistered
    ? 'readonly class="locked-field"'
    : '';

  res.type('html').send(`<!doctype html>
<html>
<head>
<link rel="icon" type="image/png" href="/images/echo-whispers-favicon-64.png">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <title>Echo Whispers</title>
  <style>
    body {
  -webkit-text-size-adjust: 100%; font-family: system-ui, -apple-system, Segoe UI, sans-serif; margin: 24px; max-width: 1000px; }
    input, textarea, select { width: 100%; box-sizing: border-box; padding: 8px; margin: 4px 0 10px; }
    button { padding: 8px 14px; margin: 6px 4px 6px 0; }
    pre { background: #111; color: #0f0; padding: 12px; overflow: auto; max-height: 360px; }
    .box { border: 1px solid #ccc; padding: 14px; border-radius: 6px; margin: 14px 0; }
    .hint { color: #555; font-size: 0.9em; }
  
.optional {
  font-weight: normal;
  opacity: 0.75;
}

.auth-refresh-bottom {
  margin-top: 14px;
}
.notice {
  margin-top: 6px;
  margin-bottom: 12px;
  opacity: 0.85;
}
.notice.code {
  font-family: monospace;
  font-size: 0.92em;
}
.restart-notice {
  margin-top: 0;
}


    input.locked-field {
      background: #f1f1f1;
      color: #777;
      border-color: #bbb;
      cursor: not-allowed;
    }

  
    details.section-toggle summary {
      cursor: pointer;
      font-size: 20px;
      font-weight: 700;
      margin-bottom: 8px;
    }
    details.section-toggle[open] summary {
      margin-bottom: 14px;
    }

  
@media (max-width: 700px) {
  body {
    font-size: 16px;
    padding: 10px;
  }

  .wrap,
  main,
  #app {
    max-width: 100%;
  }

  h1 {
    font-size: 24px;
    line-height: 1.2;
  }

  h2,
  summary {
    font-size: 18px;
  }

  .card,
  fieldset,
  section,
  details {
    padding: 14px;
    margin: 10px 0;
  }

  button,
  input,
  select,
  textarea {
    font-size: 16px;
  }

  button {
    min-height: 44px;
    padding: 10px 14px;
    margin: 4px 4px 4px 0;
  }

  input,
  select,
  textarea {
    width: 100%;
    max-width: 100%;
    min-height: 42px;
    box-sizing: border-box;
  }

  textarea {
    min-height: 86px;
  }

  .row,
  .button-row,
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
  }

  .row button,
  .button-row button,
  .actions button {
    flex: 1 1 auto;
  }

  label {
    display: block;
    margin-top: 8px;
    margin-bottom: 4px;
  }

  pre,
  code {
    font-size: 13px;
    white-space: pre-wrap;
    word-break: break-word;
  }

  #out,
  #output,
  .output {
    font-size: 13px;
    max-width: 100%;
    overflow-wrap: anywhere;
  }
}

@media (max-width: 430px) {
  body {
    font-size: 17px;
    padding: 8px;
  }

  h1 {
    font-size: 22px;
  }

  h2,
  summary {
    font-size: 18px;
  }

  button {
    width: 100%;
    min-height: 48px;
    font-size: 17px;
    margin: 4px 0;
  }

  input,
  select,
  textarea {
    font-size: 17px;
    min-height: 46px;
  }

  .row,
  .button-row,
  .actions {
    flex-direction: column;
  }

  .row button,
  .button-row button,
  .actions button {
    width: 100%;
  }
}


/* Mobile polish for form controls */
@media (max-width: 700px) {
  input,
  select,
  textarea {
    border: 1px solid #c8c8c8;
    background: #fff;
  }

  input::placeholder,
  textarea::placeholder {
    color: #8a8a8a;
    opacity: 1;
  }

  input[type="checkbox"] {
    width: 24px;
    height: 24px;
    min-height: 24px;
    margin: 0 10px 0 0;
    flex: 0 0 auto;
  }

  label:has(input[type="checkbox"]) {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 8px 0 14px 0;
  }

  label:has(input[type="checkbox"]) input[type="checkbox"] {
    margin: 0;
  }
}

@media (max-width: 430px) {
  input,
  select,
  textarea {
    border: 1px solid #c4c4c4;
  }

  input[type="checkbox"] {
    width: 26px;
    height: 26px;
    min-height: 26px;
  }

  label:has(input[type="checkbox"]) {
    font-size: 17px;
    line-height: 1.25;
  }
}


@media (max-width: 700px) {
  .checkbox-label {
    display: flex;
    align-items: center;
    gap: 14px;
    margin: 8px 0 14px 0;
  }

  .checkbox-label input[type="checkbox"] {
    width: 24px;
    height: 24px;
    min-height: 24px;
    margin: 0;
    flex: 0 0 auto;
  }

  .checkbox-label span {
    display: inline-block;
  }
}

@media (max-width: 430px) {
  .checkbox-label input[type="checkbox"] {
    width: 26px;
    height: 26px;
    min-height: 26px;
  }
}


/* Locked Settings fields after Amazon device registration exists */
.locked-field,
input:disabled,
select:disabled,
textarea:disabled {
  background: #f2f2f2;
  color: #555;
  border-color: #d0d0d0;
  opacity: 1;
  cursor: not-allowed;
}

@media (max-width: 700px) {
  .locked-field,
  input:disabled,
  select:disabled,
  textarea:disabled {
    background: #f2f2f2;
    color: #555;
    border-color: #d0d0d0;
    opacity: 1;
  }
}


.title-row {
  display: flex;
  align-items: center;
  gap: 10px;
}

.title-icon {
  width: 64px;
  height: 64px;
  object-fit: contain;
  flex: 0 0 auto;
}

@media (max-width: 700px) {
  .title-icon {
    width: 52px;
    height: 52px;
  }

  .title-row {
    gap: 8px;
  }
}

@media (max-width: 430px) {
  .title-icon {
    width: 46px;
    height: 46px;
  }
}


.brand-blue {
  color: ${COLOR_DARK_BLUE};
}

.app-header {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 18px;
  text-align: left;
}

.app-header .title-row {
  margin: 0;
  line-height: 1;
  display: flex;
  align-items: center;
  justify-content: flex-start;
  text-align: left;
  width: auto;
}

.app-header .title-row span {
  display: inline-block;
  line-height: 1;
  text-align: left;
}

.app-header-meta {
  color: ${COLOR_DARK_BLUE};
  text-align: right;
  font-size: 14px;
  line-height: 1.35;
  margin-top: 0;
  margin-bottom: 0;
  padding-bottom: 0;
  white-space: nowrap;
  align-self: flex-end;
}

.section-title-blue > summary,
details.section-title-blue > summary {
  color: ${COLOR_DARK_BLUE};
}

@media (max-width: 700px) {
  .app-header {
    flex-direction: column;
    gap: 6px;
  }

  .app-header-meta {
    text-align: left;
    margin-top: 0;
    white-space: normal;
    font-size: 14px;
    align-self: flex-start;
  }
}

/* Force app header left alignment */

@media (max-width: 700px) {
  .app-header {
    align-items: flex-start;
    justify-content: flex-start;
    text-align: left;
  }

  .app-header .title-row {
    justify-content: flex-start;
    text-align: left;
    width: 100%;
  }
}

@media (max-width: 430px) {
  .app-header .title-row {
    justify-content: flex-start;
    text-align: left;
  }
}


.app-header h1.title-row {
  text-align: left;
  justify-content: flex-start;
}


.get-preview {
  margin-top: 10px;
  font-family: monospace;
  font-size: 13px;
  word-break: break-all;
  overflow-wrap: anywhere;
}

.get-preview a {
  color: ${COLOR_DARK_BLUE};
  text-decoration: underline;
}


@media (max-width: 700px) {
  .get-preview {
    font-size: 13px;
  }
}


.speak-control-row {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  margin-bottom: 12px;
}

.speak-control-row button {
  margin: 0;
}

.speak-inline-control {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin: 0;
  white-space: nowrap;
}

.speak-inline-control input[type="number"] {
  width: 76px;
  min-width: 76px;
  min-height: 36px;
  text-align: center;
}

.speak-inline-control input[type="checkbox"] {
  width: 18px;
  height: 18px;
  min-height: 18px;
  margin: 0;
}

@media (max-width: 700px) {
  .speak-control-row {
    gap: 8px;
  }

  .speak-inline-control input[type="number"] {
    width: 88px;
    min-width: 88px;
  }
}

@media (max-width: 430px) {
  .speak-control-row {
    align-items: stretch;
  }

  .speak-control-row button {
    width: auto;
    flex: 1 1 auto;
  }

  .speak-inline-control {
    flex: 1 1 100%;
  }
}


.echo-speaks-enable-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 8px 0 14px 0;
  width: fit-content;
}

.echo-speaks-enable-row input[type="checkbox"] {
  width: 18px !important;
  height: 18px !important;
  min-height: 18px !important;
  margin: 0;
}

</style>


</head>
<body>
  <div class="app-header">
  <h1 class="title-row brand-blue"><img class="title-icon" src="/images/echo-whispers-icon-256.png" alt=""> <span>Echo Whispers</span></h1>
  <div class="app-header-meta">
    <div>Developed by: ${APP_AUTHOR}</div>
    <div>Current Version: v${APP_VERSION} - ${APP_COPYRIGHT}</div>
  </div>
</div>

  <div class="box">
<button onclick="startLogin()">Amazon Login</button>
<button onclick="refreshCookie()">Refresh Cookie</button>
    <button onclick="clearAuth()">Clear Login</button>
    <div id="authInfo" class="hint"></div>
  
<div class="auth-refresh-bottom">
  <button onclick="status()">Refresh</button>
</div>

</div>

  <div class="box">
    <div class="speak-control-row">
      <button onclick="devices()">Load Devices</button>
      <button onclick="speak()">Speak</button>
      <label class="speak-inline-control" for="speakVolume">
        <span>Volume:</span>
        <input id="speakVolume" type="number" min="0" max="100" step="1" inputmode="numeric" placeholder="0-100" onkeydown="return allowVolumeKey(event)" oninput="clampSpeakVolumeField(false)" onblur="clampSpeakVolumeField(true)">
      </label>
      <label class="speak-inline-control">
        <span>Restore:</span>
        <input id="restoreVolume" type="checkbox" checked onchange="updateSpeakGetLink()">
      </label>
    </div>

    <select id="deviceSelect" onchange="updateSpeakGetLink()"></select>
    <textarea id="speakText" rows="2" oninput="updateSpeakGetLink()">Hello from Echo Whispers</textarea>

    <div class="get-preview">
      <a id="speakGetLink" href="#" target="_blank" rel="noopener">Load devices and enter text to build URL</a>
    </div>
  </div>


  

  <div class="box">
    <details class="section-toggle section-title-blue">
<summary>Settings</summary>

<label for="deviceAppName">Device App Name:</label>
<input id="deviceAppName" value="${config.deviceAppName === 'Alexa Speaks' ? 'Echo Whispers' : (config.deviceAppName || 'Echo Whispers')}" ${registrationLocked} />

<label for="amazonPage">Amazon Page:</label>
<input id="amazonPage" value="${config.amazonPage || 'amazon.com'}" ${registrationLocked} />

<label for="acceptLanguage">Accept Language:</label>
<input id="acceptLanguage" value="${config.acceptLanguage || 'en-US,en;q=0.9'}" ${registrationLocked} />

<label for="amazonPageProxyLanguage">Proxy Language:</label>
<input id="amazonPageProxyLanguage" value="${config.amazonPageProxyLanguage || 'en_US'}" ${registrationLocked} />

<label for="alexaServiceHost">Alexa Service Host:</label>
<input id="alexaServiceHost" value="${config.alexaServiceHost || 'pitangui.amazon.com'}" ${registrationLocked} />


<label for="port">Server Port:</label>
<input id="port" type="number" min="1" max="65535" step="1" value="${config.port || PORT}" />

<label for="proxyPort">Proxy Port:</label>
<input id="proxyPort" type="number" min="1" max="65535" step="1" value="${config.proxyPort || DEFAULT_PROXY_PORT}" />

<label for="apiKey">API Key: <span class="optional">(optional)</span></label>
<input id="apiKey" value="${config.apiKey || ''}" placeholder="Use with ?apiKey=xxx or x-api-key header" />

<div class="notice restart-notice">
  Server should be restarted after Settings updates.
</div>

<button onclick="saveSettings()">Save Settings</button>
    </details>
  </div>

  <div class="box">
    <details class="section-toggle section-title-blue">
<summary>Echo Speaks Compatibility</summary>
    <label class="echo-speaks-enable-row">
      <span>Enable Echo Speaks Server:</span>
      <input id="hubitatCompatEnabled" type="checkbox" ${config.hubitatCompatEnabled ? 'checked' : ''} />
    </label>

    <label for="hubitatCallbackUrl">Echo Speaks App Callback URL:</label>
    <input id="hubitatCallbackUrl" value="${config.hubitatCallbackUrl || ''}" placeholder="https://cloud.hubitat.com/api/.../receiveData?access_token=..." />

    <label for="hubitatServerUrl">Echo Whispers Server URL:</label>
    <input id="hubitatServerUrl" value="${config.hubitatServerUrl || getAutoServerUrl()}" placeholder="${getAutoServerUrl()}" />

    <label for="echoSpeaksVersion">Echo Speaks Server Version:</label>
    <input id="echoSpeaksVersion" value="${config.echoSpeaksVersion || DEFAULT_ECHO_SPEAKS_VERSION}" />

    <button onclick="saveHubitatSettings()">Save Settings</button>
    <br>
    <button onclick="sendHubitatServerData()">Send Info</button>
    <button onclick="sendHubitatCookie()">Send Cookie</button>
    <button onclick="pullHubitatCookie()">Pull Cookie</button>
    <button onclick="clearHubitatCookie()">Clear Cookie</button>

    <div id="hubitatInfo" class="hint"></div>
    </details>
  </div>
<pre id="out"></pre>

<script>
window.echoWhispersCurrentApiKey = ${JSON.stringify(config.apiKey || '')};

function getUiApiKey() {
  const el = document.getElementById('apiKey');
  const fieldValue = el ? String(el.value || '') : '';
  return fieldValue || window.echoWhispersCurrentApiKey || '';
}

function rememberUiApiKey(value) {
  window.echoWhispersCurrentApiKey = String(value || '');
}

function out(x) {
  document.getElementById('out').textContent = typeof x === 'string' ? x : JSON.stringify(x, null, 2);
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[c]));
}

function formatTimeBoth(value, emptyText = 'Unknown') {
  if (!value) return emptyText;

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return escapeHtml(value);

  const pad = n => String(n).padStart(2, '0');
  const hours24 = date.getHours();
  const ampm = hours24 >= 12 ? 'PM' : 'AM';
  const hours12 = hours24 % 12 || 12;

  return escapeHtml(
    date.getFullYear() + '-' +
    pad(date.getMonth() + 1) + '-' +
    pad(date.getDate()) + ' ' +
    hours12 + ':' +
    pad(date.getMinutes()) + ':' +
    pad(date.getSeconds()) + ' ' +
    ampm
  );
}

async function api(path, opts) {
  const options = Object.assign({}, opts || {});
  const headers = Object.assign({ 'Content-Type': 'application/json' }, options.headers || {});
  const apiKey = getUiApiKey();

  if (apiKey) {
    headers['x-api-key'] = apiKey;
  }

  options.headers = headers;

  const res = await fetch(path, options);
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch(e) { data = text; }

  if (data && data.ok === false && res.status === 401) {
    data.hint = 'API key is enabled. The UI will use the API Key field as x-api-key. To clear it, leave the field blank and click Save Settings.';
  }

  out(data);
  return data;
}


function setDeviceCreatedLocks(statusData) {
  const locked = !!(statusData && statusData.deviceCreated);
  const ids = [
    'deviceAppName',
    'amazonPage',
    'acceptLanguage',
    'amazonPageProxyLanguage',
    'alexaServiceHost',
    // Server Port, Proxy Port, and API Key must always remain editable.
    // They can be changed without rebuilding the Amazon device registration.

  ];

  ids.forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    el.disabled = locked;
    el.readOnly = locked;
    el.classList.toggle('locked-field', locked);
  });
}

function applyStatusUiState(statusData) {
  setDeviceCreatedLocks(statusData);
}

async function refreshUiAfterAction(delayMs = 250) {
  if (delayMs) await new Promise(resolve => setTimeout(resolve, delayMs));
  await status();
}

function startLoginStatusPolling(durationMs = 90000, intervalMs = 2000) {
  const started = Date.now();

  if (window.echoWhispersLoginPoller) {
    clearInterval(window.echoWhispersLoginPoller);
  }

  window.echoWhispersLoginPoller = setInterval(async () => {
    try {
      await status();

      const s = window.echoWhispersStatus || {};
      const done = !!s.initialized || !!s.deviceCreated || !!s.hasCookie;
      const expired = Date.now() - started > durationMs;

      if (done || expired) {
        clearInterval(window.echoWhispersLoginPoller);
        window.echoWhispersLoginPoller = null;
      }
    } catch (err) {
      // Keep polling until timeout.
      if (Date.now() - started > durationMs) {
        clearInterval(window.echoWhispersLoginPoller);
        window.echoWhispersLoginPoller = null;
      }
    }
  }, intervalMs);
}


function getSelectedSpeakDevice() {
  const select = document.getElementById('deviceSelect');
  if (!select || !select.value) return {};

  const parts = select.value.split('|');
  return {
    serialNumber: parts[0] || '',
    deviceType: parts[1] || ''
  };
}


function allowVolumeKey(event) {
  if (['Backspace', 'Delete', 'Tab', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return true;
  if ((event.ctrlKey || event.metaKey) && ['a', 'c', 'v', 'x'].includes(event.key.toLowerCase())) return true;
  return /^[0-9]$/.test(event.key);
}

function clampSpeakVolumeField(force) {
  const volumeEl = document.getElementById('speakVolume');
  if (!volumeEl) return;

  let value = String(volumeEl.value || '').replace(/[^0-9]/g, '');
  if (value === '') {
    volumeEl.value = '';
    updateSpeakGetLink();
    return;
  }

  let n = Math.max(0, Math.min(100, Math.round(Number(value))));
  volumeEl.value = force || Number(value) > 100 ? String(n) : value;
  updateSpeakGetLink();
}

function getSpeakVolumeOptions() {
  const volumeEl = document.getElementById('speakVolume');
  const restoreEl = document.getElementById('restoreVolume');

  const rawVolume = volumeEl ? volumeEl.value : '';
  const volume = rawVolume === '' ? null : Math.max(0, Math.min(100, Math.round(Number(rawVolume))));

  return {
    volume: Number.isFinite(volume) ? volume : null,
    restoreVolume: restoreEl ? !!restoreEl.checked : true
  };
}

function buildSpeakGetUrl() {
  const textEl = document.getElementById('speakText');
  const text = textEl ? textEl.value || '' : '';
  const device = getSelectedSpeakDevice();

  const url = new URL('/api/speak', window.location.origin);
  if (text) url.searchParams.set('text', text);
  if (device.serialNumber) url.searchParams.set('serialNumber', device.serialNumber);
  if (device.deviceType) url.searchParams.set('deviceType', device.deviceType);

  const volumeOptions = getSpeakVolumeOptions();
  if (volumeOptions.volume !== null) {
    url.searchParams.set('volume', String(volumeOptions.volume));
    url.searchParams.set('restoreVolume', String(volumeOptions.restoreVolume));
  }

  const status = window.echoWhispersStatus || {};
  if (status.apiKeyEnabled) {
    const apiKey = getUiApiKey();
    if (apiKey) url.searchParams.set('apiKey', apiKey);
  }

  return url.toString();
}

function updateSpeakGetLink() {
  const link = document.getElementById('speakGetLink');
  if (!link) return;

  const url = buildSpeakGetUrl();
  link.href = url;
  link.textContent = url;
}

async function status() {
  const s = await api('/api/status');
  window.echoWhispersStatus = s;
  applyStatusUiState(s);

  const auth = document.getElementById('authInfo');
  if (auth) {
    const registered = s.deviceName ? escapeHtml(s.deviceName) : 'No';
    auth.innerHTML =
      'Device Registered: ' + registered +
      '<br>Device Created: ' + formatTimeBoth(s.deviceCreated) +
      '<br>Cookie Hash: ' + (s.cookieHash ? escapeHtml(s.cookieHash) : 'None') +
      '<br>Cookie Created: ' + formatTimeBoth(s.cookieCreated) +
      '<br>Cookie Expires: ' + formatTimeBoth(s.cookieExpires) +
      '<br>CSRF: ' + (s.hasCsrf ? 'Yes' : 'No');
  }

  const hubitat = document.getElementById('hubitatInfo');
  if (hubitat) {
    hubitat.innerHTML =
      'Last Sync: ' + formatTimeBoth(s.hubitatLastSyncAt, 'Never') +
      '<br>Last Status: ' + escapeHtml(s.hubitatLastSyncStatus || 'None') +
      '<br>Last Error: ' + escapeHtml(s.hubitatLastSyncError || 'None') +
      '<br>Last Action: ' + escapeHtml(s.hubitatLastAction || 'None') +
      '<br>Last Response Code: ' + escapeHtml(s.hubitatLastResponseStatusCode ?? 'None') +
      '<br>Last Response: ' + escapeHtml(s.hubitatLastResponseBody || 'None');
  }

  updateSpeakGetLink();
  return s;
}

async function saveSettings() {
  const newApiKey = document.getElementById('apiKey').value || '';

  const result = await api('/api/config', {
    method: 'POST',
    body: JSON.stringify({
      amazonPage: document.getElementById('amazonPage').value || 'amazon.com',
      acceptLanguage: document.getElementById('acceptLanguage').value || 'en-US,en;q=0.9',
      deviceAppName: (document.getElementById('deviceAppName').value === 'Alexa Speaks'
        ? 'Echo Whispers'
        : document.getElementById('deviceAppName').value) || 'Echo Whispers',
      amazonPageProxyLanguage: document.getElementById('amazonPageProxyLanguage').value || 'en_US',
      alexaServiceHost: document.getElementById('alexaServiceHost').value || 'pitangui.amazon.com',
      port: document.getElementById('port')
        ? Number(document.getElementById('port').value || ${config.port || PORT})
        : ${config.port || PORT},
      proxyPort: Number(document.getElementById('proxyPort').value || ${config.proxyPort || DEFAULT_PROXY_PORT}),
      apiKey: newApiKey,
      currentApiKey: getUiApiKey()
    })
  });

  if (result && result.ok !== false) {
    rememberUiApiKey(newApiKey);
  }

  await refreshUiAfterAction();
}

async function saveHubitatSettings() {
  await api('/api/hubitat/config', {
    method: 'POST',
    body: JSON.stringify({
      hubitatCompatEnabled: document.getElementById('hubitatCompatEnabled').checked,
      echoSpeaksVersion: document.getElementById('echoSpeaksVersion').value || '2.8.0',
      hubitatCallbackUrl: document.getElementById('hubitatCallbackUrl').value || '',
      hubitatServerUrl: document.getElementById('hubitatServerUrl').value || ''
    })
  });

  await refreshUiAfterAction();
}

async function sendHubitatServerData() {
  await api('/api/hubitat/send-server-data', { method: 'POST', body: '{}' });
  await refreshUiAfterAction();
}

async function sendHubitatCookie() {
  await api('/api/hubitat/send-cookie', { method: 'POST', body: '{}' });
  await refreshUiAfterAction();
}

async function pullHubitatCookie() {
  await api('/api/hubitat/pull-cookie', { method: 'POST', body: '{}' });
  await refreshUiAfterAction();
}

async function clearHubitatCookie() {
  await api('/api/hubitat/cookie', { method: 'DELETE', body: '{}' });
  await refreshUiAfterAction();
}

async function startLogin() {
  const data = await api('/api/login/start', { method: 'POST', body: '{}' });
  if (data.proxyUrl) {
    window.open(data.proxyUrl, 'alexaLogin', 'width=520,height=760,menubar=no,toolbar=no,location=yes,status=yes');
  }

  startLoginStatusPolling();
  await refreshUiAfterAction();
}

async function refreshCookie() {
  const s = window.echoWhispersStatus || await api('/api/status');
  window.echoWhispersStatus = s;

  if (!s.deviceCreated) {
    out({ ok: true, skipped: true, message: 'No deviceCreated value. Refresh Cookie skipped.' });
    return;
  }

  await api('/api/auth/refresh-cookie', { method: 'POST', body: '{}' });
  await refreshUiAfterAction();
}

async function fullReauth() {
  const data = await api('/api/auth/full-reauth', { method: 'POST', body: '{}' });
  if (data.proxyUrl) {
    window.open(data.proxyUrl, 'alexaLogin', 'width=520,height=760,menubar=no,toolbar=no,location=yes,status=yes');
  }

  startLoginStatusPolling();
  await refreshUiAfterAction();
}

async function clearAuth() {
  const s = window.echoWhispersStatus || await api('/api/status');
  window.echoWhispersStatus = s;

  if (!s.deviceCreated) {
    out({ ok: true, skipped: true, message: 'No deviceCreated value. Clear Login skipped.' });
    return;
  }

  if (!(await confirmClearLoginDeviceReset())) return;

  await api('/api/clear', { method: 'POST', body: '{}' });
  await refreshUiAfterAction();
}

async function devices() {
  const data = await api('/api/devices');
  const select = document.getElementById('deviceSelect');
  select.innerHTML = '';
  select.onchange = updateSpeakGetLink;

  if (data.devices) {
    data.devices.forEach(device => {
      const option = document.createElement('option');
      option.value = device.serialNumber + '|' + device.deviceType;
      option.textContent = [
        device.accountName,
        device.deviceFamily,
        device.deviceType,
        device.online ? 'online' : 'offline'
      ].join(' - ');
      select.appendChild(option);
    });
  }

  updateSpeakGetLink();
  await refreshUiAfterAction();
}

async function speak() {
  updateSpeakGetLink();
  const parts = document.getElementById('deviceSelect').value.split('|');
  const body = { text: document.getElementById('speakText').value };
  const volumeOptions = getSpeakVolumeOptions();

  if (volumeOptions.volume !== null) {
    body.volume = volumeOptions.volume;
    body.restoreVolume = volumeOptions.restoreVolume;
  }

  if (parts[0] && parts[1]) {
    body.serialNumber = parts[0];
    body.deviceType = parts[1];
  }

  await api('/api/speak', { method: 'POST', body: JSON.stringify(body) });
  await refreshUiAfterAction();
}

status();

function confirmClearLoginDeviceReset() {
  return new Promise(resolve => {
    const existing = document.getElementById('clearLoginConfirmOverlay');
    if (existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.id = 'clearLoginConfirmOverlay';
    overlay.style.position = 'fixed';
    overlay.style.inset = '0';
    overlay.style.background = 'rgba(0,0,0,0.35)';
    overlay.style.display = 'flex';
    overlay.style.alignItems = 'center';
    overlay.style.justifyContent = 'center';
    overlay.style.zIndex = '9999';

    const box = document.createElement('div');
    box.style.background = '#fff';
    box.style.color = '#111';
    box.style.borderRadius = '10px';
    box.style.padding = '20px 24px';
    box.style.maxWidth = '620px';
    box.style.width = window.innerWidth <= 430 ? 'calc(100% - 40px)' : 'calc(100% - 96px)';
    box.style.boxShadow = '0 8px 24px rgba(0,0,0,0.20)';
    box.style.border = '1px solid #d0d7de';

    const msg = document.createElement('div');
    msg.style.marginBottom = '16px';
    msg.style.lineHeight = '1.35';
    msg.style.textAlign = 'center';
    msg.style.fontSize = window.innerWidth <= 430 ? '16px' : '15px';
    msg.textContent = 'Notice: This will clear all saved login and device registration information. The next Amazon Login will register Echo Whispers as a new Amazon device. Any older Echo Whispers device registrations will remain in Amazon until you remove them. Do you wish to continue?';

    const buttons = document.createElement('div');
    buttons.style.display = 'flex';
    buttons.style.gap = '12px';
    buttons.style.justifyContent = 'center';

    const cancel = document.createElement('button');
    cancel.textContent = 'Cancel';
    cancel.autofocus = true;
    cancel.style.minWidth = window.innerWidth <= 430 ? '130px' : '110px';
    cancel.style.height = window.innerWidth <= 430 ? '44px' : '38px';

    const cont = document.createElement('button');
    cont.textContent = 'Continue';
    cont.style.minWidth = window.innerWidth <= 430 ? '130px' : '110px';
    cont.style.height = window.innerWidth <= 430 ? '44px' : '38px';
    cont.style.color = '#b00020';
    cont.style.fontWeight = '700';

    function close(value) {
      overlay.remove();
      resolve(value);
    }

    cancel.onclick = () => close(false);
    cont.onclick = () => close(true);
    overlay.onclick = e => {
      if (e.target === overlay) close(false);
    };
    document.addEventListener('keydown', function escHandler(e) {
      if (e.key === 'Escape') {
        document.removeEventListener('keydown', escHandler);
        close(false);
      }
    });

    buttons.appendChild(cancel);
    buttons.appendChild(cont);
    box.appendChild(msg);
    box.appendChild(buttons);
    overlay.appendChild(box);
    document.body.appendChild(overlay);
    cancel.focus();
  });
}


function fixMobileCheckboxLabels() {
  document.querySelectorAll('label input[type="checkbox"]').forEach(cb => {
    const label = cb.closest('label');
    if (label && !label.classList.contains('echo-speaks-enable-row')) label.classList.add('checkbox-label');
  });
}
document.addEventListener('DOMContentLoaded', fixMobileCheckboxLabels);


document.addEventListener('DOMContentLoaded', () => {
  if (window.echoWhispersStatus) applyStatusUiState(window.echoWhispersStatus);
});

</script>
</body>
</html>`);
});

function buildEchoSpeaksWakeupPayload(reqHost = null) {
  const serverUrl = getHubitatServerUrl(reqHost);

  return {
    ok: true,
    success: true,
    status: 'ok',
    name: APP_NAME,
    serverName: APP_NAME,
    version: getEchoSpeaksVersion(),
    echoSpeaksVersion: getEchoSpeaksVersion(),
    onHeroku: false,
    isLocal: true,
    serverUrl,
    host: serverUrl,
    port: getServerPort(),
    proxyPort: getProxyPort(),
    hasCookie: !!getSavedCookie(),
    hasCsrf: !!config.csrf,
    hasRefreshToken: !!config.refreshToken,
    hasRegistrationData: !!(config.registrationData || config.macDms),
    timestamp: new Date().toISOString()
  };
}

function echoSpeaksWakeup(req, res) {
  const payload = buildEchoSpeaksWakeupPayload(getHostFromRequest(req));
  res.json(payload);
}

// Echo Speaks compatibility endpoints used by the Hubitat app.
// -----------------------------------------------------------------------------
// Echo Speaks compatibility endpoints
// -----------------------------------------------------------------------------

app.get('/wakeup', echoSpeaksWakeup);
app.post('/wakeup', echoSpeaksWakeup);

app.get('/refreshCookie', async (req, res) => {
  try {
    const result = await refreshCookieFromRefreshToken();
    res.json(Object.assign(buildEchoSpeaksWakeupPayload(getHostFromRequest(req)), {
      refreshed: true,
      result
    }));
  } catch (err) {
    res.status(500).json({ ok: false, success: false, error: safeError(err) });
  }
});

app.post('/refreshCookie', async (req, res) => {
  try {
    const result = await refreshCookieFromRefreshToken();
    res.json(Object.assign(buildEchoSpeaksWakeupPayload(getHostFromRequest(req)), {
      refreshed: true,
      result
    }));
  } catch (err) {
    res.status(500).json({ ok: false, success: false, error: safeError(err) });
  }
});

app.get('/clearAuth', (req, res) => {
  if (!config.deviceCreated) {
    return res.json(Object.assign(buildEchoSpeaksWakeupPayload(getHostFromRequest(req)), {
      skipped: true,
      cleared: false,
      message: 'No deviceCreated value. Clear Login skipped.'
    }));
  }

  clearAuthOnly();
  res.json(Object.assign(buildEchoSpeaksWakeupPayload(getHostFromRequest(req)), {
    cleared: true
  }));
});

app.post('/clearAuth', (req, res) => {
  if (!config.deviceCreated) {
    return res.json(Object.assign(buildEchoSpeaksWakeupPayload(getHostFromRequest(req)), {
      skipped: true,
      cleared: false,
      message: 'No deviceCreated value. Clear Login skipped.'
    }));
  }

  clearAuthOnly();
  res.json(Object.assign(buildEchoSpeaksWakeupPayload(getHostFromRequest(req)), {
    cleared: true
  }));
});

// -----------------------------------------------------------------------------
// Core API endpoints
// -----------------------------------------------------------------------------

app.get('/health', (req, res) => res.json({ ok: true, initialized: isInitialized }));


app.post('/api/settings', requireApiKey, (req, res) => {
  const body = req.body || {};
  if (config.registrationData || config.macDms) {
    delete body.deviceAppName;
    delete body.amazonPage;
    delete body.acceptLanguage;
    delete body.amazonPageProxyLanguage;
    delete body.alexaServiceHost;
  }

  const patch = {};

  if (Object.prototype.hasOwnProperty.call(body, 'deviceAppName')) {
    patch.deviceAppName = String(body.deviceAppName || 'Echo Whispers').trim() || 'Echo Whispers';
  }

  if (Object.prototype.hasOwnProperty.call(body, 'acceptLanguage')) {
    patch.acceptLanguage = String(body.acceptLanguage || 'en-US,en;q=0.9').trim() || 'en-US,en;q=0.9';
  }

  if (Object.prototype.hasOwnProperty.call(body, 'amazonPageProxyLanguage')) {
    patch.amazonPageProxyLanguage = String(body.amazonPageProxyLanguage || 'en_US').trim() || 'en_US';
  }

  if (Object.prototype.hasOwnProperty.call(body, 'amazonPage')) {
    patch.amazonPage = String(body.amazonPage || 'amazon.com').trim() || 'amazon.com';
  }

  if (Object.prototype.hasOwnProperty.call(body, 'alexaServiceHost')) {
    patch.alexaServiceHost = String(body.alexaServiceHost || 'pitangui.amazon.com').trim() || 'pitangui.amazon.com';
  }

  if (Object.prototype.hasOwnProperty.call(body, 'hubitatCompatEnabled')) {
    patch.hubitatCompatEnabled = body.hubitatCompatEnabled === true || String(body.hubitatCompatEnabled).toLowerCase() === 'true';
  }

  if (Object.prototype.hasOwnProperty.call(body, 'hubitatCallbackUrl')) {
    patch.hubitatCallbackUrl = asTrimmedString(body.hubitatCallbackUrl);
  }

  if (Object.prototype.hasOwnProperty.call(body, 'hubitatServerUrl')) {
    patch.hubitatServerUrl = asTrimmedString(body.hubitatServerUrl);
  }

  if (Object.prototype.hasOwnProperty.call(body, 'echoSpeaksVersion')) {
    patch.echoSpeaksVersion = asTrimmedString(body.echoSpeaksVersion, DEFAULT_ECHO_SPEAKS_VERSION);
  }

  saveConfig(patch);

  res.json({
    ok: true,
    saved: patch,
    status: publicStatus()
  });
});


app.get('/api/config', requireApiKey, (req, res) => {
  cleanupStoredRegistrationDataIfNeeded();

  res.json({
    ok: true,
    port: getServerPort(),
    amazonPage: config.amazonPage || 'amazon.com',
    alexaServiceHost: config.alexaServiceHost || 'pitangui.amazon.com',
    acceptLanguage: config.acceptLanguage || 'en-US,en;q=0.9',
    deviceAppName: config.deviceAppName || 'Echo Whispers',
    apiKey: config.apiKey || '',
    amazonPageProxyLanguage: config.amazonPageProxyLanguage || 'en_US',
    hubitatCompatEnabled: !!config.hubitatCompatEnabled,
    hubitatCallbackUrl: config.hubitatCallbackUrl || '',
    hubitatServerUrl: config.hubitatServerUrl || getAutoServerUrl(),
    hubitatLastSyncAt: config.hubitatLastSyncAt || null,
    hubitatLastSyncStatus: config.hubitatLastSyncStatus || null,
    hubitatLastSyncError: config.hubitatLastSyncError || null,

    cookie: config.cookie || null,
    localCookie: config.localCookie || null,
    loginCookie: config.loginCookie || null,
    csrf: config.csrf || null,

    refreshToken: config.refreshToken || null,
    macDms: cleanRegistrationData(config.macDms),
    registrationData: cleanRegistrationData(config.registrationData || config.macDms),

    cookieCreated: config.cookieCreated || null,
    cookieExpires: config.cookieExpires || null,
    cookieTtlSeconds: Number(config.cookieTtlSeconds || 0) || null,
    cookieTtlDays: config.cookieTtlSeconds ? Math.round((Number(config.cookieTtlSeconds) / 86400) * 10) / 10 : null,
    cookieAgeDays: getCookieAgeDays(),
    cookieDaysRemaining: getCookieDaysRemaining(),

    frc: config.frc || null,
    'map-md': config['map-md'] || null,
    deviceId: config.deviceId || null,
    deviceSerial: config.deviceSerial || null,
    dataVersion: config.dataVersion || null,

    deviceCreated: config.deviceCreated || null,
    fullReauthRequired: Boolean(config.fullReauthRequired),
    lastRefreshErrorCode: config.lastRefreshErrorCode || null,
    lastRefreshError: config.lastRefreshError || null,
    lastRefreshErrorAt: config.lastRefreshErrorAt || null
  });
});


app.get('/api/status', (req, res) => res.json(publicStatus()));


app.get('/api/hubitat/status', requireApiKey, (req, res) => {
  res.json({
    ok: true,
    echoSpeaksVersion: getEchoSpeaksVersion(),
    enabled: !!config.hubitatCompatEnabled,
    callbackConfigured: !!config.hubitatCallbackUrl,
    callbackUrl: config.hubitatCallbackUrl || '',
    serverUrl: getHubitatServerUrl(getHostFromRequest(req)),
    lastSyncAt: config.hubitatLastSyncAt || null,
    lastSyncStatus: config.hubitatLastSyncStatus || null,
    lastSyncError: config.hubitatLastSyncError || null,
    lastAction: config.hubitatLastAction || null,
    lastEndpoint: config.hubitatLastEndpoint || null,
    lastResponseStatusCode: config.hubitatLastResponseStatusCode || null,
    lastResponseBody: config.hubitatLastResponseBody || null
  });
});

app.post('/api/hubitat/config', requireApiKey, (req, res) => {
  const body = req.body || {};

  const patch = {};
  if (Object.prototype.hasOwnProperty.call(body, 'hubitatCompatEnabled')) {
    patch.hubitatCompatEnabled = body.hubitatCompatEnabled === true || String(body.hubitatCompatEnabled).toLowerCase() === 'true';
  }
  if (Object.prototype.hasOwnProperty.call(body, 'hubitatCallbackUrl')) {
    patch.hubitatCallbackUrl = asTrimmedString(body.hubitatCallbackUrl);
  }
  if (Object.prototype.hasOwnProperty.call(body, 'hubitatServerUrl')) {
    patch.hubitatServerUrl = asTrimmedString(body.hubitatServerUrl);
  }
  if (Object.prototype.hasOwnProperty.call(body, 'echoSpeaksVersion')) {
    patch.echoSpeaksVersion = asTrimmedString(body.echoSpeaksVersion, DEFAULT_ECHO_SPEAKS_VERSION);
  }

  saveConfig(patch);

  res.json({
    ok: true,
    saved: patch,
    status: publicStatus()
  });
});

app.post('/api/hubitat/send-server-data', requireApiKey, async (req, res) => {
  try {
    const result = await sendServerDataToHubitat(getHostFromRequest(req));
    res.json({ ok: true, result, status: publicStatus() });
  } catch (err) {
    res.status(500).json({ ok: false, error: safeError(err), status: publicStatus() });
  }
});

app.post('/api/hubitat/send-cookie', requireApiKey, async (req, res) => {
  try {
    const result = await sendCookiesToHubitat(getHostFromRequest(req));
    res.json({ ok: true, result, status: publicStatus() });
  } catch (err) {
    res.status(500).json({ ok: false, error: safeError(err), status: publicStatus() });
  }
});

app.post('/api/hubitat/pull-cookie', requireApiKey, async (req, res) => {
  try {
    const result = await pullCookiesFromHubitat();
    res.json({ ok: true, result, status: publicStatus() });
  } catch (err) {
    res.status(500).json({ ok: false, error: safeError(err), status: publicStatus() });
  }
});

app.delete('/api/hubitat/cookie', requireApiKey, async (req, res) => {
  try {
    const result = await clearHubitatCookie();
    res.json({ ok: true, result, status: publicStatus() });
  } catch (err) {
    res.status(500).json({ ok: false, error: safeError(err), status: publicStatus() });
  }
});


app.post('/api/config', requireApiKey, (req, res) => {
  const body = req.body || {};
  const patch = {};
  [
    'amazonPage','acceptLanguage','amazonPageProxyLanguage','alexaServiceHost',
    'proxyPort','proxyOwnIp','proxyListenBind','port','apiKey','deviceAppName',
    'defaultSerialNumber','defaultDeviceType','hubitatCompatEnabled','hubitatCallbackUrl','hubitatServerUrl','echoSpeaksVersion'
  ].forEach(k => {
    if (Object.prototype.hasOwnProperty.call(body, k)) patch[k] = body[k];
  });
  if (Object.prototype.hasOwnProperty.call(patch, 'deviceAppName')) {
    patch.deviceAppName = String(patch.deviceAppName || 'Echo Whispers').trim() || 'Echo Whispers';
  }

  if (Object.prototype.hasOwnProperty.call(patch, 'hubitatCompatEnabled')) {
    patch.hubitatCompatEnabled = patch.hubitatCompatEnabled === true || String(patch.hubitatCompatEnabled).toLowerCase() === 'true';
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'hubitatCallbackUrl')) {
    patch.hubitatCallbackUrl = String(patch.hubitatCallbackUrl || '').trim();
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'hubitatServerUrl')) {
    patch.hubitatServerUrl = String(patch.hubitatServerUrl || '').trim();
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'echoSpeaksVersion')) {
    patch.echoSpeaksVersion = asTrimmedString(patch.echoSpeaksVersion, DEFAULT_ECHO_SPEAKS_VERSION);
  }

  if (Object.prototype.hasOwnProperty.call(patch, 'port')) {
    const port = Number(patch.port || PORT);
    patch.port = Number.isFinite(port) && port > 0 && port <= 65535 ? port : PORT;
  }

  if (Object.prototype.hasOwnProperty.call(patch, 'proxyPort')) {
    const proxyPort = Number(patch.proxyPort || DEFAULT_PROXY_PORT);
    patch.proxyPort = Number.isFinite(proxyPort) && proxyPort > 0 && proxyPort <= 65535 ? proxyPort : DEFAULT_PROXY_PORT;
  }

  saveConfig(patch);
  res.json(publicStatus());
});

app.post('/api/login/start', requireApiKey, async (req, res) => {
  try {
    const reqHost = getHostFromRequest(req);

    // Always force a proxy login. If a runtime cookie is already initialized,
    // leaving it active can prevent alexa-cookie2 from starting the proxy.
    // This clears only session auth and preserves registrationData/macDms.
    clearSessionAuthOnly();
    saveConfig({ proxyOwnIp: reqHost, proxyPort: getProxyPort() });

    alexa = new AlexaRemote();
    isInitialized = false;
    isInitializing = false;
    devicesCache = [];
    defaultDevice = null;

    isLoginProxyRunning = true;
    initAlexa(true, 'proxy', reqHost).catch(err => {
      isLoginProxyRunning = false;
      lastError = err;
      console.error('[LOGIN] proxy init error:', err);
    });

    res.json(Object.assign(publicStatus(), {
      ok: true,
      message: 'Amazon login started. Complete Amazon login in the popup.',
      proxyUrl: `http://${reqHost}:${getProxyPort()}/`
    }));
  } catch (err) {
    res.status(500).json({ ok: false, error: safeError(err) });
  }
});

app.post('/api/auth/refresh-cookie', requireApiKey, async (req, res) => {
  try {
    if (!config.deviceCreated) {
      return res.json(Object.assign(publicStatus(), {
        skipped: true,
        message: 'No deviceCreated value. Refresh Cookie skipped.'
      }));
    }

      //
    // Real refresh-token based cookie refresh.
    // This does not call /auth/register. App registration only happens during Amazon Login / Full Reauth.
    //
    const refreshResult = await refreshCookieFromRefreshToken();

    // Restart direct runtime against the newly saved cookie.
    isInitialized = false;
    devicesCache = [];
    defaultDevice = null;
    await initRuntimeDirect(true);
    if (config.hubitatCompatEnabled) {
      await safeHubitatAction('send cookie after refresh', () => sendCookiesToHubitat(getHostFromRequest(req)));
    }

    res.json(Object.assign(publicStatus(), {
      ok: true,
      message: 'Cookie refreshed using refreshToken without app re-registration.',
      cookieChanged: !!refreshResult.cookieChanged,
      before: refreshResult.before,
      after: refreshResult.after
    }));
  } catch (err) {
    lastError = err;
    console.error('[REFRESH_COOKIE] direct refresh failed:', err);
    const classified = saveRefreshFailureState(err);
    console.error('[REFRESH_COOKIE] direct refresh failed:', err && err.stack ? err.stack : err);

    const statusCode = classified.fullReauthRequired ? 409 : 500;
    return res.status(statusCode).json(buildRefreshErrorResponse(err));
  }
});


app.post('/api/auth/full-reauth', requireApiKey, async (req, res) => {
  try {
      const reqHost = getHostFromRequest(req);

    clearSessionAuthOnly();
    saveConfig({ proxyOwnIp: reqHost, proxyPort: getProxyPort() });

    alexa = new AlexaRemote();
    isInitialized = false;
    isInitializing = false;
    devicesCache = [];
    defaultDevice = null;

    isLoginProxyRunning = true;
    initAlexa(true, 'proxy', reqHost).catch(err => {
      isLoginProxyRunning = false;
      lastError = err;
      console.error('[FULL_REAUTH] proxy init error:', err);
    });

    res.json(Object.assign(publicStatus(), {
      ok: true,
      message: 'Full reauth started. Complete Amazon login in the popup.',
      proxyUrl: `http://${reqHost}:${getProxyPort()}/`
    }));
  } catch (err) {
    res.status(500).json({ ok: false, error: safeError(err) });
  }
});

app.post('/api/init', requireApiKey, async (req, res) => {
  try {
    await initAlexa(!!(req.body && req.body.force), 'runtime', getHostFromRequest(req));
    res.json(publicStatus());
  } catch (err) {
    res.status(500).json({ ok: false, error: safeError(err) });
  }
});

app.get('/api/devices', requireApiKey, async (req, res) => {
  try {
    if (!isInitialized) await initAlexa(false, 'runtime', getHostFromRequest(req));
    await refreshDevices();

    const devices = devicesCache.map(d => ({
      accountName: d.accountName,
      deviceFamily: d.deviceFamily,
      deviceType: d.deviceType,
      serialNumber: d.serialNumber,
      online: d.online,
      capabilities: d.capabilities || []
    }));

    res.json({ ok: true, count: devices.length, defaultDevice: deviceSummary(defaultDevice), devices });
  } catch (err) {
    res.status(500).json({ ok: false, error: safeError(err) });
  }
});


function findDeviceBySerial(serial) {
  const s = String(serial || '').trim();

  return devicesCache.find(d =>
    String(d.serialNumber || '') === s ||
    String(d.deviceSerialNumber || '') === s ||
    String(d.serial || '') === s
  );
}

function getDeviceSerial(device) {
  return device && (device.serialNumber || device.deviceSerialNumber || device.serial || null);
}

function getDeviceType(device) {
  return device && (device.deviceType || device.deviceTypeId || device.type || null);
}

async function getDeviceMediaState(device) {
  const serial = getDeviceSerial(device);
  const type = getDeviceType(device);
  if (!serial || !type) return null;

  return directRequest(
    'GET',
    `/api/media/state?deviceSerialNumber=${encodeURIComponent(serial)}&deviceType=${encodeURIComponent(type)}&_=${Date.now()}`
  );
}

async function getDeviceNowPlaying(device) {
  const serial = getDeviceSerial(device);
  const type = getDeviceType(device);
  if (!serial || !type) return null;

  return directRequest(
    'GET',
    `/api/np/player?deviceSerialNumber=${encodeURIComponent(serial)}&deviceType=${encodeURIComponent(type)}&_=${Date.now()}`
  );
}

async function getDndStatusList() {
  return directRequest('GET', `/api/dnd/device-status-list?_=${Date.now()}`);
}

async function getNotifications() {
  return directRequest('GET', `/api/notifications?_=${Date.now()}`);
}

function findDndForDevice(dnd, device) {
  const serial = getDeviceSerial(device);
  const type = getDeviceType(device);
  const list =
    (dnd && Array.isArray(dnd.deviceStatusList) && dnd.deviceStatusList) ||
    (dnd && Array.isArray(dnd) && dnd) ||
    [];

  return list.find(x =>
    String(x.deviceSerialNumber || x.serialNumber || '') === String(serial) ||
    (
      String(x.deviceSerialNumber || x.serialNumber || '') === String(serial) &&
      String(x.deviceType || '') === String(type)
    )
  ) || null;
}

function findNotificationsForDevice(notifications, device) {
  const serial = getDeviceSerial(device);
  const list =
    (notifications && Array.isArray(notifications.notifications) && notifications.notifications) ||
    (notifications && Array.isArray(notifications) && notifications) ||
    [];

  return list.filter(x =>
    String(x.deviceSerialNumber || x.serialNumber || '') === String(serial) ||
    String(x.originalDeviceSerialNumber || '') === String(serial)
  );
}

async function safeStatusPart(name, fn) {
  try {
    const data = await fn();
    return { ok: true, data };
  } catch (err) {
    return {
      ok: false,
      error: err && err.message ? err.message : String(err)
    };
  }
}


app.get('/api/devices/:serialNumber/status', requireApiKey, async (req, res) => {
  try {
    await initAlexa(false, 'runtime');

    const serial = String(req.params.serialNumber || '').trim();
    const device = findDeviceBySerial(serial);

    if (!device) {
      return res.status(404).json({
        ok: false,
        error: 'Device not found',
        serialNumber: serial,
        deviceCount: devicesCache.length
      });
    }

    const [mediaState, nowPlaying, dndList, notifications] = await Promise.all([
      safeStatusPart('mediaState', () => getDeviceMediaState(device)),
      safeStatusPart('nowPlaying', () => getDeviceNowPlaying(device)),
      safeStatusPart('dnd', () => getDndStatusList()),
      safeStatusPart('notifications', () => getNotifications())
    ]);

    const dnd = dndList.ok ? findDndForDevice(dndList.data, device) : null;
    const deviceNotifications = notifications.ok ? findNotificationsForDevice(notifications.data, device) : [];

    return res.json({
      ok: true,
      serialNumber: serial,
      deviceType: getDeviceType(device),
      name: device.accountName || device.friendlyName || device.name || null,
      device,
      status: {
        mediaState,
        nowPlaying,
        dnd: {
          ok: dndList.ok,
          data: dnd,
          sourceError: dndList.ok ? null : dndList.error
        },
        notifications: {
          ok: notifications.ok,
          count: deviceNotifications.length,
          data: deviceNotifications,
          sourceError: notifications.ok ? null : notifications.error
        }
      }
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: err && err.message ? err.message : String(err)
    });
  }
});


app.get('/api/devices/:serialNumber', requireApiKey, async (req, res) => {
  try {
    await initAlexa(false, 'runtime');

    const serial = String(req.params.serialNumber || '').trim();

    const device = devicesCache.find(d =>
      String(d.serialNumber || '') === serial ||
      String(d.deviceSerialNumber || '') === serial ||
      String(d.serial || '') === serial
    );

    if (!device) {
      return res.status(404).json({
        ok: false,
        error: 'Device not found',
        serialNumber: serial,
        deviceCount: devicesCache.length
      });
    }

    return res.json({
      ok: true,
      serialNumber: serial,
      device
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: err && err.message ? err.message : String(err)
    });
  }
});


function getVolumeFromStatusResponse(status) {
  if (!status) return null;

  const candidates = [
    status.volume,
    status.volumeLevel,
    status.currentVolume,
    status.data && status.data.volume,
    status.data && status.data.volumeLevel,
    status.mediaState && status.mediaState.data && status.mediaState.data.volume,
    status.playerInfo && status.playerInfo.volume,
    status.data && status.data.playerInfo && status.data.playerInfo.volume
  ];

  for (const value of candidates) {
    if (value === undefined || value === null || value === '') continue;

    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }

  return null;
}

function normalizeVolumeLevel(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(100, Math.round(n)));
}

async function getVolumeDirect(target) {
  const serial = target.serialNumber || target.deviceSerialNumber || target.serial;
  const type = target.deviceType || target.deviceTypeId || target.type;

  if (!serial || !type) {
    throw new Error('Missing device serialNumber/deviceType for volume read');
  }

  // /api/media/state is where Amazon returns the current volume for these devices.
  const mediaState = await directRequest(
    'GET',
    `/api/media/state?deviceSerialNumber=${encodeURIComponent(serial)}&deviceType=${encodeURIComponent(type)}&_=${Date.now()}`
  );

  return getVolumeFromStatusResponse(mediaState);
}

async function setVolumeDirect(target, level) {
  const preferenceData = await getDevicePreferenceDataForSpeak(target);
  const preference = preferenceData.matched;
  const accountPreference = preferenceData.accountPreference;

  const serial =
    (target && (target.serialNumber || target.deviceSerialNumber || target.serial)) ||
    (preference && preference.deviceSerialNumber);

  const type =
    (target && (target.deviceType || target.deviceTypeId || target.type)) ||
    (preference && preference.deviceType);

  const customerId =
    (target && target.customerId) ||
    (target && target.searchCustomerId) ||
    getCustomerIdFromPreferences(preferenceData) ||
    config.searchCustomerId ||
    config.customerId ||
    '';

  const locale = normalizeLocaleForSpeak(
    (preference && preference.locale) ||
    (accountPreference && accountPreference.locale) ||
    (target && target.locale) ||
    config.acceptLanguage ||
    'en-US'
  );

  const safeLevel = normalizeVolumeLevel(level);

  if (!serial || !type) {
    throw new Error('Missing device serialNumber/deviceType for volume set');
  }

  if (!customerId) {
    throw new Error('Missing customerId/searchCustomerId for volume set');
  }

  if (safeLevel === null) {
    throw new Error('Invalid volume level');
  }

  const sequenceJson = JSON.stringify({
    '@type': 'com.amazon.alexa.behaviors.model.Sequence',
    startNode: {
      '@type': 'com.amazon.alexa.behaviors.model.SerialNode',
      nodesToExecute: [
        {
          '@type': 'com.amazon.alexa.behaviors.model.ParallelNode',
          nodesToExecute: [
            {
              '@type': 'com.amazon.alexa.behaviors.model.OpaquePayloadOperationNode',
              type: 'Alexa.DeviceControls.Volume',
              operationPayload: {
                deviceType: type,
                deviceSerialNumber: serial,
                locale,
                customerId,
                value: safeLevel
              }
            }
          ],
          name: null
        }
      ],
      name: null
    }
  });

  const body = {
    behaviorId: 'PREVIEW',
    sequenceJson,
    status: 'ENABLED'
  };

  console.log('[VOLUME] behavior payload:', JSON.stringify({
    behaviorId: body.behaviorId,
    status: body.status,
    deviceFamily: target && target.deviceFamily,
    deviceType: type,
    deviceSerialNumber: serial,
    locale,
    hasCustomerId: Boolean(customerId),
    value: safeLevel
  }));

  return directRequest('POST', '/api/behaviors/preview', body);
}

function parseBoolean(value, defaultValue) {
  if (value === undefined || value === null || value === '') return defaultValue;
  if (typeof value === 'boolean') return value;

  const s = String(value).trim().toLowerCase();
  if (['true', '1', 'yes', 'y', 'on'].includes(s)) return true;
  if (['false', '0', 'no', 'n', 'off'].includes(s)) return false;

  return defaultValue;
}


async function speakDirectWithVolumeSequence(target, text, requestedVolume, restoreVolume, originalVolume) {
  const preferenceData = await getDevicePreferenceDataForSpeak(target);
  const preference = preferenceData.matched;
  const accountPreference = preferenceData.accountPreference;

  const serial =
    (target && (target.serialNumber || target.deviceSerialNumber || target.serial)) ||
    (preference && preference.deviceSerialNumber);

  const type =
    (target && (target.deviceType || target.deviceTypeId || target.type)) ||
    (preference && preference.deviceType);

  const customerId =
    (target && target.customerId) ||
    (target && target.searchCustomerId) ||
    getCustomerIdFromPreferences(preferenceData) ||
    config.searchCustomerId ||
    config.customerId ||
    '';

  const locale = normalizeLocaleForSpeak(
    (preference && preference.locale) ||
    (accountPreference && accountPreference.locale) ||
    (target && target.locale) ||
    config.acceptLanguage ||
    'en-US'
  );

  const safeRequestedVolume = normalizeVolumeLevel(requestedVolume);
  const safeOriginalVolume = normalizeVolumeLevel(originalVolume);

  if (!serial || !type) {
    throw new Error('Missing device serialNumber/deviceType for speak volume sequence');
  }

  if (!customerId) {
    throw new Error('Missing customerId/searchCustomerId for speak volume sequence');
  }

  if (safeRequestedVolume === null) {
    throw new Error('Invalid requested volume level');
  }

  const nodesToExecute = [
    {
      '@type': 'com.amazon.alexa.behaviors.model.ParallelNode',
      nodesToExecute: [
        {
          '@type': 'com.amazon.alexa.behaviors.model.OpaquePayloadOperationNode',
          type: 'Alexa.DeviceControls.Volume',
          operationPayload: {
            deviceType: type,
            deviceSerialNumber: serial,
            locale,
            customerId,
            value: safeRequestedVolume
          }
        }
      ],
      name: null
    },
    {
      '@type': 'com.amazon.alexa.behaviors.model.ParallelNode',
      nodesToExecute: [
        {
          '@type': 'com.amazon.alexa.behaviors.model.OpaquePayloadOperationNode',
          type: 'Alexa.Speak',
          operationPayload: {
            deviceType: type,
            deviceSerialNumber: serial,
            locale,
            customerId,
            textToSpeak: String(text || '')
          }
        }
      ],
      name: null
    }
  ];

  if (restoreVolume && safeOriginalVolume !== null) {
    nodesToExecute.push({
      '@type': 'com.amazon.alexa.behaviors.model.ParallelNode',
      nodesToExecute: [
        {
          '@type': 'com.amazon.alexa.behaviors.model.OpaquePayloadOperationNode',
          type: 'Alexa.DeviceControls.Volume',
          operationPayload: {
            deviceType: type,
            deviceSerialNumber: serial,
            locale,
            customerId,
            value: safeOriginalVolume
          }
        }
      ],
      name: null
    });
  }

  const sequenceJson = JSON.stringify({
    '@type': 'com.amazon.alexa.behaviors.model.Sequence',
    startNode: {
      '@type': 'com.amazon.alexa.behaviors.model.SerialNode',
      nodesToExecute,
      name: null
    }
  });

  const body = {
    behaviorId: 'PREVIEW',
    sequenceJson,
    status: 'ENABLED'
  };

  console.log('[SPEAK_VOLUME_SEQUENCE] behavior payload:', JSON.stringify({
    behaviorId: body.behaviorId,
    status: body.status,
    deviceFamily: target && target.deviceFamily,
    deviceType: type,
    deviceSerialNumber: serial,
    locale,
    hasMatchedPreference: Boolean(preference),
    usedAccountPreference: Boolean(!preference && accountPreference),
    hasCustomerId: Boolean(customerId),
    requestedVolume: safeRequestedVolume,
    restoreVolume: Boolean(restoreVolume && safeOriginalVolume !== null),
    originalVolume: safeOriginalVolume,
    textLength: String(text || '').length,
    nodeCount: nodesToExecute.length
  }));

  return directRequest('POST', '/api/behaviors/preview', body);
}


function getSpeakRequestData(req) {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const query = req.query && typeof req.query === 'object' ? req.query : {};
  const params = req.params && typeof req.params === 'object' ? req.params : {};

  return Object.assign({}, body, query, params);
}

async function handleSpeakRequest(req, res) {
  let target = null;
  let originalVolume = null;
  let requestedVolume = null;
  let shouldRestoreVolume = false;
  let volumeAlreadyAtRequested = false;
  let volumeSet = false;
  let volumeRestore = {
    attempted: false,
    ok: null,
    error: null,
    mode: null
  };

  try {
    const data = getSpeakRequestData(req);
    const text = String(data.text || data.message || data.speech || '').trim();

    requestedVolume = normalizeVolumeLevel(data.volume ?? data.level ?? data.volumeLevel);
    shouldRestoreVolume = requestedVolume !== null
      ? parseBoolean(data.restoreVolume ?? data.restore ?? data.returnVolume, true)
      : false;

    if (!text) {
      return res.status(400).json({
        ok: false,
        error: 'Missing text',
        usage: {
          postBody: {
            url: '/api/speak',
            body: {
              serialNumber: 'G6G236093082061K',
              text: 'Hello',
              volume: 35,
              restoreVolume: true
            }
          },
          urlLine: '/api/speak/G6G236093082061K?text=Hello&volume=35&restoreVolume=true'
        }
      });
    }

    if (!isInitialized) await initAlexa(false, 'runtime', getHostFromRequest(req));
    if (!devicesCache.length) await refreshDevices();

    target = findTarget(data);
    if (!target) {
      return res.status(400).json({
        ok: false,
        error: 'No target device',
        request: {
          serialNumber: data.serialNumber || data.deviceSerialNumber || data.serial || null,
          deviceType: data.deviceType || data.deviceTypeId || data.type || null,
          device: data.device || data.deviceName || data.name || data.accountName || data.friendlyName || null
        }
      });
    }

    if (requestedVolume !== null) {
      try {
        originalVolume = await getVolumeDirect(target);
        volumeAlreadyAtRequested = normalizeVolumeLevel(originalVolume) === requestedVolume;

        if (volumeAlreadyAtRequested) {
          console.log('[SPEAK] requested volume already matches current volume, skipping volume change:', requestedVolume);
          shouldRestoreVolume = false;
        }
      } catch (err) {
        console.warn('[SPEAK] volume read failed:', err && err.message ? err.message : String(err));
      }
    }

    const payload = {
      textToSpeak: text,
      serialNumber: target.serialNumber || target.deviceSerialNumber || target.serial || null,
      deviceType: target.deviceType || target.deviceTypeId || target.type || null,
      requestedVolume,
      originalVolume,
      volumeAlreadyAtRequested,
      restoreVolume: shouldRestoreVolume
    };

    console.log('[SPEAK]', target.accountName || target.friendlyName || target.name, payload.serialNumber, payload.deviceType, text, requestedVolume !== null ? `volume=${requestedVolume}` : '');

    let result;
    try {
      if (requestedVolume !== null && !volumeAlreadyAtRequested) {
        result = await speakDirectWithVolumeSequence(target, text, requestedVolume, shouldRestoreVolume, originalVolume);
        volumeSet = true;
        volumeRestore.mode = 'single_behavior_sequence';
        volumeRestore.attempted = shouldRestoreVolume && originalVolume !== null;
        volumeRestore.ok = shouldRestoreVolume && originalVolume !== null ? true : null;
      } else {
        result = await speakDirect(target, text);
        if (requestedVolume !== null && volumeAlreadyAtRequested) {
          volumeRestore.mode = 'skipped_same_volume';
          volumeRestore.attempted = false;
          volumeRestore.ok = true;
        }
      }
    } catch (err) {
      lastError = err;
      console.error('[SPEAK] error:', err);
      return res.status(err.statusCode || 500).json({
        ok: false,
        error: safeError(err),
        target: deviceSummary(target),
        body: err.body || null,
        volume: {
          requested: requestedVolume,
          original: originalVolume,
          sameAsRequested: volumeAlreadyAtRequested,
          set: volumeSet,
          restore: volumeRestore
        }
      });
    }

    return res.json({
      ok: true,
      result,
      target: deviceSummary(target),
      payload,
      volume: {
        requested: requestedVolume,
        original: originalVolume,
        set: volumeSet,
        restore: volumeRestore
      }
    });
  } catch (err) {
    lastError = err;
    return res.status(err.statusCode || 500).json({
      ok: false,
      error: safeError(err),
      target: target ? deviceSummary(target) : null,
      body: err.body || null,
      volume: {
        requested: requestedVolume,
        original: originalVolume,
        set: volumeSet,
        restore: volumeRestore
      }
    });
  }
}


// -----------------------------------------------------------------------------
// Volume, Speak, and Announcement endpoints
// -----------------------------------------------------------------------------

app.post('/api/volume-sequence', requireApiKey, handleVolumeRequest);
app.post('/api/volume-sequence/:serialNumber', requireApiKey, handleVolumeRequest);
app.get('/api/volume-sequence', requireApiKey, handleVolumeRequest);
app.get('/api/volume-sequence/:serialNumber', requireApiKey, handleVolumeRequest);

app.post('/api/volume', requireApiKey, handleVolumeRequest);
app.post('/api/volume/:serialNumber', requireApiKey, handleVolumeRequest);
app.get('/api/volume', requireApiKey, handleVolumeRequest);
app.get('/api/volume/:serialNumber', requireApiKey, handleVolumeRequest);

async function handleVolumeRequest(req, res) {
  try {
    const data = getSpeakRequestData(req);
    const level = normalizeVolumeLevel(data.volume ?? data.level ?? data.volumeLevel);

    if (level === null) {
      return res.status(400).json({
        ok: false,
        error: 'Missing or invalid volume level',
        usage: '/api/volume/G6G236093082061K?level=35'
      });
    }

    if (!isInitialized) await initAlexa(false, 'runtime', getHostFromRequest(req));
    if (!devicesCache.length) await refreshDevices();

    const target = findTarget(data);
    if (!target) {
      return res.status(400).json({ ok: false, error: 'No target device' });
    }

    const original = await getVolumeDirect(target);
    const result = await setVolumeDirect(target, level);

    return res.json({
      ok: true,
      target: deviceSummary(target),
      original,
      requested: level,
      result
    });
  } catch (err) {
    lastError = err;
    return res.status(500).json({
      ok: false,
      error: safeError(err),
      body: err.body || null
    });
  }
}


app.post('/api/speak', requireApiKey, handleSpeakRequest);
app.post('/api/speak/:serialNumber', requireApiKey, handleSpeakRequest);
app.get('/api/speak', requireApiKey, handleSpeakRequest);
app.get('/api/speak/:serialNumber', requireApiKey, handleSpeakRequest);


function parseDeviceList(value) {
  if (!value) return [];

  if (Array.isArray(value)) return value;

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return [];

    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) return parsed;
    } catch (_) {}

    return trimmed
      .split(',')
      .map(s => s.trim())
      .filter(Boolean)
      .map(serialNumber => ({ serialNumber }));
  }

  return [];
}

function isAnnouncementCapableDevice(device) {
  if (!device) return false;

  const family = String(device.deviceFamily || '').toUpperCase();
  const serial = device.serialNumber || device.deviceSerialNumber || device.serial;
  const type = device.deviceType || device.deviceTypeId || device.type;

  if (!serial || !type) return false;
  if (device.online === false) return false;
  if (family === 'WHA') return false;

  return ['ECHO', 'KNIGHT', 'ROOK', 'SOUNDBAR'].includes(family);
}

function findAnnouncementDevice(item) {
  if (!item) return null;

  if (typeof item === 'string') {
    item = { serialNumber: item };
  }

  const serial =
    item.serialNumber ||
    item.deviceSerialNumber ||
    item.serial ||
    null;

  const type =
    item.deviceType ||
    item.deviceTypeId ||
    item.type ||
    null;

  const name =
    item.device ||
    item.deviceName ||
    item.name ||
    item.accountName ||
    item.friendlyName ||
    null;

  if (serial) {
    const found = devicesCache.find(d => {
      const dSerial = d.serialNumber || d.deviceSerialNumber || d.serial;
      const dType = d.deviceType || d.deviceTypeId || d.type;

      if (String(dSerial || '') !== String(serial)) return false;
      if (type && String(dType || '') !== String(type)) return false;

      return true;
    });

    if (found) return found;

    if (type) {
      return {
        accountName: item.name || item.accountName || 'Provided device',
        serialNumber: serial,
        deviceType: type,
        deviceFamily: item.deviceFamily || null,
        online: true
      };
    }
  }

  if (name) {
    const wanted = String(name).trim().toLowerCase();

    return devicesCache.find(d =>
      String(d.accountName || '').trim().toLowerCase() === wanted ||
      String(d.friendlyName || '').trim().toLowerCase() === wanted ||
      String(d.name || '').trim().toLowerCase() === wanted
    ) || null;
  }

  return null;
}

function getAllAnnouncementDevices() {
  return devicesCache.filter(isAnnouncementCapableDevice);
}

function uniqueAnnouncementDevices(devices) {
  const seen = new Set();
  const out = [];

  for (const d of devices) {
    if (!d) continue;

    const serial = d.serialNumber || d.deviceSerialNumber || d.serial;
    const type = d.deviceType || d.deviceTypeId || d.type;

    if (!serial || !type) continue;

    const key = `${type}:${serial}`;
    if (seen.has(key)) continue;

    seen.add(key);
    out.push(d);
  }

  return out;
}

async function getAnnouncementPreferenceData(devices) {
  try {
    const prefs = await directRequest('GET', `/api/device-preferences?cached=true&_=${Date.now()}`);
    const list = prefs && Array.isArray(prefs.devicePreferences) ? prefs.devicePreferences : [];

    const firstWithCustomer = list.find(p => p && p.searchCustomerId) || null;

    return {
      list,
      customerId: firstWithCustomer && firstWithCustomer.searchCustomerId ? firstWithCustomer.searchCustomerId : '',
      locale: firstWithCustomer && firstWithCustomer.locale ? firstWithCustomer.locale : null
    };
  } catch (err) {
    console.warn('[ANNOUNCE] device-preferences lookup failed:', err && err.message ? err.message : String(err));
    return {
      list: [],
      customerId: config.searchCustomerId || config.customerId || '',
      locale: null
    };
  }
}

function normalizeAnnouncementLocale(value) {
  const locale = String(value || config.acceptLanguage || 'en-US').split(',')[0].replace('_', '-');
  if (!locale) return 'en-US';

  const parts = locale.split('-');
  if (parts.length === 2) return `${parts[0].toLowerCase()}-${parts[1].toUpperCase()}`;
  return locale;
}

function buildAnnouncementDevices(devices) {
  return uniqueAnnouncementDevices(devices).map(d => ({
    deviceSerialNumber: d.serialNumber || d.deviceSerialNumber || d.serial,
    deviceType: d.deviceType || d.deviceTypeId || d.type
  }));
}

function buildAnnouncementPayload(text, title, devices, preferenceData) {
  const customerId =
    (preferenceData && preferenceData.customerId) ||
    config.searchCustomerId ||
    config.customerId ||
    '';

  const locale = normalizeAnnouncementLocale(
    (preferenceData && preferenceData.locale) ||
    config.acceptLanguage ||
    'en-US'
  );

  const announcementDevices = buildAnnouncementDevices(devices);

  if (!customerId) {
    throw new Error('Missing customerId/searchCustomerId for announcement');
  }

  if (!announcementDevices.length) {
    throw new Error('No announcement-capable target devices');
  }

  const sequenceJson = JSON.stringify({
    '@type': 'com.amazon.alexa.behaviors.model.Sequence',
    startNode: {
      '@type': 'com.amazon.alexa.behaviors.model.OpaquePayloadOperationNode',
      type: 'AlexaAnnouncement',
      operationPayload: {
        expireAfter: 'PT5S',
        content: [
          {
            locale,
            display: {
              title: title || config.deviceAppName || 'Echo Whispers',
              body: String(text || '')
            },
            speak: {
              type: 'text',
              value: String(text || '')
            }
          }
        ],
        target: {
          customerId,
          devices: announcementDevices
        }
      }
    }
  });

  return {
    behaviorId: 'PREVIEW',
    sequenceJson,
    status: 'ENABLED'
  };
}

function getAnnouncementRequestData(req) {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const query = req.query && typeof req.query === 'object' ? req.query : {};
  const params = req.params && typeof req.params === 'object' ? req.params : {};

  return Object.assign({}, body, query, params);
}

async function handleAnnounceRequest(req, res) {
  try {
    const data = getAnnouncementRequestData(req);
    const text = String(data.text || data.message || data.speech || '').trim();
    const title = String(data.title || config.deviceAppName || 'Echo Whispers').trim();

    if (!text) {
      return res.status(400).json({
        ok: false,
        error: 'Missing text',
        usage: {
          postBody: {
            url: '/api/announce',
            body: {
              devices: [
                { serialNumber: 'G6G236093082061K' },
                { serialNumber: 'GK61B505240503EQ' }
              ],
              text: 'Hello'
            }
          },
          urlLine: '/api/announce?devices=G6G236093082061K,GK61B505240503EQ&text=Hello'
        }
      });
    }

    if (!isInitialized) await initAlexa(false, 'runtime', getHostFromRequest(req));
    if (!devicesCache.length) await refreshDevices();

    const allMode =
      req.path.endsWith('/all') ||
      String(data.all || '').toLowerCase() === 'true' ||
      String(data.devices || '').toLowerCase() === 'all';

    let targetDevices = [];

    if (allMode) {
      targetDevices = getAllAnnouncementDevices();
    } else {
      const requested = parseDeviceList(data.devices || data.deviceList || data.serialNumbers || data.serialNumber || data.deviceSerialNumber || data.serial || data.device || data.name);

      targetDevices = requested
        .map(findAnnouncementDevice)
        .filter(Boolean)
        .filter(isAnnouncementCapableDevice);
    }

    targetDevices = uniqueAnnouncementDevices(targetDevices);

    if (!targetDevices.length) {
      return res.status(400).json({
        ok: false,
        error: 'No announcement-capable target devices',
        requested: data.devices || data.deviceList || data.serialNumbers || data.serialNumber || data.deviceSerialNumber || data.serial || data.device || data.name || null,
        allMode
      });
    }

    const preferenceData = await getAnnouncementPreferenceData(targetDevices);
    const payload = buildAnnouncementPayload(text, title, targetDevices, preferenceData);

    console.log('[ANNOUNCE] payload:', JSON.stringify({
      title,
      deviceCount: targetDevices.length,
      devices: targetDevices.map(d => ({
        name: d.accountName || d.friendlyName || d.name,
        serialNumber: d.serialNumber || d.deviceSerialNumber || d.serial,
        deviceType: d.deviceType || d.deviceTypeId || d.type,
        deviceFamily: d.deviceFamily
      })),
      hasCustomerId: Boolean(preferenceData.customerId),
      textLength: text.length
    }));

    const result = await directRequest('POST', '/api/behaviors/preview', payload);

    return res.json({
      ok: true,
      result,
      count: targetDevices.length,
      targets: targetDevices.map(deviceSummary),
      payload: {
        title,
        text,
        devices: buildAnnouncementDevices(targetDevices)
      }
    });
  } catch (err) {
    lastError = err;
    console.error('[ANNOUNCE] error:', err);
    return res.status(500).json({
      ok: false,
      error: safeError(err),
      body: err.body || null
    });
  }
}

app.post('/api/announce', requireApiKey, handleAnnounceRequest);
app.post('/api/announce/all', requireApiKey, handleAnnounceRequest);
app.get('/api/announce', requireApiKey, handleAnnounceRequest);
app.get('/api/announce/all', requireApiKey, handleAnnounceRequest);


app.post('/api/clear', requireApiKey, (req, res) => {
  try {
    if (!config.deviceCreated) {
      return res.json(Object.assign(publicStatus(), {
        skipped: true,
        message: 'No deviceCreated value. Clear Login skipped.'
      }));
    }

    clearAuthOnly();

    alexa = new AlexaRemote();
    isInitialized = false;
    isInitializing = false;
    isLoginProxyRunning = false;
    lastError = null;
    lastInitAt = null;
    devicesCache = [];
    defaultDevice = null;

    res.json(publicStatus());
  } catch (err) {
    res.status(500).json({ ok: false, error: safeError(err) });
  }
});

app.post('/api/reset-registration', requireApiKey, async (req, res) => {
  try {
    clearAllAuthAndRegistration();
    alexa = new AlexaRemote();
    isInitialized = false;
    isInitializing = false;
    devicesCache = [];
    defaultDevice = null;
    res.json(Object.assign(publicStatus(), {
      ok: true,
      message: 'All auth and registration data cleared. Next Amazon Login may register a new device.'
    }));
  } catch (err) {
    res.status(500).json({ ok: false, error: safeError(err) });
  }
});


process.on('unhandledRejection', reason => {
  lastError = reason;
  console.error('[UNHANDLED_REJECTION]', reason);
});
process.on('uncaughtException', err => {
  lastError = err;
  console.error('[UNCAUGHT_EXCEPTION]', err);
});

app.listen(getServerPort(), '0.0.0.0', () => {
  console.log(`Echo Whispers listening on http://0.0.0.0:${getServerPort()}`);
  console.log(`Open http://localhost:${getServerPort()}/`);
});
