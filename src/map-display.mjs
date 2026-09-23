import {fullscreenButtonCopy} from './fullscreen.mjs';
import {nextZoom, zoomKey, ZOOM_LEVELS} from './viewport.mjs';

/** Fullscreen and panel chrome live outside the inspector's streaming content. */
export function createMapDisplay({camera, canvas, getMode, onOverview}) {
  const $ = id => document.getElementById(id);
  const root = $('map-shell'), viewport = $('map-viewport'), details = $('details-shell');
  const panel = $('panel');
  const outside = [...root.parentElement.children].filter(element => element !== root);
  const fullscreen = $('fullscreen-toggle'), toggle = $('details-toggle'), close = $('details-close');
  const zoomControls = $('map-zoom'), minus = $('zoom-out'), plus = $('zoom-in'), reset = $('zoom-reset');
  let active = false, detailsOpen = true, pageScroll = null;
  let frame = 0;
  let fullscreenReading = null;
  const isActive = () => active;
  const focusMap = () => $(getMode() === 'room' ? 'room-canvas' : 'town').focus({preventScroll: true});

  function positionPanel() {
    frame = 0;
    if (active) {
      const r = root.getBoundingClientRect(), v = viewport.getBoundingClientRect();
      root.style.setProperty('--details-top', Math.max(12, v.top - r.top + 12) + 'px');
      root.style.setProperty('--details-right', Math.max(12, r.right - v.right + 12) + 'px');
      root.style.setProperty('--details-bottom', Math.max(12, r.bottom - v.bottom + 12) + 'px');
    }
    camera.resize();
  }
  function scheduleLayout() { if (!frame) frame = requestAnimationFrame(positionPanel); }
  const observer = new ResizeObserver(scheduleLayout);
  observer.observe(viewport); observer.observe(details);

  function syncDetails() {
    details.hidden = active && !detailsOpen;
    toggle.hidden = !active;
    toggle.setAttribute('aria-expanded', String(detailsOpen));
    toggle.setAttribute('aria-pressed', String(detailsOpen));
    positionPanel();
  }
  function showDetails() { detailsOpen = true; syncDetails(); }
  function syncFullscreen(next = active) {
    const entering = next && !active;
    if (entering) detailsOpen = true;
    const leaving = active && !next;
    if (leaving && detailsOpen) fullscreenReading = {view:panel.dataset.view, top:panel.scrollTop};
    active = next;
    root.classList.toggle('is-fullscreen', active);
    document.body.classList.toggle('is-map-fullscreen', active);
    for (const element of outside) element.inert = active;
    const copy = fullscreenButtonCopy(active);
    fullscreen.setAttribute('aria-pressed', String(active));
    fullscreen.setAttribute('aria-label', copy.ariaLabel); fullscreen.textContent = copy.label;
    fullscreen.title = copy.title;
    syncDetails();
    if (entering && fullscreenReading && fullscreenReading.view === panel.dataset.view) panel.scrollTop = fullscreenReading.top;
    if (leaving && pageScroll) { window.scrollTo({...pageScroll, behavior: 'instant'}); pageScroll = null; }
  }
  function exit() {
    camera.capture();
    syncFullscreen(false);
  }
  function toggleFullscreen() {
    if (active) { exit(); return; }
    camera.capture();
    pageScroll = {left: window.scrollX, top: window.scrollY};
    syncFullscreen(true);
  }
  function syncZoom() {
    const zoom = camera.state.zoom;
    zoomControls.hidden = getMode() === 'room';
    minus.disabled = zoom === ZOOM_LEVELS[0]; plus.disabled = zoom === ZOOM_LEVELS.at(-1);
    reset.textContent = zoom + '%'; reset.setAttribute('aria-label', 'Map zoom ' + zoom + '%. Reset to 100%');
  }
  function changeZoom(action) {
    camera.setZoom(action === 'reset' ? 100 : nextZoom(camera.state.zoom, action === 'in' ? 1 : -1));
    syncZoom();
  }
  for (const [button, action] of [[minus, 'out'], [plus, 'in'], [reset, 'reset']]) {
    button.addEventListener('click', () => { changeZoom(action); focusMap(); });
  }
  $('map-overview').addEventListener('click', () => {
    const result=onOverview?.();syncZoom();focusMap();
    $('overview-status').textContent=result ? 'Overview at '+result.zoom+'%.'+
      (result.allVisible?'':' Some cottages are outside the view; scroll to explore.') : 'No cottages to show yet.';
  });
  canvas.addEventListener('keydown', event => {
    const action = zoomKey(event);
    if (!action || getMode() === 'room') return;
    event.preventDefault(); changeZoom(action);
  });
  fullscreen.addEventListener('click', () => { void toggleFullscreen(); });
  toggle.addEventListener('click', () => { detailsOpen = !detailsOpen; syncDetails(); });
  close.addEventListener('click', () => { detailsOpen = false; syncDetails(); focusMap(); });
  window.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || event.defaultPrevented || !active || root.querySelector('dialog[open]')) return;
    event.preventDefault(); void exit();
  });
  syncFullscreen(); syncZoom();
  return {isActive, toggle: toggleFullscreen, exit, showDetails, syncZoom,
    obscured() {
      if (!active || !detailsOpen) return {};
      const v = viewport.getBoundingClientRect(), d = details.getBoundingClientRect();
      return matchMedia('(max-width: 600px)').matches
        ? {bottom: Math.max(0, v.bottom - d.top)}
        : {right: Math.max(0, v.right - d.left)};
    },
    get state() { return {fullscreen: active, detailsOpen}; },
  };
}
