import { mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

export async function publishReferenceAssets({
  references,
  publicBaseUrl,
  assetDir,
  publicStorage,
  fetchImpl = fetch
}) {
  const normalizedBaseUrl = `${publicBaseUrl || ''}`.trim().replace(/\/+$/, '');
  const hasDataUrls = references.some((reference) => reference.dataUrl && !reference.url);

  if (hasDataUrls && isConfiguredPublicStorage(publicStorage)) {
    return uploadReferenceAssets({
      references,
      publicStorage,
      fetchImpl
    });
  }

  if (hasDataUrls && !normalizedBaseUrl) {
    throw new Error(
      'GPTSAPI 的 image-edit 需要可访问的图片 URL。请配置 OPENAI_ASSET_UPLOAD_URL 和 OPENAI_ASSET_PUBLIC_BASE_URL，把参考图上传到公网素材仓库；或配置 OPENAI_ASSET_BASE_URL 为公网可访问的本工具地址。'
    );
  }

  if (hasDataUrls) {
    await mkdir(assetDir, { recursive: true });
  }

  return Promise.all(
    references.map(async (reference) => {
      if (reference.url) {
        return { ...reference, dataUrl: undefined };
      }

      const { mimeType, bytes, extension } = parseDataUrl(reference.dataUrl);
      const fileName = `${Date.now()}-${randomUUID()}.${extension}`;
      await writeFile(join(assetDir, fileName), bytes);

      return {
        ...reference,
        dataUrl: undefined,
        mimeType,
        url: `${normalizedBaseUrl}/api/reference-assets/${fileName}`
      };
    })
  );
}

export function getPublicAssetStorageConfig(env = {}) {
  const uploadUrl = normalizePublicBaseUrl(env.OPENAI_ASSET_UPLOAD_URL || env.ASSET_UPLOAD_URL || '');
  const publicBaseUrl = normalizePublicBaseUrl(
    env.OPENAI_ASSET_PUBLIC_BASE_URL || env.ASSET_PUBLIC_BASE_URL || ''
  );
  const authorization = `${env.OPENAI_ASSET_UPLOAD_AUTHORIZATION || env.ASSET_UPLOAD_AUTHORIZATION || ''}`.trim();

  if (!uploadUrl && !publicBaseUrl) return null;

  return {
    uploadUrl,
    publicBaseUrl,
    authorization
  };
}

export function parseDataUrl(dataUrl) {
  const match = /^data:([^;,]+);base64,(.+)$/u.exec(dataUrl || '');
  if (!match) {
    throw new Error('参考图格式无效，请重新上传图片。');
  }

  const mimeType = match[1];
  return {
    mimeType,
    extension: extensionForMimeType(mimeType),
    bytes: Buffer.from(match[2], 'base64')
  };
}

async function uploadReferenceAssets({ references, publicStorage, fetchImpl }) {
  return Promise.all(
    references.map(async (reference) => {
      if (reference.url) {
        return { ...reference, dataUrl: undefined };
      }

      const { mimeType, bytes, extension } = parseDataUrl(reference.dataUrl);
      const fileName = `${Date.now()}-${randomUUID()}.${extension}`;
      const uploadUrl = joinUrl(publicStorage.uploadUrl, fileName);
      const publicUrl = joinUrl(publicStorage.publicBaseUrl, fileName);
      const headers = {
        'Content-Type': mimeType,
        'Cache-Control': 'no-store'
      };

      if (publicStorage.authorization) {
        headers.Authorization = publicStorage.authorization;
      }

      const response = await fetchImpl(uploadUrl, {
        method: 'PUT',
        headers,
        body: bytes
      });

      if (!response.ok) {
        throw new Error(`公网素材上传失败：HTTP ${response.status}`);
      }

      return {
        ...reference,
        dataUrl: undefined,
        mimeType,
        url: publicUrl
      };
    })
  );
}

function isConfiguredPublicStorage(publicStorage) {
  return Boolean(publicStorage?.uploadUrl && publicStorage?.publicBaseUrl);
}

function joinUrl(baseUrl, fileName) {
  return `${normalizePublicBaseUrl(baseUrl)}/${encodeURIComponent(fileName)}`;
}

function normalizePublicBaseUrl(url) {
  return `${url || ''}`.trim().replace(/\/+$/, '');
}

function extensionForMimeType(mimeType) {
  if (mimeType === 'image/jpeg') return 'jpg';
  if (mimeType === 'image/png') return 'png';
  if (mimeType === 'image/webp') return 'webp';
  return 'bin';
}
