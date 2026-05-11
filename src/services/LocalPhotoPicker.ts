// src/services/LocalPhotoPicker.ts
// Triggers the device-native file picker (shows gallery on Quest Browser, iOS, Android).
// Returns an object URL for the chosen file, or null if cancelled.

export interface LocalPhotoResult {
  photoUrl: string;   // blob: object URL (valid only in this tab)
  photoId: string;    // 'local_<uuid>'
  photoName: string;  // original filename
}

// iOS Safari silently blocks programmatic input.click() unless it originates from
// a direct user-gesture call stack (touchend/click handler). When called from
// requestAnimationFrame (as in flat-mode raycast press detection), the file picker
// simply won't open. To handle this, we provide two paths:
//   1. pickLocalPhoto() — attempts programmatic click (works on Android/desktop/Quest)
//   2. pickLocalPhotoViaOverlay() — shows a DOM overlay button the user taps directly
//      (reliable on all platforms including iOS Safari)

export function pickLocalPhoto(): Promise<LocalPhotoResult | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.style.position = 'fixed';
    input.style.top = '-9999px';
    input.style.left = '-9999px';
    input.style.opacity = '0';
    document.body.appendChild(input);
    input.value = '';

    let resolved = false;
    function finish(result: LocalPhotoResult | null) {
      if (resolved) return;
      resolved = true;
      cleanup();
      resolve(result);
    }

    function onChangeHandler() {
      const file = input.files?.[0] ?? null;
      if (!file) { finish(null); return; }
      const photoUrl = URL.createObjectURL(file);
      const photoId = 'local_' + crypto.randomUUID();
      finish({ photoUrl, photoId, photoName: file.name });
    }

    function onVisibilityChange() {
      if (document.visibilityState === 'visible') {
        setTimeout(() => { if (!resolved) finish(null); }, 1000);
      }
    }

    function cleanup() {
      input.removeEventListener('change', onChangeHandler);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      if (input.isConnected) document.body.removeChild(input);
    }

    input.addEventListener('change', onChangeHandler);
    document.addEventListener('visibilitychange', onVisibilityChange);

    input.click();
  });
}

/**
 * iOS-safe variant: shows a full-screen transparent overlay with a visible tap target.
 * The user's direct tap on the overlay triggers the file input from within a real
 * user-gesture call stack, which iOS Safari requires.
 */
export function pickLocalPhotoViaOverlay(): Promise<LocalPhotoResult | null> {
  return new Promise((resolve) => {
    let resolved = false;

    const overlay = document.createElement('div');
    overlay.style.cssText = `
      position: fixed; inset: 0; z-index: 99999;
      display: flex; align-items: center; justify-content: center;
      background: rgba(0,0,0,0.6);
      touch-action: none;
    `;

    const btn = document.createElement('button');
    btn.textContent = 'Tap to open photos';
    btn.style.cssText = `
      padding: 20px 40px; font-size: 20px; font-weight: bold;
      border-radius: 12px; border: none;
      background: #ffffff; color: #111111;
      cursor: pointer;
    `;
    overlay.appendChild(btn);

    const cancelBtn = document.createElement('button');
    cancelBtn.textContent = 'Cancel';
    cancelBtn.style.cssText = `
      position: absolute; bottom: 60px; left: 50%;
      transform: translateX(-50%);
      padding: 12px 32px; font-size: 16px;
      border-radius: 8px; border: 2px solid #ffffff;
      background: transparent; color: #ffffff;
      cursor: pointer;
    `;
    overlay.appendChild(cancelBtn);

    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.style.display = 'none';
    overlay.appendChild(input);

    document.body.appendChild(overlay);

    function finish(result: LocalPhotoResult | null) {
      if (resolved) return;
      resolved = true;
      if (overlay.isConnected) document.body.removeChild(overlay);
      resolve(result);
    }

    input.addEventListener('change', () => {
      const file = input.files?.[0] ?? null;
      if (!file) { finish(null); return; }
      const photoUrl = URL.createObjectURL(file);
      const photoId = 'local_' + crypto.randomUUID();
      finish({ photoUrl, photoId, photoName: file.name });
    });

    btn.addEventListener('click', () => {
      input.click();
      // If no file is chosen, cancel after returning to page
      document.addEventListener('visibilitychange', function vc() {
        if (document.visibilityState === 'visible') {
          document.removeEventListener('visibilitychange', vc);
          setTimeout(() => { if (!resolved) finish(null); }, 1000);
        }
      });
    });

    cancelBtn.addEventListener('click', () => finish(null));
  });
}

const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

/** Auto-selects the right picker strategy based on platform */
export function pickLocalPhotoAuto(): Promise<LocalPhotoResult | null> {
  return isIOS ? pickLocalPhotoViaOverlay() : pickLocalPhoto();
}
