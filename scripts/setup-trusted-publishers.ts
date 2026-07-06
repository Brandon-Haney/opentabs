/**
 * Configure npm trusted publishers for OpenTabs packages.
 *
 * Sets up OIDC trusted publishing so the GitHub Actions publish workflows can
 * publish to npm without a long-lived npm token. Supports two target sets:
 *   - plugins  → registers every plugin package against publish-plugins.yml
 *   - platform → registers the 7 platform packages against publish-platform.yml
 *
 * Requirements:
 *   - npm CLI authenticated (`npm whoami` must succeed)
 *   - 2FA enabled on the npm account
 *   - A valid 2FA OTP code (TOTP rotates every 30s, so the script
 *     processes packages as fast as possible)
 *
 * Usage:
 *   npx tsx scripts/setup-trusted-publishers.ts --target=platform --otp=123456
 *   npx tsx scripts/setup-trusted-publishers.ts --target=plugins --otp=123456
 *   npx tsx scripts/setup-trusted-publishers.ts --target=platform --dry-run
 *
 * --target defaults to 'plugins'. The --otp flag is required for the real run
 * (skipped for --dry-run). If the OTP expires mid-batch, the script prompts for
 * a new one.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';

const ROOT = resolve(import.meta.dirname, '..');
const REPO = 'opentabs-dev/opentabs';

/** Platform packages published by publish-platform.yml, in dependency order. */
const PLATFORM_PACKAGE_DIRS = [
  'shared',
  'browser-extension',
  'mcp-server',
  'plugin-sdk',
  'plugin-tools',
  'cli',
  'create-plugin',
];

interface Target {
  /** The publish workflow file the trusted-publisher claim is bound to. */
  workflowFile: string;
  /** Resolve the npm package names this target covers. */
  packageNames: () => string[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const capture = (cmd: string[]): string => {
  const [bin = '', ...args] = cmd;
  const result = spawnSync(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  if ((result.status ?? 0) !== 0) {
    throw new Error(`Command failed: ${cmd.join(' ')}\n${result.stderr.toString().trim()}`);
  }
  return result.stdout.toString().trim();
};

const prompt = (question: string): Promise<string> => {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(res => {
    rl.question(question, answer => {
      rl.close();
      res(answer.trim());
    });
  });
};

/** Discover all plugin package names under plugins/. */
const discoverPluginPackageNames = (): string[] => {
  const pluginsDir = resolve(ROOT, 'plugins');
  return readdirSync(pluginsDir, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => {
      const pkgPath = resolve(pluginsDir, d.name, 'package.json');
      if (!existsSync(pkgPath)) return null;
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { name?: string; opentabs?: unknown };
      if (!pkg.opentabs) return null;
      return pkg.name ?? null;
    })
    .filter((name): name is string => name !== null);
};

/** Resolve the npm package names for the platform packages. */
const discoverPlatformPackageNames = (): string[] =>
  PLATFORM_PACKAGE_DIRS.map(dir => {
    const pkgPath = resolve(ROOT, 'platform', dir, 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { name?: string };
    if (!pkg.name) throw new Error(`platform/${dir}/package.json has no name`);
    return pkg.name;
  });

const TARGETS: Record<string, Target> = {
  plugins: { workflowFile: 'publish-plugins.yml', packageNames: discoverPluginPackageNames },
  platform: { workflowFile: 'publish-platform.yml', packageNames: discoverPlatformPackageNames },
};

// ---------------------------------------------------------------------------
// npm registry API
// ---------------------------------------------------------------------------

/** Get the npm auth token from the environment or .npmrc. */
const getNpmToken = (): string => {
  // Try environment variable first (set by `npm login` or CI)
  if (process.env.NPM_TOKEN) return process.env.NPM_TOKEN;

  // Read from ~/.npmrc
  const npmrcPath = resolve(process.env.HOME ?? '~', '.npmrc');
  if (existsSync(npmrcPath)) {
    const content = readFileSync(npmrcPath, 'utf-8');
    const match = /\/\/registry\.npmjs\.org\/:_authToken=(.+)/.exec(content);
    if (match?.[1]) return match[1];
  }

  throw new Error('No npm auth token found. Run `npm login` or set NPM_TOKEN.');
};

interface TrustConfig {
  id?: string;
  type: string;
  claims: Record<string, unknown>;
}

/** Check existing trusted publisher config for a package. */
const getTrustedPublishers = async (packageName: string, token: string, otp: string): Promise<TrustConfig[]> => {
  const encoded = encodeURIComponent(packageName);
  const response = await fetch(`https://registry.npmjs.org/-/package/${encoded}/trust`, {
    headers: {
      Authorization: `Bearer ${token}`,
      'npm-otp': otp,
    },
  });
  if (response.status === 404) return [];
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`GET trust for ${packageName}: HTTP ${response.status} — ${body.substring(0, 200)}`);
  }
  return (await response.json()) as TrustConfig[];
};

/** Add trusted publisher config for a package. */
const addTrustedPublisher = async (
  packageName: string,
  workflowFile: string,
  token: string,
  otp: string,
): Promise<void> => {
  const encoded = encodeURIComponent(packageName);
  const body: TrustConfig[] = [
    {
      type: 'github',
      claims: {
        repository: REPO,
        workflow_ref: { file: workflowFile },
      },
    },
  ];

  const response = await fetch(`https://registry.npmjs.org/-/package/${encoded}/trust`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'npm-otp': otp,
    },
    body: JSON.stringify(body),
  });

  if (response.status === 409) {
    // Already configured
    return;
  }
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`POST trust for ${packageName}: HTTP ${response.status} — ${text.substring(0, 200)}`);
  }
};

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const main = async (): Promise<void> => {
  const dryRun = process.argv.includes('--dry-run');

  // Select the target package set (defaults to plugins).
  const targetArg = process.argv.find(a => a.startsWith('--target='));
  const targetName = targetArg ? (targetArg.split('=')[1] ?? '') : 'plugins';
  const target = TARGETS[targetName];
  if (!target) {
    console.error(`Unknown --target=${targetName}. Expected one of: ${Object.keys(TARGETS).join(', ')}`);
    process.exit(1);
  }
  const { workflowFile } = target;

  // Discover packages for the selected target
  const packageNames = target.packageNames();
  console.log(`Found ${packageNames.length} ${targetName} packages.\n`);

  if (dryRun) {
    console.log('Dry run — would configure trusted publishing for:');
    for (const name of packageNames) {
      console.log(`  ${name}`);
    }
    console.log(`\nTrusted publisher: GitHub Actions`);
    console.log(`  Repository: ${REPO}`);
    console.log(`  Workflow:   ${workflowFile}`);
    return;
  }

  // Verify npm auth (real run only — dry runs work offline)
  console.log('Verifying npm authentication...');
  const npmUser = capture(['npm', 'whoami']);
  console.log(`  Authenticated as: ${npmUser}`);

  const token = getNpmToken();

  // 2FA OTP — accept via --otp=XXXXXX flag or interactive prompt.
  // TOTP codes last 30 seconds, and each API call takes ~200ms,
  // so we can process ~100+ packages per OTP code.
  const otpArg = process.argv.find(a => a.startsWith('--otp='));
  let otp = otpArg ? (otpArg.split('=')[1] ?? '') : '';
  if (!otp) {
    otp = await prompt('Enter your npm 2FA OTP code: ');
  }
  if (!otp) {
    console.error('OTP is required. Pass --otp=XXXXXX or enter interactively.');
    process.exit(1);
  }

  let configured = 0;
  let skipped = 0;
  let failed = 0;

  for (const name of packageNames) {
    try {
      // Check if already configured
      const existing = await getTrustedPublishers(name, token, otp);
      const alreadyConfigured = existing.some(
        c => c.type === 'github' && (c.claims as { repository?: string }).repository === REPO,
      );

      if (alreadyConfigured) {
        console.log(`  ✓ ${name} — already configured`);
        skipped++;
        continue;
      }

      await addTrustedPublisher(name, workflowFile, token, otp);
      console.log(`  ✓ ${name} — configured`);
      configured++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);

      // If OTP expired, prompt for a new one and retry this package
      if (msg.includes('401') || msg.includes('otp') || msg.includes('OTP')) {
        console.log(`\n  OTP expired. Enter a new 2FA OTP code to continue.`);
        otp = await prompt('New OTP: ');
        if (!otp) {
          console.error('OTP is required. Stopping.');
          break;
        }
        // Retry this package
        try {
          await addTrustedPublisher(name, workflowFile, token, otp);
          console.log(`  ✓ ${name} — configured (after OTP refresh)`);
          configured++;
        } catch (retryErr) {
          console.error(`  ✗ ${name} — ${retryErr instanceof Error ? retryErr.message : String(retryErr)}`);
          failed++;
        }
        continue;
      }

      console.error(`  ✗ ${name} — ${msg}`);
      failed++;
    }
  }

  console.log(`\nDone: ${configured} configured, ${skipped} already set up, ${failed} failed.`);
};

await main();
