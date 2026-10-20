// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

/**
 * Guards the gizmo API surface the viewport relies on (mode, space, snapping,
 * attach/detach and helper object). Rendering itself needs a real GPU.
 */
describe('TransformControls integration surface', () => {
  it('configures modes, spaces, snapping and attachment', () => {
    const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 1000);
    const element = document.createElement('div');
    document.body.appendChild(element);

    const controls = new TransformControls(camera, element);
    const helper = controls.getHelper();
    expect(helper).toBeInstanceOf(THREE.Object3D);

    controls.setMode('translate');
    controls.setSpace('world');
    controls.translationSnap = 0.5;
    expect(controls.mode).toBe('translate');
    expect(controls.space).toBe('world');
    expect(controls.translationSnap).toBe(0.5);

    const object = new THREE.Group();
    controls.attach(object);
    expect(controls.object).toBe(object);

    // The viewport disables orbit while dragging; verify the event contract.
    let draggingEvents = 0;
    controls.addEventListener('dragging-changed', () => {
      draggingEvents += 1;
    });
    controls.dispatchEvent({ type: 'dragging-changed', value: true });
    expect(draggingEvents).toBe(1);

    controls.setMode('rotate');
    controls.rotationSnap = THREE.MathUtils.degToRad(15);
    expect(controls.mode).toBe('rotate');

    // Axis constraints (X/Y/Z shortcuts + toolbar) hide individual handles.
    controls.showX = false;
    controls.showY = true;
    controls.showZ = false;
    expect(controls.showX).toBe(false);
    expect(controls.showY).toBe(true);

    controls.detach();
    expect(controls.object).toBeUndefined();

    controls.dispose();
    element.remove();
  });

  it('configures orbit controls for touch', () => {
    const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 1000);
    const element = document.createElement('div');
    document.body.appendChild(element);

    const controls = new OrbitControls(camera, element);
    controls.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN };
    controls.enableDamping = true;
    controls.maxPolarAngle = Math.PI * 0.495;
    expect(controls.touches.ONE).toBe(THREE.TOUCH.ROTATE);
    expect(controls.touches.TWO).toBe(THREE.TOUCH.DOLLY_PAN);
    controls.dispose();
    element.remove();
  });
});
