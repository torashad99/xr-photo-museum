// src/services/photosService.ts
export interface MediaItem {
  id: string;
  baseUrl: string;
  filename: string;
  mimeType: string;
  mediaMetadata: {
    width: string;
    height: string;
    creationTime: string;
  };
}

export class GooglePhotosService {
  private accessToken: string;

  constructor(accessToken: string) {
    this.accessToken = accessToken;
  }

  async listMediaItems(pageSize: number = 50): Promise<MediaItem[]> {
    const response = await fetch(
      `https://photoslibrary.googleapis.com/v1/mediaItems?pageSize=${pageSize}`,
      {
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
        },
      }
    );

    const data = await response.json();
    return data.mediaItems || [];
  }

  async listAlbums(): Promise<any[]> {
    const response = await fetch(
      'https://photoslibrary.googleapis.com/v1/albums',
      {
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
        },
      }
    );

    const data = await response.json();
    return data.albums || [];
  }

  // Get full-resolution image URL
  getImageUrl(baseUrl: string, width: number, height: number): string {
    return `${baseUrl}=w${width}-h${height}`;
  }
}