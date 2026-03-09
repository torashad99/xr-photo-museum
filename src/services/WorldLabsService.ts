// src/services/WorldLabsService.ts

export interface SplatResult {
  worldId: string;
  spzUrl: string;
  colliderMeshUrl?: string;
  fromCache: boolean;
}

export interface GenerateResponse {
  operationId: string;
  startedAt: number;
  estimatedDurationMs: number;
}

export class WorldLabsService {
  private pollIntervalMs = 3000;

  /** Check if a splat is already cached on the server (no generation triggered). */
  async checkCache(imageUrl: string): Promise<SplatResult | null> {
    const res = await fetch('/api/worldlabs/check-cache', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ imageUrl }),
    });

    if (!res.ok) return null;

    const data = await res.json();
    if (data.cached) {
      return {
        worldId: data.worldId,
        spzUrl: data.spzUrl,
        colliderMeshUrl: data.colliderMeshUrl,
        fromCache: true,
      };
    }
    return null;
  }

  /** Start generation and return the operation ID + timing info. */
  async startGeneration(imageUrl: string, name: string): Promise<GenerateResponse | SplatResult> {
    const res = await fetch('/api/worldlabs/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ imageUrl, name }),
    });

    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || 'Failed to start generation');
    }

    const data = await res.json();

    // Server returned a cached result directly
    if (data.status === 'done') {
      return {
        worldId: data.worldId,
        spzUrl: data.spzUrl,
        colliderMeshUrl: data.colliderMeshUrl,
        fromCache: !!data.fromCache,
      } as SplatResult;
    }

    return {
      operationId: data.operationId,
      startedAt: data.startedAt,
      estimatedDurationMs: data.estimatedDurationMs,
    };
  }

  /** Poll until generation is complete. Calls onStatus with progress updates. */
  async pollUntilDone(
    operationId: string,
    imageUrl: string,
    onStatus?: (status: string) => void,
  ): Promise<SplatResult> {
    while (true) {
      await new Promise(resolve => setTimeout(resolve, this.pollIntervalMs));

      const res = await fetch(`/api/worldlabs/status/${operationId}`);
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Failed to poll status');
      }

      const data = await res.json();

      if (data.status === 'done') {
        // Cache the result on the server keyed by imageUrl
        await fetch('/api/worldlabs/cache', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            imageUrl,
            result: { worldId: data.worldId, spzUrl: data.spzUrl, colliderMeshUrl: data.colliderMeshUrl },
          }),
        });

        return {
          worldId: data.worldId,
          spzUrl: data.spzUrl,
          colliderMeshUrl: data.colliderMeshUrl,
          fromCache: false,
        };
      }

      if (onStatus) {
        onStatus(data.progress ? `Generating... ${data.progress}` : 'Generating...');
      }
    }
  }
}
