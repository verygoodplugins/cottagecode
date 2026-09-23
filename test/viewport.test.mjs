import test from 'node:test';
import assert from 'node:assert/strict';
import {ZOOM_LEVELS, nextZoom, zoomKey, overviewZoom, viewportGeometry, worldPoint, screenPoint, scrollForPoint, createMapViewport} from '../src/viewport.mjs';

const base = {worldWidth:768, worldHeight:2000, width:1084, height:640, scale:1084/768};
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} != ${expected}`);

test('fullscreen changes the visible bounds without stretching the world', () => {
  const normal = viewportGeometry(base), full = viewportGeometry({...base, width:2077, height:1100});
  assert.equal(full.mapWidth, normal.mapWidth);
  assert.equal(full.mapHeight, normal.mapHeight);
  assert.equal(full.x, (2077 - 1084) / 2);
  assert.ok(full.height / full.scale > normal.height / normal.scale);
});

test('resizing and zooming preserve a world center away from the map edges', () => {
  const point = {x:384, y:900};
  for (const zoom of ZOOM_LEVELS) {
    const geometry = viewportGeometry({...base, width:900, height:480, scale:base.scale * zoom / 100});
    const scroll = scrollForPoint(point, geometry);
    const actual = worldPoint({x:450,y:240}, geometry, scroll);
    near(actual.x, point.x); near(actual.y, point.y);
  }
});

test('centering a smaller world introduces margins, not negative scroll positions', () => {
  const geometry = viewportGeometry({...base, worldHeight:300, scale:.5});
  assert.equal(geometry.contentWidth, base.width);
  assert.equal(geometry.contentHeight, base.height);
  assert.deepEqual(scrollForPoint({x:0,y:0}, geometry), {left:0,top:0});
  assert.deepEqual(screenPoint({x:384,y:150}, geometry), {x:542,y:320});
});

test('camera clamping keeps the viewport within its scrollable content', () => {
  const geometry = viewportGeometry({...base, scale:2});
  assert.deepEqual(scrollForPoint({x:-200,y:-500}, geometry), {left:0,top:0});
  assert.deepEqual(scrollForPoint({x:5000,y:5000}, geometry), {
    left:geometry.contentWidth-geometry.width, top:geometry.contentHeight-geometry.height});
});

test('coordinate conversion round trips with scroll, centering, and fractional zoom', () => {
  const geometry = viewportGeometry({...base, width:1500, scale:.875});
  const scroll = {left:0,top:437.5}, point = {x:677.25,y:911.5};
  const actual = worldPoint(screenPoint(point, geometry, scroll), geometry, scroll);
  near(actual.x, point.x); near(actual.y, point.y);
});

test('overlay gutters let edge targets scroll out from under the panel without moving the map', () => {
  const normal = viewportGeometry({...base, scale:2});
  for (const obstruction of [{right:352}, {bottom:260}]) {
    const geometry = viewportGeometry({...base, scale:2, ...obstruction});
    assert.equal(geometry.x, normal.x); assert.equal(geometry.y, normal.y);
    assert.equal(geometry.mapWidth, normal.mapWidth);
    const point = {x:760,y:1992};
    const target = {x:(geometry.width-geometry.right)/2,y:(geometry.height-geometry.bottom)/2};
    const p = screenPoint(point, geometry, scrollForPoint(point, geometry, target));
    assert.ok(p.x <= geometry.width-geometry.right);
    assert.ok(p.y <= geometry.height-geometry.bottom);
  }
});

test('zoom steps stop at the limits and include the default scale', () => {
  assert.equal(nextZoom(50,-1),50); assert.equal(nextZoom(200,1),200);
  assert.equal(nextZoom(100,-1),75); assert.equal(nextZoom(100,1),125);
  assert.equal(nextZoom(125,-1),100);
});

test('map zoom shortcuts leave typing, browser zoom, composition, and held keys alone', () => {
  for (const key of ['+','=']) assert.equal(zoomKey({key}), 'in');
  assert.equal(zoomKey({key:'-'}),'out'); assert.equal(zoomKey({key:'0'}),'reset');
  assert.equal(zoomKey({key:'f'}),null);
  for (const modifier of ['ctrlKey','metaKey','altKey','isComposing','repeat']) assert.equal(zoomKey({key:'+', [modifier]:true}),null);
  assert.equal(zoomKey({key:'-',target:{closest:()=>({})}}),null);
});

test('camera retains its initial scale through delayed feeds, room visits, and world growth', t => {
  const original = globalThis.ResizeObserver;
  globalThis.ResizeObserver = class {observe() {}};
  t.after(() => {if(original)globalThis.ResizeObserver=original;else delete globalThis.ResizeObserver;});
  const viewport = {clientWidth:1084, clientHeight:640, scrollLeft:0, scrollTop:0,
    classList:{toggle(){}}, scrollTo({left=0,top=0}) {this.scrollLeft=left;this.scrollTop=top;}};
  const camera = createMapViewport({viewport,surface:{style:{}},canvas:{style:{}}});
  viewport.clientWidth=2077;viewport.clientHeight=1100; // Fullscreen before the first snapshot arrives.
  camera.setWorld(768,2400);
  near(camera.state.scale,1084/768);
  viewport.scrollTop=900;
  const center=camera.state.center;
  camera.setZoom(150);
  near(camera.state.center.x,center.x);near(camera.state.center.y,center.y);
  camera.setIndoors(true);
  camera.setZoom(200); // Hidden map controls cannot change the saved outdoor view.
  assert.equal(camera.state.zoom,150);
  viewport.clientHeight=700;
  camera.setWorld(768,3200);
  camera.setIndoors(false);
  near(camera.state.center.x,center.x);near(camera.state.center.y,center.y);
  near(camera.state.scale,1084/768*1.5);
  camera.setWorld(768,3600);
  near(camera.state.center.y,center.y);
});

test('Overview fits active bounds around desktop and mobile details within the zoom limits', () => {
  const bounds={x:0,y:0,w:1000,h:500};
  assert.equal(overviewZoom(bounds,{width:1100,height:700,baseScale:1}),100);
  assert.equal(overviewZoom(bounds,{width:1100,height:700,right:352,baseScale:1}),50);
  assert.equal(overviewZoom(bounds,{width:1100,height:700,bottom:300,baseScale:1}),50);
  assert.equal(overviewZoom(bounds,{width:850,height:600,baseScale:1}),75);
  assert.equal(overviewZoom(bounds,{width:300,height:200,baseScale:2}),50);
});

test('a wider packed world retains the reference cottage scale; Overview is explicit', t => {
  const original=globalThis.ResizeObserver;
  globalThis.ResizeObserver=class{observe(){}};
  t.after(()=>{if(original)globalThis.ResizeObserver=original;else delete globalThis.ResizeObserver;});
  const viewport={clientWidth:768,clientHeight:600,scrollLeft:0,scrollTop:0,classList:{toggle(){}},
    scrollTo({left=0,top=0}){this.scrollLeft=left;this.scrollTop=top;}};
  const camera=createMapViewport({viewport,surface:{style:{}},canvas:{style:{}},referenceWidth:768,getObscured:()=>({right:352})});
  camera.setWorld(1500,1200);near(camera.state.scale,1);
  viewport.clientWidth=1500;camera.resize();near(camera.state.scale,1);
  const result=camera.overview({x:100,y:100,w:1200,h:500});
  assert.equal(result.zoom,75);assert.equal(result.allVisible,true);
  camera.setWorld(1700,1600);near(camera.state.scale,.75);
  camera.setIndoors(true);assert.equal(camera.overview({x:0,y:0,w:50,h:50}),null);
});
