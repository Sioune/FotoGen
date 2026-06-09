const DEFAULT_RESPONSES_ENDPOINT = 'https://api.openai.com/v1/responses';
const DEFAULT_IMAGE_MODEL = 'gpt-image-2';
const DEFAULT_SIZE = '1536x1024';

export function getImageServiceConfig(env = {}) {
  const baseUrl = normalizeBaseUrl(env.OPENAI_BASE_URL || env.OPENAI_API_BASE_URL || env.BASE_URL || '');
  const mode = env.OPENAI_IMAGE_MODE || 'responses';
  const model = env.OPENAI_IMAGE_MODEL || DEFAULT_IMAGE_MODEL;
  const endpoint = env.OPENAI_IMAGE_ENDPOINT || buildEndpointFromBaseUrl(baseUrl, mode, model) || DEFAULT_RESPONSES_ENDPOINT;
  const config = {
    hasApiKey: Boolean(env.OPENAI_API_KEY),
    mode,
    model,
    endpoint,
    size: env.OPENAI_IMAGE_SIZE || DEFAULT_SIZE,
    aspectRatio: env.OPENAI_IMAGE_ASPECT_RATIO || '16:9',
    resolution: env.OPENAI_IMAGE_RESOLUTION || '2K'
  };

  if (baseUrl) {
    config.baseUrl = baseUrl;
  }

  return config;
}

export function buildResponsesImageRequest({ model, prompt, references, size = DEFAULT_SIZE }) {
  return {
    model,
    input: [
      {
        role: 'user',
        content: [
          { type: 'input_text', text: buildRequestText(prompt, references) },
          ...references.map((reference) => ({
            type: 'input_image',
            image_url: reference.dataUrl
          }))
        ]
      }
    ],
    tools: [
      {
        type: 'image_generation',
        size,
        quality: 'high',
        output_format: 'png'
      }
    ]
  };
}

export async function generateMeetingImage({
  apiKey,
  mode,
  endpoint,
  model,
  prompt,
  references,
  size,
  aspectRatio,
  resolution,
  fetchImpl = fetch,
  pollIntervalMs = 2000,
  maxPollAttempts = 60
}) {
  if (!apiKey) {
    throw new Error('缺少 OPENAI_API_KEY，请先在 .env 中配置。');
  }
  if (!prompt || !Array.isArray(references) || references.length === 0) {
    throw new Error('生成请求缺少提示词或参考图。');
  }

  if (mode === 'images') {
    const formData = buildImageEditsFormData({ model, prompt, references, size });
    const response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`
      },
      body: formData
    });

    const payload = await readJsonResponse(response);

    if (!response.ok) {
      const message = payload?.error?.message || payload?.message || `图片生成失败：HTTP ${response.status}`;
      throw new Error(message);
    }

    return {
      imageDataUrl: extractImageDataUrl(payload),
      raw: payload
    };
  }

  if (mode === 'generations') {
    const request = buildImageGenerationsRequest({ model, prompt, references, size });
    const response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(request)
    });

    const payload = await readJsonResponse(response);

    if (!response.ok) {
      const message = payload?.error?.message || payload?.message || `图片生成失败：HTTP ${response.status}`;
      throw new Error(message);
    }

    return {
      imageDataUrl: extractImageDataUrl(payload),
      raw: payload
    };
  }

  if (mode === 'gptsapi-edit') {
    const request = buildGptsApiImageEditRequest({ prompt, references, aspectRatio, resolution });
    const response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(request)
    });

    const payload = await readJsonResponse(response);

    if (!response.ok || isApiError(payload)) {
      throw new Error(extractErrorMessage(payload, response.status));
    }

    const initialImage = tryExtractImageDataUrl(payload);
    if (initialImage) {
      return { imageDataUrl: initialImage, raw: payload };
    }

    const resultUrl = payload?.data?.urls?.get || payload?.urls?.get;
    if (!resultUrl) {
      throw new Error('图片任务已创建，但接口没有返回结果查询地址。');
    }

    return pollGptsApiResult({
      apiKey,
      resultUrl,
      fetchImpl,
      pollIntervalMs,
      maxPollAttempts
    });
  }

  const request =
    mode === 'custom'
      ? buildCustomImageRequest({ model, prompt, references, size })
      : buildResponsesImageRequest({ model, prompt, references, size });

  const response = await fetchImpl(endpoint || DEFAULT_RESPONSES_ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(request)
  });

  const payload = await readJsonResponse(response);

  if (!response.ok) {
    const message = payload?.error?.message || payload?.message || `图片生成失败：HTTP ${response.status}`;
    throw new Error(message);
  }

  return {
    imageDataUrl: extractImageDataUrl(payload),
    raw: payload
  };
}

export function buildCustomImageRequest({ model, prompt, references, size = DEFAULT_SIZE }) {
  return {
    model,
    prompt: buildRequestText(prompt, references),
    references: references.map((reference) => ({
      name: reference.name,
      kind: reference.kind,
      label: reference.label,
      image: reference.dataUrl
    })),
    output: {
      size,
      format: 'png',
      quality: 'high'
    }
  };
}

export function buildImageGenerationsRequest({ model, prompt, references, size = DEFAULT_SIZE }) {
  return {
    model,
    prompt: buildRequestText(prompt, references),
    size,
    quality: 'high',
    output_format: 'png'
  };
}

export function buildGptsApiImageEditRequest({ prompt, references, aspectRatio = '16:9', resolution = '2K' }) {
  const inputUrls = references.map((reference) => reference.url).filter(Boolean).slice(0, 16);

  if (!inputUrls.length) {
    throw new Error('GPTSAPI image-edit 需要可访问的图片 URL，不能直接使用本地上传的 data URL。');
  }

  return {
    prompt,
    input_urls: inputUrls,
    aspect_ratio: aspectRatio,
    resolution
  };
}

export function buildImageEditsFormData({ model, prompt, references, size = DEFAULT_SIZE }) {
  const formData = new FormData();
  formData.append('model', model);
  formData.append('prompt', buildRequestText(prompt, references));
  formData.append('size', size);
  formData.append('quality', 'high');
  formData.append('output_format', 'png');

  references.forEach((reference, index) => {
    const { mimeType, bytes } = dataUrlToBytes(reference.dataUrl);
    const extension = mimeType.split('/')[1] || 'png';
    const blob = new Blob([bytes], { type: mimeType });
    formData.append('image[]', blob, `reference-${index + 1}.${extension}`);
  });

  return formData;
}

export function extractImageDataUrl(payload) {
  const base64 =
    payload?.output?.find?.((item) => item?.type === 'image_generation_call' && item?.result)?.result ||
    payload?.output?.flatMap?.((item) => item?.content || [])?.find?.((item) => item?.b64_json)?.b64_json ||
    payload?.data?.[0]?.b64_json ||
    payload?.data?.outputs?.find?.((item) => item?.b64_json)?.b64_json ||
    payload?.outputs?.find?.((item) => item?.b64_json)?.b64_json ||
    payload?.image?.b64_json ||
    payload?.result;

  if (base64) {
    return base64.startsWith('data:image/') ? base64 : `data:image/png;base64,${base64}`;
  }

  const url =
    payload?.output?.flatMap?.((item) => item?.content || [])?.find?.((item) => item?.image_url)?.image_url ||
    payload?.data?.[0]?.url ||
    normalizeOutputUrl(payload?.data?.outputs?.[0]) ||
    normalizeOutputUrl(payload?.outputs?.[0]) ||
    payload?.image?.url;

  if (url) return url;

  throw new Error('图片生成接口没有返回可用图片。');
}

function buildRequestText(prompt, references) {
  const referenceMap = references
    .map((reference, index) => `${index + 1}. ${reference.label || reference.kind}：${reference.name}`)
    .join('\n');

  return `${prompt}\n\n参考图清单：\n${referenceMap}`;
}

async function readJsonResponse(response) {
  const text = await response.text();
  if (!text) return {};

  try {
    return JSON.parse(text);
  } catch {
    return { message: text };
  }
}

function normalizeBaseUrl(baseUrl) {
  return `${baseUrl || ''}`.trim().replace(/\/+$/, '');
}

function buildEndpointFromBaseUrl(baseUrl, mode, model = DEFAULT_IMAGE_MODEL) {
  if (!baseUrl) return '';
  if (mode === 'gptsapi-edit') {
    const origin = getOrigin(baseUrl);
    return `${origin}/api/v3/openai/${model}/image-edit`;
  }
  if (mode === 'images') {
    if (baseUrl.endsWith('/images/edits')) return baseUrl;
    if (baseUrl.endsWith('/v1')) return `${baseUrl}/images/edits`;
    return `${baseUrl}/v1/images/edits`;
  }
  if (mode === 'generations') {
    if (baseUrl.endsWith('/images/generations')) return baseUrl;
    if (baseUrl.endsWith('/v1')) return `${baseUrl}/images/generations`;
    return `${baseUrl}/v1/images/generations`;
  }

  if (baseUrl.endsWith('/responses')) return baseUrl;
  if (baseUrl.endsWith('/v1')) return `${baseUrl}/responses`;
  return `${baseUrl}/v1/responses`;
}

async function pollGptsApiResult({ apiKey, resultUrl, fetchImpl, pollIntervalMs, maxPollAttempts }) {
  let lastPayload = null;

  for (let attempt = 0; attempt < maxPollAttempts; attempt += 1) {
    if (attempt > 0 && pollIntervalMs > 0) {
      await wait(pollIntervalMs);
    }

    const response = await fetchImpl(resultUrl, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`
      }
    });
    const payload = await readJsonResponse(response);
    lastPayload = payload;

    if (!response.ok || isApiError(payload)) {
      throw new Error(extractErrorMessage(payload, response.status));
    }

    const imageDataUrl = tryExtractImageDataUrl(payload);
    if (imageDataUrl) {
      return { imageDataUrl, raw: payload };
    }

    const status = `${payload?.data?.status || payload?.status || ''}`.toLowerCase();
    if (['failed', 'failure', 'error', 'cancelled', 'canceled'].includes(status)) {
      throw new Error(payload?.data?.error || payload?.error?.message || '图片生成任务失败。');
    }
  }

  throw new Error(`图片生成仍在处理中，请稍后重试。最后状态：${lastPayload?.data?.status || lastPayload?.status || 'unknown'}`);
}

function tryExtractImageDataUrl(payload) {
  try {
    return extractImageDataUrl(payload);
  } catch {
    return '';
  }
}

function isApiError(payload) {
  return Number(payload?.code) >= 400 || Boolean(payload?.error);
}

function extractErrorMessage(payload, status) {
  return payload?.error?.message || payload?.message || payload?.data?.error || `图片生成失败：HTTP ${status}`;
}

function normalizeOutputUrl(output) {
  if (!output) return '';
  if (typeof output === 'string') return output;
  return output.url || output.image_url || output.uri || '';
}

function getOrigin(baseUrl) {
  try {
    return new URL(baseUrl).origin;
  } catch {
    return baseUrl.replace(/\/v1$/u, '').replace(/\/+$/u, '');
  }
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function dataUrlToBytes(dataUrl) {
  const match = /^data:([^;,]+);base64,(.+)$/u.exec(dataUrl);
  if (!match) {
    throw new Error('参考图格式无效，请重新上传图片。');
  }

  return {
    mimeType: match[1],
    bytes: Uint8Array.from(atob(match[2]), (char) => char.charCodeAt(0))
  };
}
