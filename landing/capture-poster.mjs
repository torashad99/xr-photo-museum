import playwright from 'playwright';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

(async () => {
  const browser = await playwright.chromium.launch({ headless: true });
  const page = await browser.newPage();

  // Set viewport to 4K width (3840px) with very tall height to capture full features section
  await page.setViewportSize({ width: 3840, height: 8000 });

  // Navigate to landing page
  await page.goto('https://localhost:8081/landing/', { waitUntil: 'networkidle' });

  // Wait for videos to load
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(2000);

  // Scroll to features section
  await page.evaluate(() => {
    const featuresSection = document.querySelector('#features');
    if (featuresSection) {
      featuresSection.scrollIntoView({ behavior: 'instant' });
    }
  });

  await page.waitForTimeout(1000);

  // Get the features section bounds (use scrollHeight for accurate full height)
  const featuresBounds = await page.evaluate(() => {
    const header = document.querySelector('.section-header');
    const grid = document.querySelector('.features-grid');
    if (!header || !grid) return null;

    const headerRect = header.getBoundingClientRect();
    const gridHeight = grid.scrollHeight;
    const headerHeight = header.scrollHeight;

    return {
      x: 0,
      y: headerRect.top,
      width: window.innerWidth,
      height: headerHeight + gridHeight,
    };
  });

  if (!featuresBounds) {
    console.error('Could not find features section');
    await browser.close();
    process.exit(1);
  }

  console.log('Capturing features section:', featuresBounds);

  // Take screenshot of features section
  const screenshotPath = path.join(__dirname, 'features-poster.jpg');
  await page.screenshot({
    path: screenshotPath,
    clip: featuresBounds,
    type: 'jpeg',
    quality: 95,
  });

  console.log(`✅ Poster saved: ${screenshotPath}`);
  console.log(`📐 Resolution: ${featuresBounds.width}x${Math.round(featuresBounds.height)}`);

  await browser.close();
})().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
