// @vitest-environment happy-dom
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DesignSheet } from './DesignSheet';
import { PaperMapView } from './PaperMapView';
import { BOSSES, REGIONS } from '../data';
import { PAPER_MAP_SVG } from './paperMap.svg';

/**
 * DOM-level smoke tests for the two WebGL-free map views. These run in
 * happy-dom and assert that the map's content is actually readable when the
 * 3D scene cannot render.
 */

afterEach(() => cleanup());

describe('DesignSheet', () => {
  it('renders the three core regions and all five bosses', () => {
    render(<DesignSheet />);
    for (const region of REGIONS) {
      expect(screen.getAllByText(region.name).length).toBeGreaterThan(0);
    }
    for (const boss of BOSSES) {
      expect(screen.getAllByText(boss.name).length).toBeGreaterThan(0);
      expect(screen.getAllByText(new RegExp(boss.epithet)).length).toBeGreaterThan(0);
    }
    expect(screen.getByText(/خط سير زعتر/)).toBeTruthy();
    expect(screen.getByText(/أرقام التوازن/)).toBeTruthy();
  });
});

describe('PaperMapView', () => {
  it('renders the generated SVG map and region index', () => {
    const onRegionSelect = vi.fn();
    const onBossSelect = vi.fn();
    const { container } = render(
      <PaperMapView
        selectedRegion="farm"
        onRegionSelect={onRegionSelect}
        onBossSelect={onBossSelect}
        onOpen3D={() => {}}
      />,
    );
    // happy-dom does not fully parse inline SVG markup, so check the generated
    // art at the source and the interactive index through the DOM.
    expect(PAPER_MAP_SVG).toContain('<svg');
    expect(PAPER_MAP_SVG.length).toBeGreaterThan(40000);
    expect(PAPER_MAP_SVG).toContain('class="region-chip"');
    expect(PAPER_MAP_SVG).toContain('مفتاح الخريطة');
    for (const boss of BOSSES) {
      expect(PAPER_MAP_SVG).toContain(boss.name);
    }
    expect(container.querySelector('.paper-view-side')).toBeTruthy();

    fireEvent.click(screen.getByText('منطقة الحظائر'));
    expect(onRegionSelect).toHaveBeenCalledWith('pens');

    fireEvent.click(screen.getAllByText('غُبار')[0]!);
    expect(onBossSelect).toHaveBeenCalledWith('grobak');
  });
});
