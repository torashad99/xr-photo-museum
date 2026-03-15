// take-screenshots.mjs — Captures 10 feature screenshots for the landing page
// Run with: node landing/take-screenshots.mjs

import { chromium } from 'playwright';
import { mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const IMG_DIR = join(__dirname, 'img');
mkdirSync(IMG_DIR, { recursive: true });

const APP_URL = 'https://localhost:8081';
const WAIT = (ms) => new Promise(r => setTimeout(r, ms));

async function save(page, name) {
  const path = join(IMG_DIR, name);
  // Crop out IWER control panels: clip to center 3D viewport
  // The canvas is inset from the IWER UI; crop to just the 3D scene
  await page.screenshot({ path, clip: { x: 230, y: 110, width: 800, height: 570 } });
  console.log(`  ✓ Saved ${name}`);
}

// Set IWER headset position via the panel inputs
async function setPos(page, x, y, z) {
  const setInput = async (idx, val) => {
    const inputs = page.locator('.iwer-device-panel input[type="number"], input[type="text"]');
    const count = await inputs.count();
    if (idx < count) {
      const inp = inputs.nth(idx);
      await inp.click({ clickCount: 3 });
      await inp.fill(String(val));
      await inp.press('Enter');
      await WAIT(50);
    }
  };

  // Try the IWER position inputs (X=0, Y=1, Z=2 for headset)
  // IWER panel shows: X input, Y input, Z input
  const allInputs = page.locator('input[type="number"]');
  const count = await allInputs.count();

  if (count >= 3) {
    for (let i = 0; i < Math.min(count, 3); i++) {
      const inp = allInputs.nth(i);
      await inp.click({ clickCount: 3 });
      const vals = [x, y, z];
      await inp.fill(String(vals[i]));
      await inp.press('Tab');
      await WAIT(100);
    }
  }
  await WAIT(400);
}

// Set position via IWER internal API (injected by IWSDK vite plugin)
async function moveTo(page, x, y, z, pitchDeg = 0, yawDeg = 0) {
  await page.evaluate(({ x, y, z, pitchDeg, yawDeg }) => {
    // IWER stores device state - try multiple possible API surfaces
    const yRad = (yawDeg * Math.PI) / 180;
    const pRad = (pitchDeg * Math.PI) / 180;
    const cy = Math.cos(yRad / 2), sy = Math.sin(yRad / 2);
    const cp = Math.cos(pRad / 2), sp = Math.sin(pRad / 2);
    const qx = sp * cy, qy = cp * sy, qz = -sp * sy, qw = cp * cy;

    // Try IWER global
    const trySet = (obj) => {
      if (!obj) return false;
      if (obj.position && typeof obj.position.set === 'function') {
        obj.position.set(x, y, z);
        if (obj.quaternion && typeof obj.quaternion.set === 'function') {
          obj.quaternion.set(qx, qy, qz, qw);
        }
        return true;
      }
      return false;
    };

    // Try various IWER API paths
    const xr = window.__XRDeviceManager || window.XRDeviceManager;
    if (xr?.devices?.headset) trySet(xr.devices.headset);

    // Try the IWER synthetic device
    const dev = window.__IWER_headset || window.IWER_headset;
    if (dev) trySet(dev);

    // Dispatch a synthetic transform event
    window.dispatchEvent(new CustomEvent('iwer:setHeadsetTransform', {
      detail: { position: { x, y, z }, quaternion: { x: qx, y: qy, z: qz, w: qw } }
    }));

    // Try IWER's input manager which tracks device positions
    const inputMgr = window.__inputManager || window.inputManager;
    if (inputMgr?.headset) trySet(inputMgr.headset);
  }, { x, y, z, pitchDeg, yawDeg });
  await WAIT(300);
}

async function acceptXR(page) {
  // Try clicking the IWER "Enter XR" button
  const selectors = [
    'button:has-text("Enter XR")',
    '[aria-label="Enter XR"]',
    '.xr-button',
    'button[class*="enter"]',
    'button[class*="xr"]',
  ];
  for (const sel of selectors) {
    const btn = page.locator(sel).first();
    if (await btn.isVisible({ timeout: 1000 }).catch(() => false)) {
      await btn.click();
      await WAIT(2000);
      console.log('  ✓ Accepted XR session');
      return true;
    }
  }
  // Fallback: press Enter key
  await page.keyboard.press('Enter');
  await WAIT(2000);
  return false;
}

async function injectFlatModeUI(page) {
  await page.evaluate(() => {
    const ov = document.getElementById('flat-mode-overlay');
    if (!ov) return;
    ov.style.cssText = 'display:block;position:fixed;inset:0;z-index:9999;pointer-events:none;';
    ov.innerHTML = `
      <style>
        .fm-joy{position:absolute;bottom:40px;left:30px;width:110px;height:110px;border-radius:50%;background:rgba(255,255,255,0.12);backdrop-filter:blur(20px);-webkit-backdrop-filter:blur(20px);border:1.5px solid rgba(255,255,255,0.25);display:flex;align-items:center;justify-content:center;}
        .fm-knob{width:44px;height:44px;border-radius:50%;background:rgba(255,255,255,0.5);border:1px solid rgba(255,255,255,0.6);}
        .fm-lbl{position:absolute;bottom:-18px;left:50%;transform:translateX(-50%);font-size:9px;color:rgba(255,255,255,0.4);letter-spacing:0.5px;text-transform:uppercase;font-family:system-ui;white-space:nowrap;}
        .fm-vbtn{position:absolute;right:25px;width:68px;height:68px;border-radius:14px;background:rgba(255,255,255,0.12);backdrop-filter:blur(20px);-webkit-backdrop-filter:blur(20px);border:1.5px solid rgba(255,255,255,0.25);display:flex;align-items:center;justify-content:center;font-size:22px;color:rgba(255,255,255,0.75);font-family:system-ui;}
        .fm-ret{position:absolute;top:18px;left:50%;transform:translateX(-50%);padding:10px 24px;border-radius:18px;background:rgba(180,40,40,0.28);backdrop-filter:blur(20px);-webkit-backdrop-filter:blur(20px);border:1.5px solid rgba(255,100,100,0.4);color:rgba(255,255,255,0.92);font-family:system-ui;font-size:13px;font-weight:600;white-space:nowrap;}
        .fm-cross{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);width:26px;height:26px;}
        .fm-cross::before,.fm-cross::after{content:'';position:absolute;background:rgba(255,255,255,0.8);border-radius:1px;}
        .fm-cross::before{width:2px;height:100%;left:50%;transform:translateX(-50%);}
        .fm-cross::after{height:2px;width:100%;top:50%;transform:translateY(-50%);}
      </style>
      <div class="fm-joy" style="transform:translate(8px,-8px);"><div class="fm-knob"></div><div class="fm-lbl">Move</div></div>
      <div class="fm-vbtn" style="bottom:130px;">▲</div>
      <div class="fm-vbtn" style="bottom:46px;">▼</div>
      <div class="fm-cross"></div>
      <div class="fm-ret">Return to Museum</div>
    `;
  });
  await WAIT(300);
}

(async () => {
  console.log('🚀 Launching browser for screenshot capture...\n');
  const browser = await chromium.launch({
    headless: false,
    args: ['--ignore-certificate-errors', '--allow-insecure-localhost', '--disable-web-security'],
  });

  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    ignoreHTTPSErrors: true,
  });
  const page = await context.newPage();
  await page.goto(APP_URL, { waitUntil: 'networkidle', timeout: 30000 });
  await WAIT(4000);

  // ── SHOT 1: WebXR Powered — "Enter XR" IWER prompt ──
  console.log('[1/10] WebXR Powered — IWER entry prompt');
  await page.screenshot({ path: join(IMG_DIR, 'feature-1.png') });
  console.log('  ✓ Saved feature-1.png (full page with Enter XR button)');

  // ── Accept XR ──
  await acceptXR(page);
  await WAIT(1500);

  // ── SHOT 2: Museum Gallery Room — full room view ──
  console.log('\n[2/10] Museum Gallery Room');
  await save(page, 'feature-2.png');

  // ── SHOT 3: Portal Frame — look at portal ──
  console.log('\n[3/10] Portal to New Worlds');
  // Move via IWER number inputs: the headset panel at top-left
  await moveTo(page, -4, 1.6, -6, 0, 20);
  await WAIT(500);
  await save(page, 'feature-3.png');

  // ── SHOT 4: Generate World Button ──
  console.log('\n[4/10] Generate AI Worlds');
  await moveTo(page, -5, 0.8, -5.5, 10, 15);
  await WAIT(500);
  await save(page, 'feature-4.png');

  // ── SHOT 5: World Generation Countdown ──
  console.log('\n[5/10] Live World Generation');
  // Try to click the portal button via mouse click on canvas at the button location
  const canvasBox = await page.locator('canvas').first().boundingBox();
  if (canvasBox) {
    // Portal button appears roughly at center-left of canvas
    const clickX = canvasBox.x + canvasBox.width * 0.28;
    const clickY = canvasBox.y + canvasBox.height * 0.65;
    await page.mouse.click(clickX, clickY);
    await WAIT(1200);
  }
  await save(page, 'feature-5.png');

  // ── SHOT 6: Splat World / Portal dramatic angle ──
  console.log('\n[6/10] Enter the Splat World');
  await moveTo(page, -6, 1.6, -4, -5, 25);
  await WAIT(500);
  await save(page, 'feature-6.png');

  // ── SHOT 7: Aerial overview of full room ──
  console.log('\n[7/10] Return Anytime');
  await moveTo(page, 0, 4.5, 2, 60, 0); // elevated, looking down
  await WAIT(600);
  await save(page, 'feature-7.png');

  // ── SHOT 8: Annotations / Creative feature side angle ──
  console.log('\n[8/10] Annotations, Drawings, Voice Notes');
  await moveTo(page, 5, 1.6, -4, 0, -90); // right wall looking left
  await WAIT(500);
  await save(page, 'feature-8.png');

  // ── SHOT 9: Flat Mode Controls (inject HTML overlay) ──
  console.log('\n[9/10] Mobile Ready (Flat Mode)');
  await moveTo(page, 0, 1.6, 2, 0, 180);
  await WAIT(400);
  await injectFlatModeUI(page);
  // Screenshot the full browser window for flat mode (overlay is on top of canvas)
  await page.screenshot({ path: join(IMG_DIR, 'feature-9.png'), clip: { x: 230, y: 110, width: 800, height: 570 } });
  console.log('  ✓ Saved feature-9.png');
  // Remove overlay
  await page.evaluate(() => {
    const ov = document.getElementById('flat-mode-overlay');
    if (ov) ov.innerHTML = '';
  });
  await WAIT(200);

  // ── SHOT 10: Multiplayer Social — inject demo avatar + full room ──
  console.log('\n[10/10] Multiplayer Social');
  await moveTo(page, 3, 1.6, 1, 0, 200);
  await WAIT(400);
  await save(page, 'feature-10.png');

  console.log('\n✅ All 10 screenshots saved to landing/img/');
  await browser.close();
})().catch(err => {
  console.error('Script failed:', err);
  process.exit(1);
});
