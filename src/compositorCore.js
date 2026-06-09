export const CANVAS_SIZE = Object.freeze({ width: 1800, height: 1200 });

export const MODE_LABELS = Object.freeze({
  layout: {
    seated: '座位',
    standing: '站位',
    conference: '会议桌'
  },
  clothing: {
    formal: '正式商务',
    smart: '商务休闲',
    unified: '统一深色'
  },
  expression: {
    focused: '专注',
    warm: '自然微笑',
    confident: '精神饱满'
  }
});

export function hasCompleteSelection(selection) {
  return Boolean(
    Array.isArray(selection?.participantIds) &&
      selection.participantIds.length > 0 &&
      selection.locationId &&
      selection.screenImage &&
      selection.layoutMode &&
      selection.clothingMode &&
      selection.expressionMode
  );
}

export function normalizeAssetRecord(record) {
  const id = record?.id || createId(record?.type || 'asset');
  const name = normalizeAssetName(record?.name);
  const dataUrl = record?.dataUrl || '';
  const type = record?.type || 'asset';

  return { id, name, dataUrl, type };
}

export function renameAssetRecord(record, name) {
  return normalizeAssetRecord({
    ...record,
    name: normalizeAssetName(name)
  });
}

export function removeAssetFromSelection(selection, asset) {
  if (!selection || !asset?.id) return selection;

  if (asset.type === 'person') {
    return {
      ...selection,
      participantIds: (selection.participantIds || []).filter((id) => id !== asset.id)
    };
  }

  if (asset.type === 'location' && selection.locationId === asset.id) {
    return {
      ...selection,
      locationId: ''
    };
  }

  return { ...selection };
}

export function createId(prefix = 'item') {
  const random = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${Date.now().toString(36)}-${random}`;
}

export function createExportName(date = new Date()) {
  const yyyy = date.getFullYear();
  const mm = pad(date.getMonth() + 1);
  const dd = pad(date.getDate());
  const hh = pad(date.getHours());
  const mi = pad(date.getMinutes());
  const ss = pad(date.getSeconds());

  return `meeting-photo-${yyyy}-${mm}-${dd}-${hh}${mi}${ss}.png`;
}

export function computePersonSlots(count, layoutMode, size = CANVAS_SIZE) {
  if (!Number.isFinite(count) || count <= 0) {
    return [];
  }

  const rows = getRows(count, layoutMode);
  const slots = [];

  rows.forEach((row, layer) => {
    const rowCount = row.count;
    const spacing = row.width / Math.max(rowCount - 1, 1);
    const startX = size.width / 2 - row.width / 2;

    for (let index = 0; index < rowCount; index += 1) {
      const centeredIndex = index - (rowCount - 1) / 2;
      const curve = Math.abs(centeredIndex) / Math.max(rowCount / 2, 1);
      const x = rowCount === 1 ? size.width / 2 : startX + spacing * index;
      const y = row.y + curve * row.arc;

      slots.push({
        x: clamp(Math.round(x), 180, size.width - 180),
        y: Math.round(y),
        scale: row.scale,
        layer,
        rowIndex: index
      });
    }
  });

  return slots;
}

function getRows(count, layoutMode) {
  if (layoutMode === 'standing') {
    if (count <= 5) {
      return [{ count, y: 705, width: Math.min(1180, 220 * Math.max(count - 1, 1)), scale: 1.04, arc: 42 }];
    }

    const back = Math.ceil(count * 0.45);
    const front = count - back;
    return [
      { count: back, y: 610, width: Math.min(1240, 235 * Math.max(back - 1, 1)), scale: 0.9, arc: 34 },
      { count: front, y: 785, width: Math.min(1440, 245 * Math.max(front - 1, 1)), scale: 1.08, arc: 50 }
    ];
  }

  if (layoutMode === 'conference') {
    const back = Math.max(1, Math.floor(count * 0.4));
    const front = count - back;
    return [
      { count: back, y: 545, width: Math.min(1020, 230 * Math.max(back - 1, 1)), scale: 0.82, arc: 26 },
      { count: front, y: 780, width: Math.min(1390, 230 * Math.max(front - 1, 1)), scale: 1, arc: 44 }
    ];
  }

  if (count <= 3) {
    return [{ count, y: 750, width: Math.min(840, 250 * Math.max(count - 1, 1)), scale: 1.05, arc: 36 }];
  }

  const back = Math.floor(count * 0.42);
  const front = count - back;
  return [
    { count: back, y: 575, width: Math.min(980, 245 * Math.max(back - 1, 1)), scale: 0.82, arc: 28 },
    { count: front, y: 805, width: Math.min(1370, 240 * Math.max(front - 1, 1)), scale: 1.02, arc: 42 }
  ];
}

function pad(value) {
  return String(value).padStart(2, '0');
}

function normalizeAssetName(name) {
  return `${name || '未命名素材'}`.trim() || '未命名素材';
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}
