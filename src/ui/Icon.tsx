import type { ReactNode } from 'react';

export type IconName =
  | 'cube'
  | 'plus'
  | 'trash'
  | 'eye'
  | 'eyeOff'
  | 'lock'
  | 'unlock'
  | 'undo'
  | 'redo'
  | 'download'
  | 'upload'
  | 'chevronDown'
  | 'close'
  | 'sparkles'
  | 'tree'
  | 'mountain'
  | 'copy'
  | 'folder'
  | 'search'
  | 'check'
  | 'alert'
  | 'layers'
  | 'info'
  | 'frame'
  | 'menu'
  | 'sun'
  | 'sliders'
  | 'move'
  | 'rotate'
  | 'scale'
  | 'magnet'
  | 'grid'
  | 'save'
  | 'camera';

const PATHS: Record<IconName, ReactNode> = {
  cube: (
    <>
      <path d="M12 2.8 21 7.4v9.2l-9 4.6-9-4.6V7.4l9-4.6Z" />
      <path d="m3.3 7.6 8.7 4.5 8.7-4.5M12 12.1v8.6" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
  trash: (
    <>
      <path d="M4 7h16M9.5 7V4.8h5V7M6.5 7l.9 13h9.2l.9-13" />
      <path d="M10.2 11v5.4M13.8 11v5.4" />
    </>
  ),
  eye: (
    <>
      <path d="M2.5 12S6 5.8 12 5.8 21.5 12 21.5 12 18 18.2 12 18.2 2.5 12 2.5 12Z" />
      <circle cx="12" cy="12" r="2.8" />
    </>
  ),
  eyeOff: (
    <>
      <path d="M4 4.5 20 20M9.8 6.2A9.7 9.7 0 0 1 12 6c6 0 9.5 6 9.5 6a17 17 0 0 1-3 3.6M6.2 8.1A17.6 17.6 0 0 0 2.5 12s3.5 6 9.5 6a9.4 9.4 0 0 0 3.6-.7" />
      <path d="M9.6 9.7a3 3 0 0 0 4.3 4.2" />
    </>
  ),
  lock: (
    <>
      <rect x="4.8" y="10.5" width="14.4" height="10" rx="2" />
      <path d="M8.4 10.5V7.8a3.6 3.6 0 0 1 7.2 0v2.7" />
    </>
  ),
  unlock: (
    <>
      <rect x="4.8" y="10.5" width="14.4" height="10" rx="2" />
      <path d="M8.4 10.5V7.8a3.6 3.6 0 0 1 6.9-1.5" />
    </>
  ),
  undo: (
    <>
      <path d="M9 7 4 12l5 5" />
      <path d="M4.5 12H14a5 5 0 0 1 0 10h-2" />
    </>
  ),
  redo: (
    <>
      <path d="m15 7 5 5-5 5" />
      <path d="M19.5 12H10a5 5 0 0 0 0 10h2" />
    </>
  ),
  download: (
    <>
      <path d="M12 3.5v11M7.5 10.5 12 15l4.5-4.5" />
      <path d="M4.5 17v3h15v-3" />
    </>
  ),
  upload: (
    <>
      <path d="M12 15V4M7.5 8.5 12 4l4.5 4.5" />
      <path d="M4.5 17v3h15v-3" />
    </>
  ),
  chevronDown: <path d="m6 9.5 6 6 6-6" />,
  close: <path d="M6 6l12 12M18 6 6 18" />,
  sparkles: (
    <>
      <path d="M12 3.5l1.7 4.6L18 9.8l-4.3 1.7L12 16l-1.7-4.5L6 9.8l4.3-1.7L12 3.5Z" />
      <path d="M18.6 15.4l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8.8-2ZM5 3l.5 1.4L7 5l-1.5.6L5 7l-.5-1.4L3 5l1.5-.6L5 3Z" />
    </>
  ),
  tree: (
    <>
      <path d="M12 3 6.5 11h3L5 18h14l-4.5-7h3L12 3Z" />
      <path d="M12 18v3" />
    </>
  ),
  mountain: (
    <>
      <path d="M3 20h18L14.5 5l-3.5 6-2.5-3L3 20Z" />
      <path d="m11 11 1.5-2.5" />
    </>
  ),
  copy: (
    <>
      <rect x="8.5" y="8.5" width="12" height="12" rx="2" />
      <path d="M15.5 8.5v-3a2 2 0 0 0-2-2h-9a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3" />
    </>
  ),
  folder: <path d="M3.5 6.5a2 2 0 0 1 2-2h4l2 2.5h7a2 2 0 0 1 2 2v8.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2V6.5Z" />,
  search: (
    <>
      <circle cx="10.8" cy="10.8" r="6.3" />
      <path d="m15.5 15.5 4.5 4.5" />
    </>
  ),
  check: <path d="m5 12.5 4.5 4.5L19 7" />,
  alert: (
    <>
      <path d="M12 4 2.8 20h18.4L12 4Z" />
      <path d="M12 9.5v4.8M12 17.4v.1" />
    </>
  ),
  layers: (
    <>
      <path d="m12 3.5 9 4.7-9 4.7-9-4.7 9-4.7Z" />
      <path d="m3 12.5 9 4.7 9-4.7M3 16.8l9 4.7 9-4.7" />
    </>
  ),
  info: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 11v5.5M12 7.8v.1" />
    </>
  ),
  frame: (
    <>
      <path d="M4 9V5a1 1 0 0 1 1-1h4M20 9V5a1 1 0 0 0-1-1h-4M4 15v4a1 1 0 0 0 1 1h4M20 15v4a1 1 0 0 1-1 1h-4" />
    </>
  ),
  menu: <path d="M4 7h16M4 12h16M4 17h16" />,
  sun: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M18.7 5.3l-1.4 1.4M6.7 17.3l-1.4 1.4" />
    </>
  ),
  sliders: (
    <>
      <path d="M5 4v6M5 14v6M12 4v3M12 11v9M19 4v10M19 18v2" />
      <circle cx="5" cy="12" r="2" />
      <circle cx="12" cy="9" r="2" />
      <circle cx="19" cy="16" r="2" />
    </>
  ),
  move: (
    <>
      <path d="M12 3v18M3 12h18" />
      <path d="m8.5 6.5 3.5-3.5 3.5 3.5M8.5 17.5 12 21l3.5-3.5M6.5 8.5 3 12l3.5 3.5M17.5 8.5 21 12l-3.5 3.5" />
    </>
  ),
  rotate: (
    <>
      <path d="M20 12a8 8 0 1 1-2.6-5.9" />
      <path d="M20 4v5h-5" />
    </>
  ),
  scale: (
    <>
      <path d="M14 4h6v6M10 20H4v-6M20 4l-7 7M4 20l7-7" />
    </>
  ),
  magnet: (
    <>
      <path d="M5 4v8a7 7 0 0 0 14 0V4h-4v8a3 3 0 0 1-6 0V4H5Z" />
      <path d="M5 8h4M15 8h4" />
    </>
  ),
  grid: (
    <>
      <rect x="3.5" y="3.5" width="17" height="17" rx="1.5" />
      <path d="M3.5 9.2h17M3.5 14.8h17M9.2 3.5v17M14.8 3.5v17" />
    </>
  ),
  save: (
    <>
      <path d="M5 3.5h11L20.5 8v12.5h-15.5V3.5Z" />
      <path d="M8 3.5v6h7v-6M8 20.5v-6h8v6" />
    </>
  ),
  camera: (
    <>
      <path d="M3.5 8.5A2.5 2.5 0 0 1 6 6h2l1.4-2h5.2L16 6h2a2.5 2.5 0 0 1 2.5 2.5v8A2.5 2.5 0 0 1 18 19H6a2.5 2.5 0 0 1-2.5-2.5v-8Z" />
      <circle cx="12" cy="12.5" r="3.4" />
    </>
  ),
};

export function Icon({
  name,
  size = 18,
  className,
}: {
  name: IconName;
  size?: number;
  className?: string;
}) {
  return (
    <svg
      className={className ? `icon ${className}` : 'icon'}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {PATHS[name]}
    </svg>
  );
}
