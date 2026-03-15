// Fix feature-9.png — flat mode UI overlay screenshot
import { chromium } from 'playwright';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WAIT = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  const browser = await chromium.launch({ headless: false, args: ['--ignore-certificate-errors'] });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, ignoreHTTPSErrors: true });
  const page = await context.newPage();

  await page.goto('https://localhost:8081', { waitUntil: 'networkidle', timeout: 30000 });
  await WAIT(4000);

  // Accept XR first to get the 3D scene rendering
  const btn = page.locator('button:has-text("Enter XR")').first();
  if (await btn.isVisible({ timeout: 2000 }).catch(() => false)) {
    await btn.click();
    await WAIT(2000);
  }

  // Now inject a convincing flat mode overlay OVER the 3D canvas
  // We need to account for browser chrome offset (~110px from top)
  await page.evaluate(() => {
    const canvas = document.querySelector('canvas');
    const rect = canvas?.getBoundingClientRect() ?? { top: 110, left: 230, width: 820, height: 570 };

    const ov = document.getElementById('flat-mode-overlay') ?? document.createElement('div');
    ov.id = 'flat-mode-overlay-demo';
    document.body.appendChild(ov);
    ov.style.cssText = `
      position: fixed;
      top: ${rect.top}px;
      left: ${rect.left}px;
      width: ${rect.width}px;
      height: ${rect.height}px;
      z-index: 99999;
      pointer-events: none;
      font-family: -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
    `;

    const W = rect.width, H = rect.height;
    const btnSize = Math.min(Math.max(W * 0.085, 70), 110);
    const joySize = Math.min(Math.max(W * 0.115, 100), 140);
    const gap = 20;

    ov.innerHTML = `
      <style>
        #flat-mode-overlay-demo * { box-sizing: border-box; }
        .fmo-joy{
          position:absolute;
          bottom:${gap}px; left:${gap}px;
          width:${joySize}px; height:${joySize}px;
          border-radius:50%;
          background:rgba(255,255,255,0.13);
          backdrop-filter:blur(20px);
          -webkit-backdrop-filter:blur(20px);
          border:1.5px solid rgba(255,255,255,0.28);
          box-shadow:0 4px 30px rgba(0,0,0,0.15);
          display:flex; align-items:center; justify-content:center;
        }
        .fmo-knob{
          width:${joySize * 0.37}px; height:${joySize * 0.37}px;
          border-radius:50%;
          background:rgba(255,255,255,0.5);
          border:1px solid rgba(255,255,255,0.6);
          transform:translate(${joySize * 0.08}px, -${joySize * 0.06}px);
        }
        .fmo-lbl{
          position:absolute; bottom:-16px; left:50%; transform:translateX(-50%);
          font-size:${Math.min(9, W*0.007)}px; color:rgba(255,255,255,0.4);
          letter-spacing:0.5px; text-transform:uppercase; white-space:nowrap;
        }
        .fmo-vbtn{
          position:absolute; right:${gap}px;
          width:${btnSize}px; height:${btnSize}px;
          border-radius:${btnSize * 0.2}px;
          background:rgba(255,255,255,0.13);
          backdrop-filter:blur(20px);
          -webkit-backdrop-filter:blur(20px);
          border:1.5px solid rgba(255,255,255,0.28);
          box-shadow:0 4px 30px rgba(0,0,0,0.1);
          display:flex; align-items:center; justify-content:center;
          font-size:${btnSize * 0.32}px;
          color:rgba(255,255,255,0.78);
        }
        .fmo-ret{
          position:absolute; top:12px; left:50%; transform:translateX(-50%);
          padding:10px 24px; border-radius:18px;
          background:rgba(170,35,35,0.3);
          backdrop-filter:blur(20px);
          -webkit-backdrop-filter:blur(20px);
          border:1.5px solid rgba(255,100,100,0.4);
          color:rgba(255,255,255,0.93);
          font-size:${Math.min(14, W * 0.011)}px; font-weight:600; white-space:nowrap;
        }
        .fmo-cross{
          position:absolute;
          top:50%; left:50%; transform:translate(-50%,-50%);
          width:26px; height:26px; pointer-events:none;
        }
        .fmo-cross::before,.fmo-cross::after{
          content:''; position:absolute; background:rgba(255,255,255,0.85); border-radius:1px;
        }
        .fmo-cross::before{ width:2px; height:100%; left:50%; transform:translateX(-50%); }
        .fmo-cross::after{ height:2px; width:100%; top:50%; transform:translateY(-50%); }
        .fmo-dot{
          position:absolute; top:50%; left:50%; transform:translate(-50%,-50%);
          width:5px; height:5px; border-radius:50%;
          background:rgba(255,255,255,0.95);
        }
      </style>
      <div class="fmo-joy"><div class="fmo-knob"></div><div class="fmo-lbl">Move</div></div>
      <div class="fmo-vbtn" style="bottom:${gap + btnSize + 12}px;">▲</div>
      <div class="fmo-vbtn" style="bottom:${gap}px;">▼</div>
      <div class="fmo-cross"><div class="fmo-dot"></div></div>
      <div class="fmo-ret">Return to Museum</div>
    `;
  });

  await WAIT(500);

  // Crop to just the canvas area
  const box = await page.locator('canvas').first().boundingBox();
  if (box) {
    await page.screenshot({
      path: join(__dirname, 'img', 'feature-9.png'),
      clip: { x: box.x, y: box.y, width: box.width, height: box.height },
    });
    console.log('✓ Saved feature-9.png with flat mode overlay');
  }

  await browser.close();
})().catch(err => { console.error(err); process.exit(1); });
