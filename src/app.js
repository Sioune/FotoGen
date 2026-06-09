import {
  CANVAS_SIZE,
  MODE_LABELS,
  computePersonSlots,
  createExportName,
  normalizeAssetRecord,
  removeAssetFromSelection,
  renameAssetRecord
} from './compositorCore.js';
import { buildGenerationPackage } from './promptBuilder.js';
import { createPersistedSelection, writeJsonStorage } from './storage.js';

const STORAGE_KEYS = {
  people: 'photogen.people',
  locations: 'photogen.locations',
  selection: 'photogen.selection'
};

const UPLOAD_LIMITS = Object.freeze({
  person: { maxDimension: 1400, quality: 0.88 },
  location: { maxDimension: 1800, quality: 0.88 },
  screen: { maxDimension: 1800, quality: 0.9 }
});

const state = {
  people: [],
  locations: [],
  activeLibrary: 'people',
  selection: {
    participantIds: [],
    locationId: '',
    screenImage: '',
    layoutMode: 'seated',
    clothingMode: 'formal',
    expressionMode: 'warm'
  },
  imageCache: new Map(),
  generatedImage: '',
  isGenerating: false,
  generationMessage: '等待生成',
  statusMessage: '',
  serviceConfig: null
};

const els = {
  peopleGrid: document.querySelector('#peopleGrid'),
  locationGrid: document.querySelector('#locationGrid'),
  peopleUpload: document.querySelector('#peopleUpload'),
  locationUpload: document.querySelector('#locationUpload'),
  screenUpload: document.querySelector('#screenUpload'),
  screenUploadLabel: document.querySelector('#screenUploadLabel'),
  canvas: document.querySelector('#photoCanvas'),
  promptPreview: document.querySelector('#promptPreview'),
  generateButton: document.querySelector('#generateButton'),
  generatedImage: document.querySelector('#generatedImage'),
  resultPlaceholder: document.querySelector('#resultPlaceholder'),
  resultStatus: document.querySelector('#resultStatus'),
  modelStatus: document.querySelector('#modelStatus'),
  downloadButton: document.querySelector('#downloadButton'),
  clearSelectionButton: document.querySelector('#clearSelectionButton'),
  resetDemoButton: document.querySelector('#resetDemoButton'),
  statusDot: document.querySelector('#statusDot'),
  statusText: document.querySelector('#statusText'),
  selectedPeopleCount: document.querySelector('#selectedPeopleCount'),
  selectedLocationName: document.querySelector('#selectedLocationName'),
  selectedLayoutName: document.querySelector('#selectedLayoutName'),
  selectedClothingName: document.querySelector('#selectedClothingName'),
  selectedExpressionName: document.querySelector('#selectedExpressionName')
};

const ctx = els.canvas.getContext('2d');

boot();

function boot() {
  loadState();
  bindEvents();
  loadServiceConfig();
  render();
}

function loadState() {
  const storedPeople = readStorage(STORAGE_KEYS.people);
  const storedLocations = readStorage(STORAGE_KEYS.locations);
  const storedSelection = readStorage(STORAGE_KEYS.selection);

  state.people = storedPeople?.length ? storedPeople : createDemoPeople();
  state.locations = storedLocations?.length ? storedLocations : createDemoLocations();
  state.selection = {
    ...state.selection,
    ...(storedSelection || {})
  };

  if (!state.selection.locationId && state.locations[0]) {
    state.selection.locationId = state.locations[0].id;
  }
}

function bindEvents() {
  document.querySelectorAll('[data-library-tab]').forEach((button) => {
    button.addEventListener('click', () => {
      state.activeLibrary = button.dataset.libraryTab;
      renderLibraries();
    });
  });

  document.querySelectorAll('[data-mode-group]').forEach((group) => {
    group.addEventListener('click', (event) => {
      const button = event.target.closest('[data-mode-value]');
      if (!button) return;

      resetGeneratedImage();
      state.selection[group.dataset.modeGroup] = button.dataset.modeValue;
      persistSelection();
      render();
    });
  });

  els.peopleUpload.addEventListener('change', async (event) => {
    const files = Array.from(event.target.files || []);
    if (!files.length) return;

    try {
      setStatusMessage('正在读取并压缩人员照片');
      const assets = await readImageFiles(files, 'person');
      resetGeneratedImage();
      state.people = [...assets, ...state.people];
      state.selection.participantIds = unique([
        ...assets.map((asset) => asset.id),
        ...state.selection.participantIds
      ]);
      event.target.value = '';
      const persistResult = persistAll();
      if (persistResult.ok) {
        setStatusMessage(`已上传 ${assets.length} 张人员照片`);
      }
    } catch (error) {
      setStatusMessage(error.message || '人员照片上传失败');
    } finally {
      render();
    }
  });

  els.locationUpload.addEventListener('change', async (event) => {
    const files = Array.from(event.target.files || []);
    if (!files.length) return;

    try {
      setStatusMessage('正在读取并压缩地址照片');
      const assets = await readImageFiles(files, 'location');
      resetGeneratedImage();
      state.locations = [...assets, ...state.locations];
      if (assets[0]) {
        state.selection.locationId = assets[0].id;
      }
      event.target.value = '';
      const persistResult = persistAll();
      if (persistResult.ok) {
        setStatusMessage(`已上传 ${assets.length} 张地址照片`);
      }
    } catch (error) {
      setStatusMessage(error.message || '地址照片上传失败');
    } finally {
      render();
    }
  });

  els.screenUpload.addEventListener('change', async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;

    try {
      setStatusMessage('正在读取并压缩屏幕内容');
      resetGeneratedImage();
      const asset = await prepareUploadedImage(file, 'screen');
      state.selection.screenImage = asset.dataUrl;
      els.screenUploadLabel.textContent = file.name;
      event.target.value = '';
      persistSelection();
      setStatusMessage('屏幕内容已上传');
    } catch (error) {
      setStatusMessage(error.message || '屏幕内容上传失败');
    } finally {
      render();
    }
  });

  els.generateButton.addEventListener('click', generateImage);
  els.downloadButton.addEventListener('click', downloadGeneratedImage);

  els.clearSelectionButton.addEventListener('click', () => {
    resetGeneratedImage();
    state.selection.participantIds = [];
    state.selection.screenImage = '';
    els.screenUploadLabel.textContent = '上传屏幕内容';
    persistSelection();
    render();
  });

  els.resetDemoButton.addEventListener('click', () => {
    resetGeneratedImage();
    state.people = createDemoPeople();
    state.locations = createDemoLocations();
    state.selection = {
      participantIds: [],
      locationId: state.locations[0]?.id || '',
      screenImage: '',
      layoutMode: 'seated',
      clothingMode: 'formal',
      expressionMode: 'warm'
    };
    els.screenUploadLabel.textContent = '上传屏幕内容';
    persistAssets();
    persistSelection();
    render();
  });
}

function render() {
  renderLibraries();
  renderModes();
  renderSelectionSummary();
  drawComposite();
}

function renderLibraries() {
  document.querySelectorAll('[data-library-tab]').forEach((button) => {
    button.classList.toggle('is-active', button.dataset.libraryTab === state.activeLibrary);
  });

  document.querySelector('#peopleLibrary').classList.toggle('is-active', state.activeLibrary === 'people');
  document
    .querySelector('#locationsLibrary')
    .classList.toggle('is-active', state.activeLibrary === 'locations');

  els.peopleGrid.replaceChildren(
    ...state.people.map((asset) =>
      createAssetCard(asset, state.selection.participantIds.includes(asset.id), {
        onSelect: () => {
          const selected = state.selection.participantIds.includes(asset.id);
          resetGeneratedImage();
          state.selection.participantIds = selected
            ? state.selection.participantIds.filter((id) => id !== asset.id)
            : [...state.selection.participantIds, asset.id];
          persistSelection();
          render();
        },
        onRename: (name) => renameAsset('people', asset.id, name),
        onDelete: () => deleteAsset('people', asset)
      })
    )
  );

  els.locationGrid.replaceChildren(
    ...state.locations.map((asset) =>
      createAssetCard(asset, state.selection.locationId === asset.id, {
        onSelect: () => {
          resetGeneratedImage();
          state.selection.locationId = asset.id;
          persistSelection();
          render();
        },
        onRename: (name) => renameAsset('locations', asset.id, name),
        onDelete: () => deleteAsset('locations', asset)
      })
    )
  );
}

function createAssetCard(asset, isSelected, handlers) {
  const card = document.createElement('article');
  card.className = `asset-card ${asset.type === 'location' ? 'location-card' : ''}`;
  card.classList.toggle('is-selected', isSelected);

  const selectButton = document.createElement('button');
  selectButton.type = 'button';
  selectButton.className = 'asset-select';
  selectButton.setAttribute('aria-pressed', String(isSelected));
  selectButton.setAttribute('aria-label', `选择 ${asset.name}`);
  selectButton.addEventListener('click', handlers.onSelect);

  const image = document.createElement('img');
  image.src = asset.dataUrl;
  image.alt = asset.name;

  selectButton.append(image);

  const footer = document.createElement('div');
  footer.className = 'asset-footer';

  const nameInput = document.createElement('input');
  nameInput.className = 'asset-name-input';
  nameInput.type = 'text';
  nameInput.value = asset.name;
  nameInput.setAttribute('aria-label', `修改 ${asset.name} 的名称`);
  const commitRename = () => handlers.onRename(nameInput.value);
  nameInput.addEventListener('blur', commitRename);
  nameInput.addEventListener('change', commitRename);
  nameInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      commitRename();
    }
    if (event.key === 'Escape') {
      nameInput.value = asset.name;
      nameInput.blur();
    }
  });

  const deleteButton = document.createElement('button');
  deleteButton.type = 'button';
  deleteButton.className = 'asset-delete';
  deleteButton.textContent = '×';
  deleteButton.title = '删除照片';
  deleteButton.setAttribute('aria-label', `删除 ${asset.name}`);
  deleteButton.addEventListener('click', handlers.onDelete);

  footer.append(nameInput, deleteButton);
  card.append(selectButton, footer);
  return card;
}

function renameAsset(collectionName, assetId, name) {
  const collection = state[collectionName];
  const index = collection.findIndex((asset) => asset.id === assetId);
  if (index === -1) return;

  const nextAsset = renameAssetRecord(collection[index], name);
  if (nextAsset.name === collection[index].name) return;

  resetGeneratedImage();
  state[collectionName] = collection.map((asset) => (asset.id === assetId ? nextAsset : asset));
  persistAll();
  render();
}

function deleteAsset(collectionName, asset) {
  resetGeneratedImage();
  state[collectionName] = state[collectionName].filter((item) => item.id !== asset.id);
  state.selection = removeAssetFromSelection(state.selection, asset);
  state.imageCache.delete(asset.dataUrl);
  const persistResult = persistAll();
  if (persistResult.ok) {
    setStatusMessage('照片已删除');
  }
  render();
}

function renderModes() {
  document.querySelectorAll('[data-mode-group]').forEach((group) => {
    const groupName = group.dataset.modeGroup;
    group.querySelectorAll('[data-mode-value]').forEach((button) => {
      button.classList.toggle('is-active', state.selection[groupName] === button.dataset.modeValue);
    });
  });
}

function renderSelectionSummary() {
  const packageInfo = getGenerationPackage();
  const complete = packageInfo.ready;
  const selectedLocation = state.locations.find((asset) => asset.id === state.selection.locationId);

  els.selectedPeopleCount.textContent = String(state.selection.participantIds.length);
  els.selectedLocationName.textContent = selectedLocation?.name || '未选择';
  els.selectedLayoutName.textContent = MODE_LABELS.layout[state.selection.layoutMode] || '座位';
  els.selectedClothingName.textContent = MODE_LABELS.clothing[state.selection.clothingMode] || '正式商务';
  els.selectedExpressionName.textContent = MODE_LABELS.expression[state.selection.expressionMode] || '自然微笑';
  els.statusDot.classList.toggle('is-ready', complete);
  els.statusText.textContent = getStatusText(complete);
  els.generateButton.disabled = !complete || state.isGenerating;
  els.downloadButton.disabled = !state.generatedImage;
  els.promptPreview.value = packageInfo.prompt || `请先补齐：${packageInfo.missing.join('、')}`;
  els.resultStatus.textContent = state.isGenerating ? '正在生成' : state.generationMessage;
  els.generatedImage.hidden = !state.generatedImage;
  els.resultPlaceholder.hidden = Boolean(state.generatedImage);
  if (state.generatedImage) {
    els.generatedImage.src = state.generatedImage;
  }

  if (state.selection.screenImage && els.screenUploadLabel.textContent === '上传屏幕内容') {
    els.screenUploadLabel.textContent = '屏幕内容已上传';
  }
}

function getStatusText(complete) {
  if (state.statusMessage) return state.statusMessage;
  if (state.isGenerating) return '正在生成最终合照';
  if (state.generatedImage) return '最终合照已生成';
  return complete ? '可生成最终合照' : getMissingText();
}

function getMissingText() {
  if (!state.selection.participantIds.length) return '请选择参会人员';
  if (!state.selection.locationId) return '请选择参会地址';
  if (!state.selection.screenImage) return '请上传屏幕内容';
  return '待选择模式';
}

async function loadServiceConfig() {
  try {
    const response = await fetch('/api/config');
    if (!response.ok) throw new Error('模型配置读取失败');
    state.serviceConfig = await response.json();
    els.modelStatus.textContent = state.serviceConfig.hasApiKey
      ? `${state.serviceConfig.model} · 已配置`
      : `${state.serviceConfig.model} · 待配置密钥`;
  } catch (error) {
    els.modelStatus.textContent = error.message || '模型配置读取失败';
  }
}

async function generateImage() {
  const packageInfo = getGenerationPackage();
  if (!packageInfo.ready || state.isGenerating) return;

  state.isGenerating = true;
  state.generatedImage = '';
  state.generationMessage = '正在生成';
  renderSelectionSummary();

  try {
    const response = await fetch('/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt: packageInfo.prompt,
        references: packageInfo.references
      })
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || '生成失败');

    state.generatedImage = body.imageDataUrl;
    state.generationMessage = `已生成 · ${body.model || '图片模型'}`;
  } catch (error) {
    state.generationMessage = error.message || '生成失败';
  } finally {
    state.isGenerating = false;
    renderSelectionSummary();
  }
}

function getGenerationPackage() {
  return buildGenerationPackage({
    people: state.people,
    locations: state.locations,
    selection: state.selection
  });
}

function setStatusMessage(message) {
  state.statusMessage = message;
}

async function drawComposite() {
  ctx.clearRect(0, 0, CANVAS_SIZE.width, CANVAS_SIZE.height);

  const location = state.locations.find((asset) => asset.id === state.selection.locationId);
  await drawLocation(location);
  await drawScreenContent();

  const participants = state.selection.participantIds
    .map((id) => state.people.find((asset) => asset.id === id))
    .filter(Boolean);
  const slots = computePersonSlots(participants.length, state.selection.layoutMode, CANVAS_SIZE);

  for (const layer of [0, 1]) {
    const items = participants
      .map((participant, index) => ({ participant, slot: slots[index] }))
      .filter((item) => item.slot?.layer === layer);

    for (const item of items) {
      await drawParticipant(item.participant, item.slot);
    }

    if (layer === 0 && shouldDrawTable()) {
      drawMeetingTable();
    }
  }

  if (!participants.length) {
    drawEmptyStage();
  }

  drawFinishGrade();
}

async function drawLocation(location) {
  if (location?.dataUrl) {
    const image = await loadImage(location.dataUrl);
    drawImageCover(image, 0, 0, CANVAS_SIZE.width, CANVAS_SIZE.height);
  } else {
    drawGeneratedRoom('#e3e8ea', '#8aa0aa', '#586a72');
  }

  const vignette = ctx.createRadialGradient(900, 460, 240, 900, 610, 960);
  vignette.addColorStop(0, 'rgb(255 255 255 / 0.10)');
  vignette.addColorStop(1, 'rgb(17 27 35 / 0.28)');
  ctx.fillStyle = vignette;
  ctx.fillRect(0, 0, CANVAS_SIZE.width, CANVAS_SIZE.height);
}

async function drawScreenContent() {
  const screen = { x: 558, y: 130, width: 684, height: 354 };

  ctx.save();
  ctx.shadowColor = 'rgb(8 18 25 / 0.25)';
  ctx.shadowBlur = 28;
  ctx.shadowOffsetY = 16;
  roundRect(screen.x - 18, screen.y - 18, screen.width + 36, screen.height + 42, 8);
  ctx.fillStyle = '#1d252d';
  ctx.fill();
  ctx.restore();

  roundRect(screen.x, screen.y, screen.width, screen.height, 5);
  ctx.fillStyle = '#eef3f4';
  ctx.fill();

  if (state.selection.screenImage) {
    const image = await loadImage(state.selection.screenImage);
    ctx.save();
    roundRect(screen.x, screen.y, screen.width, screen.height, 5);
    ctx.clip();
    drawImageCover(image, screen.x, screen.y, screen.width, screen.height);
    ctx.restore();
  } else {
    drawScreenPlaceholder(screen);
  }

  const shine = ctx.createLinearGradient(screen.x, screen.y, screen.x + screen.width, screen.y);
  shine.addColorStop(0, 'rgb(255 255 255 / 0.18)');
  shine.addColorStop(0.45, 'rgb(255 255 255 / 0.02)');
  shine.addColorStop(1, 'rgb(255 255 255 / 0.12)');
  ctx.fillStyle = shine;
  roundRect(screen.x, screen.y, screen.width, screen.height, 5);
  ctx.fill();
}

async function drawParticipant(participant, slot) {
  const image = await loadImage(participant.dataUrl);
  const body = getBodyMetrics(slot);

  ctx.save();
  ctx.globalAlpha = 0.32;
  ctx.fillStyle = '#0d1820';
  ctx.beginPath();
  ctx.ellipse(slot.x, body.shadowY, body.bodyWidth * 0.62, 28 * slot.scale, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  drawBody(slot, body);
  drawHeadImage(image, slot, body);
  drawNeckAndCollar(slot, body);
}

function getBodyMetrics(slot) {
  const seated = state.selection.layoutMode !== 'standing';
  return {
    headSize: (seated ? 146 : 156) * slot.scale,
    bodyWidth: (seated ? 228 : 216) * slot.scale,
    bodyHeight: (seated ? 315 : 350) * slot.scale,
    shoulderY: slot.y + (seated ? 70 : 50) * slot.scale,
    headY: slot.y - (seated ? 38 : 34) * slot.scale,
    shadowY: slot.y + (seated ? 306 : 392) * slot.scale
  };
}

function drawBody(slot, body) {
  const palette = getClothingPalette();
  const x = slot.x;
  const shoulderY = body.shoulderY;
  const half = body.bodyWidth / 2;
  const bottomY = shoulderY + body.bodyHeight;

  ctx.save();
  ctx.shadowColor = 'rgb(7 17 24 / 0.22)';
  ctx.shadowBlur = 18;
  ctx.shadowOffsetY = 12;

  ctx.beginPath();
  ctx.moveTo(x - half * 0.6, shoulderY);
  ctx.bezierCurveTo(x - half, shoulderY + 34, x - half * 0.88, bottomY - 20, x - half * 0.62, bottomY);
  ctx.lineTo(x + half * 0.62, bottomY);
  ctx.bezierCurveTo(x + half * 0.88, bottomY - 20, x + half, shoulderY + 34, x + half * 0.6, shoulderY);
  ctx.closePath();
  ctx.fillStyle = palette.jacket;
  ctx.fill();

  ctx.shadowColor = 'transparent';
  ctx.beginPath();
  ctx.moveTo(x - half * 0.28, shoulderY + 12);
  ctx.lineTo(x, shoulderY + body.bodyHeight * 0.56);
  ctx.lineTo(x + half * 0.28, shoulderY + 12);
  ctx.quadraticCurveTo(x, shoulderY + 42, x - half * 0.28, shoulderY + 12);
  ctx.fillStyle = palette.shirt;
  ctx.fill();

  if (state.selection.clothingMode === 'formal' || state.selection.clothingMode === 'unified') {
    ctx.beginPath();
    ctx.moveTo(x, shoulderY + 38);
    ctx.lineTo(x - 14 * slot.scale, shoulderY + 132 * slot.scale);
    ctx.lineTo(x, shoulderY + 178 * slot.scale);
    ctx.lineTo(x + 14 * slot.scale, shoulderY + 132 * slot.scale);
    ctx.closePath();
    ctx.fillStyle = palette.tie;
    ctx.fill();
  }

  ctx.restore();
}

function drawHeadImage(image, slot, body) {
  const size = body.headSize;
  const x = slot.x - size / 2;
  const y = body.headY - size / 2;

  ctx.save();
  ctx.shadowColor = 'rgb(6 15 21 / 0.24)';
  ctx.shadowBlur = 14;
  ctx.shadowOffsetY = 8;
  ctx.beginPath();
  ctx.ellipse(slot.x, body.headY, size * 0.43, size * 0.5, 0, 0, Math.PI * 2);
  ctx.fillStyle = '#d7b298';
  ctx.fill();
  ctx.clip();
  drawImageCover(image, x - size * 0.06, y - size * 0.02, size * 1.12, size * 1.1);
  ctx.restore();

  ctx.save();
  ctx.globalCompositeOperation = 'multiply';
  ctx.fillStyle = getExpressionTone();
  ctx.beginPath();
  ctx.ellipse(slot.x, body.headY + size * 0.05, size * 0.43, size * 0.44, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function drawNeckAndCollar(slot, body) {
  const x = slot.x;
  const y = body.shoulderY + 2 * slot.scale;

  ctx.save();
  ctx.globalCompositeOperation = 'destination-over';
  ctx.fillStyle = '#cfa58c';
  roundRect(x - 22 * slot.scale, y - 52 * slot.scale, 44 * slot.scale, 62 * slot.scale, 8 * slot.scale);
  ctx.fill();
  ctx.restore();

  ctx.save();
  ctx.fillStyle = getClothingPalette().shirt;
  ctx.beginPath();
  ctx.moveTo(x - 46 * slot.scale, y - 10 * slot.scale);
  ctx.lineTo(x - 8 * slot.scale, y + 38 * slot.scale);
  ctx.lineTo(x, y + 12 * slot.scale);
  ctx.lineTo(x + 8 * slot.scale, y + 38 * slot.scale);
  ctx.lineTo(x + 46 * slot.scale, y - 10 * slot.scale);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function drawMeetingTable() {
  const isConference = state.selection.layoutMode === 'conference';
  const tableY = isConference ? 840 : 875;
  const tableH = isConference ? 300 : 250;
  const tableW = isConference ? 1450 : 1280;
  const x = (CANVAS_SIZE.width - tableW) / 2;

  ctx.save();
  ctx.shadowColor = 'rgb(10 20 28 / 0.24)';
  ctx.shadowBlur = 24;
  ctx.shadowOffsetY = 16;
  ctx.beginPath();
  ctx.ellipse(CANVAS_SIZE.width / 2, tableY + tableH * 0.2, tableW / 2, tableH / 2, 0, 0, Math.PI * 2);
  ctx.fillStyle = isConference ? '#7d6755' : '#866a55';
  ctx.fill();

  const grain = ctx.createLinearGradient(x, tableY - tableH / 2, x + tableW, tableY + tableH / 2);
  grain.addColorStop(0, 'rgb(255 255 255 / 0.12)');
  grain.addColorStop(0.55, 'rgb(0 0 0 / 0.06)');
  grain.addColorStop(1, 'rgb(255 255 255 / 0.08)');
  ctx.fillStyle = grain;
  ctx.beginPath();
  ctx.ellipse(CANVAS_SIZE.width / 2, tableY + tableH * 0.2, tableW / 2, tableH / 2, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function shouldDrawTable() {
  return state.selection.layoutMode === 'seated' || state.selection.layoutMode === 'conference';
}

function drawScreenPlaceholder(screen) {
  const gradient = ctx.createLinearGradient(screen.x, screen.y, screen.x + screen.width, screen.y + screen.height);
  gradient.addColorStop(0, '#e3ecef');
  gradient.addColorStop(1, '#cfdadc');
  ctx.fillStyle = gradient;
  ctx.fillRect(screen.x, screen.y, screen.width, screen.height);

  ctx.fillStyle = 'rgb(37 111 104 / 0.16)';
  for (let i = 0; i < 5; i += 1) {
    roundRect(screen.x + 70, screen.y + 76 + i * 38, screen.width - 140 - i * 18, 14, 6);
    ctx.fill();
  }
}

function drawEmptyStage() {
  ctx.save();
  ctx.globalAlpha = 0.22;
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.ellipse(900, 875, 470, 92, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function drawFinishGrade() {
  const warmth = ctx.createLinearGradient(0, 0, CANVAS_SIZE.width, CANVAS_SIZE.height);
  warmth.addColorStop(0, 'rgb(255 245 226 / 0.08)');
  warmth.addColorStop(0.5, 'rgb(255 255 255 / 0.02)');
  warmth.addColorStop(1, 'rgb(31 60 69 / 0.10)');
  ctx.fillStyle = warmth;
  ctx.fillRect(0, 0, CANVAS_SIZE.width, CANVAS_SIZE.height);
}

function getClothingPalette() {
  if (state.selection.clothingMode === 'smart') {
    return { jacket: '#7f7365', shirt: '#f3f0e9', tie: '#3c6662' };
  }
  if (state.selection.clothingMode === 'unified') {
    return { jacket: '#222c36', shirt: '#f5f7f8', tie: '#7f2332' };
  }
  return { jacket: '#2e3e53', shirt: '#f8fafb', tie: '#8c4431' };
}

function getExpressionTone() {
  if (state.selection.expressionMode === 'focused') return 'rgb(235 240 244 / 0.06)';
  if (state.selection.expressionMode === 'confident') return 'rgb(255 236 205 / 0.08)';
  return 'rgb(255 223 210 / 0.08)';
}

function drawGeneratedRoom(wall, trim, floor) {
  const wallGradient = ctx.createLinearGradient(0, 0, 0, 760);
  wallGradient.addColorStop(0, wall);
  wallGradient.addColorStop(1, '#c7d0d4');
  ctx.fillStyle = wallGradient;
  ctx.fillRect(0, 0, CANVAS_SIZE.width, 760);

  ctx.fillStyle = trim;
  ctx.fillRect(0, 690, CANVAS_SIZE.width, 18);

  const floorGradient = ctx.createLinearGradient(0, 710, 0, CANVAS_SIZE.height);
  floorGradient.addColorStop(0, '#9aa9ac');
  floorGradient.addColorStop(1, floor);
  ctx.fillStyle = floorGradient;
  ctx.fillRect(0, 708, CANVAS_SIZE.width, CANVAS_SIZE.height - 708);

  ctx.strokeStyle = 'rgb(255 255 255 / 0.22)';
  ctx.lineWidth = 3;
  for (let i = -3; i <= 3; i += 1) {
    ctx.beginPath();
    ctx.moveTo(900 + i * 160, 708);
    ctx.lineTo(900 + i * 330, 1200);
    ctx.stroke();
  }
}

function createDemoPeople() {
  const names = ['陈岚', '王亦舟', '林嘉禾', '赵敏', '周一诺', '许晨'];
  const palettes = [
    ['#81634f', '#d7a184', '#29384b'],
    ['#2d3444', '#c88f72', '#354d49'],
    ['#5f463f', '#ddb094', '#5d6d7b'],
    ['#262c35', '#c8947c', '#7a4c62'],
    ['#6d5345', '#d9a787', '#3f5064'],
    ['#303c47', '#c68e74', '#6a604a']
  ];

  return names.map((name, index) =>
    normalizeAssetRecord({
      id: `demo-person-${index + 1}`,
      name,
      type: 'person',
      dataUrl: createPortraitDataUrl(name, palettes[index])
    })
  );
}

function createDemoLocations() {
  const rooms = [
    ['董事会议室', '#dfe7ea', '#9aaab2', '#617176'],
    ['培训中心', '#e9e3dc', '#a37e63', '#61544d'],
    ['项目作战室', '#dde6e0', '#6d9588', '#4d5f5f']
  ];

  return rooms.map(([name, wall, trim, floor], index) =>
    normalizeAssetRecord({
      id: `demo-location-${index + 1}`,
      name,
      type: 'location',
      dataUrl: createRoomDataUrl(wall, trim, floor)
    })
  );
}

function createPortraitDataUrl(name, [hair, skin, jacket]) {
  const canvas = document.createElement('canvas');
  canvas.width = 420;
  canvas.height = 420;
  const portrait = canvas.getContext('2d');

  const bg = portrait.createLinearGradient(0, 0, 420, 420);
  bg.addColorStop(0, '#e9eef0');
  bg.addColorStop(1, '#c6d4d8');
  portrait.fillStyle = bg;
  portrait.fillRect(0, 0, 420, 420);

  portrait.fillStyle = 'rgb(255 255 255 / 0.55)';
  portrait.beginPath();
  portrait.arc(210, 192, 138, 0, Math.PI * 2);
  portrait.fill();

  portrait.fillStyle = jacket;
  portrait.beginPath();
  portrait.moveTo(100, 420);
  portrait.quadraticCurveTo(210, 260, 320, 420);
  portrait.closePath();
  portrait.fill();

  portrait.fillStyle = skin;
  roundRectWithContext(portrait, 182, 244, 56, 68, 18);
  portrait.fill();

  portrait.fillStyle = skin;
  portrait.beginPath();
  portrait.ellipse(210, 188, 76, 91, 0, 0, Math.PI * 2);
  portrait.fill();

  portrait.fillStyle = hair;
  portrait.beginPath();
  portrait.ellipse(210, 133, 82, 54, 0, Math.PI * 0.05, Math.PI * 1.03, true);
  portrait.fill();

  portrait.fillStyle = '#29313a';
  portrait.beginPath();
  portrait.arc(184, 188, 6, 0, Math.PI * 2);
  portrait.arc(236, 188, 6, 0, Math.PI * 2);
  portrait.fill();

  portrait.strokeStyle = '#8d554a';
  portrait.lineWidth = 5;
  portrait.lineCap = 'round';
  portrait.beginPath();
  portrait.moveTo(185, 225);
  portrait.quadraticCurveTo(210, 242, 238, 225);
  portrait.stroke();

  portrait.fillStyle = 'rgb(255 255 255 / 0.82)';
  portrait.font = '700 28px "PingFang SC", "Microsoft YaHei", sans-serif';
  portrait.textAlign = 'center';
  portrait.fillText(name.slice(0, 2), 210, 372);

  return canvas.toDataURL('image/png');
}

function createRoomDataUrl(wall, trim, floor) {
  const canvas = document.createElement('canvas');
  canvas.width = 900;
  canvas.height = 600;
  const room = canvas.getContext('2d');
  const previous = ctx;

  room.fillStyle = wall;
  room.fillRect(0, 0, 900, 390);
  room.fillStyle = trim;
  room.fillRect(0, 343, 900, 8);
  room.fillStyle = floor;
  room.fillRect(0, 351, 900, 249);

  room.fillStyle = '#202a33';
  roundRectWithContext(room, 270, 70, 360, 190, 8);
  room.fill();
  room.fillStyle = '#e8eef0';
  roundRectWithContext(room, 284, 84, 332, 162, 4);
  room.fill();

  room.fillStyle = 'rgb(255 255 255 / 0.32)';
  for (let x = 80; x < 850; x += 130) {
    room.beginPath();
    room.ellipse(x, 42, 46, 12, 0, 0, Math.PI * 2);
    room.fill();
  }

  room.fillStyle = 'rgb(35 28 22 / 0.34)';
  room.beginPath();
  room.ellipse(450, 452, 360, 74, 0, 0, Math.PI * 2);
  room.fill();

  void previous;
  return canvas.toDataURL('image/png');
}

function roundRectWithContext(targetCtx, x, y, width, height, radius) {
  targetCtx.beginPath();
  targetCtx.moveTo(x + radius, y);
  targetCtx.lineTo(x + width - radius, y);
  targetCtx.quadraticCurveTo(x + width, y, x + width, y + radius);
  targetCtx.lineTo(x + width, y + height - radius);
  targetCtx.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
  targetCtx.lineTo(x + radius, y + height);
  targetCtx.quadraticCurveTo(x, y + height, x, y + height - radius);
  targetCtx.lineTo(x, y + radius);
  targetCtx.quadraticCurveTo(x, y, x + radius, y);
  targetCtx.closePath();
}

function drawImageCover(image, x, y, width, height) {
  const scale = Math.max(width / image.width, height / image.height);
  const drawWidth = image.width * scale;
  const drawHeight = image.height * scale;
  const drawX = x + (width - drawWidth) / 2;
  const drawY = y + (height - drawHeight) / 2;
  ctx.drawImage(image, drawX, drawY, drawWidth, drawHeight);
}

function roundRect(x, y, width, height, radius) {
  roundRectWithContext(ctx, x, y, width, height, radius);
}

function loadImage(src) {
  if (state.imageCache.has(src)) {
    return state.imageCache.get(src);
  }

  const promise = new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = reject;
    image.src = src;
  });

  state.imageCache.set(src, promise);
  return promise;
}

function readImageFiles(files, type) {
  return Promise.all(
    files
      .filter((file) => file.type.startsWith('image/'))
      .map((file) => prepareUploadedImage(file, type))
  );
}

async function prepareUploadedImage(file, type) {
  return normalizeAssetRecord({
    name: file.name.replace(/\.[^.]+$/, ''),
    type,
    dataUrl: await resizeImageFile(file, UPLOAD_LIMITS[type] || UPLOAD_LIMITS.person)
  });
}

function resizeImageFile(file, options) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    const objectUrl = URL.createObjectURL(file);

    image.onload = () => {
      URL.revokeObjectURL(objectUrl);
      const scale = Math.min(1, options.maxDimension / Math.max(image.naturalWidth, image.naturalHeight));
      const width = Math.max(1, Math.round(image.naturalWidth * scale));
      const height = Math.max(1, Math.round(image.naturalHeight * scale));
      const canvas = document.createElement('canvas');
      const imageCtx = canvas.getContext('2d');

      canvas.width = width;
      canvas.height = height;
      imageCtx.fillStyle = '#ffffff';
      imageCtx.fillRect(0, 0, width, height);
      imageCtx.drawImage(image, 0, 0, width, height);
      resolve(canvas.toDataURL('image/jpeg', options.quality));
    };

    image.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error('照片格式无法读取，请换用 JPG、PNG 或 WebP 图片。'));
    };

    image.src = objectUrl;
  });
}

function downloadGeneratedImage() {
  if (!state.generatedImage) return;

  const filename = createExportName();
  const href = state.generatedImage.startsWith('data:')
    ? state.generatedImage
    : `/api/download-image?${new URLSearchParams({
        url: state.generatedImage,
        filename
      }).toString()}`;

  triggerDownload(href, filename);
  setStatusMessage('下载已开始');
  renderSelectionSummary();
}

function triggerDownload(href, filename) {
  const link = document.createElement('a');
  link.href = href;
  link.download = filename;
  link.rel = 'noopener';
  document.body.append(link);
  link.click();
  link.remove();
}

function resetGeneratedImage() {
  state.generatedImage = '';
  state.generationMessage = '等待生成';
}

function persistAll() {
  const assetResult = persistAssets();
  const selectionResult = persistSelection();
  const failed = [assetResult, selectionResult].find((result) => result && !result.ok);

  if (failed) {
    setStatusMessage(failed.message);
    return failed;
  }

  return { ok: true, message: '' };
}

function persistAssets() {
  const peopleResult = writeStorage(STORAGE_KEYS.people, state.people);
  const locationResult = writeStorage(STORAGE_KEYS.locations, state.locations);
  return peopleResult.ok ? locationResult : peopleResult;
}

function persistSelection() {
  return writeStorage(STORAGE_KEYS.selection, createPersistedSelection(state.selection));
}

function readStorage(key) {
  try {
    return JSON.parse(localStorage.getItem(key) || 'null');
  } catch {
    return null;
  }
}

function writeStorage(key, value) {
  return writeJsonStorage(localStorage, key, value);
}

function unique(values) {
  return [...new Set(values)];
}
