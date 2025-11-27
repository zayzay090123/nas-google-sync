import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface GoogleAccountConfig {
  name: string;
}

export interface SynologyAccountConfig {
  name: string;
  host: string;
  port: number;
  username: string;
  password: string;
  photoLibraryPath: string;
  useSsl: boolean;
}

export interface AccountPairing {
  googleAccountName: string;
  synologyAccountName: string;
}

export interface Config {
  googleAccounts: GoogleAccountConfig[];
  synologyAccounts: SynologyAccountConfig[];
  accountPairings: AccountPairing[];
  storageThresholdPercent: number;
  databasePath: string;
  dryRun: boolean;
  logLevel: string;
}

export function loadConfig(): Config {
  const synologyAccounts: SynologyAccountConfig[] = [];
  const googleAccounts: GoogleAccountConfig[] = [];
  const accountPairings: AccountPairing[] = [];

  const globalHost = process.env.SYNOLOGY_HOST || 'localhost';
  const globalPort = parseInt(process.env.SYNOLOGY_PORT || '5000', 10);
  const globalUseSsl = process.env.SYNOLOGY_SECURE === 'true';

  // ===========================================
  // SIMPLE FORMAT (recommended for most users)
  // ===========================================
  // SYNOLOGY_USERNAME, SYNOLOGY_PASSWORD, SYNOLOGY_PHOTO_PATH, GOOGLE_ACCOUNT
  // SYNOLOGY_2_USERNAME, SYNOLOGY_2_PASSWORD, SYNOLOGY_2_PHOTO_PATH, GOOGLE_ACCOUNT_2

  // First user (no number suffix)
  if (process.env.SYNOLOGY_USERNAME) {
    const accountName = process.env.GOOGLE_ACCOUNT || 'account1';

    synologyAccounts.push({
      name: accountName,
      host: globalHost,
      port: globalPort,
      username: process.env.SYNOLOGY_USERNAME,
      password: process.env.SYNOLOGY_PASSWORD || '',
      photoLibraryPath: process.env.SYNOLOGY_PHOTO_PATH || '/photo',
      useSsl: globalUseSsl,
    });

    googleAccounts.push({ name: accountName });
    accountPairings.push({
      googleAccountName: accountName,
      synologyAccountName: accountName,
    });
  }

  // Additional users (numbered: SYNOLOGY_2_*, SYNOLOGY_3_*, etc.)
  for (let i = 2; i <= 5; i++) {
    const username = process.env[`SYNOLOGY_${i}_USERNAME`];
    if (username) {
      const accountName = process.env[`GOOGLE_ACCOUNT_${i}`] || `account${i}`;

      synologyAccounts.push({
        name: accountName,
        host: process.env[`SYNOLOGY_${i}_HOST`] || globalHost,
        port: parseInt(process.env[`SYNOLOGY_${i}_PORT`] || String(globalPort), 10),
        username,
        password: process.env[`SYNOLOGY_${i}_PASSWORD`] || '',
        photoLibraryPath: process.env[`SYNOLOGY_${i}_PHOTO_PATH`] || '/photo',
        useSsl: process.env[`SYNOLOGY_${i}_SECURE`] === 'true' || globalUseSsl,
      });

      googleAccounts.push({ name: accountName });
      accountPairings.push({
        googleAccountName: accountName,
        synologyAccountName: accountName,
      });
    }
  }

  // ===========================================
  // LEGACY FORMAT (for backwards compatibility)
  // ===========================================
  // SYNOLOGY_ACCOUNTS=name1,name2
  // SYNOLOGY_name1_USERNAME, SYNOLOGY_name1_PASSWORD, etc.

  if (synologyAccounts.length === 0 && process.env.SYNOLOGY_ACCOUNTS) {
    const synologyAccountNames = process.env.SYNOLOGY_ACCOUNTS
      .split(',')
      .map(s => s.trim())
      .filter(s => s.length > 0);

    for (const accountName of synologyAccountNames) {
      synologyAccounts.push({
        name: accountName,
        host: process.env[`SYNOLOGY_${accountName}_HOST`] || globalHost,
        port: parseInt(process.env[`SYNOLOGY_${accountName}_PORT`] || String(globalPort), 10),
        username: process.env[`SYNOLOGY_${accountName}_USERNAME`] || '',
        password: process.env[`SYNOLOGY_${accountName}_PASSWORD`] || '',
        photoLibraryPath: process.env[`SYNOLOGY_${accountName}_PHOTO_PATH`] || '/photo',
        useSsl: process.env[`SYNOLOGY_${accountName}_SECURE`] === 'true' || globalUseSsl,
      });
    }

    // Parse Google accounts for legacy format
    const googleAccountNames = (process.env.GOOGLE_ACCOUNTS || '')
      .split(',')
      .map(s => s.trim())
      .filter(s => s.length > 0);

    for (const name of googleAccountNames) {
      googleAccounts.push({ name });
    }

    // Parse explicit pairings for legacy format
    if (process.env.PAIRING_1_GOOGLE && process.env.PAIRING_1_SYNOLOGY) {
      accountPairings.push({
        googleAccountName: process.env.PAIRING_1_GOOGLE,
        synologyAccountName: process.env.PAIRING_1_SYNOLOGY,
      });
    }
    if (process.env.PAIRING_2_GOOGLE && process.env.PAIRING_2_SYNOLOGY) {
      accountPairings.push({
        googleAccountName: process.env.PAIRING_2_GOOGLE,
        synologyAccountName: process.env.PAIRING_2_SYNOLOGY,
      });
    }
  }

  // ===========================================
  // NUMBERED LEGACY FORMAT (SYNOLOGY_ACCOUNT_1_NAME, etc.)
  // ===========================================
  if (synologyAccounts.length === 0) {
    for (let i = 1; i <= 3; i++) {
      const name = process.env[`SYNOLOGY_ACCOUNT_${i}_NAME`];
      if (name) {
        synologyAccounts.push({
          name,
          host: process.env[`SYNOLOGY_ACCOUNT_${i}_HOST`] || globalHost,
          port: parseInt(process.env[`SYNOLOGY_ACCOUNT_${i}_PORT`] || String(globalPort), 10),
          username: process.env[`SYNOLOGY_ACCOUNT_${i}_USERNAME`] || '',
          password: process.env[`SYNOLOGY_ACCOUNT_${i}_PASSWORD`] || '',
          photoLibraryPath: process.env[`SYNOLOGY_ACCOUNT_${i}_PHOTO_PATH`] || '/photo',
          useSsl: process.env[`SYNOLOGY_ACCOUNT_${i}_USE_SSL`] === 'true' || globalUseSsl,
        });
      }
    }
  }

  return {
    googleAccounts,
    synologyAccounts,
    accountPairings,
    storageThresholdPercent: parseInt(process.env.STORAGE_THRESHOLD_PERCENT || '80', 10),
    databasePath: process.env.DATABASE_PATH || './data/photos.db',
    dryRun: process.env.DRY_RUN === 'true',
    logLevel: process.env.LOG_LEVEL || 'info',
  };
}

// Helper to get the paired Synology account for a Google account
export function getPairedSynologyAccount(config: Config, googleAccountName: string): SynologyAccountConfig | undefined {
  const pairing = config.accountPairings.find(p => p.googleAccountName === googleAccountName);
  if (!pairing) return undefined;
  return config.synologyAccounts.find(s => s.name === pairing.synologyAccountName);
}
