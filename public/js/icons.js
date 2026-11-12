// Свой набор тонких линейных иконок: сетка 24, штрих 1.6, круглые концы. Нарисован для Ложи.
const P = {
  film: '<rect x="3" y="4.5" width="18" height="15" rx="3.2"/><path d="M7.6 4.5v15M16.4 4.5v15M3 9.5h4.6M3 14.5h4.6M16.4 9.5H21M16.4 14.5H21"/>',
  music: '<path d="M9.2 17.4V6.2l10-2.2v11.2"/><circle cx="6.6" cy="17.4" r="2.6"/><circle cx="16.6" cy="15.2" r="2.6"/>',
  users: '<circle cx="9" cy="8.4" r="3.4"/><path d="M2.8 19.4c.7-3.3 3.1-5.3 6.2-5.3s5.5 2 6.2 5.3"/><path d="M15.6 5.3a3.4 3.4 0 0 1 0 6.2M18 14.6c1.6.8 2.7 2.4 3.2 4.6"/>',
  sliders: '<path d="M4 7h8.6M16.8 7H20M4 17h3.2M11.4 17H20"/><circle cx="14.7" cy="7" r="2.1"/><circle cx="9.3" cy="17" r="2.1"/>',
  gear: '<path d="M19.18 10.22L21.47 10.42L21.47 13.58L19.18 13.78A7.4 7.4 0 0 1 18.34 15.82L19.81 17.58L17.58 19.81L15.82 18.34A7.4 7.4 0 0 1 13.78 19.18L13.58 21.47L10.42 21.47L10.22 19.18A7.4 7.4 0 0 1 8.18 18.34L6.42 19.81L4.19 17.58L5.66 15.82A7.4 7.4 0 0 1 4.82 13.78L2.53 13.58L2.53 10.42L4.82 10.22A7.4 7.4 0 0 1 5.66 8.18L4.19 6.42L6.42 4.19L8.18 5.66A7.4 7.4 0 0 1 10.22 4.82L10.42 2.53L13.58 2.53L13.78 4.82A7.4 7.4 0 0 1 15.82 5.66L17.58 4.19L19.81 6.42L18.34 8.18A7.4 7.4 0 0 1 19.18 10.22Z"/><circle cx="12" cy="12" r="3"/>',
  play: '<path d="M7.6 5.3v13.4c0 .8.9 1.3 1.6.9l10.7-6.7c.6-.4.6-1.4 0-1.8L9.2 4.4c-.7-.4-1.6.1-1.6.9z"/>',
  pause: '<rect x="6.4" y="4.8" width="3.8" height="14.4" rx="1.3"/><rect x="13.8" y="4.8" width="3.8" height="14.4" rx="1.3"/>',
  next: '<path d="M6 5.7v12.6c0 .8.9 1.2 1.5.7l8.2-6.3a.9.9 0 0 0 0-1.4L7.5 5C6.9 4.5 6 4.9 6 5.7z"/><path d="M18.6 5v14"/>',
  prev: '<path d="M18 5.7v12.6c0 .8-.9 1.2-1.5.7l-8.2-6.3a.9.9 0 0 1 0-1.4L16.5 5c.6-.5 1.5-.1 1.5.7z"/><path d="M5.4 5v14"/>',
  vol: '<path d="M4 9.6v4.8h3.1l4.4 3.7V5.9L7.1 9.6H4z"/><path d="M15.2 9.3a3.9 3.9 0 0 1 0 5.4M17.8 6.7a7.5 7.5 0 0 1 0 10.6"/>',
  volLow: '<path d="M4 9.6v4.8h3.1l4.4 3.7V5.9L7.1 9.6H4z"/><path d="M15.2 9.3a3.9 3.9 0 0 1 0 5.4"/>',
  mute: '<path d="M4 9.6v4.8h3.1l4.4 3.7V5.9L7.1 9.6H4z"/><path d="M15.6 9.6l4.8 4.8M20.4 9.6l-4.8 4.8"/>',
  fs: '<path d="M4 9V5.6A1.6 1.6 0 0 1 5.6 4H9M15 4h3.4A1.6 1.6 0 0 1 20 5.6V9M20 15v3.4a1.6 1.6 0 0 1-1.6 1.6H15M9 20H5.6A1.6 1.6 0 0 1 4 18.4V15"/>',
  fsExit: '<path d="M9 4v3.4A1.6 1.6 0 0 1 7.4 9H4M20 9h-3.4A1.6 1.6 0 0 1 15 7.4V4M15 20v-3.4a1.6 1.6 0 0 1 1.6-1.6H20M4 15h3.4A1.6 1.6 0 0 1 9 16.6V20"/>',
  pip: '<rect x="3" y="5" width="18" height="14" rx="2.8"/><rect x="11.4" y="11.4" width="7.2" height="5.2" rx="1.3"/>',
  chat: '<path d="M5.6 17.2A2.6 2.6 0 0 1 4 14.8V6.6A2.6 2.6 0 0 1 6.6 4h10.8A2.6 2.6 0 0 1 20 6.6v8.2a2.6 2.6 0 0 1-2.6 2.6H10l-4.4 3.2v-3.4z"/>',
  mic: '<rect x="9" y="3.4" width="6" height="11" rx="3"/><path d="M5.6 11.4a6.4 6.4 0 0 0 12.8 0M12 17.8v2.8"/>',
  micOff: '<rect x="9" y="3.4" width="6" height="11" rx="3"/><path d="M5.6 11.4a6.4 6.4 0 0 0 12.8 0M12 17.8v2.8M4.2 4.2l15.6 15.6"/>',
  phones: '<path d="M4.4 15.2v-3a7.6 7.6 0 0 1 15.2 0v3"/><rect x="3.4" y="13.6" width="4" height="6" rx="1.8"/><rect x="16.6" y="13.6" width="4" height="6" rx="1.8"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  minus: '<path d="M5 12h14"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  check: '<path d="M5 12.6l4.4 4.4L19 7.4"/>',
  chevL: '<path d="M14.6 5.6L8.2 12l6.4 6.4"/>',
  chevR: '<path d="M9.4 5.6l6.4 6.4-6.4 6.4"/>',
  back: '<path d="M19.2 12H5M11.2 5.6L4.8 12l6.4 6.4"/>',
  more: '<circle cx="5.4" cy="12" r="1.5" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none"/><circle cx="18.6" cy="12" r="1.5" fill="currentColor" stroke="none"/>',
  link: '<path d="M10.2 13.8a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1.3 1.3"/><path d="M13.8 10.2a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1.3-1.3"/>',
  upload: '<path d="M12 15.5V4.6M7.4 9L12 4.4 16.6 9"/><path d="M4.5 15.2v2.3a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-2.3"/>',
  download: '<path d="M12 4.5v10.9M7.4 11L12 15.6l4.6-4.6"/><path d="M4.5 15.2v2.3a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-2.3"/>',
  trash: '<path d="M4.5 6.8h15M9.4 6.8V5.2A1.2 1.2 0 0 1 10.6 4h2.8a1.2 1.2 0 0 1 1.2 1.2v1.6"/><path d="M6.6 6.8l.8 11.4a2 2 0 0 0 2 1.8h5.2a2 2 0 0 0 2-1.8l.8-11.4M10.2 10.6V16M13.8 10.6V16"/>',
  edit: '<path d="M4.6 19.4l.9-4L15.9 5A2.2 2.2 0 0 1 19 8.1L8.6 18.5l-4 .9z"/><path d="M14.2 6.7l3.1 3.1"/>',
  copy: '<rect x="8.6" y="8.6" width="11" height="11" rx="2.4"/><path d="M5.6 15.4h-.2a1.8 1.8 0 0 1-1.8-1.8V5.4a1.8 1.8 0 0 1 1.8-1.8h8.2a1.8 1.8 0 0 1 1.8 1.8v.2"/>',
  exit: '<path d="M10 4.6H6.6a2 2 0 0 0-2 2v10.8a2 2 0 0 0 2 2H10"/><path d="M15 8l4 4-4 4M19 12H9.6"/>',
  sun: '<circle cx="12" cy="12" r="3.8"/><path d="M12 3v2.2M12 18.8V21M3 12h2.2M18.8 12H21M5.6 5.6l1.6 1.6M16.8 16.8l1.6 1.6M18.4 5.6l-1.6 1.6M7.2 16.8l-1.6 1.6"/>',
  moon: '<path d="M19.6 14.2A8 8 0 0 1 9.8 4.4a8 8 0 1 0 9.8 9.8z"/>',
  auto: '<circle cx="12" cy="12" r="8.2"/><path d="M12 3.8v16.4M12 8.2h7.2M12 12h8.2M12 15.8h7.2"/>',
  queue: '<path d="M4.5 6.5h11M4.5 12h11M4.5 17.5h6.4"/><path d="M16.4 14.6v5.6l4.1-2.8-4.1-2.8z"/>',
  grip: '<circle cx="9" cy="6.5" r="1.3" fill="currentColor" stroke="none"/><circle cx="15" cy="6.5" r="1.3" fill="currentColor" stroke="none"/><circle cx="9" cy="12" r="1.3" fill="currentColor" stroke="none"/><circle cx="15" cy="12" r="1.3" fill="currentColor" stroke="none"/><circle cx="9" cy="17.5" r="1.3" fill="currentColor" stroke="none"/><circle cx="15" cy="17.5" r="1.3" fill="currentColor" stroke="none"/>',
  send: '<path d="M20.4 3.8L3.6 10.6l6.6 2.6 2.6 6.6 7.6-16z"/><path d="M10.2 13.2l4.4-4.2"/>',
  disk: '<rect x="3.6" y="13" width="16.8" height="6.4" rx="2"/><path d="M5.4 13l2.2-7a2 2 0 0 1 1.9-1.4h5a2 2 0 0 1 1.9 1.4l2.2 7M7.4 16.2h.1M10.4 16.2h.1"/>',
  refresh: '<path d="M19.4 12a7.4 7.4 0 0 1-13.2 4.6M4.6 12a7.4 7.4 0 0 1 13.2-4.6"/><path d="M18.6 3.8v3.9h-3.9M5.4 20.2v-3.9h3.9"/>',
  key: '<circle cx="8" cy="15.4" r="3.6"/><path d="M10.6 12.8l8-8M15.4 8L18 10.6M18 5.4L19.6 7"/>',
  cc: '<rect x="3.2" y="5.4" width="17.6" height="13.2" rx="3"/><path d="M10 10.6a2.2 2.2 0 1 0 0 2.8M16.6 10.6a2.2 2.2 0 1 0 0 2.8"/>',
  gauge: '<path d="M4.6 16.4a8 8 0 1 1 14.8 0"/><path d="M12 13.4l3.6-4.2"/><circle cx="12" cy="13.6" r="1.1"/>',
  zoom: '<circle cx="10.8" cy="10.8" r="6.4"/><path d="M15.6 15.6l4.6 4.6M8.2 10.8h5.2M10.8 8.2v5.2"/>',
  bars: '<path d="M5 19.4V12M10 19.4V5M15 19.4v-9M20 19.4v-5"/>',
  hd: '<rect x="3.2" y="5.4" width="17.6" height="13.2" rx="3"/><path d="M7.2 9.6v4.8M7.2 12h3.2M10.4 9.6v4.8M13.6 9.6v4.8h1a2.4 2.4 0 0 0 0-4.8h-1z"/>',
  info: '<circle cx="12" cy="12" r="8.4"/><path d="M12 11v5.4M12 7.8v.2"/>',
  warn: '<path d="M12 4.2l8.4 14.6H3.6L12 4.2z"/><path d="M12 10v4.2M12 16.6v.2"/>',
  crown: '<path d="M4.2 8.2l3.9 3.6L12 6l3.9 5.8 3.9-3.6-1.5 9.6H5.7L4.2 8.2z"/>',
  image: '<rect x="3.6" y="4.6" width="16.8" height="14.8" rx="3"/><circle cx="9" cy="10" r="1.7"/><path d="M4.4 17l4.8-4.6 3.6 3.2 2.8-2.4 4.2 3.8"/>',
  cookie: '<path d="M12 3.6a8.4 8.4 0 1 0 8.4 8.6 3.4 3.4 0 0 1-4-4.2A3.4 3.4 0 0 1 12 3.6z"/><path d="M9 10.2v.1M13.4 13.6v.1M9.2 15.4v.1"/>',
  lock: '<rect x="5.2" y="10.6" width="13.6" height="9" rx="2.4"/><path d="M8.4 10.6V8a3.6 3.6 0 0 1 7.2 0v2.6"/>',
  swap: '<path d="M4.6 8.4h13.6M14.6 4.8l3.8 3.6-3.8 3.6M19.4 15.6H5.8M9.4 12l-3.8 3.6 3.8 3.6"/>',
  mail: '<rect x="3.4" y="5.4" width="17.2" height="13.2" rx="3"/><path d="M4.4 7.4l7.6 6 7.6-6"/>',
  eye: '<path d="M2.8 12s3.4-6.2 9.2-6.2 9.2 6.2 9.2 6.2-3.4 6.2-9.2 6.2S2.8 12 2.8 12z"/><circle cx="12" cy="12" r="2.8"/>',
  disc: '<circle cx="12" cy="12" r="8.4"/><circle cx="12" cy="12" r="2.4"/>',
  wifi: '<path d="M4 9.6a11.6 11.6 0 0 1 16 0M6.8 12.8a7.4 7.4 0 0 1 10.4 0M9.6 16a3.4 3.4 0 0 1 4.8 0"/><path d="M12 19.2v.1"/>',
};
const SOLID = new Set(['play', 'pause', 'next', 'prev']);

const tpl = document.createElement('template');
export function icon(name, cls = '') {
  const body = P[name] || P.info;
  const paint = SOLID.has(name)
    ? 'fill="currentColor" stroke="currentColor" stroke-width="1" stroke-linejoin="round"'
    : 'fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"';
  tpl.innerHTML = `<svg class="ic i-${name}${cls ? ` ${cls}` : ''}" viewBox="0 0 24 24" ${paint} aria-hidden="true">${body}</svg>`;
  return tpl.content.firstChild;
}

// Знак Ложи: арка театральной ложи, перила и зритель в ней.
export function logo(cls = '') {
  tpl.innerHTML = `<svg class="${cls}" viewBox="0 0 64 64" fill="none" stroke="currentColor" stroke-width="3.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M13 52V27a19 19 0 0 1 38 0v25"/><path d="M7 52h50"/><circle cx="32" cy="31" r="5.2"/><path d="M22.5 52a9.5 9.5 0 0 1 19 0"/></svg>`;
  return tpl.content.firstChild;
}
