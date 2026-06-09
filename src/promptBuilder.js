import { MODE_LABELS, hasCompleteSelection } from './compositorCore.js';

const MISSING_LABELS = Object.freeze({
  participantIds: '参会人员',
  locationId: '参会地址',
  screenImage: '屏幕展示内容',
  layoutMode: '站位或座位',
  clothingMode: '衣服',
  expressionMode: '表情'
});

export function buildGenerationPackage({ people, locations, selection }) {
  const missing = getMissingInputs(selection);
  if (missing.length) {
    return {
      ready: false,
      missing,
      prompt: '',
      references: [],
      summary: {}
    };
  }

  const selectedPeople = selection.participantIds
    .map((id) => people.find((person) => person.id === id))
    .filter(Boolean);
  const selectedLocation = locations.find((location) => location.id === selection.locationId);

  if (!selectedPeople.length || !selectedLocation) {
    return {
      ready: false,
      missing: [
        ...(!selectedPeople.length ? [MISSING_LABELS.participantIds] : []),
        ...(!selectedLocation ? [MISSING_LABELS.locationId] : [])
      ],
      prompt: '',
      references: [],
      summary: {}
    };
  }

  const summary = {
    participantNames: selectedPeople.map((person) => person.name),
    locationName: selectedLocation.name,
    layout: MODE_LABELS.layout[selection.layoutMode],
    clothing: MODE_LABELS.clothing[selection.clothingMode],
    expression: MODE_LABELS.expression[selection.expressionMode]
  };

  const references = buildReferences({ selectedPeople, selectedLocation, screenImage: selection.screenImage });

  return {
    ready: true,
    missing: [],
    prompt: buildPrompt(summary, references),
    references,
    summary
  };
}

export function getMissingInputs(selection) {
  const missing = [];

  if (!Array.isArray(selection?.participantIds) || selection.participantIds.length === 0) {
    missing.push(MISSING_LABELS.participantIds);
  }
  if (!selection?.locationId) missing.push(MISSING_LABELS.locationId);
  if (!selection?.screenImage) missing.push(MISSING_LABELS.screenImage);
  if (!selection?.layoutMode) missing.push(MISSING_LABELS.layoutMode);
  if (!selection?.clothingMode) missing.push(MISSING_LABELS.clothingMode);
  if (!selection?.expressionMode) missing.push(MISSING_LABELS.expressionMode);

  return missing;
}

function buildReferences({ selectedPeople, selectedLocation, screenImage }) {
  return [
    ...selectedPeople.map((person, index) => ({
      id: person.id,
      name: person.name,
      kind: 'person',
      label: `参会人员参考图 ${index + 1}`,
      dataUrl: person.dataUrl
    })),
    {
      id: selectedLocation.id,
      name: selectedLocation.name,
      kind: 'location',
      label: '参会地址参考图',
      dataUrl: selectedLocation.dataUrl
    },
    {
      id: 'screen-content',
      name: '屏幕展示内容',
      kind: 'screen',
      label: '屏幕展示内容参考图',
      dataUrl: screenImage
    }
  ];
}

function buildPrompt(summary, references) {
  const names = summary.participantNames.join('、');

  return [
    '生成一张真实自然的公司内部会议纪要配图，画面是一张大型会议合照。',
    '参考图序列说明：input_urls 的顺序必须与下列参考图序列一致，生成时逐项对应使用。',
    ...references.map(formatReferenceInstruction),
    `参会人员必须参考人员照片中的身份特征，人员包括：${names}。`,
    `会议环境严格参考参会地址照片，地点风格为：${summary.locationName}。`,
    `屏幕展示内容必须参考屏幕图片，并自然显示在会议室屏幕上。`,
    `人员安排使用“${summary.layout}”构图，衣着为“${summary.clothing}”，表情为“${summary.expression}”。`,
    '构图要求：多人比例自然，光线统一，脸部清晰，无遮挡，像真实相机拍摄的会议现场照片。',
    '保持会议室、人物、屏幕内容之间的透视关系和真实空间感，不要像拼贴图。',
    '不要加入任何水印、角标、签名、说明文字、生成标签、额外字幕或边框。',
    '最终只输出自然逼真的合照图片。'
  ].join('\n');
}

function formatReferenceInstruction(reference, index) {
  const order = index + 1;
  if (reference.kind === 'person') {
    return `参考图 ${order}：参会人员“${reference.name}”，用于还原该参会者的身份特征、脸部轮廓、发型和整体气质。`;
  }
  if (reference.kind === 'location') {
    return `参考图 ${order}：参会地址“${reference.name}”，用于还原会议室空间、墙面、桌椅、光线和整体环境。`;
  }
  if (reference.kind === 'screen') {
    return `参考图 ${order}：屏幕展示内容，用于还原会议室屏幕上的画面，不要改写核心内容。`;
  }
  return `参考图 ${order}：${reference.name}，按素材名称对应使用。`;
}

export function assertGenerationReady(selection) {
  if (hasCompleteSelection(selection)) return;
  throw new Error(`缺少必填项：${getMissingInputs(selection).join('、')}`);
}
