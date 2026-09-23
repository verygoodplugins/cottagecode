/** The town's world pixels and the viewport's CSS pixels are independent. */
export const ZOOM_LEVELS = Object.freeze([50, 75, 100, 125, 150, 200]);
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

export function nextZoom(current, direction) {
  const index = ZOOM_LEVELS.indexOf(current);
  return ZOOM_LEVELS[clamp((index < 0 ? 2 : index) + Math.sign(direction), 0, ZOOM_LEVELS.length - 1)];
}

/** Overview never enlarges cottages beyond their normal scale. */
export function overviewZoom(bounds, {width,height,right=0,bottom=0,baseScale,padding=24}) {
  const fit = Math.min(Math.max(1,width-right-padding*2)/Math.max(1,bounds.w),
    Math.max(1,height-bottom-padding*2)/Math.max(1,bounds.h))/baseScale*100;
  return ZOOM_LEVELS.filter(level => level <= Math.min(100,fit)).at(-1) || ZOOM_LEVELS[0];
}

export function zoomKey(event) {
  if (event.ctrlKey || event.metaKey || event.altKey || event.isComposing || event.repeat ||
      event.target?.closest?.('input, textarea, select, [contenteditable]:not([contenteditable="false"])')) return null;
  if (event.key === '+' || event.key === '=') return 'in';
  if (event.key === '-') return 'out';
  if (event.key === '0') return 'reset';
  return null;
}

export function viewportGeometry({worldWidth, worldHeight, width, height, scale, right = 0, bottom = 0}) {
  const mapWidth = worldWidth * scale, mapHeight = worldHeight * scale;
  const x = Math.max(0, (width - mapWidth) / 2), y = Math.max(0, (height - mapHeight) / 2);
  right = clamp(right, 0, width); bottom = clamp(bottom, 0, height);
  return {width, height, scale, x, y, mapWidth, mapHeight, right, bottom,
    // Extra scroll space lets Jack reach the clear part of the viewport even at a map edge.
    contentWidth: Math.max(width, x + mapWidth + right),
    contentHeight: Math.max(height, y + mapHeight + bottom)};
}

export function worldPoint(point, geometry, scroll = {left: 0, top: 0}) {
  return {x: (point.x + scroll.left - geometry.x) / geometry.scale,
    y: (point.y + scroll.top - geometry.y) / geometry.scale};
}

export function screenPoint(point, geometry, scroll = {left: 0, top: 0}) {
  return {x: point.x * geometry.scale + geometry.x - scroll.left,
    y: point.y * geometry.scale + geometry.y - scroll.top};
}

export function scrollForPoint(point, geometry, target = {x: geometry.width / 2, y: geometry.height / 2}) {
  return {left: clamp(point.x * geometry.scale + geometry.x - target.x, 0, geometry.contentWidth - geometry.width),
    top: clamp(point.y * geometry.scale + geometry.y - target.y, 0, geometry.contentHeight - geometry.height)};
}

export function createMapViewport({viewport, surface, canvas, referenceWidth, getObscured = () => ({})}) {
  // Remember the normal layout even if fullscreen is entered while the feed is still loading.
  const initialWidth = viewport.clientWidth;
  let worldWidth = 0, worldHeight = 0, baseScale = null, zoom = 100, geometry = null;
  let indoors = false, pendingCenter = null;
  const scroll = () => ({left: viewport.scrollLeft, top: viewport.scrollTop});
  const center = () => geometry && worldPoint({x: geometry.width / 2, y: geometry.height / 2}, geometry, scroll());
  const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

  function capture() { if (!indoors && geometry) pendingCenter = center(); }
  function resize() {
    if (indoors || !worldWidth || !worldHeight || !viewport.clientWidth || !viewport.clientHeight) return;
    const anchor = pendingCenter || center();
    if (baseScale === null) baseScale = (initialWidth || viewport.clientWidth) / (referenceWidth || worldWidth);
    const next = viewportGeometry({worldWidth, worldHeight, width: viewport.clientWidth,
      height: viewport.clientHeight, scale: baseScale * zoom / 100, ...getObscured()});
    if (!pendingCenter && geometry && Object.keys(next).every(key => next[key] === geometry[key])) return;
    geometry = next;
    surface.style.width = next.contentWidth + 'px'; surface.style.height = next.contentHeight + 'px';
    canvas.style.width = next.mapWidth + 'px'; canvas.style.height = next.mapHeight + 'px';
    canvas.style.left = next.x + 'px'; canvas.style.top = next.y + 'px';
    if (anchor) viewport.scrollTo({...scrollForPoint(anchor, next), behavior: 'instant'});
    pendingCenter = null;
  }
  const observer = new ResizeObserver(resize);
  observer.observe(viewport);

  function focus(point, immediate = false) {
    resize();
    if (!geometry || indoors) return;
    const target = {x: (geometry.width - geometry.right) / 2, y: (geometry.height - geometry.bottom) * .45};
    viewport.scrollTo({...scrollForPoint(point, geometry, target), behavior: immediate || reduced() ? 'instant' : 'smooth'});
  }
  function ensureVisible(point) {
    resize();
    if (!geometry || indoors) return;
    const current = scroll(), p = screenPoint(point, geometry, current);
    const width = geometry.width - geometry.right, height = geometry.height - geometry.bottom;
    const mx = Math.min(60, width / 4), my = Math.min(60, height / 4);
    const target = {x: clamp(p.x, mx, width - mx), y: clamp(p.y, my, height - my)};
    if (target.x !== p.x || target.y !== p.y) viewport.scrollTo({...scrollForPoint(point, geometry, target), behavior: 'instant'});
  }
  return {
    capture, resize, focus, ensureVisible,
    overview(bounds) {
      if (!bounds || indoors) return null;
      resize();if (!geometry) return null;
      capture();zoom=overviewZoom(bounds,{...geometry,baseScale});resize();
      const point={x:bounds.x+bounds.w/2,y:bounds.y+bounds.h/2};
      const target={x:(geometry.width-geometry.right)/2,y:(geometry.height-geometry.bottom)/2};
      viewport.scrollTo({...scrollForPoint(point,geometry,target),behavior:'instant'});
      const top=screenPoint(bounds,geometry,scroll()),bottom=screenPoint({x:bounds.x+bounds.w,y:bounds.y+bounds.h},geometry,scroll());
      return {zoom,allVisible:top.x>=0&&top.y>=0&&bottom.x<=geometry.width-geometry.right&&bottom.y<=geometry.height-geometry.bottom};
    },
    visibleArea() {
      const {right = 0, bottom = 0} = getObscured();
      return {width:Math.max(1, viewport.clientWidth-right), height:Math.max(1, viewport.clientHeight-bottom)};
    },
    setWorld(width, height) { worldWidth = width; worldHeight = height; resize(); },
    setIndoors(value) {
      if (value === indoors) return;
      if (value) capture();
      indoors = value; viewport.classList.toggle('is-indoors', value);
      if (value) viewport.scrollTo({left: 0, top: 0, behavior: 'instant'});
      else resize();
    },
    setZoom(value) {
      if (indoors || !ZOOM_LEVELS.includes(value) || value === zoom) return;
      capture(); zoom = value; resize();
    },
    pointAtEvent(event) {
      const rect = canvas.getBoundingClientRect();
      return {x: (event.clientX - rect.left) * canvas.width / rect.width,
        y: (event.clientY - rect.top) * canvas.height / rect.height};
    },
    get state() { return {zoom, baseScale, scale: baseScale === null ? null : baseScale * zoom / 100,
      center: indoors ? pendingCenter : center(), indoors, geometry: geometry && {...geometry}}; },
  };
}
