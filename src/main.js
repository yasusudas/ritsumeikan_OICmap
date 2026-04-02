import './style.css';
import * as pdfjsLib from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.mjs?url';

if (window.__FILE_MODE__) {
  console.warn('This app must be opened through a local server, not file://');
} else {
  pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

  const FLOOR_FILES = [
    {
      id: '1F',
      label: '1F',
      svgUrl: new URL('../フロア/1F.svg', import.meta.url).href,
      searchUrl: new URL('../pdf/1F.pdf', import.meta.url).href
    },
    {
      id: '2F',
      label: '2F',
      svgUrl: new URL('../フロア/2F.svg', import.meta.url).href,
      searchUrl: new URL('../pdf/2F.pdf', import.meta.url).href
    },
    {
      id: '3F',
      label: '3F',
      svgUrl: new URL('../フロア/3F.svg', import.meta.url).href,
      searchUrl: new URL('../pdf/3F.pdf', import.meta.url).href
    },
    {
      id: '4F',
      label: '4F',
      svgUrl: new URL('../フロア/4F.svg', import.meta.url).href,
      searchUrl: new URL('../pdf/4F.pdf', import.meta.url).href
    },
    {
      id: '5F',
      label: '5F',
      svgUrl: new URL('../フロア/5F.svg', import.meta.url).href,
      searchUrl: new URL('../pdf/5F.pdf', import.meta.url).href
    }
  ];
  const PDF_SUPPORT_ASSET_BASE = import.meta.env.BASE_URL;
  const CMAP_URL = `${PDF_SUPPORT_ASSET_BASE}cmaps/`;
  const STANDARD_FONT_DATA_URL = `${PDF_SUPPORT_ASSET_BASE}standard_fonts/`;

  const MAP_PADDING = 32;
  const SEARCH_RESULT_LIMIT = 18;
  const SEARCH_FOCUS_ZOOM = 3.6;
  const MANUAL_STORAGE_KEY = 'campus-map-manual-entries-v2';
  const MANUAL_EXPORT_FILENAME = 'manual-search-index.json';
  const ROOM_CODE_PATTERN = /[A-Z]{1,3}\s*-?\s*\d{2,4}[A-Z]?/g;
  const SEARCHABLE_CHAR_PATTERN = /[\p{L}\p{N}]/u;
  const LETTER_PATTERN = /\p{L}/u;
  const roomCodeCollator = new Intl.Collator('ja', { numeric: true, sensitivity: 'base' });
  const svgCache = new Map();
  const appMode = document.body?.dataset.appMode === 'editor' ? 'editor' : 'viewer';
  const isEditorSite = appMode === 'editor';

  const viewer = document.querySelector('#viewer');
  const canvasLayer = document.querySelector('#canvas-layer');
  const statusElement = document.querySelector('#status');
  const tabButtons = Array.from(document.querySelectorAll('.floor-tab'));
  const zoomInButton = document.querySelector('#zoom-in');
  const zoomOutButton = document.querySelector('#zoom-out');
  const searchPanel = document.querySelector('#search-panel');
  const searchInput = document.querySelector('#search-input');
  const searchClearButton = document.querySelector('#search-clear');
  const searchFeedback = document.querySelector('#search-feedback');
  const searchResults = document.querySelector('#search-results');
  const editorToggleButton = document.querySelector('#editor-toggle');
  const editorPanel = document.querySelector('#editor-panel');
  const editorFloor = document.querySelector('#editor-floor');
  const editorCoords = document.querySelector('#editor-coords');
  const editorLabelInput = document.querySelector('#editor-label');
  const editorAliasesInput = document.querySelector('#editor-aliases');
  const editorWidthInput = document.querySelector('#editor-width');
  const editorHeightInput = document.querySelector('#editor-height');
  const editorSaveButton = document.querySelector('#editor-save');
  const editorClearPointButton = document.querySelector('#editor-clear-point');
  const editorCopyButton = document.querySelector('#editor-copy');
  const editorExportButton = document.querySelector('#editor-export');
  const editorFeedback = document.querySelector('#editor-feedback');
  const editorList = document.querySelector('#editor-list');
  const editorJson = document.querySelector('#editor-json');

  const state = {
    floorIndex: 0,
    zoom: 1,
    minZoom: 1,
    maxZoom: 10,
    x: 0,
    y: 0,
    baseWidth: 0,
    baseHeight: 0,
    intrinsicWidth: 0,
    intrinsicHeight: 0,
    isDragging: false,
    isPinching: false,
    dragStartX: 0,
    dragStartY: 0,
    startX: 0,
    startY: 0,
    pinchStartDistance: 0,
    pinchStartZoom: 1,
    pinchStartX: 0,
    pinchStartY: 0,
    pinchStartCenterX: 0,
    pinchStartCenterY: 0,
    floorLoadToken: 0,
    highlightLayer: null,
    editorLayer: null,
    searchReady: false,
    searchLoading: false,
    searchPromise: null,
    baseSearchEntries: [],
    searchEntries: [],
    searchSuggestions: [],
    activeSuggestionIndex: -1,
    activeSearchEntryId: null,
    manualEntries: [],
    activeEditorPinKey: null,
    editMode: false,
    pendingEditorPoint: null,
    dragMoved: false
  };

  function setStatus(message) {
    statusElement.textContent = message;
  }

  function setSearchFeedback(message) {
    searchFeedback.textContent = message;
  }

  function getViewportSize() {
    return {
      width: viewer.clientWidth,
      height: viewer.clientHeight
    };
  }

  function clamp(number, min, max) {
    return Math.min(Math.max(number, min), max);
  }

  function normalizeSearchValue(value) {
    return value.normalize('NFKC').toUpperCase().replace(/[^\p{L}\p{N}]+/gu, '');
  }

  function normalizeMatchSource(value) {
    return value.normalize('NFKC').toUpperCase();
  }

  function getFloorDefinition() {
    return FLOOR_FILES[state.floorIndex];
  }

  function getFloorOrder(floorId) {
    return FLOOR_FILES.findIndex((floor) => floor.id === floorId);
  }

  function setEditorFeedback(message) {
    if (editorFeedback) {
      editorFeedback.textContent = message;
    }
  }

  function getCurrentFloorLabel() {
    return getFloorDefinition().label;
  }

  function getDocumentOptions(url) {
    return {
      url,
      cMapUrl: CMAP_URL,
      cMapPacked: true,
      standardFontDataUrl: STANDARD_FONT_DATA_URL
    };
  }

  function createManualEntryId(floorId) {
    return `manual-${floorId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }

  function sanitizeAliases(value) {
    if (Array.isArray(value)) {
      return value.map((item) => String(item).trim()).filter(Boolean);
    }

    return String(value)
      .split(/[,\n]/)
      .map((item) => item.trim())
      .filter(Boolean);
  }

  function normalizeRect(rect) {
    const widthRatio = clamp(Number(rect?.widthRatio) || 0, 0.001, 1);
    const heightRatio = clamp(Number(rect?.heightRatio) || 0, 0.001, 1);
    const xRatio = clamp(Number(rect?.xRatio) || 0, 0, 1 - widthRatio);
    const yRatio = clamp(Number(rect?.yRatio) || 0, 0, 1 - heightRatio);

    return {
      xRatio,
      yRatio,
      widthRatio,
      heightRatio
    };
  }

  function createEntrySearchTerms(label, aliases = []) {
    return [...new Set([label, ...aliases].map((value) => normalizeSearchValue(value)).filter(Boolean))];
  }

  function hydrateManualEntry(entry, fallbackFloorId = getCurrentFloorLabel()) {
    const floorId =
      FLOOR_FILES.find((floor) => floor.id === entry?.floorId)?.id ??
      FLOOR_FILES.find((floor) => floor.label === fallbackFloorId)?.id ??
      getFloorDefinition().id;
    const label = String(entry?.label ?? '').trim();
    const rects = Array.isArray(entry?.rects) ? entry.rects.map((rect) => normalizeRect(rect)) : [];

    if (!label || rects.length === 0) {
      return null;
    }

    const aliases = sanitizeAliases(entry?.aliases ?? []);
    const floorLabel = FLOOR_FILES.find((floor) => floor.id === floorId)?.label ?? floorId;

    return {
      id: String(entry?.id ?? createManualEntryId(floorId)),
      label,
      normalized: normalizeSearchValue(label),
      searchTerms: createEntrySearchTerms(label, aliases),
      aliases,
      floorId,
      floorLabel,
      floorOrder: getFloorOrder(floorId),
      rects,
      source: 'manual'
    };
  }

  function loadManualEntries() {
    try {
      const raw = window.localStorage.getItem(MANUAL_STORAGE_KEY);

      if (!raw) {
        return [];
      }

      const parsed = JSON.parse(raw);
      const sourceEntries = Array.isArray(parsed) ? parsed : parsed?.entries;

      if (!Array.isArray(sourceEntries)) {
        return [];
      }

      return sourceEntries
        .map((entry) => hydrateManualEntry(entry))
        .filter((entry) => entry !== null);
    } catch (error) {
      console.warn('Failed to load manual search entries.', error);
      return [];
    }
  }

  function serializeManualEntries() {
    const sortedEntries = [...state.manualEntries].sort((left, right) => {
      const floorOrder = left.floorOrder - right.floorOrder;

      if (floorOrder !== 0) {
        return floorOrder;
      }

      return roomCodeCollator.compare(left.label, right.label);
    });

    return {
      version: 1,
      entries: sortedEntries.map((entry) => ({
        id: entry.id,
        floorId: entry.floorId,
        label: entry.label,
        aliases: entry.aliases,
        rects: entry.rects.map((rect) => ({
          xRatio: Number(rect.xRatio.toFixed(6)),
          yRatio: Number(rect.yRatio.toFixed(6)),
          widthRatio: Number(rect.widthRatio.toFixed(6)),
          heightRatio: Number(rect.heightRatio.toFixed(6))
        }))
      }))
    };
  }

  function persistManualEntries() {
    try {
      window.localStorage.setItem(MANUAL_STORAGE_KEY, JSON.stringify(serializeManualEntries()));
    } catch (error) {
      console.warn('Failed to persist manual search entries.', error);
    }
  }

  function getEntrySearchTerms(entry) {
    return entry.searchTerms?.length ? entry.searchTerms : [entry.normalized];
  }

  function refreshSearchEntries() {
    const combinedEntries = [...state.manualEntries];

    combinedEntries.sort((left, right) => {
      const labelOrder = roomCodeCollator.compare(left.label, right.label);

      if (labelOrder !== 0) {
        return labelOrder;
      }

      return left.floorOrder - right.floorOrder;
    });

    state.searchEntries = combinedEntries;
  }

  function parseSvgLength(value) {
    if (!value) {
      return 0;
    }

    const parsed = Number.parseFloat(String(value).replace(/[^\d.+-]/g, ''));
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function extractSvgMetrics(svgElement) {
    const viewBox = svgElement.getAttribute('viewBox');

    if (viewBox) {
      const values = viewBox
        .trim()
        .split(/[\s,]+/)
        .map((value) => Number.parseFloat(value));

      if (values.length === 4 && values[2] > 0 && values[3] > 0) {
        return { width: values[2], height: values[3] };
      }
    }

    const width = parseSvgLength(svgElement.getAttribute('width'));
    const height = parseSvgLength(svgElement.getAttribute('height'));

    if (width > 0 && height > 0) {
      return { width, height };
    }

    throw new Error('SVG size could not be determined.');
  }

  async function fetchSvgAsset(floor) {
    if (svgCache.has(floor.id)) {
      return svgCache.get(floor.id);
    }

    const response = await fetch(floor.svgUrl);

    if (!response.ok) {
      throw new Error(`Failed to load SVG for ${floor.id}`);
    }

    const text = await response.text();
    const svgDocument = new DOMParser().parseFromString(text, 'image/svg+xml');
    const svgElement = svgDocument.documentElement;

    if (!svgElement || svgElement.nodeName.toLowerCase() !== 'svg') {
      throw new Error(`Invalid SVG for ${floor.id}`);
    }

    const metrics = extractSvgMetrics(svgElement);
    const asset = { text, width: metrics.width, height: metrics.height };
    svgCache.set(floor.id, asset);
    return asset;
  }

  function stripEmbeddedSvgText(svgRoot) {
    svgRoot.querySelectorAll('[id^="glyph-"]').forEach((node) => {
      node.remove();
    });

    svgRoot.querySelectorAll('use').forEach((node) => {
      const href =
        node.getAttribute('href') ??
        node.getAttributeNS('http://www.w3.org/1999/xlink', 'href') ??
        node.getAttribute('xlink:href');

      if (href?.startsWith('#glyph-')) {
        node.remove();
      }
    });
  }

  function createSvgNode(svgText) {
    const svgDocument = new DOMParser().parseFromString(svgText, 'image/svg+xml');
    const importedSvg = document.importNode(svgDocument.documentElement, true);
    stripEmbeddedSvgText(importedSvg);
    importedSvg.classList.add('floor-svg');
    importedSvg.removeAttribute('width');
    importedSvg.removeAttribute('height');
    importedSvg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
    importedSvg.setAttribute('aria-hidden', 'true');
    importedSvg.setAttribute('focusable', 'false');
    return importedSvg;
  }

  function getFittedBaseSize(intrinsicWidth, intrinsicHeight) {
    const viewport = getViewportSize();
    const availableWidth = Math.max(viewport.width - MAP_PADDING, 80);
    const availableHeight = Math.max(viewport.height - MAP_PADDING, 80);
    const fitScale = Math.min(availableWidth / intrinsicWidth, availableHeight / intrinsicHeight);

    return {
      width: intrinsicWidth * fitScale,
      height: intrinsicHeight * fitScale
    };
  }

  function clampPosition() {
    const { width: viewportWidth, height: viewportHeight } = getViewportSize();
    const scaledWidth = state.baseWidth * state.zoom;
    const scaledHeight = state.baseHeight * state.zoom;

    if (scaledWidth <= viewportWidth) {
      state.x = (viewportWidth - scaledWidth) / 2;
    } else {
      state.x = clamp(state.x, viewportWidth - scaledWidth, 0);
    }

    if (scaledHeight <= viewportHeight) {
      state.y = (viewportHeight - scaledHeight) / 2;
    } else {
      state.y = clamp(state.y, viewportHeight - scaledHeight, 0);
    }
  }

  function applyTransform() {
    canvasLayer.style.width = `${state.baseWidth * state.zoom}px`;
    canvasLayer.style.height = `${state.baseHeight * state.zoom}px`;
    canvasLayer.style.transform = `translate(${state.x}px, ${state.y}px)`;
  }

  function updateView() {
    clampPosition();
    applyTransform();

    const percent = Math.round(state.zoom * 100);
    setStatus(`${getFloorDefinition().label} | ${percent}%`);
  }

  function updateTabSelection() {
    const activeFloorId = getFloorDefinition().id;
    tabButtons.forEach((button) => {
      const isActive = button.dataset.floor === activeFloorId;
      button.classList.toggle('is-active', isActive);
      button.setAttribute('aria-pressed', String(isActive));
    });
  }

  function getActiveSearchEntry() {
    return state.searchEntries.find((entry) => entry.id === state.activeSearchEntryId) ?? null;
  }

  function resetView() {
    state.zoom = 1;
    const { width, height } = getViewportSize();
    state.x = (width - state.baseWidth) / 2;
    state.y = (height - state.baseHeight) / 2;
    updateView();
  }

  function captureViewportCenterRatios() {
    const { width, height } = getViewportSize();

    if (!state.baseWidth || !state.baseHeight || !state.zoom) {
      return { xRatio: 0.5, yRatio: 0.5 };
    }

    const mapX = (width / 2 - state.x) / state.zoom;
    const mapY = (height / 2 - state.y) / state.zoom;

    return {
      xRatio: clamp(mapX / state.baseWidth, 0, 1),
      yRatio: clamp(mapY / state.baseHeight, 0, 1)
    };
  }

  function restoreViewportCenterRatios(centerRatios) {
    const { width, height } = getViewportSize();
    const targetX = state.baseWidth * centerRatios.xRatio;
    const targetY = state.baseHeight * centerRatios.yRatio;
    state.x = width / 2 - targetX * state.zoom;
    state.y = height / 2 - targetY * state.zoom;
    updateView();
  }

  function renderSearchHighlights() {
    if (!state.highlightLayer) {
      return;
    }

    state.highlightLayer.replaceChildren();

    const activeEntry = getActiveSearchEntry();

    if (!activeEntry || activeEntry.floorId !== getFloorDefinition().id) {
      return;
    }

    const fragment = document.createDocumentFragment();
    activeEntry.rects.forEach((rect, index) => {
      const highlight = document.createElement('div');
      highlight.className = 'search-highlight';
      highlight.style.left = `${rect.xRatio * 100}%`;
      highlight.style.top = `${rect.yRatio * 100}%`;
      highlight.style.width = `${Math.max(rect.widthRatio * 100, 1.1)}%`;
      highlight.style.height = `${Math.max(rect.heightRatio * 100, 0.9)}%`;
      highlight.style.minWidth = '16px';
      highlight.style.minHeight = '12px';
      highlight.style.animationDelay = `${index * 120}ms`;
      fragment.append(highlight);
    });

    state.highlightLayer.append(fragment);
  }

  function createEditorPinKey(entryId, rectIndex = 0) {
    return `${entryId}:${rectIndex}`;
  }

  function getRectCenter(rect) {
    return {
      xRatio: rect.xRatio + rect.widthRatio / 2,
      yRatio: rect.yRatio + rect.heightRatio / 2
    };
  }

  function getManualEntryById(entryId) {
    return state.manualEntries.find((entry) => entry.id === entryId) ?? null;
  }

  function setActiveEditorPin(entryId = null, rectIndex = 0) {
    state.activeEditorPinKey = entryId ? createEditorPinKey(entryId, rectIndex) : null;

    if (entryId) {
      const entry = getManualEntryById(entryId);

      if (entry) {
        const aliasText = entry.aliases.length ? ` / 別名: ${entry.aliases.join(', ')}` : '';
        setEditorFeedback(`${entry.label}${aliasText}`);
      }
    }

    renderEditorOverlay();
  }

  function getEditorSizeRatios() {
    const widthRatio = clamp((Number(editorWidthInput?.value) || 5) / 100, 0.005, 0.4);
    const heightRatio = clamp((Number(editorHeightInput?.value) || 3) / 100, 0.005, 0.3);

    return { widthRatio, heightRatio };
  }

  function getPendingEditorRect() {
    if (!state.pendingEditorPoint) {
      return null;
    }

    const { widthRatio, heightRatio } = getEditorSizeRatios();

    return {
      xRatio: clamp(state.pendingEditorPoint.xRatio - widthRatio / 2, 0, 1 - widthRatio),
      yRatio: clamp(state.pendingEditorPoint.yRatio - heightRatio / 2, 0, 1 - heightRatio),
      widthRatio,
      heightRatio
    };
  }

  function updateEditorCoords() {
    if (!isEditorSite || !editorCoords) {
      return;
    }

    if (!state.pendingEditorPoint) {
      editorCoords.textContent = '位置未指定';
      return;
    }

    editorCoords.textContent = `x ${state.pendingEditorPoint.xRatio.toFixed(4)} / y ${state.pendingEditorPoint.yRatio.toFixed(4)}`;
  }

  function updateEditorJsonOutput() {
    if (!isEditorSite || !editorJson) {
      return;
    }

    editorJson.value = JSON.stringify(serializeManualEntries(), null, 2);
  }

  function renderEditorList() {
    if (!isEditorSite || !editorList) {
      return;
    }

    const currentFloorId = getFloorDefinition().id;
    const currentFloorEntries = state.manualEntries.filter((entry) => entry.floorId === currentFloorId);

    if (currentFloorEntries.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'editor-empty';
      empty.textContent = `${getCurrentFloorLabel()} の手入力データはまだありません`;
      editorList.replaceChildren(empty);
      return;
    }

    const fragment = document.createDocumentFragment();

    currentFloorEntries.forEach((entry) => {
      const row = document.createElement('div');
      row.className = 'editor-entry';

      const body = document.createElement('div');
      body.className = 'editor-entry-body';

      const label = document.createElement('div');
      label.className = 'editor-entry-label';
      label.textContent = entry.label;

      const meta = document.createElement('div');
      meta.className = 'editor-entry-meta';
      meta.textContent = `${entry.rects.length} rect${entry.rects.length > 1 ? 's' : ''}${
        entry.aliases.length ? ` / 別名: ${entry.aliases.join(', ')}` : ''
      }`;

      body.append(label, meta);

      const actions = document.createElement('div');
      actions.className = 'editor-entry-actions';

      const focusButton = document.createElement('button');
      focusButton.type = 'button';
      focusButton.className = 'editor-entry-button';
      focusButton.dataset.action = 'focus';
      focusButton.dataset.entryId = entry.id;
      focusButton.textContent = '移動';

      const deleteButton = document.createElement('button');
      deleteButton.type = 'button';
      deleteButton.className = 'editor-entry-button';
      deleteButton.dataset.action = 'delete';
      deleteButton.dataset.entryId = entry.id;
      deleteButton.textContent = '削除';

      actions.append(focusButton, deleteButton);
      row.append(body, actions);
      fragment.append(row);
    });

    editorList.replaceChildren(fragment);
  }

  function renderEditorOverlay() {
    if (!isEditorSite || !state.editorLayer) {
      return;
    }

    state.editorLayer.replaceChildren();

    if (!state.editMode) {
      return;
    }

    const currentFloorId = getFloorDefinition().id;
    const fragment = document.createDocumentFragment();
    const floorEntries = state.manualEntries.filter((entry) => entry.floorId === currentFloorId);

    floorEntries.forEach((entry) => {
      entry.rects.forEach((rect, rectIndex) => {
        const pinKey = createEditorPinKey(entry.id, rectIndex);
        const isActive = state.activeEditorPinKey === pinKey;
        const center = getRectCenter(rect);

        if (isActive) {
          const focusRing = document.createElement('div');
          focusRing.className = 'editor-pin-focus-ring';
          focusRing.style.left = `${rect.xRatio * 100}%`;
          focusRing.style.top = `${rect.yRatio * 100}%`;
          focusRing.style.width = `${rect.widthRatio * 100}%`;
          focusRing.style.height = `${rect.heightRatio * 100}%`;
          fragment.append(focusRing);
        }

        const pin = document.createElement('button');
        pin.type = 'button';
        pin.className = 'editor-pin-button';
        pin.dataset.entryId = entry.id;
        pin.dataset.rectIndex = String(rectIndex);
        pin.setAttribute('aria-label', `${entry.label} を確認`);
        pin.style.left = `${center.xRatio * 100}%`;
        pin.style.top = `${center.yRatio * 100}%`;

        if (isActive) {
          pin.classList.add('is-active');
        }

        fragment.append(pin);

        if (isActive) {
          const popover = document.createElement('div');
          popover.className = 'editor-pin-popover';
          popover.style.left = `${center.xRatio * 100}%`;
          popover.style.top = `${center.yRatio * 100}%`;

          const label = document.createElement('div');
          label.className = 'editor-pin-popover-label';
          label.textContent = entry.label;

          const meta = document.createElement('div');
          meta.className = 'editor-pin-popover-meta';
          meta.textContent = entry.aliases.length
            ? `${entry.floorLabel} / 別名: ${entry.aliases.join(', ')}`
            : `${entry.floorLabel}`;

          popover.append(label, meta);
          fragment.append(popover);
        }
      });
    });

    const pendingRect = getPendingEditorRect();

    if (pendingRect) {
      const pending = document.createElement('div');
      pending.className = 'editor-pending-rect';
      pending.style.left = `${pendingRect.xRatio * 100}%`;
      pending.style.top = `${pendingRect.yRatio * 100}%`;
      pending.style.width = `${pendingRect.widthRatio * 100}%`;
      pending.style.height = `${pendingRect.heightRatio * 100}%`;

      const dot = document.createElement('div');
      dot.className = 'editor-pending-dot';
      dot.style.left = `${state.pendingEditorPoint.xRatio * 100}%`;
      dot.style.top = `${state.pendingEditorPoint.yRatio * 100}%`;

      fragment.append(pending, dot);
    }

    state.editorLayer.append(fragment);
  }

  function refreshEditorUi() {
    if (!isEditorSite) {
      return;
    }

    if (editorFloor) {
      editorFloor.textContent = getCurrentFloorLabel();
    }
    updateEditorCoords();
    updateEditorJsonOutput();
    renderEditorList();
    renderEditorOverlay();
  }

  function focusSearchEntry(entry, targetZoom = SEARCH_FOCUS_ZOOM) {
    if (!entry || entry.floorId !== getFloorDefinition().id || entry.rects.length === 0) {
      return;
    }

    const focusRect = entry.rects[0];
    const nextZoom = clamp(Math.max(state.zoom, targetZoom), state.minZoom, state.maxZoom);
    const targetX = state.baseWidth * (focusRect.xRatio + focusRect.widthRatio / 2);
    const targetY = state.baseHeight * (focusRect.yRatio + focusRect.heightRatio / 2);
    const { width: viewportWidth, height: viewportHeight } = getViewportSize();

    state.zoom = nextZoom;
    state.x = viewportWidth / 2 - targetX * state.zoom;
    state.y = viewportHeight / 2 - targetY * state.zoom;
    updateView();
  }

  function renderSearchSuggestions() {
    const query = searchInput.value.trim();
    const previousActiveEntryId = state.searchSuggestions[state.activeSuggestionIndex]?.id ?? null;
    searchClearButton.hidden = query.length === 0;

    if (!query) {
      searchResults.hidden = true;
      searchResults.replaceChildren();
      state.searchSuggestions = [];
      state.activeSuggestionIndex = -1;

      if (getActiveSearchEntry()) {
        setSearchFeedback(`${getActiveSearchEntry().label} を ${getActiveSearchEntry().floorLabel} で表示中`);
      } else if (state.searchEntries.length === 0) {
        setSearchFeedback('手入力データはまだありません');
      } else {
        setSearchFeedback('1F〜5F を横断検索できます');
      }
      return;
    }

    const normalizedQuery = normalizeSearchValue(query);

    if (!normalizedQuery) {
      const hint = document.createElement('div');
      hint.className = 'search-result-empty';
      hint.textContent = 'アルファベットと数字で検索できます';
      searchResults.replaceChildren(hint);
      searchResults.hidden = false;
      state.searchSuggestions = [];
      state.activeSuggestionIndex = -1;
      setSearchFeedback('検索語を入力してください');
      return;
    }

    const exactMatches = [];
    const prefixMatches = [];
    const partialMatches = [];

    state.searchEntries.forEach((entry) => {
      const searchTerms = getEntrySearchTerms(entry);

      if (searchTerms.some((term) => term === normalizedQuery)) {
        exactMatches.push(entry);
        return;
      }

      if (searchTerms.some((term) => term.startsWith(normalizedQuery))) {
        prefixMatches.push(entry);
        return;
      }

      if (searchTerms.some((term) => term.includes(normalizedQuery))) {
        partialMatches.push(entry);
      }
    });

    state.searchSuggestions = [...exactMatches, ...prefixMatches, ...partialMatches].slice(
      0,
      SEARCH_RESULT_LIMIT
    );
    const preservedIndex = state.searchSuggestions.findIndex((entry) => entry.id === previousActiveEntryId);
    state.activeSuggestionIndex = state.searchSuggestions.length === 0 ? -1 : Math.max(preservedIndex, 0);

    if (state.searchSuggestions.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'search-result-empty';
      empty.textContent =
        state.searchEntries.length === 0 ? '手入力データがまだ登録されていません' : '一致する教室候補がありません';
      searchResults.replaceChildren(empty);
      searchResults.hidden = false;
      setSearchFeedback(state.searchEntries.length === 0 ? '手入力データなし' : '一致候補なし');
      return;
    }

    const fragment = document.createDocumentFragment();
    state.searchSuggestions.forEach((entry, index) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'search-result';
      if (index === state.activeSuggestionIndex) {
        button.classList.add('is-active');
      }
      button.setAttribute('role', 'option');
      button.setAttribute('aria-selected', String(index === state.activeSuggestionIndex));
      button.dataset.entryId = entry.id;

      const label = document.createElement('span');
      label.className = 'search-result-label';
      label.textContent = entry.label;

      const floor = document.createElement('span');
      floor.className = 'search-result-floor';
      floor.textContent = entry.floorLabel;

      button.append(label, floor);
      fragment.append(button);
    });

    searchResults.replaceChildren(fragment);
    searchResults.hidden = false;
    setSearchFeedback(`${state.searchSuggestions.length} 件の候補`);
  }

  function clearActiveSearchSelection({ clearInput = false } = {}) {
    state.activeSearchEntryId = null;
    renderSearchHighlights();

    if (clearInput) {
      searchInput.value = '';
    }

    renderSearchSuggestions();
  }

  async function selectSearchEntry(entry) {
    if (!entry) {
      return;
    }

    state.activeSearchEntryId = entry.id;
    searchInput.value = entry.label;
    searchResults.hidden = true;

    if (entry.floorId !== getFloorDefinition().id) {
      await setActiveFloor(entry.floorId, { resetZoom: true });
    } else {
      renderSearchHighlights();
    }

    renderSearchHighlights();
    focusSearchEntry(entry);
    setSearchFeedback(`${entry.label} を ${entry.floorLabel} で表示中`);
  }

  function createTextMatchRect(item, viewport, matchIndex, matchLength, sourceLength) {
    const transformed = pdfjsLib.Util.transform(viewport.transform, item.transform);
    const fontHeight = Math.max(
      Math.abs(Math.hypot(transformed[2], transformed[3])),
      Math.abs(item.height || 0),
      8
    );
    const totalWidth = Math.max(
      Math.abs((item.width || 0) * viewport.scale),
      fontHeight * Math.max(sourceLength, 1) * 0.52
    );
    const charWidth = totalWidth / Math.max(sourceLength, 1);
    const x = clamp(transformed[4] + charWidth * matchIndex, 0, viewport.width);
    const y = clamp(transformed[5] - fontHeight, 0, viewport.height);
    const width = clamp(Math.max(charWidth * matchLength, fontHeight * 0.9), 8, viewport.width - x);
    const height = clamp(fontHeight * 1.14, 8, viewport.height - y);

    return {
      xRatio: x / viewport.width,
      yRatio: y / viewport.height,
      widthRatio: width / viewport.width,
      heightRatio: height / viewport.height
    };
  }

  function createItemGeometry(item, viewport) {
    const transformed = pdfjsLib.Util.transform(viewport.transform, item.transform);
    const fontHeight = Math.max(
      Math.abs(Math.hypot(transformed[2], transformed[3])),
      Math.abs(item.height || 0),
      8
    );
    const source = typeof item.str === 'string' ? item.str : '';
    const sourceLength = Math.max(source.length, 1);
    const totalWidth = Math.max(
      Math.abs((item.width || 0) * viewport.scale),
      fontHeight * sourceLength * 0.52
    );
    const x = clamp(transformed[4], 0, viewport.width);
    const y = clamp(transformed[5] - fontHeight, 0, viewport.height);
    const width = clamp(totalWidth, 8, viewport.width - x);
    const height = clamp(fontHeight * 1.14, 8, viewport.height - y);

    return {
      x,
      y,
      width,
      height,
      centerX: x + width / 2,
      centerY: y + height / 2
    };
  }

  function geometryToRatioRect(geometry, viewport) {
    return {
      xRatio: geometry.x / viewport.width,
      yRatio: geometry.y / viewport.height,
      widthRatio: geometry.width / viewport.width,
      heightRatio: geometry.height / viewport.height
    };
  }

  function mergeRatioRects(rects) {
    const left = Math.min(...rects.map((rect) => rect.xRatio));
    const top = Math.min(...rects.map((rect) => rect.yRatio));
    const right = Math.max(...rects.map((rect) => rect.xRatio + rect.widthRatio));
    const bottom = Math.max(...rects.map((rect) => rect.yRatio + rect.heightRatio));

    return {
      xRatio: left,
      yRatio: top,
      widthRatio: right - left,
      heightRatio: bottom - top
    };
  }

  function hasRoomCodeShape(normalized) {
    return /^[A-Z]{1,3}\d{2,4}[A-Z]?$/u.test(normalized);
  }

  function isSearchableLabel(rawLabel, normalizedLabel) {
    const trimmedRaw = rawLabel.trim();

    if (!trimmedRaw || normalizedLabel.length < 2) {
      return false;
    }

    if (!SEARCHABLE_CHAR_PATTERN.test(normalizedLabel)) {
      return false;
    }

    if (/^\p{N}+$/u.test(normalizedLabel)) {
      return false;
    }

    if (hasRoomCodeShape(normalizedLabel)) {
      return true;
    }

    return LETTER_PATTERN.test(normalizedLabel);
  }

  function joinSearchLabels(parts) {
    return parts.reduce((joined, part, index) => {
      if (index === 0) {
        return part;
      }

      const previous = joined.at(-1) ?? '';
      const next = part[0] ?? '';
      const needsSpace =
        /[A-Z0-9]$/u.test(previous) &&
        /^[A-Z0-9]/u.test(next) &&
        !joined.endsWith(' ') &&
        !part.startsWith(' ');

      return `${joined}${needsSpace ? ' ' : ''}${part}`;
    }, '');
  }

  function canMergeSearchParts(previousPart, nextPart) {
    const horizontalGap = nextPart.geometry.x - (previousPart.geometry.x + previousPart.geometry.width);
    const verticalGap = nextPart.geometry.y - (previousPart.geometry.y + previousPart.geometry.height);
    const sameLine =
      Math.abs(previousPart.geometry.centerY - nextPart.geometry.centerY) <=
      Math.max(previousPart.geometry.height, nextPart.geometry.height) * 0.8;
    const sameColumn =
      Math.abs(previousPart.geometry.centerX - nextPart.geometry.centerX) <=
      Math.max(previousPart.geometry.width, nextPart.geometry.width, 28);

    if (sameLine && horizontalGap >= -12 && horizontalGap <= 84) {
      return true;
    }

    if (sameColumn && Math.abs(verticalGap) <= Math.max(previousPart.geometry.height, nextPart.geometry.height) * 1.5) {
      return true;
    }

    const pointDistance = Math.hypot(
      previousPart.geometry.centerX - nextPart.geometry.centerX,
      previousPart.geometry.centerY - nextPart.geometry.centerY
    );

    return pointDistance <= Math.max(previousPart.geometry.height, nextPart.geometry.height) * 3.2;
  }

  function collectSearchCandidates(textContent, viewport) {
    const candidates = [];
    const searchableParts = [];

    textContent.items.forEach((item) => {
      if (!('str' in item)) {
        return;
      }

      const rawLabel = item.str.trim();
      const normalizedLabel = normalizeSearchValue(rawLabel);

      if (!isSearchableLabel(rawLabel, normalizedLabel)) {
        return;
      }

      const geometry = createItemGeometry(item, viewport);
      const rect = geometryToRatioRect(geometry, viewport);
      const part = {
        rawLabel,
        normalizedLabel,
        rect,
        geometry
      };

      searchableParts.push(part);
      if (!hasRoomCodeShape(normalizedLabel)) {
        candidates.push({
          label: rawLabel,
          normalized: normalizedLabel,
          rect
        });
      }
    });

    for (let startIndex = 0; startIndex < searchableParts.length; startIndex += 1) {
      const parts = [searchableParts[startIndex]];

      for (
        let nextIndex = startIndex + 1;
        nextIndex < Math.min(searchableParts.length, startIndex + 4);
        nextIndex += 1
      ) {
        const nextPart = searchableParts[nextIndex];

        if (!canMergeSearchParts(parts.at(-1), nextPart)) {
          break;
        }

        parts.push(nextPart);

        const label = joinSearchLabels(parts.map((part) => part.rawLabel));
        const normalized = normalizeSearchValue(label);

        if (!isSearchableLabel(label, normalized)) {
          continue;
        }

        candidates.push({
          label,
          normalized,
          rect: mergeRatioRects(parts.map((part) => part.rect))
        });
      }
    }

    return candidates;
  }

  async function buildSearchIndex() {
    state.baseSearchEntries = [];
    state.searchReady = true;
    state.searchLoading = false;
    state.searchPromise = Promise.resolve(state.searchEntries);
    refreshSearchEntries();
    renderSearchSuggestions();
    return state.searchPromise;
  }

  function zoomAt(nextZoom, focalX, focalY) {
    const previousZoom = state.zoom;
    const clampedZoom = clamp(nextZoom, state.minZoom, state.maxZoom);

    if (clampedZoom === previousZoom) {
      return;
    }

    const ratio = clampedZoom / previousZoom;
    state.x = focalX - ratio * (focalX - state.x);
    state.y = focalY - ratio * (focalY - state.y);
    state.zoom = clampedZoom;
    updateView();
  }

  async function renderFloor({ resetZoom = false, preserveView = false } = {}) {
    const floor = getFloorDefinition();
    const floorLoadToken = ++state.floorLoadToken;
    const centerRatios = preserveView ? captureViewportCenterRatios() : null;

    setStatus(`${floor.label} を読み込み中...`);

    try {
      const asset = await fetchSvgAsset(floor);

      if (floorLoadToken !== state.floorLoadToken) {
        return;
      }

      const mapAsset = document.createElement('article');
      mapAsset.className = 'map-asset';

      const svgNode = createSvgNode(asset.text);
      const highlightLayer = document.createElement('div');
      highlightLayer.className = 'highlight-layer';
      let editorLayer = null;
      if (isEditorSite) {
        editorLayer = document.createElement('div');
        editorLayer.className = 'editor-layer';
      }

      mapAsset.append(svgNode, highlightLayer);
      if (editorLayer) {
        mapAsset.append(editorLayer);
      }
      canvasLayer.replaceChildren(mapAsset);

      state.highlightLayer = highlightLayer;
      state.editorLayer = editorLayer;
      state.intrinsicWidth = asset.width;
      state.intrinsicHeight = asset.height;

      const baseSize = getFittedBaseSize(asset.width, asset.height);
      const hadDimensions = state.baseWidth > 0 && state.baseHeight > 0;
      state.baseWidth = baseSize.width;
      state.baseHeight = baseSize.height;

      if (resetZoom || !hadDimensions) {
        resetView();
      } else if (centerRatios) {
        restoreViewportCenterRatios(centerRatios);
      } else {
        updateView();
      }

      renderSearchHighlights();
      if (isEditorSite) {
        renderEditorOverlay();
        renderEditorList();
      }
    } catch (error) {
      console.error(error);
      canvasLayer.replaceChildren();
      state.highlightLayer = null;
      state.editorLayer = null;
      setStatus('地図の読み込みに失敗しました');
    }
  }

  async function setActiveFloor(floorId, { resetZoom = true } = {}) {
    const nextIndex = FLOOR_FILES.findIndex((floor) => floor.id === floorId);

    if (nextIndex < 0) {
      return;
    }

    state.floorIndex = nextIndex;
    updateTabSelection();
    await renderFloor({ resetZoom, preserveView: !resetZoom });
    if (isEditorSite) {
      refreshEditorUi();
    }
  }

  function getTouchDistance(touches) {
    const dx = touches[0].clientX - touches[1].clientX;
    const dy = touches[0].clientY - touches[1].clientY;
    return Math.hypot(dx, dy);
  }

  function getTouchCenter(touches) {
    const rect = viewer.getBoundingClientRect();
    return {
      x: (touches[0].clientX + touches[1].clientX) / 2 - rect.left,
      y: (touches[0].clientY + touches[1].clientY) / 2 - rect.top
    };
  }

  function getMapPointFromClient(clientX, clientY) {
    if (!state.baseWidth || !state.baseHeight) {
      return null;
    }

    const rect = viewer.getBoundingClientRect();
    const mapX = (clientX - rect.left - state.x) / state.zoom;
    const mapY = (clientY - rect.top - state.y) / state.zoom;
    const xRatio = mapX / state.baseWidth;
    const yRatio = mapY / state.baseHeight;

    if (xRatio < 0 || xRatio > 1 || yRatio < 0 || yRatio > 1) {
      return null;
    }

    return {
      xRatio: clamp(xRatio, 0, 1),
      yRatio: clamp(yRatio, 0, 1)
    };
  }

  function setEditMode(nextValue) {
    state.editMode = isEditorSite && Boolean(nextValue);
    if (editorPanel) {
      editorPanel.hidden = !state.editMode;
    }
    if (editorToggleButton) {
      editorToggleButton.classList.toggle('is-active', state.editMode);
      editorToggleButton.setAttribute('aria-pressed', String(state.editMode));
    }
    viewer.classList.toggle('is-editing', state.editMode);

    if (state.editMode) {
      setEditorFeedback('クリックした位置を中心にプレビューを作成します');
    } else {
      setEditorFeedback('編集モードをオンにして、地図上の文字位置をクリックしてください');
      state.pendingEditorPoint = null;
      state.activeEditorPinKey = null;
    }

    refreshEditorUi();
  }

  function removeManualEntry(entryId) {
    if (!isEditorSite) {
      return;
    }

    state.manualEntries = state.manualEntries.filter((entry) => entry.id !== entryId);
    if (state.activeEditorPinKey?.startsWith(`${entryId}:`)) {
      state.activeEditorPinKey = null;
    }
    if (state.activeSearchEntryId === entryId) {
      state.activeSearchEntryId = null;
      renderSearchHighlights();
    }
    persistManualEntries();
    refreshSearchEntries();
    refreshEditorUi();
    renderSearchSuggestions();
  }

  async function focusManualEntry(entryId) {
    if (!isEditorSite) {
      return;
    }

    const entry = state.manualEntries.find((candidate) => candidate.id === entryId);

    if (!entry) {
      return;
    }

    await selectSearchEntry(entry);
  }

  function saveManualEntry() {
    if (!isEditorSite || !editorLabelInput || !editorAliasesInput) {
      return;
    }

    const label = editorLabelInput.value.trim();

    if (!label) {
      setEditorFeedback('表示名を入力してください');
      editorLabelInput.focus();
      return;
    }

    const rect = getPendingEditorRect();

    if (!rect) {
      setEditorFeedback('先に地図上をクリックして位置を指定してください');
      return;
    }

    const floor = getFloorDefinition();
    const aliases = sanitizeAliases(editorAliasesInput.value);
    const entry = hydrateManualEntry({
      id: createManualEntryId(floor.id),
      floorId: floor.id,
      label,
      aliases,
      rects: [rect]
    });

    if (!entry) {
      setEditorFeedback('入力値から検索データを作成できませんでした');
      return;
    }

    state.manualEntries.push(entry);
    persistManualEntries();
    refreshSearchEntries();
    state.pendingEditorPoint = null;
    state.activeEditorPinKey = null;
    editorLabelInput.value = '';
    editorAliasesInput.value = '';
    setEditorFeedback(`${entry.label} を ${floor.label} に記録しました`);
    refreshEditorUi();
    renderSearchSuggestions();
  }

  async function copyManualEntriesJson() {
    if (!isEditorSite) {
      return;
    }

    const payload = JSON.stringify(serializeManualEntries(), null, 2);

    try {
      await navigator.clipboard.writeText(payload);
      setEditorFeedback('JSON をクリップボードにコピーしました');
    } catch (error) {
      editorJson?.focus();
      editorJson?.select();
      setEditorFeedback('自動コピーに失敗したため、JSON を選択した状態にしました');
    }
  }

  function exportManualEntriesJson() {
    if (!isEditorSite) {
      return;
    }

    const payload = JSON.stringify(serializeManualEntries(), null, 2);
    const blob = new Blob([payload], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = MANUAL_EXPORT_FILENAME;
    document.body.append(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    setEditorFeedback(`${MANUAL_EXPORT_FILENAME} を保存しました`);
  }

  function captureEditorPointAtClient(clientX, clientY) {
    if (!isEditorSite || !state.editMode || state.dragMoved || state.isPinching) {
      return;
    }

    const point = getMapPointFromClient(clientX, clientY);

    if (!point) {
      setEditorFeedback('地図の外側は記録できません');
      return;
    }

    state.activeEditorPinKey = null;
    state.pendingEditorPoint = point;
    setEditorFeedback('位置を取得しました。表示名を入れて「この位置を記録」を押してください');
    refreshEditorUi();
  }

  function startDrag(clientX, clientY) {
    state.isDragging = true;
    state.dragMoved = false;
    state.dragStartX = clientX;
    state.dragStartY = clientY;
    state.startX = state.x;
    state.startY = state.y;
  }

  function endDrag() {
    state.isDragging = false;
  }

  function beginPinch(touches) {
    const center = getTouchCenter(touches);
    state.isPinching = true;
    state.pinchStartDistance = getTouchDistance(touches);
    state.pinchStartZoom = state.zoom;
    state.pinchStartX = state.x;
    state.pinchStartY = state.y;
    state.pinchStartCenterX = center.x;
    state.pinchStartCenterY = center.y;
  }

  state.manualEntries = loadManualEntries();
  refreshSearchEntries();
  state.searchReady = true;
  state.searchPromise = Promise.resolve(state.searchEntries);
  if (isEditorSite) {
    setEditMode(true);
    refreshEditorUi();
  }

  tabButtons.forEach((button) => {
    button.addEventListener('click', () => {
      void setActiveFloor(button.dataset.floor, { resetZoom: true });
    });
  });

  zoomInButton.addEventListener('click', () => {
    const { width, height } = getViewportSize();
    zoomAt(state.zoom * 1.2, width / 2, height / 2);
  });

  zoomOutButton.addEventListener('click', () => {
    const { width, height } = getViewportSize();
    zoomAt(state.zoom / 1.2, width / 2, height / 2);
  });

  searchClearButton.addEventListener('click', () => {
    clearActiveSearchSelection({ clearInput: true });
    searchInput.focus();
  });

  searchInput.addEventListener('focus', () => {
    renderSearchSuggestions();
  });

  searchInput.addEventListener('input', () => {
    const activeEntry = getActiveSearchEntry();
    const normalizedValue = normalizeSearchValue(searchInput.value);

    if (activeEntry && !getEntrySearchTerms(activeEntry).includes(normalizedValue)) {
      state.activeSearchEntryId = null;
      renderSearchHighlights();
    }

    renderSearchSuggestions();
  });

  searchInput.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      if (state.searchSuggestions.length === 0) {
        return;
      }

      state.activeSuggestionIndex = (state.activeSuggestionIndex + 1) % state.searchSuggestions.length;
      renderSearchSuggestions();
      return;
    }

    if (event.key === 'ArrowUp') {
      event.preventDefault();
      if (state.searchSuggestions.length === 0) {
        return;
      }

      state.activeSuggestionIndex =
        (state.activeSuggestionIndex - 1 + state.searchSuggestions.length) % state.searchSuggestions.length;
      renderSearchSuggestions();
      return;
    }

    if (event.key === 'Escape') {
      searchResults.hidden = true;
      return;
    }

    if (event.key === 'Enter') {
      event.preventDefault();
      const selectedSuggestion =
        state.searchSuggestions[state.activeSuggestionIndex] ??
        state.searchEntries.find((entry) => getEntrySearchTerms(entry).includes(normalizeSearchValue(searchInput.value)));

      if (selectedSuggestion) {
        void selectSearchEntry(selectedSuggestion);
      }
    }
  });

  searchResults.addEventListener('click', (event) => {
    const button = event.target.closest('.search-result');

    if (!button) {
      return;
    }

    const entry = state.searchEntries.find((candidate) => candidate.id === button.dataset.entryId);

    if (entry) {
      void selectSearchEntry(entry);
    }
  });

  if (editorSaveButton) {
    editorSaveButton.addEventListener('click', () => {
      saveManualEntry();
    });
  }

  if (editorClearPointButton) {
    editorClearPointButton.addEventListener('click', () => {
      state.pendingEditorPoint = null;
      setEditorFeedback('仮位置をクリアしました');
      refreshEditorUi();
    });
  }

  if (editorCopyButton) {
    editorCopyButton.addEventListener('click', () => {
      void copyManualEntriesJson();
    });
  }

  if (editorExportButton) {
    editorExportButton.addEventListener('click', () => {
      exportManualEntriesJson();
    });
  }

  if (editorList) {
    editorList.addEventListener('click', (event) => {
      const button = event.target.closest('.editor-entry-button');

      if (!button) {
        return;
      }

      const { action, entryId } = button.dataset;

      if (action === 'delete' && entryId) {
        removeManualEntry(entryId);
        return;
      }

      if (action === 'focus' && entryId) {
        void focusManualEntry(entryId);
      }
    });
  }

  [editorWidthInput, editorHeightInput].filter(Boolean).forEach((input) => {
    input.addEventListener('input', () => {
      renderEditorOverlay();
      updateEditorCoords();
      updateEditorJsonOutput();
    });
  });

  document.addEventListener('pointerdown', (event) => {
    if (searchPanel.contains(event.target)) {
      return;
    }

    searchResults.hidden = true;

    if (isEditorSite && !event.target.closest('.editor-pin-button')) {
      state.activeEditorPinKey = null;
      renderEditorOverlay();
    }
  });

  viewer.addEventListener('click', (event) => {
    const pinButton = event.target.closest('.editor-pin-button');

    if (!pinButton) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    const { entryId, rectIndex } = pinButton.dataset;

    if (!entryId) {
      return;
    }

    const pinKey = createEditorPinKey(entryId, Number(rectIndex || 0));
    state.activeEditorPinKey = state.activeEditorPinKey === pinKey ? null : pinKey;
    const entry = getManualEntryById(entryId);

    if (entry && state.activeEditorPinKey) {
      const aliasText = entry.aliases.length ? ` / 別名: ${entry.aliases.join(', ')}` : '';
      setEditorFeedback(`${entry.label}${aliasText}`);
    }

    renderEditorOverlay();
  });

  viewer.addEventListener(
    'wheel',
    (event) => {
      event.preventDefault();
      const rect = viewer.getBoundingClientRect();
      const focalX = event.clientX - rect.left;
      const focalY = event.clientY - rect.top;
      const direction = event.deltaY < 0 ? 1.1 : 1 / 1.1;
      zoomAt(state.zoom * direction, focalX, focalY);
    },
    { passive: false }
  );

  viewer.addEventListener('mousedown', (event) => {
    if (event.target.closest('.editor-pin-button')) {
      return;
    }

    event.preventDefault();
    startDrag(event.clientX, event.clientY);
  });

  viewer.addEventListener('mouseup', (event) => {
    if (event.target.closest('.editor-pin-button')) {
      return;
    }

    captureEditorPointAtClient(event.clientX, event.clientY);
    endDrag();
  });

  window.addEventListener('mousemove', (event) => {
    if (!state.isDragging) {
      return;
    }

    if (
      Math.abs(event.clientX - state.dragStartX) > 4 ||
      Math.abs(event.clientY - state.dragStartY) > 4
    ) {
      state.dragMoved = true;
    }

    state.x = state.startX + (event.clientX - state.dragStartX);
    state.y = state.startY + (event.clientY - state.dragStartY);
    updateView();
  });

  window.addEventListener('mouseup', () => {
    endDrag();
  });

  viewer.addEventListener(
    'touchstart',
    (event) => {
      if (event.target.closest('.editor-pin-button')) {
        return;
      }

      if (event.touches.length === 1 && !state.isPinching) {
        const touch = event.touches[0];
        startDrag(touch.clientX, touch.clientY);
      }

      if (event.touches.length === 2) {
        endDrag();
        beginPinch(event.touches);
      }
    },
    { passive: false }
  );

  viewer.addEventListener(
    'touchmove',
    (event) => {
      event.preventDefault();

      if (event.touches.length === 1 && state.isDragging && !state.isPinching) {
        const touch = event.touches[0];
        if (
          Math.abs(touch.clientX - state.dragStartX) > 4 ||
          Math.abs(touch.clientY - state.dragStartY) > 4
        ) {
          state.dragMoved = true;
        }
        state.x = state.startX + (touch.clientX - state.dragStartX);
        state.y = state.startY + (touch.clientY - state.dragStartY);
        updateView();
        return;
      }

      if (event.touches.length === 2) {
        if (!state.isPinching) {
          beginPinch(event.touches);
        }

        const center = getTouchCenter(event.touches);
        const distance = getTouchDistance(event.touches);
        const nextZoom = clamp(
          state.pinchStartZoom * (distance / Math.max(state.pinchStartDistance, 1)),
          state.minZoom,
          state.maxZoom
        );
        const ratio = nextZoom / state.pinchStartZoom;

        state.zoom = nextZoom;
        state.x = center.x - ratio * (state.pinchStartCenterX - state.pinchStartX);
        state.y = center.y - ratio * (state.pinchStartCenterY - state.pinchStartY);
        updateView();
      }
    },
    { passive: false }
  );

  viewer.addEventListener('touchend', (event) => {
    if (event.target.closest('.editor-pin-button')) {
      return;
    }

    if (!state.isPinching && !state.dragMoved && event.changedTouches.length === 1 && event.touches.length === 0) {
      const touch = event.changedTouches[0];
      captureEditorPointAtClient(touch.clientX, touch.clientY);
    }

    if (event.touches.length < 2) {
      state.isPinching = false;
    }

    if (event.touches.length === 1) {
      const touch = event.touches[0];
      startDrag(touch.clientX, touch.clientY);
      return;
    }

    if (event.touches.length === 0) {
      endDrag();
      updateView();
    }
  });

  viewer.addEventListener('touchcancel', () => {
    state.isPinching = false;
    endDrag();
    updateView();
  });

  window.addEventListener('resize', () => {
    if (!state.intrinsicWidth || !state.intrinsicHeight) {
      return;
    }

    void renderFloor({ resetZoom: false, preserveView: true });
  });

  window.addEventListener('storage', (event) => {
    if (event.key !== MANUAL_STORAGE_KEY) {
      return;
    }

    state.manualEntries = loadManualEntries();

    if (state.activeSearchEntryId && !getManualEntryById(state.activeSearchEntryId)) {
      state.activeSearchEntryId = null;
      renderSearchHighlights();
    }

    if (state.activeEditorPinKey) {
      const [entryId] = state.activeEditorPinKey.split(':');
      if (!getManualEntryById(entryId)) {
        state.activeEditorPinKey = null;
      }
    }

    refreshSearchEntries();
    renderSearchSuggestions();
    if (isEditorSite) {
      refreshEditorUi();
    }
  });

  updateTabSelection();
  void renderFloor({ resetZoom: true });
}
