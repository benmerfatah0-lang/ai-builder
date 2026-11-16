import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { GameMap } from './GameMap';

/**
 * Standalone entry point for the game map. It is intentionally separate from
 * the world-builder SPA: the map is a design deliverable that can be opened at
 * `/game-map.html` without touching the editor's route or state.
 */
const container = document.getElementById('root');
if (!container) throw new Error('Missing #root element');

createRoot(container).render(
  <StrictMode>
    <GameMap />
  </StrictMode>,
);
