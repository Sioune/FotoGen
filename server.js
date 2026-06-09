import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';
import { Readable } from 'node:stream';

import { generateMeetingImage, getImageServiceConfig } from './src/openaiImageService.js';
import { getPublicAssetStorageConfig, publishReferenceAssets } from './src/referenceAssets.js';

const ROOT_DIR = resolve('.');
const DEFAULT_PORT = 5173;
const ASSET_DIR = join(ROOT_DIR, '.tmp', 'reference-assets');

export function createApp({ env = process.env, fetchImpl = fetch, rootDir = ROOT_DIR, loadEnvFile = true } = {}) {
  const effectiveEnv = loadEnvFile ? { ...loadDotEnv(rootDir), ...env } : { ...env };
  const assetDir = join(rootDir, '.tmp', 'reference-assets');

  return {
    async handleRequest(request) {
      const url = new URL(request.url);

      if (url.pathname === '/api/config' && request.method === 'GET') {
        return jsonResponse(getImageServiceConfig(effectiveEnv));
      }

      if (url.pathname === '/api/generate' && request.method === 'POST') {
        try {
          const body = await request.json();
          const config = getImageServiceConfig(effectiveEnv);
          const references = await prepareReferencesForProvider({
            references: body.references || [],
            mode: config.mode,
            publicBaseUrl: effectiveEnv.OPENAI_ASSET_BASE_URL,
            assetDir,
            publicStorage: getPublicAssetStorageConfig(effectiveEnv),
            fetchImpl
          });
          const result = await generateMeetingImage({
            apiKey: effectiveEnv.OPENAI_API_KEY,
            mode: config.mode,
            endpoint: config.endpoint,
            model: config.model,
            size: config.size,
            aspectRatio: config.aspectRatio,
            resolution: config.resolution,
            prompt: body.prompt,
            references,
            fetchImpl
          });

          return jsonResponse({
            imageDataUrl: result.imageDataUrl,
            model: config.model
          });
        } catch (error) {
          return jsonResponse({ error: error.message || '图片生成失败。' }, 500);
        }
      }

      if (url.pathname.startsWith('/api/reference-assets/') && request.method === 'GET') {
        return serveReferenceAsset(url.pathname, assetDir);
      }

      if (url.pathname === '/api/download-image' && request.method === 'GET') {
        return proxyGeneratedImageDownload(url, fetchImpl);
      }

      if (request.method !== 'GET' && request.method !== 'HEAD') {
        return new Response('Method Not Allowed', { status: 405 });
      }

      return serveStatic(url.pathname, rootDir);
    }
  };
}

export function startServer({ port = Number(process.env.PORT) || DEFAULT_PORT } = {}) {
  mkdirSync(ASSET_DIR, { recursive: true });
  const app = createApp();
  const server = createServer(async (incoming, outgoing) => {
    const request = toWebRequest(incoming);
    const response = await app.handleRequest(request);
    await writeNodeResponse(outgoing, response);
  });

  server.listen(port, () => {
    console.log(`会议合照生成器已启动：http://127.0.0.1:${port}`);
  });

  return server;
}

async function prepareReferencesForProvider({
  references,
  mode,
  publicBaseUrl,
  assetDir,
  publicStorage,
  fetchImpl
}) {
  if (mode !== 'gptsapi-edit') {
    return references;
  }

  return publishReferenceAssets({
    references,
    publicBaseUrl,
    assetDir,
    publicStorage,
    fetchImpl
  });
}

function serveReferenceAsset(pathname, assetDir) {
  const fileName = decodeURIComponent(pathname.replace('/api/reference-assets/', ''));
  const filePath = normalize(join(assetDir, fileName));

  if (!filePath.startsWith(assetDir) || !existsSync(filePath) || !statSync(filePath).isFile()) {
    return new Response('Not Found', { status: 404 });
  }

  return new Response(Readable.toWeb(createReadStream(filePath)), {
    headers: {
      'Content-Type': getContentType(filePath),
      'Cache-Control': 'no-store'
    }
  });
}

async function proxyGeneratedImageDownload(requestUrl, fetchImpl) {
  const imageUrl = requestUrl.searchParams.get('url') || '';
  const filename = sanitizeDownloadName(requestUrl.searchParams.get('filename'));

  if (!isHttpUrl(imageUrl)) {
    return new Response('Bad Request', { status: 400 });
  }

  const upstream = await fetchImpl(imageUrl);
  if (!upstream.ok) {
    return new Response('Image Download Failed', { status: upstream.status || 502 });
  }

  const contentType = upstream.headers.get('Content-Type') || 'application/octet-stream';

  return new Response(upstream.body, {
    headers: {
      'Content-Type': contentType,
      'Content-Disposition': `attachment; filename="${escapeHeaderValue(filename)}"`,
      'Cache-Control': 'no-store'
    }
  });
}

function serveStatic(pathname, rootDir) {
  const relativePath = pathname === '/' ? '/index.html' : pathname;
  const filePath = normalize(join(rootDir, decodeURIComponent(relativePath)));

  if (!filePath.startsWith(rootDir) || !existsSync(filePath) || !statSync(filePath).isFile()) {
    return new Response('Not Found', { status: 404 });
  }

  return new Response(Readable.toWeb(createReadStream(filePath)), {
    headers: {
      'Content-Type': getContentType(filePath)
    }
  });
}

function isHttpUrl(value) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch {
    return false;
  }
}

function sanitizeDownloadName(filename) {
  const clean = `${filename || 'meeting-photo.png'}`
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);

  return clean || 'meeting-photo.png';
}

function escapeHeaderValue(value) {
  return value.replace(/\\/g, '').replace(/"/g, "'");
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' }
  });
}

function toWebRequest(incoming) {
  const origin = `http://${incoming.headers.host || '127.0.0.1'}`;
  return new Request(new URL(incoming.url || '/', origin), {
    method: incoming.method,
    headers: incoming.headers,
    body: incoming.method === 'GET' || incoming.method === 'HEAD' ? undefined : Readable.toWeb(incoming),
    duplex: 'half'
  });
}

async function writeNodeResponse(outgoing, response) {
  outgoing.writeHead(response.status, Object.fromEntries(response.headers.entries()));
  if (!response.body) {
    outgoing.end();
    return;
  }

  for await (const chunk of response.body) {
    outgoing.write(chunk);
  }
  outgoing.end();
}

function loadDotEnv(rootDir) {
  const envPath = join(rootDir, '.env');
  if (!existsSync(envPath)) return {};

  const parsed = {};
  for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const index = trimmed.indexOf('=');
    if (index === -1) continue;

    const key = trimmed.slice(0, index).trim();
    const rawValue = trimmed.slice(index + 1).trim();
    parsed[key] = rawValue.replace(/^["']|["']$/g, '');
  }

  return parsed;
}

function getContentType(filePath) {
  const extension = extname(filePath);
  if (extension === '.html') return 'text/html; charset=utf-8';
  if (extension === '.css') return 'text/css; charset=utf-8';
  if (extension === '.js') return 'text/javascript; charset=utf-8';
  if (extension === '.json') return 'application/json; charset=utf-8';
  if (extension === '.png') return 'image/png';
  if (extension === '.jpg' || extension === '.jpeg') return 'image/jpeg';
  if (extension === '.svg') return 'image/svg+xml';
  return 'application/octet-stream';
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startServer();
}
