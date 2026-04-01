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
  pdfDocument: null
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

function updateView() {
  clampPosition();
  applyTransform();
  const percent = Math.round(state.zoom * 100);
  const floor = FLOOR_FILES[state.floorIndex].label;
  setStatus(`${floor} | ${percent}%`);
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

function resetView() {
  state.zoom = 1;
  state.minZoom = 1;
  const { width, height } = getViewportSize();
  state.x = (width - state.contentWidth) / 2;
  state.y = (height - state.contentHeight) / 2;
  updateView();
}

function clearCanvasLayer() {
  canvasLayer.replaceChildren();
}

async function renderFloor() {
  const renderToken = ++state.renderToken;
  const selectedFloor = FLOOR_FILES[state.floorIndex];
  setStatus(`${selectedFloor.label} を読み込み中...`);

  if (state.pdfDocument) {
    await state.pdfDocument.destroy();
    state.pdfDocument = null;
  }

  clearCanvasLayer();

  try {
    const loadingTask = pdfjsLib.getDocument(selectedFloor.url);
    const pdfDocument = await loadingTask.promise;

    if (renderToken !== state.renderToken) {
      await pdfDocument.destroy();
      return;
    }

    state.pdfDocument = pdfDocument;

    const viewerSize = getViewportSize();
    const fragment = document.createDocumentFragment();
    const gap = 20;
    let totalHeight = 0;
    let maxWidth = 0;

    for (let pageNumber = 1; pageNumber <= pdfDocument.numPages; pageNumber += 1) {
      const page = await pdfDocument.getPage(pageNumber);

      if (renderToken !== state.renderToken) {
        return;
      }

      const initialViewport = page.getViewport({ scale: 1 });
      const fitWidth = (viewerSize.width - 32) / initialViewport.width;
      const fitHeight = (viewerSize.height - 32) / initialViewport.height;
      const baseScale = Math.min(fitWidth, fitHeight);
      const viewport = page.getViewport({ scale: baseScale });
      const outputScale = window.devicePixelRatio || 1;

      const canvas = document.createElement('canvas');
      const context = canvas.getContext('2d', { alpha: false });

      canvas.width = Math.floor(viewport.width * outputScale);
      canvas.height = Math.floor(viewport.height * outputScale);
      canvas.style.width = `${viewport.width}px`;
      canvas.style.height = `${viewport.height}px`;
      canvas.className = 'pdf-canvas';

      await page.render({
        canvasContext: context,
        transform: [outputScale, 0, 0, outputScale, 0, 0],
        viewport
      }).promise;

      fragment.append(canvas);

      totalHeight += viewport.height;
      if (pageNumber < pdfDocument.numPages) {
        totalHeight += gap;
      }
      maxWidth = Math.max(maxWidth, viewport.width);
    }

    canvasLayer.append(fragment);
    state.contentWidth = maxWidth;
    state.contentHeight = totalHeight;
    resetView();
  } catch (error) {
    console.error(error);
    setStatus('PDFの読み込みに失敗しました');
  }
}

function setActiveFloor(floorId) {
  const nextIndex = FLOOR_FILES.findIndex((floor) => floor.id === floorId);

  if (nextIndex < 0 || nextIndex === state.floorIndex) {
    return;
  }

  state.floorIndex = nextIndex;
  updateTabSelection();
  renderFloor();
}

function updateTabSelection() {
  const activeFloorId = FLOOR_FILES[state.floorIndex].id;
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
  return {
    x: (touches[0].clientX + touches[1].clientX) / 2 - viewer.getBoundingClientRect().left,
    y: (touches[0].clientY + touches[1].clientY) / 2 - viewer.getBoundingClientRect().top
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
    setActiveFloor(button.dataset.floor);
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
  }
}, { passive: false });

viewer.addEventListener('touchend', (event) => {
  if (event.touches.length === 0) {
    endDrag();
    return;
  }

  if (event.touches.length === 1) {
    const touch = event.touches[0];
    startDrag(touch.clientX, touch.clientY);
  }
});

window.addEventListener('resize', () => {
  renderFloor();
});

updateTabSelection();
renderFloor();
}
