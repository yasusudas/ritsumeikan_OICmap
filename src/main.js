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
  const ROOM_CODE_PATTERN = /[A-Z]{1,3}\s*-?\s*\d{2,4}[A-Z]?/g;
  const SEARCHABLE_CHAR_PATTERN = /[\p{L}\p{N}]/u;
  const LETTER_PATTERN = /\p{L}/u;
  const roomCodeCollator = new Intl.Collator('ja', { numeric: true, sensitivity: 'base' });
  const svgCache = new Map();

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
    searchReady: false,
    searchLoading: false,
    searchPromise: null,
    searchEntries: [],
    searchSuggestions: [],
    activeSuggestionIndex: -1,
    activeSearchEntryId: null
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

  function getDocumentOptions(url) {
    return {
      url,
      cMapUrl: CMAP_URL,
      cMapPacked: true,
      standardFontDataUrl: STANDARD_FONT_DATA_URL
    };
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

  function createSvgNode(svgText) {
    const svgDocument = new DOMParser().parseFromString(svgText, 'image/svg+xml');
    const importedSvg = document.importNode(svgDocument.documentElement, true);
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
      } else {
        setSearchFeedback('1F〜5F を横断検索できます');
      }
      return;
    }

    if (state.searchLoading && !state.searchReady) {
      const loading = document.createElement('div');
      loading.className = 'search-result-empty';
      loading.textContent = '教室データを読み込み中...';
      searchResults.replaceChildren(loading);
      searchResults.hidden = false;
      state.searchSuggestions = [];
      state.activeSuggestionIndex = -1;
      setSearchFeedback('検索インデックスを準備しています');
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
      if (entry.normalized === normalizedQuery) {
        exactMatches.push(entry);
        return;
      }

      if (entry.normalized.startsWith(normalizedQuery)) {
        prefixMatches.push(entry);
        return;
      }

      if (entry.normalized.includes(normalizedQuery)) {
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
      empty.textContent = '一致する教室候補がありません';
      searchResults.replaceChildren(empty);
      searchResults.hidden = false;
      setSearchFeedback('一致候補なし');
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
    if (state.searchPromise) {
      return state.searchPromise;
    }

    state.searchLoading = true;
    renderSearchSuggestions();

    state.searchPromise = (async () => {
      const searchEntries = [];

      for (const floor of FLOOR_FILES) {
        const loadingTask = pdfjsLib.getDocument(getDocumentOptions(floor.searchUrl));
        const pdfDocument = await loadingTask.promise;
        const floorEntryMap = new Map();

        try {
          for (let pageNumber = 1; pageNumber <= pdfDocument.numPages; pageNumber += 1) {
            const page = await pdfDocument.getPage(pageNumber);
            const viewport = page.getViewport({ scale: 1 });
            const textContent = await page.getTextContent();

            textContent.items.forEach((item) => {
              if (!('str' in item)) {
                return;
              }

              const source = normalizeMatchSource(item.str);

              for (const match of source.matchAll(ROOM_CODE_PATTERN)) {
                const normalized = normalizeSearchValue(match[0]);

                if (!normalized) {
                  continue;
                }

                const id = `${floor.id}-${normalized}`;
                const rect = createTextMatchRect(
                  item,
                  viewport,
                  match.index ?? 0,
                  match[0].length,
                  source.length
                );

                if (!floorEntryMap.has(id)) {
                  floorEntryMap.set(id, {
                    id,
                    label: normalized,
                    normalized,
                    floorId: floor.id,
                    floorLabel: floor.label,
                    floorOrder: getFloorOrder(floor.id),
                    rects: []
                  });
                }

                floorEntryMap.get(id).rects.push(rect);
              }
            });

            collectSearchCandidates(textContent, viewport).forEach((candidate) => {
              const id = `${floor.id}-${candidate.normalized}`;

              if (!floorEntryMap.has(id)) {
                floorEntryMap.set(id, {
                  id,
                  label: candidate.label,
                  normalized: candidate.normalized,
                  floorId: floor.id,
                  floorLabel: floor.label,
                  floorOrder: getFloorOrder(floor.id),
                  rects: []
                });
              }

              floorEntryMap.get(id).rects.push(candidate.rect);
            });

            page.cleanup();
          }
        } finally {
          await pdfDocument.destroy();
        }

        searchEntries.push(...floorEntryMap.values());
      }

      searchEntries.sort((left, right) => {
        const labelOrder = roomCodeCollator.compare(left.label, right.label);

        if (labelOrder !== 0) {
          return labelOrder;
        }

        return left.floorOrder - right.floorOrder;
      });

      state.searchEntries = searchEntries;
      state.searchReady = true;
      return searchEntries;
    })();

    try {
      await state.searchPromise;
    } finally {
      state.searchLoading = false;
      renderSearchSuggestions();
    }

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

      mapAsset.append(svgNode, highlightLayer);
      canvasLayer.replaceChildren(mapAsset);

      state.highlightLayer = highlightLayer;
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
    } catch (error) {
      console.error(error);
      canvasLayer.replaceChildren();
      state.highlightLayer = null;
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

  function startDrag(clientX, clientY) {
    state.isDragging = true;
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
    void buildSearchIndex();
    renderSearchSuggestions();
  });

  searchInput.addEventListener('input', () => {
    if (!state.searchReady) {
      void buildSearchIndex();
    }

    if (normalizeSearchValue(searchInput.value) !== getActiveSearchEntry()?.normalized) {
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
        state.searchEntries.find((entry) => entry.normalized === normalizeSearchValue(searchInput.value));

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

  document.addEventListener('pointerdown', (event) => {
    if (searchPanel.contains(event.target)) {
      return;
    }

    searchResults.hidden = true;
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
    event.preventDefault();
    startDrag(event.clientX, event.clientY);
  });

  window.addEventListener('mousemove', (event) => {
    if (!state.isDragging) {
      return;
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

  updateTabSelection();
  void renderFloor({ resetZoom: true });
  window.setTimeout(() => {
    void buildSearchIndex();
  }, 120);
}
