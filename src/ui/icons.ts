/** Inline SVG icons (24px viewBox, stroke based). */
const svg = (body: string, vb = '0 0 24 24') =>
  `<svg viewBox="${vb}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

export const icons = {
  heart: svg('<path d="M12 20s-7-4.4-9-9.2C1.6 7.4 3.6 4 7 4c2 0 3.4 1.1 5 3 1.6-1.9 3-3 5-3 3.4 0 5.4 3.4 4 6.8-2 4.8-9 9.2-9 9.2z"/>'),
  scalpel: svg('<path d="M3 21l6-6"/><path d="M8 14l2 2"/><path d="M9 15L20 4l1 1L10 16z"/><path d="M16 8l1 1"/>'),
  needle: svg('<path d="M4 20c4-1 9-4 12-10"/><path d="M16 10l4-4"/><path d="M18 4l2 2"/><path d="M4 20l1-3"/>'),
  robot: svg('<rect x="5" y="8" width="14" height="11" rx="2"/><path d="M12 8V4"/><circle cx="12" cy="3" r="1"/><circle cx="9" cy="13" r="1.2"/><circle cx="15" cy="13" r="1.2"/><path d="M9 17h6"/>'),
  camera: svg('<path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/>'),
  layers: svg('<path d="M12 3l9 5-9 5-9-5z"/><path d="M3 13l9 5 9-5"/>'),
  tag: svg('<path d="M3 12V4h8l10 10-8 8z"/><circle cx="7.5" cy="8.5" r="1.3"/>'),
  play: svg('<path d="M7 4l13 8-13 8z"/>'),
  check: svg('<path d="M4 12l5 5L20 6"/>'),
  reset: svg('<path d="M4 4v6h6"/><path d="M4.5 14a8 8 0 1 0 1.6-7.3L4 10"/>'),
  report: svg('<path d="M6 3h9l4 4v14H6z"/><path d="M14 3v5h5"/><path d="M9 13h7M9 17h7"/>'),
  settings: svg('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>'),
  valve: svg('<ellipse cx="12" cy="12" rx="9" ry="6"/><path d="M3.5 12c3 2.5 5.5 3 8.5 3s5.5-.5 8.5-3"/><path d="M3.5 12c3-2.5 5.5-3 8.5-3s5.5.5 8.5 3"/>'),
  bypass: svg('<path d="M4 14c0-5 3-8 8-8s8 3 8 8"/><path d="M4 14h4M16 14h4"/><path d="M12 6V3"/><path d="M8 20h8"/>'),
  menu: svg('<path d="M4 7h16M4 12h16M4 17h16"/>'),
  panel: svg('<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M15 4v16"/>'),
  ruler: svg('<path d="M3 17L17 3l4 4L7 21z"/><path d="M8 12l2 2M11 9l2 2M14 6l2 2"/>'),
  flow: svg('<path d="M3 12c3-4 6-4 9 0s6 4 9 0"/><path d="M3 17c3-4 6-4 9 0s6 4 9 0"/><path d="M3 7c3-4 6-4 9 0s6 4 9 0"/>'),
  download: svg('<path d="M12 3v12"/><path d="M7 10l5 5 5-5"/><path d="M4 20h16"/>'),
  close: svg('<path d="M6 6l12 12M18 6L6 18"/>'),
  eye: svg('<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>'),
};

export const brandMark = `<svg class="brand-mark" viewBox="0 0 32 32" aria-hidden="true"><circle cx="16" cy="16" r="15" fill="#162329" stroke="#31485a"/><path d="M7 17h4l2-5 3 9 2-6 2 2h5" fill="none" stroke="#e9a23b" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
