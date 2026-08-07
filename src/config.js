// Central configuration. Loads .env (if present) using Node's built-in
// process.loadEnvFile so the project stays dependency-free.
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(__dirname, '..');

const envPath = join(ROOT, '.env');
if (existsSync(envPath) && typeof process.loadEnvFile === 'function') {
  try {
    process.loadEnvFile(envPath);
  } catch (err) {
    console.warn(`Could not load .env: ${err.message}`);
  }
}

const num = (v, fallback) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

const tlsCert = process.env.TLS_CERT_FILE || join(ROOT, 'data', 'tls', 'cert.pem');
const tlsKey = process.env.TLS_KEY_FILE || join(ROOT, 'data', 'tls', 'key.pem');

export const config = {
  port: num(process.env.PORT, 3000),
  dataDir: join(ROOT, 'data'),
  // INV_DB_PATH allows tests to use ':memory:' for isolation.
  dbPath: process.env.INV_DB_PATH || join(ROOT, 'data', 'inventory.db'),

  // HTTPS: enabled automatically when both a certificate and key exist.
  // Point TLS_CERT_FILE / TLS_KEY_FILE at your files, or drop them at
  // data/tls/cert.pem and data/tls/key.pem (see gen-cert.sh).
  tls: {
    certFile: tlsCert,
    keyFile: tlsKey,
    get enabled() {
      return existsSync(tlsCert) && existsSync(tlsKey);
    },
  },
  // Optional plain-HTTP port that 301-redirects to HTTPS (0 = off).
  httpRedirectPort: num(process.env.HTTP_REDIRECT_PORT, 0),

  // Marketplace assumptions used for break-even / suggested pricing
  defaultFeeRate: num(process.env.DEFAULT_FEE_RATE, 0.132),
  defaultFlatFee: num(process.env.DEFAULT_FLAT_FEE, 0.3),
  defaultTargetMargin: num(process.env.DEFAULT_TARGET_MARGIN, 0.25),

  ebay: {
    clientId: process.env.EBAY_CLIENT_ID || '',
    clientSecret: process.env.EBAY_CLIENT_SECRET || '',
    env: (process.env.EBAY_ENV || 'PRODUCTION').toUpperCase(),
    marketplace: process.env.EBAY_MARKETPLACE || 'EBAY_US',
    get enabled() {
      return Boolean(this.clientId && this.clientSecret);
    },
  },

  amazon: {
    accessKey: process.env.AMAZON_ACCESS_KEY || '',
    secretKey: process.env.AMAZON_SECRET_KEY || '',
    partnerTag: process.env.AMAZON_PARTNER_TAG || '',
    region: process.env.AMAZON_REGION || 'us-east-1',
    host: process.env.AMAZON_HOST || 'webservices.amazon.com',
    get enabled() {
      return Boolean(this.accessKey && this.secretKey && this.partnerTag);
    },
  },
};

export default config;
