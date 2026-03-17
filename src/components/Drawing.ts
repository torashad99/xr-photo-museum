import * as THREE from 'three';
import { World, Entity, createComponent, Types } from '@iwsdk/core';

export const DrawingStroke = createComponent('DrawingStroke', {
    color: { type: Types.String, default: 'black' },
});

// Track all stroke lines for hide/show
const strokeLines: Set<THREE.Line> = new Set();

export function startStroke(world: World, color: string = 'black', startPoint: THREE.Vector3, context: 'museum' | 'splat' = 'museum'): { entity: Entity, line: THREE.Line, points: THREE.Vector3[] } {
    // Create geometry with initial capacity
    const MAX_POINTS = 3000;
    const geometry = new THREE.BufferGeometry();
    const positions = new Float32Array(MAX_POINTS * 3);
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));

    // Initialize with start point
    positions[0] = startPoint.x;
    positions[1] = startPoint.y;
    positions[2] = startPoint.z;
    positions[3] = startPoint.x; // Duplicate start point to make line visible even with 1 point? 
    // Actually line needs 2 points to render segments. 
    // We'll just set draw range to 1 initially (0 to 1 means 1 point, so nothing renders until 2nd point)

    geometry.setDrawRange(0, 1);

    const material = new THREE.LineBasicMaterial({
        color: color,
        linewidth: 3, // Note: linewidth is generally ignored by WebGL renderers on Windows/Linux
    });

    const line = new THREE.Line(geometry, material);
    line.frustumCulled = false; // Prevent culling issues as bounds change

    const entity = world.createTransformEntity(line);
    entity.addComponent(DrawingStroke, {
        color: color,
    });

    line.userData.context = context;
    strokeLines.add(line);

    const points = [startPoint.clone()];

    return { entity, line, points };
}

export function addPointToStroke(line: THREE.Line, point: THREE.Vector3, pointsCache: THREE.Vector3[]) {
    const positions = line.geometry.attributes.position.array as Float32Array;
    const index = pointsCache.length;

    if (index >= positions.length / 3) {
        // Buffer full (could resize, but for now just stop adding)
        return;
    }

    positions[index * 3] = point.x;
    positions[index * 3 + 1] = point.y;
    positions[index * 3 + 2] = point.z;

    pointsCache.push(point.clone());

    line.geometry.setDrawRange(0, pointsCache.length);
    line.geometry.attributes.position.needsUpdate = true;
    line.geometry.computeBoundingSphere();
}

export function hideAllDrawings(): void {
    for (const line of strokeLines) {
        if (line.parent) line.visible = false;
    }
}

export function showAllDrawings(): void {
    for (const line of strokeLines) {
        if (line.parent) line.visible = true;
    }
}

export function showDrawingsInContext(context: 'museum' | 'splat'): void {
    for (const line of strokeLines) {
        if (line.parent) line.visible = line.userData.context === context;
    }
}
