import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseHtml } from 'parse5';
import { prepareCommand } from '../lib/process-launch.mjs';

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);

test('package metadata exposes the OpenMergeLens identity and CLI', async () => {
  const packageJson = JSON.parse(
    await readFile(path.join(projectRoot, 'package.json'), 'utf8'),
  );
  const shrinkwrap = JSON.parse(
    await readFile(path.join(projectRoot, 'npm-shrinkwrap.json'), 'utf8'),
  );

  assert.equal(packageJson.name, 'openmergelens');
  assert.equal(
    packageJson.description,
    'A local CLI that automates AI code reviews for GitHub pull requests using Codex, Claude Code, or any compatible MCP-enabled reviewer CLI.',
  );
  assert.deepEqual(packageJson.bin, {
    openmergelens: 'bin/openmergelens.mjs',
  });
  assert.equal(
    packageJson.scripts.report,
    'node bin/openmergelens.mjs report',
    'the repository report script must use the published CLI dispatcher',
  );
  assert.equal(
    packageJson.repository.url,
    'git+https://github.com/suguspnk/openmergelens.git',
  );
  assert.equal(
    packageJson.homepage,
    'https://suguspnk.github.io/openmergelens/',
  );
  assert.equal(
    packageJson.scripts.prepublishOnly,
    'pnpm release:check',
    'interactive publishes must run the same audit and package gate as CI',
  );
  assert.equal(
    packageJson.dependencies['@clack/prompts'],
    '1.7.0',
    'published production dependencies must not float after release',
  );
  assert.equal(shrinkwrap.name, packageJson.name);
  assert.equal(shrinkwrap.version, packageJson.version);
  assert.equal(shrinkwrap.packages[''].name, packageJson.name);
  assert.equal(shrinkwrap.packages[''].version, packageJson.version);
  assert.deepEqual(shrinkwrap.packages[''].dependencies, packageJson.dependencies);
  assert.deepEqual(
    shrinkwrap.packages[''].devDependencies,
    packageJson.devDependencies,
  );
  assert.equal(shrinkwrap.packages['node_modules/@clack/prompts'].version, '1.7.0');
  assert.equal(shrinkwrap.packages['node_modules/@clack/core'].version, '1.4.3');
  assert.equal(
    Object.keys(shrinkwrap.packages).some((entry) => entry.includes('/.pnpm/')),
    false,
    'the published npm lock must not contain pnpm store paths',
  );
  assert.ok(packageJson.files.includes('npm-shrinkwrap.json'));
});

test('published package excludes the repository-only E2E harness', async (t) => {
  const packageJson = JSON.parse(
    await readFile(path.join(projectRoot, 'package.json'), 'utf8'),
  );
  const npmCache = await mkdtemp(path.join(tmpdir(), 'openmergelens-npm-cache-'));
  t.after(() => rm(npmCache, { recursive: true, force: true }));

  const environment = {
    ...process.env,
    npm_config_cache: npmCache,
  };
  const npmCommand = await prepareCommand(
    'npm',
    ['pack', '--dry-run', '--json', '--ignore-scripts'],
    {
      platform: process.platform,
      environment,
    },
  );
  const { stdout } = await execFileAsync(
    npmCommand.command,
    npmCommand.args,
    {
      ...npmCommand.options,
      cwd: projectRoot,
      env: environment,
      timeout: 30_000,
    },
  );
  const packMetadata = JSON.parse(stdout.trim());
  const packagedFiles = new Set(
    packMetadata.flatMap((entry) => entry.files.map((file) => file.path)),
  );
  const e2eScriptPaths = Object.entries(packageJson.scripts)
    .filter(([name]) => name.startsWith('test:e2e:'))
    .flatMap(([, command]) => command.match(/\be2e\/[^\s]+\.mjs\b/g) ?? []);

  assert.deepEqual(
    e2eScriptPaths.filter((filePath) => packagedFiles.has(filePath)),
    [],
    'repository-only E2E script entrypoints must not be published',
  );
  assert.equal(
    [...packagedFiles].some((filePath) => filePath.startsWith('e2e/')),
    false,
    'the repository-only E2E harness must not be published',
  );
});

test('the bundled manual config requires init to record bulk consent', async () => {
  const example = JSON.parse(
    await readFile(path.join(projectRoot, 'config.example.json'), 'utf8'),
  );

  assert.equal(example.configVersion, 6);
  assert.equal(example.aiProcessingConsent, null);
});

test('GitHub Pages entry point exposes complete search metadata', async () => {
  const packageJson = JSON.parse(
    await readFile(path.join(projectRoot, 'package.json'), 'utf8'),
  );
  const html = await readFile(path.join(projectRoot, 'docs/index.html'), 'utf8');
  const sitemap = await readFile(
    path.join(projectRoot, 'docs/sitemap.xml'),
    'utf8',
  );
  const canonicalUrl = packageJson.homepage;
  const metaTags = [...html.matchAll(/<meta\b[^>]*>/g)].map(
    (match) => match[0],
  );
  const metaContent = (attribute, value) => {
    const tag = metaTags.find(
      (candidate) => candidate.includes(`${attribute}="${value}"`),
    );
    return tag?.match(/\bcontent="([^"]*)"/)?.[1];
  };

  assert.match(
    html,
    /<title>OpenMergeLens \| Local AI Code Review for GitHub Pull Requests<\/title>/,
  );
  assert.equal(
    html.match(/<link rel="canonical" href="([^"]+)">/)?.[1],
    canonicalUrl,
  );
  assert.match(
    html,
    /<h1\b[^>]*>\s*OpenMergeLens: AI code reviews on your machine\.\s*<\/h1>/,
  );
  assert.equal(sitemap.match(/<loc>([^<]+)<\/loc>/)?.[1], canonicalUrl);
  assert.equal(metaContent('property', 'og:url'), canonicalUrl);
  assert.ok(metaContent('property', 'og:image'));
  assert.equal(
    metaContent('property', 'og:image'),
    metaContent('name', 'twitter:image'),
  );
  assert.equal(metaContent('property', 'og:image:width'), '1200');
  assert.equal(metaContent('property', 'og:image:height'), '600');
  assert.equal(
    metaContent('property', 'og:image:alt'),
    metaContent('name', 'twitter:image:alt'),
  );

  const structuredDataSource = html.match(
    /<script type="application\/ld\+json">([\s\S]*?)<\/script>/,
  )?.[1];
  assert.ok(structuredDataSource, 'structured data script is present');

  const structuredData = JSON.parse(structuredDataSource);
  const schemaTypes = structuredData['@graph'].map((entry) => entry['@type']);
  assert.deepEqual(schemaTypes, ['WebSite', 'SoftwareApplication']);
  assert.equal(structuredData['@graph'][0].url, canonicalUrl);
  assert.equal(structuredData['@graph'][1].url, canonicalUrl);
});

test('GitHub Pages includes the official Product Hunt follow badge', async () => {
  const html = await readFile(path.join(projectRoot, 'docs/index.html'), 'utf8');

  assert.match(
    html,
    /<a\s+class="product-hunt-badge"\s+href="https:\/\/www\.producthunt\.com\/products\/openmergelens\?utm_source=badge-follow&amp;utm_medium=badge&amp;utm_source=badge-openmergelens"\s+target="_blank"\s+rel="noopener noreferrer"\s*>\s*<img\s+src="https:\/\/api\.producthunt\.com\/widgets\/embed-image\/v1\/follow\.svg\?product_id=1283249&amp;theme=neutral"\s+alt="OpenMergeLens - Local&#0032;AI&#0032;pull&#0045;request&#0032;reviews&#0032;without&#0032;another&#0032;GitHub&#0032;bot \| Product Hunt"\s+style="width: 250px; height: 54px;"\s+width="250"\s+height="54"\s*\/?>\s*<\/a>/,
  );
});

test('GitHub Pages motion is local, pinned, and progressively enhanced', async () => {
  const html = await readFile(path.join(projectRoot, 'docs/index.html'), 'utf8');
  const motionSource = await readFile(
    path.join(projectRoot, 'docs/assets/site-motion.js'),
    'utf8',
  );
  const motionBundle = await readFile(
    path.join(
      projectRoot,
      'docs/assets/vendor/motion-mini-12.43.0.js',
    ),
    'utf8',
  );
  const motionLicense = await readFile(
    path.join(projectRoot, 'docs/assets/vendor/MOTION-LICENSE.md'),
    'utf8',
  );
  const motionProvenance = await readFile(
    path.join(projectRoot, 'docs/assets/vendor/README.md'),
    'utf8',
  );
  const pageStyles = html.match(/<style>([\s\S]*?)<\/style>/)?.[1] ?? '';

  assert.match(
    html,
    /<script type="module" src="\.\/assets\/site-motion\.js"><\/script>/,
  );
  assert.match(
    html,
    /href="\.\/assets\/vendor\/motion-mini-12\.43\.0\.js"/,
  );
  assert.doesNotMatch(html, /cdn\.jsdelivr\.net|unpkg\.com/);
  assert.match(
    motionSource,
    /from '\.\/vendor\/motion-mini-12\.43\.0\.js'/,
  );
  assert.match(motionSource, /prefers-reduced-motion: reduce/);
  assert.match(motionSource, /IntersectionObserver/);
  assert.match(motionSource, /heroDuration: 0\.95/);
  assert.match(motionSource, /terminalDuration: 1\.1/);
  assert.match(motionSource, /revealDuration: 0\.85/);
  assert.match(motionSource, /revealStagger: 0\.12/);
  assert.match(
    motionSource,
    /easeOut: \[0\.25, 0\.46, 0\.45, 0\.94\]/,
  );
  assert.match(motionSource, /transform: \['translateY\(12px\)'/);
  assert.match(pageStyles, /--motion-fast: 260ms/);
  assert.doesNotMatch(pageStyles, /\[data-motion[^}]*opacity:\s*0/);
  assert.match(
    pageStyles,
    /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.button\s*{\s*transition: none;/,
  );
  assert.match(
    pageStyles,
    /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.button:hover,[\s\S]*?transform: none;/,
  );
  assert.match(motionBundle, /export\{[^}]*animate/);
  assert.match(motionLicense, /The MIT License \(MIT\)/);
  assert.match(motionProvenance, /motion@12\.43\.0/);
  assert.match(
    motionProvenance,
    new RegExp(createHash('sha256').update(motionBundle).digest('hex')),
  );
});

function assertSecureGithubPagesHtml(html) {
  const document = parseHtml(html);
  const elements = [];
  const visit = (node) => {
    if (node.tagName) {
      elements.push(node);
    }
    for (const child of node.childNodes ?? []) {
      visit(child);
    }
  };
  visit(document);

  const attributes = (element) => new Map(
    element.attrs.map(({ name, value }) => [name, value]),
  );
  const cspMetas = elements.filter((element) => {
    if (element.tagName !== 'meta') return false;
    return attributes(element).get('http-equiv')?.toLowerCase() ===
      'content-security-policy';
  });
  assert.equal(
    cspMetas.length,
    1,
    'the page declares exactly one content security policy',
  );
  const [cspMeta] = cspMetas;
  const structuredDataScript = elements.find((element) => {
    if (element.tagName !== 'script') return false;
    return attributes(element).get('type')?.toLowerCase() ===
      'application/ld+json';
  });
  const contentSecurityPolicy = cspMeta && attributes(cspMeta).get('content');
  const structuredDataSource = structuredDataScript?.childNodes
    ?.filter((node) => node.nodeName === '#text')
    .map((node) => node.value)
    .join('');

  assert.ok(contentSecurityPolicy, 'the page declares a content security policy');
  assert.ok(structuredDataSource, 'the page includes its structured data');

  const structuredDataHash = createHash('sha256')
    .update(structuredDataSource)
    .digest('base64');
  const expectedDirectives = new Map([
    ['default-src', ["'none'"]],
    ['script-src', ["'self'", `'sha256-${structuredDataHash}'`]],
    ['style-src', ["'unsafe-inline'"]],
    ['img-src', ["'self'", 'https://api.producthunt.com', 'data:']],
    ['connect-src', ["'none'"]],
    ['font-src', ["'none'"]],
    ['frame-src', ["'none'"]],
    ['media-src', ["'none'"]],
    ['object-src', ["'none'"]],
    ['worker-src', ["'none'"]],
    ['base-uri', ["'none'"]],
    ['form-action', ["'none'"]],
    ['manifest-src', ["'self'"]],
  ]);
  const actualDirectives = new Map();

  for (const segment of contentSecurityPolicy.split(';')) {
    const [name, ...sources] = segment.trim().split(/\s+/);
    if (!name) continue;
    assert.equal(
      actualDirectives.has(name),
      false,
      `content security policy must not duplicate ${name}`,
    );
    actualDirectives.set(name, sources.sort());
  }

  assert.deepEqual(
    Object.fromEntries(actualDirectives),
    Object.fromEntries(
      [...expectedDirectives].map(([name, sources]) => [name, sources.sort()]),
    ),
  );

  const referrerMetas = elements.filter((element) => {
    if (element.tagName !== 'meta') return false;
    return attributes(element).get('name')?.toLowerCase() === 'referrer';
  });
  assert.equal(
    referrerMetas.length,
    1,
    'the page declares exactly one referrer policy',
  );
  const [referrerMeta] = referrerMetas;
  assert.equal(attributes(referrerMeta).get('content'), 'no-referrer');

  const pageUrl = new URL('https://suguspnk.github.io/openmergelens/');
  const allowedOutboundHosts = new Set([
    'github.com',
    'www.npmjs.com',
    'www.producthunt.com',
  ]);
  let outboundLinkCount = 0;

  for (const element of elements) {
    const attrs = attributes(element);
    for (const name of attrs.keys()) {
      assert.doesNotMatch(name, /^on/i, `${element.tagName} has no event handler`);
    }

    assert.equal(attrs.has('srcset'), false, 'srcset is not an approved resource input');
    assert.equal(
      element.tagName === 'meta' &&
        attrs.get('http-equiv')?.toLowerCase() === 'refresh',
      false,
      'meta refresh navigation is not allowed',
    );

    for (const attributeName of ['src', 'poster', 'data']) {
      const value = attrs.get(attributeName);
      if (value === undefined) continue;
      const resource = new URL(value, pageUrl);
      const allowedDataImage = element.tagName === 'img' &&
        resource.protocol === 'data:';
      const allowedLocalResource = resource.protocol === 'https:' &&
        resource.origin === pageUrl.origin;
      const allowedProductHuntImage = element.tagName === 'img' &&
        resource.protocol === 'https:' &&
        resource.origin === 'https://api.producthunt.com';
      assert.ok(
        allowedDataImage ||
          allowedLocalResource ||
          allowedProductHuntImage,
        `${element.tagName}[${attributeName}] uses an approved resource`,
      );
    }

    const href = attrs.get('href');
    if (href === undefined) continue;
    const destination = new URL(href, pageUrl);
    assert.equal(destination.protocol, 'https:', `${element.tagName}[href] uses HTTPS`);

    if (destination.origin === pageUrl.origin) continue;
    assert.equal(element.tagName, 'a', 'only anchors may leave the site origin');
    outboundLinkCount += 1;
    assert.ok(
      allowedOutboundHosts.has(destination.hostname),
      `outbound link host is approved: ${destination.hostname}`,
    );
  }

  assert.ok(outboundLinkCount > 0, 'the page includes approved outbound links');
}

test('GitHub Pages blocks unapproved active content and outbound destinations', async () => {
  const html = await readFile(path.join(projectRoot, 'docs/index.html'), 'utf8');
  assertSecureGithubPagesHtml(html);
});

test('GitHub Pages security validation rejects browser-equivalent bypass forms', async () => {
  const html = await readFile(path.join(projectRoot, 'docs/index.html'), 'utf8');
  const mutations = [
    {
      name: 'single-quoted remote script',
      html: html.replace(
        'src="./assets/site-motion.js"',
        "src='https://evil.example/site-motion.js'",
      ),
    },
    {
      name: 'entity-encoded JavaScript URL',
      html: html.replace('href="#how-it-works"', 'href="&#106;avascript:alert(1)"'),
    },
    {
      name: 'protocol-relative outbound host',
      html: html.replace(
        'href="https://github.com/suguspnk/openmergelens"',
        'href="//evil.example/openmergelens"',
      ),
    },
    {
      name: 'duplicate permissive script directive',
      html: html.replace("content=\"default-src 'none';", "content=\"script-src *; default-src 'none';"),
    },
    {
      name: 'duplicate content security policy',
      html: html.replace(
        '<meta name="referrer" content="no-referrer">',
        '<meta http-equiv="Content-Security-Policy" content="default-src *">\n    <meta name="referrer" content="no-referrer">',
      ),
    },
    {
      name: 'duplicate permissive referrer policy',
      html: html.replace(
        '<meta name="referrer" content="no-referrer">',
        '<meta name="referrer" content="no-referrer">\n    <meta name="referrer" content="unsafe-url">',
      ),
    },
    {
      name: 'missing functional style directive',
      html: html.replace(" style-src 'unsafe-inline';", ''),
    },
  ];

  for (const mutation of mutations) {
    assert.throws(
      () => assertSecureGithubPagesHtml(mutation.html),
      undefined,
      mutation.name,
    );
  }
});

test('relative links in the installed README target packaged files', async () => {
  const packageJson = JSON.parse(
    await readFile(path.join(projectRoot, 'package.json'), 'utf8'),
  );
  const readme = await readFile(path.join(projectRoot, 'README.md'), 'utf8');
  const alwaysIncluded = new Set(['README.md', 'LICENSE', 'package.json']);
  const relativeTargets = [...readme.matchAll(/\[[^\]]*]\(([^)]+)\)/g)]
    .map((match) => match[1])
    .filter((target) => !/^(?:https?:|#)/i.test(target))
    .map((target) => path.posix.normalize(target.split('#', 1)[0]));

  for (const target of relativeTargets) {
    const packaged = alwaysIncluded.has(target) ||
      packageJson.files.some(
        (entry) => target === entry || target.startsWith(`${entry}/`),
      );
    assert.equal(packaged, true, `${target} is linked from README but not packaged`);
  }
});

test('published CLI errors and usage use the OpenMergeLens command', async () => {
  await assert.rejects(
    execFileAsync(
      process.execPath,
      ['bin/openmergelens.mjs', '--invalid'],
      { cwd: projectRoot },
    ),
    (error) => {
      assert.match(error.stderr, /^openmergelens: unrecognized argument/m);
      assert.match(error.stderr, /^Usage: openmergelens /m);
      return true;
    },
  );
});

test('published CLI exposes help and version without starting a poll', async () => {
  const help = await execFileAsync(
    process.execPath,
    ['bin/openmergelens.mjs', '--help'],
    { cwd: projectRoot },
  );
  assert.match(help.stdout, /^Usage: openmergelens /);

  const packageJson = JSON.parse(
    await readFile(path.join(projectRoot, 'package.json'), 'utf8'),
  );
  const version = await execFileAsync(
    process.execPath,
    ['bin/openmergelens.mjs', '--version'],
    { cwd: projectRoot },
  );
  assert.equal(version.stdout.trim(), packageJson.version);
});
