// src/services/LocalPhotoPicker.ts
// Triggers the device-native file picker (shows gallery on Quest Browser, iOS, Android).
// Returns an object URL for the chosen file, or null if cancelled.
// NOTE: In v1 this is intended for flat (non-XR) mode. Calling from inside an
// active XR session may suspend the XR session; XR-resume flow is planned for
// a later commit.

export interface LocalPhotoResult {
  photoUrl: string;   // blob: object URL (valid only in this tab)
  photoId: string;    // 'local_<uuid>'
  photoName: string;  // original filename
}

export async function pickLocalPhoto(): Promise<LocalPhotoResult | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.style.display = 'none';
    document.body.appendChild(input);

    input.onchange = () => {
      const file = input.files?.[0] ?? null;
      document.body.removeChild(input);
      if (!file) {
        resolve(null);
        return;
      }
      const photoUrl = URL.createObjectURL(file);
      const photoId = 'local_' + crypto.randomUUID();
      resolve({ photoUrl, photoId, photoName: file.name });
    };

    // Handle cancel: if focus returns to the window without a file being chosen
    window.addEventListener(
      'focus',
      () => {
        setTimeout(() => {
          if (!input.files?.length) {
            document.body.removeChild(input);
            resolve(null);
          }
        }, 300);
      },
      { once: true },
    );

    input.click();
  });
}
