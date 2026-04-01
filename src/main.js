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

  const MIN_RENDER_QUALITY = 1;
  const MAX_RENDER_QUALITY = 4;
  const QUALITY_STEP = 0.25;
  const RERENDER_DELAY_MS = 140;
  const PAGE_GAP = 20;

  const viewer = document.querySelector('#viewer');
  const canvasLayer = document.querySelector('#canvas-layer');
  const statusElement = document.querySelector('#status');
  const tabButtons = Array.from(document.querySelectorAll('.floor-tab'));
  const zoomInButton = document.querySelector('#zoom-in');
  const zoomOutButton = document.querySelector('#zoom-out');

  const state = {
    floorIndex: 0,
    zoom: 1,
    minZoom: 1,
    maxZoom: 5,
    x: 0,
    y: 0,
    contentWidth: 0,
    contentHeight: 0,
    isDragging: false,
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
    pdfDocument: null,
    loadedFloorId: null,
    renderQuality: 0
  };

  function setStatus(message) {
    statusElement.textContent = message;
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
    const floor = FLOOR_FILES[state.floorIndex].label;
    const suffix = rendering ? ' | 高精細化中...' : '';
    setStatus(`${floor} | ${percent}%${suffix}`);
  }

  function getDesiredRenderQuality() {
    const rawQuality = Math.max(MIN_RENDER_QUALITY, state.zoom * 1.15);
    const steppedQuality = Math.round(rawQuality / QUALITY_STEP) * QUALITY_STEP;
    return clamp(steppedQuality, MIN_RENDER_QUALITY, MAX_RENDER_QUALITY);
  }

  function getFloorDefinition() {
    return FLOOR_FILES[state.floorIndex];
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

    const loadingTask = pdfjsLib.getDocument({
      url: selectedFloor.url,
      cMapUrl: CMAP_URL,
      cMapPacked: true
    });
    const pdfDocument = await loadingTask.promise;
    state.pdfDocument = pdfDocument;
    state.loadedFloorId = selectedFloor.id;

    return pdfDocument;
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
    scheduleRerender({ immediate: immediateRerender });
  }

  function resetView() {
    state.zoom = 1;
    state.minZoom = 1;
    const { width, height } = getViewportSize();
    state.x = (width - state.contentWidth) / 2;
    state.y = (height - state.contentHeight) / 2;
    updateView();
  }

  async function renderFloor({ resetZoom = false, force = false } = {}) {
    const renderToken = ++state.renderToken;
    const previousQuality = state.renderQuality;
    const desiredQuality = getDesiredRenderQuality();

    updateView({ rendering: true });

    try {
      const pdfDocument = await ensurePdfDocument();

      if (renderToken !== state.renderToken) {
        return;
      }

      if (
        !force &&
        Math.abs(previousQuality - desiredQuality) < QUALITY_STEP / 2 &&
        canvasLayer.childElementCount > 0
      ) {
        state.renderQuality = desiredQuality;
        updateView();
        return;
      }

      const viewerSize = getViewportSize();
      const fragment = document.createDocumentFragment();
      let totalHeight = 0;
      let maxWidth = 0;

      for (let pageNumber = 1; pageNumber <= pdfDocument.numPages; pageNumber += 1) {
        const page = await pdfDocument.getPage(pageNumber);

        if (renderToken !== state.renderToken) {
          return;
        }

        setStatus(`${getFloorDefinition().label} | ページ ${pageNumber} を描画中...`);

        const initialViewport = page.getViewport({ scale: 1 });
        const fitWidth = (viewerSize.width - 32) / initialViewport.width;
        const fitHeight = (viewerSize.height - 32) / initialViewport.height;
        const layoutScale = Math.min(fitWidth, fitHeight);
        const layoutViewport = page.getViewport({ scale: layoutScale });
        const renderViewport = page.getViewport({ scale: layoutScale * desiredQuality });
        const outputScale = window.devicePixelRatio || 1;

        const canvas = document.createElement('canvas');
        const context = canvas.getContext('2d');

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

        await page.render({
          canvasContext: context,
          transform: [outputScale, 0, 0, outputScale, 0, 0],
          viewport: renderViewport
        }).promise;

        fragment.append(canvas);

        totalHeight += layoutViewport.height;
        if (pageNumber < pdfDocument.numPages) {
          totalHeight += PAGE_GAP;
        }
        maxWidth = Math.max(maxWidth, layoutViewport.width);
      }

      if (renderToken !== state.renderToken) {
        return;
      }

      canvasLayer.replaceChildren(fragment);
      state.contentWidth = maxWidth;
      state.contentHeight = totalHeight;
      state.renderQuality = desiredQuality;

      if (resetZoom || previousQuality === 0) {
        resetView();
      } else {
        updateView();
      }
    } catch (error) {
      console.error(error);
      setStatus('PDFの描画に失敗しました');
    }
  }

  function scheduleRerender({ immediate = false, force = false } = {}) {
    if (state.renderTimeoutId) {
      window.clearTimeout(state.renderTimeoutId);
      state.renderTimeoutId = null;
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

  async function setActiveFloor(floorId) {
    const nextIndex = FLOOR_FILES.findIndex((floor) => floor.id === floorId);

    if (nextIndex < 0 || nextIndex === state.floorIndex) {
      return;
    }

    if (state.renderTimeoutId) {
      window.clearTimeout(state.renderTimeoutId);
      state.renderTimeoutId = null;
    }

    state.floorIndex = nextIndex;
    state.renderQuality = 0;
    updateTabSelection();
    await destroyCurrentDocument();
    void renderFloor({ resetZoom: true, force: true });
  }

  function updateTabSelection() {
    const activeFloorId = getFloorDefinition().id;
    tabButtons.forEach((button) => {
      const isActive = button.dataset.floor === activeFloorId;
      button.classList.toggle('is-active', isActive);
      button.setAttribute('aria-pressed', String(isActive));
    });
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

  tabButtons.forEach((button) => {
    button.addEventListener('click', () => {
      void setActiveFloor(button.dataset.floor);
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

  viewer.addEventListener('wheel', (event) => {
    event.preventDefault();
    const rect = viewer.getBoundingClientRect();
    const focalX = event.clientX - rect.left;
    const focalY = event.clientY - rect.top;
    const direction = event.deltaY < 0 ? 1.1 : 1 / 1.1;
    zoomAt(state.zoom * direction, focalX, focalY);
  }, { passive: false });

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

  viewer.addEventListener('touchstart', (event) => {
    if (event.touches.length === 1) {
      const touch = event.touches[0];
      startDrag(touch.clientX, touch.clientY);
    }

    if (event.touches.length === 2) {
      endDrag();
      const center = getTouchCenter(event.touches);
      state.pinchStartDistance = getTouchDistance(event.touches);
      state.pinchStartZoom = state.zoom;
      state.pinchStartX = state.x;
      state.pinchStartY = state.y;
      state.pinchStartCenterX = center.x;
      state.pinchStartCenterY = center.y;
    }
  }, { passive: false });

  viewer.addEventListener('touchmove', (event) => {
    event.preventDefault();

    if (event.touches.length === 1 && state.isDragging) {
      const touch = event.touches[0];
      state.x = state.startX + (touch.clientX - state.dragStartX);
      state.y = state.startY + (touch.clientY - state.dragStartY);
      updateView();
      return;
    }

    if (event.touches.length === 2) {
      const center = getTouchCenter(event.touches);
      const distance = getTouchDistance(event.touches);
      const nextZoom = clamp(
        state.pinchStartZoom * (distance / state.pinchStartDistance),
        state.minZoom,
        state.maxZoom
      );
      const ratio = nextZoom / state.pinchStartZoom;

      state.zoom = nextZoom;
      state.x = center.x - ratio * (state.pinchStartCenterX - state.pinchStartX);
      state.y = center.y - ratio * (state.pinchStartCenterY - state.pinchStartY);
      updateView();
      scheduleRerender();
    }
  }, { passive: false });

  viewer.addEventListener('touchend', (event) => {
    if (event.touches.length === 0) {
      endDrag();
      scheduleRerender({ immediate: true });
      return;
    }

    if (event.touches.length === 1) {
      const touch = event.touches[0];
      startDrag(touch.clientX, touch.clientY);
    }
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
}
