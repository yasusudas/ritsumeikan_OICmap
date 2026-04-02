import './style.css';
import * as pdfjsLib from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.mjs?url';

if (window.__FILE_MODE__) {
  console.warn('This app must be opened through a local server, not file://');
} else {
  pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

  const FLOOR_FILES = [
    { id: '1F', label: '1F', url: new URL('../フロア/1F.pdf', import.meta.url).href },
    { id: '2F', label: '2F', url: new URL('../フロア/2F.pdf', import.meta.url).href },
    { id: '3F', label: '3F', url: new URL('../フロア/3F.pdf', import.meta.url).href },
    { id: '4F', label: '4F', url: new URL('../フロア/4F.pdf', import.meta.url).href },
    { id: '5F', label: '5F', url: new URL('../フロア/5F.pdf', import.meta.url).href }
  ];
  const PDF_SUPPORT_ASSET_BASE = import.meta.env.BASE_URL;
  const CMAP_URL = `${PDF_SUPPORT_ASSET_BASE}cmaps/`;
  const STANDARD_FONT_DATA_URL = `${PDF_SUPPORT_ASSET_BASE}standard_fonts/`;

  const MIN_RENDER_QUALITY = 1;
  const MAX_RENDER_QUALITY = 10;
  const QUALITY_STEP = 0.25;
  const RERENDER_DELAY_MS = 90;
  const PAGE_GAP = 20;
  const MAX_CANVAS_SIDE = 12288;
  const MAX_CANVAS_PIXELS = 48_000_000;
  const MOBILE_MAX_CANVAS_SIDE = 8192;
  const MOBILE_MAX_CANVAS_PIXELS = 16_000_000;
  const MOBILE_MAX_RENDER_QUALITY = 6;
  const SEARCH_RESULT_LIMIT = 18;
  const SEARCH_FOCUS_ZOOM = 3.6;
  const ROOM_CODE_PATTERN = /[A-Z]{1,3}\s*-?\s*\d{2,4}[A-Z]?/g;
  const roomCodeCollator = new Intl.Collator('ja', { numeric: true, sensitivity: 'base' });

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
    contentWidth: 0,
    contentHeight: 0,
    pageLayouts: [],
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
    renderToken: 0,
    renderTimeoutId: null,
    renderInFlight: false,
    pendingRenderRequest: null,
    activeRenderTask: null,
    renderQuality: 0,
    pdfDocument: null,
    loadedFloorId: null,
    touchZoomDirty: false,
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
    return value.normalize('NFKC').toUpperCase().replace(/[^A-Z0-9]/g, '');
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

  function isMobileViewport() {
    return window.matchMedia('(max-width: 720px) and (pointer: coarse)').matches;
  }

  function getRenderBudget() {
    if (isMobileViewport()) {
      return {
        maxCanvasSide: MOBILE_MAX_CANVAS_SIDE,
        maxCanvasPixels: MOBILE_MAX_CANVAS_PIXELS,
        maxRenderQuality: MOBILE_MAX_RENDER_QUALITY
      };
    }

    return {
      maxCanvasSide: MAX_CANVAS_SIDE,
      maxCanvasPixels: MAX_CANVAS_PIXELS,
      maxRenderQuality: MAX_RENDER_QUALITY
    };
  }

  function clampPosition() {
    const { width: viewportWidth, height: viewportHeight } = getViewportSize();
    const scaledWidth = state.contentWidth * state.zoom;
    const scaledHeight = state.contentHeight * state.zoom;

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
    canvasLayer.style.transform = `translate(${state.x}px, ${state.y}px) scale(${state.zoom})`;
  }

  function updateView({ rendering = false } = {}) {
    clampPosition();
    applyTransform();

    const percent = Math.round(state.zoom * 100);
    const floor = getFloorDefinition().label;
    const suffix = rendering ? ' | 高精細化中...' : '';
    setStatus(`${floor} | ${percent}%${suffix}`);
  }

  function getDesiredRenderQuality(layoutWidth, layoutHeight) {
    const outputScale = Math.max(1, window.devicePixelRatio || 1);
    const renderBudget = getRenderBudget();
    const baseQuality = Math.max(MIN_RENDER_QUALITY, state.zoom);
    const steppedQuality = Math.round(baseQuality / QUALITY_STEP) * QUALITY_STEP;
    const maxBySide =
      renderBudget.maxCanvasSide / Math.max(Math.max(layoutWidth, layoutHeight) * outputScale, 1);
    const maxByArea = Math.sqrt(
      renderBudget.maxCanvasPixels /
        Math.max(layoutWidth * layoutHeight * outputScale * outputScale, 1)
    );
    const qualityCap = clamp(
      Math.min(renderBudget.maxRenderQuality, maxBySide, maxByArea),
      MIN_RENDER_QUALITY,
      renderBudget.maxRenderQuality
    );

    return clamp(steppedQuality, MIN_RENDER_QUALITY, qualityCap);
  }

  function updateTabSelection() {
    const activeFloorId = getFloorDefinition().id;
    tabButtons.forEach((button) => {
      const isActive = button.dataset.floor === activeFloorId;
      button.classList.toggle('is-active', isActive);
      button.setAttribute('aria-pressed', String(isActive));
    });
  }

  async function destroyCurrentDocument() {
    if (!state.pdfDocument) {
      return;
    }

    const documentToDestroy = state.pdfDocument;
    state.pdfDocument = null;
    state.loadedFloorId = null;

    try {
      await documentToDestroy.destroy();
    } catch (error) {
      console.warn('Failed to destroy PDF document cleanly.', error);
    }
  }

  async function ensurePdfDocument() {
    const selectedFloor = getFloorDefinition();

    if (state.pdfDocument && state.loadedFloorId === selectedFloor.id) {
      return state.pdfDocument;
    }

    await destroyCurrentDocument();
    setStatus(`${selectedFloor.label} を読み込み中...`);

    const loadingTask = pdfjsLib.getDocument(getDocumentOptions(selectedFloor.url));
    const pdfDocument = await loadingTask.promise;
    state.pdfDocument = pdfDocument;
    state.loadedFloorId = selectedFloor.id;
    return pdfDocument;
  }

  function getActiveSearchEntry() {
    return state.searchEntries.find((entry) => entry.id === state.activeSearchEntryId) ?? null;
  }

  function resetView() {
    state.zoom = 1;
    state.minZoom = 1;
    const { width, height } = getViewportSize();
    state.x = (width - state.contentWidth) / 2;
    state.y = (height - state.contentHeight) / 2;
    updateView();
  }

  function renderSearchHighlights() {
    state.pageLayouts.forEach((pageLayout) => {
      pageLayout.highlightLayer.replaceChildren();
    });

    const activeEntry = getActiveSearchEntry();

    if (!activeEntry || activeEntry.floorId !== getFloorDefinition().id) {
      return;
    }

    state.pageLayouts.forEach((pageLayout) => {
      const rects = activeEntry.rects.filter((rect) => rect.pageNumber === pageLayout.pageNumber);

      if (rects.length === 0) {
        return;
      }

      const fragment = document.createDocumentFragment();
      rects.forEach((rect, index) => {
        const highlight = document.createElement('div');
        highlight.className = 'search-highlight';
        highlight.style.left = `${rect.xRatio * pageLayout.width}px`;
        highlight.style.top = `${rect.yRatio * pageLayout.height}px`;
        highlight.style.width = `${Math.max(rect.widthRatio * pageLayout.width, 18)}px`;
        highlight.style.height = `${Math.max(rect.heightRatio * pageLayout.height, 14)}px`;
        highlight.style.animationDelay = `${index * 120}ms`;
        fragment.append(highlight);
      });

      pageLayout.highlightLayer.append(fragment);
    });
  }

  function focusSearchEntry(entry, targetZoom = SEARCH_FOCUS_ZOOM) {
    if (!entry || entry.floorId !== getFloorDefinition().id) {
      return;
    }

    const pageLayout = state.pageLayouts.find((layout) => layout.pageNumber === entry.pageNumber);
    const focusRect = entry.rects.find((rect) => rect.pageNumber === entry.pageNumber);

    if (!pageLayout || !focusRect) {
      return;
    }

    const nextZoom = clamp(Math.max(state.zoom, targetZoom), state.minZoom, state.maxZoom);
    const targetX = pageLayout.width * (focusRect.xRatio + focusRect.widthRatio / 2);
    const targetY = pageLayout.top + pageLayout.height * (focusRect.yRatio + focusRect.heightRatio / 2);
    const { width: viewportWidth, height: viewportHeight } = getViewportSize();

    state.zoom = nextZoom;
    state.x = viewportWidth / 2 - targetX * state.zoom;
    state.y = viewportHeight / 2 - targetY * state.zoom;
    updateView();
    scheduleRerender({ immediate: true, force: true });
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
      loading.textContent = 'OCR テキストを読み込み中...';
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

  function createTextMatchRect(item, viewport, matchIndex, matchLength, sourceLength, pageNumber) {
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
      pageNumber,
      xRatio: x / viewport.width,
      yRatio: y / viewport.height,
      widthRatio: width / viewport.width,
      heightRatio: height / viewport.height
    };
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
        const loadingTask = pdfjsLib.getDocument(getDocumentOptions(floor.url));
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

                const id = `${floor.id}-${pageNumber}-${normalized}`;
                const rect = createTextMatchRect(
                  item,
                  viewport,
                  match.index ?? 0,
                  match[0].length,
                  source.length,
                  pageNumber
                );

                if (!floorEntryMap.has(id)) {
                  floorEntryMap.set(id, {
                    id,
                    label: normalized,
                    normalized,
                    floorId: floor.id,
                    floorLabel: floor.label,
                    floorOrder: getFloorOrder(floor.id),
                    pageNumber,
                    rects: []
                  });
                }

                floorEntryMap.get(id).rects.push(rect);
              }
            });
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

  function zoomAt(nextZoom, focalX, focalY, { immediateRerender = false } = {}) {
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
    scheduleRerender({
      immediate: immediateRerender,
      force: immediateRerender && isMobileViewport(),
      cancelActive: immediateRerender && isMobileViewport()
    });
  }

  async function renderFloor({ resetZoom = false, force = false } = {}) {
    if (state.renderInFlight) {
      state.pendingRenderRequest = {
        resetZoom: state.pendingRenderRequest?.resetZoom || resetZoom,
        force: state.pendingRenderRequest?.force || force
      };
      return;
    }

    state.renderInFlight = true;
    const renderToken = ++state.renderToken;
    const previousQuality = state.renderQuality;
    const currentLayout = state.pageLayouts[0];
    const desiredQuality = currentLayout
      ? getDesiredRenderQuality(currentLayout.width, currentLayout.height)
      : MIN_RENDER_QUALITY;

    updateView({ rendering: true });

    try {
      const pdfDocument = await ensurePdfDocument();

      if (renderToken !== state.renderToken) {
        return;
      }

      if (
        !force &&
        currentLayout &&
        Math.abs(state.renderQuality - desiredQuality) < QUALITY_STEP / 2 &&
        canvasLayer.childElementCount > 0
      ) {
        updateView();
        renderSearchHighlights();
        return;
      }

      const viewerSize = getViewportSize();
      const fragment = document.createDocumentFragment();
      const nextPageLayouts = [];
      let totalHeight = 0;
      let maxWidth = 0;
      let appliedQuality = Number.POSITIVE_INFINITY;

      for (let pageNumber = 1; pageNumber <= pdfDocument.numPages; pageNumber += 1) {
        const page = await pdfDocument.getPage(pageNumber);

        if (renderToken !== state.renderToken) {
          return;
        }

        setStatus(`${getFloorDefinition().label} | ページ ${pageNumber} を描画中...`);

        const baseViewport = page.getViewport({ scale: 1 });
        const fitWidth = Math.max((viewerSize.width - 32) / baseViewport.width, 0.1);
        const fitHeight = Math.max((viewerSize.height - 32) / baseViewport.height, 0.1);
        const layoutScale = Math.min(fitWidth, fitHeight);
        const layoutViewport = page.getViewport({ scale: layoutScale });
        const pageQuality = getDesiredRenderQuality(layoutViewport.width, layoutViewport.height);
        const renderViewport = page.getViewport({ scale: layoutScale * pageQuality });
        const outputScale = Math.max(1, window.devicePixelRatio || 1);

        const pageElement = document.createElement('article');
        pageElement.className = 'pdf-page';
        pageElement.style.width = `${layoutViewport.width}px`;
        pageElement.style.height = `${layoutViewport.height}px`;

        const canvas = document.createElement('canvas');
        const context = canvas.getContext('2d', { alpha: false });

        if (!context) {
          throw new Error('Canvas 2D context is not available.');
        }

        context.imageSmoothingEnabled = true;
        context.imageSmoothingQuality = 'high';

        canvas.width = Math.ceil(renderViewport.width * outputScale);
        canvas.height = Math.ceil(renderViewport.height * outputScale);
        canvas.style.width = `${layoutViewport.width}px`;
        canvas.style.height = `${layoutViewport.height}px`;
        canvas.className = 'pdf-canvas';

        state.activeRenderTask = page.render({
          canvasContext: context,
          transform: [outputScale, 0, 0, outputScale, 0, 0],
          viewport: renderViewport
        });
        await state.activeRenderTask.promise;
        state.activeRenderTask = null;

        const highlightLayer = document.createElement('div');
        highlightLayer.className = 'highlight-layer';
        highlightLayer.dataset.pageNumber = String(pageNumber);

        pageElement.append(canvas, highlightLayer);
        fragment.append(pageElement);

        nextPageLayouts.push({
          pageNumber,
          width: layoutViewport.width,
          height: layoutViewport.height,
          top: totalHeight,
          highlightLayer
        });

        maxWidth = Math.max(maxWidth, layoutViewport.width);
        totalHeight += layoutViewport.height;
        if (pageNumber < pdfDocument.numPages) {
          totalHeight += PAGE_GAP;
        }

        appliedQuality = Math.min(appliedQuality, pageQuality);
      }

      if (renderToken !== state.renderToken) {
        return;
      }

      canvasLayer.replaceChildren(fragment);
      state.pageLayouts = nextPageLayouts;
      state.contentWidth = maxWidth;
      state.contentHeight = totalHeight;
      state.renderQuality = Number.isFinite(appliedQuality) ? appliedQuality : MIN_RENDER_QUALITY;

      if (resetZoom || previousQuality === 0) {
        resetView();
      } else {
        updateView();
      }

      renderSearchHighlights();
    } catch (error) {
      if (error?.name === 'RenderingCancelledException') {
        return;
      }

      console.error(error);
      setStatus('PDFの描画に失敗しました');
    } finally {
      state.activeRenderTask = null;
      state.renderInFlight = false;

      if (state.pendingRenderRequest) {
        const pendingRenderRequest = state.pendingRenderRequest;
        state.pendingRenderRequest = null;
        void renderFloor(pendingRenderRequest);
      }
    }
  }

  function cancelActiveRenderTask() {
    if (!state.activeRenderTask) {
      return;
    }

    try {
      state.activeRenderTask.cancel();
    } catch (error) {
      console.warn('Failed to cancel active PDF render task.', error);
    }
  }

  function scheduleRerender({ immediate = false, force = false, cancelActive = false } = {}) {
    if (state.renderTimeoutId) {
      window.clearTimeout(state.renderTimeoutId);
      state.renderTimeoutId = null;
    }

    if (cancelActive) {
      cancelActiveRenderTask();
    }

    const run = () => {
      state.renderTimeoutId = null;
      void renderFloor({ force });
    };

    if (immediate) {
      run();
      return;
    }

    state.renderTimeoutId = window.setTimeout(run, RERENDER_DELAY_MS);
  }

  async function setActiveFloor(floorId, { resetZoom = true } = {}) {
    const nextIndex = FLOOR_FILES.findIndex((floor) => floor.id === floorId);

    if (nextIndex < 0) {
      return;
    }

    if (state.renderTimeoutId) {
      window.clearTimeout(state.renderTimeoutId);
      state.renderTimeoutId = null;
    }

    const floorChanged = nextIndex !== state.floorIndex;
    state.floorIndex = nextIndex;
    state.renderQuality = 0;
    updateTabSelection();

    if (floorChanged) {
      await destroyCurrentDocument();
    }

    await renderFloor({ resetZoom, force: true });
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
    state.touchZoomDirty = false;
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
    zoomAt(state.zoom * 1.2, width / 2, height / 2, { immediateRerender: true });
  });

  zoomOutButton.addEventListener('click', () => {
    const { width, height } = getViewportSize();
    zoomAt(state.zoom / 1.2, width / 2, height / 2, { immediateRerender: true });
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

        if (isMobileViewport()) {
          state.touchZoomDirty = true;
          scheduleRerender({
            immediate: true,
            force: true,
            cancelActive: true
          });
          return;
        }

        scheduleRerender();
      }
    },
    { passive: false }
  );

  viewer.addEventListener('touchend', (event) => {
    const pinchEnded = state.isPinching && event.touches.length < 2;

    if (event.touches.length < 2) {
      state.isPinching = false;
    }

    if (pinchEnded) {
      scheduleRerender({
        immediate: true,
        force: true,
        cancelActive: isMobileViewport() || state.touchZoomDirty
      });
      state.touchZoomDirty = false;
    }

    if (event.touches.length === 1) {
      const touch = event.touches[0];
      startDrag(touch.clientX, touch.clientY);
      return;
    }

    if (event.touches.length === 0) {
      endDrag();
      if (!pinchEnded) {
        scheduleRerender({
          immediate: true,
          force: true,
          cancelActive: isMobileViewport()
        });
      }
    }
  });

  viewer.addEventListener('touchcancel', () => {
    state.isPinching = false;
    state.touchZoomDirty = false;
    endDrag();
    scheduleRerender({
      immediate: true,
      force: true,
      cancelActive: isMobileViewport()
    });
  });

  window.addEventListener('resize', () => {
    state.renderQuality = 0;
    void renderFloor({ force: true });
  });

  window.addEventListener('beforeunload', () => {
    if (state.renderTimeoutId) {
      window.clearTimeout(state.renderTimeoutId);
    }
  });

  updateTabSelection();
  void renderFloor({ resetZoom: true, force: true });
  window.setTimeout(() => {
    void buildSearchIndex();
  }, 120);
}
