const paths = {
  upload: ['M12 16V4m-4 4 4-4 4 4','M4 15v4a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-4'],
  download: ['M12 4v12m-4-4 4 4 4-4','M4 15v4a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-4'],
  account: ['M16 8a4 4 0 1 1-8 0 4 4 0 0 1 8 0','M5 21v-2a5 5 0 0 1 5-5h4a5 5 0 0 1 5 5v2'],
  close: ['m6 6 12 12M18 6 6 18'],
  folder: ['M3 7V6a1 1 0 0 1 1-1h6l2 2h8a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V7Z','M3 9h18'],
  file: ['M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8Z','M14 3v5h5'],
  archive: ['M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8Z','M14 3v5h5','M10 4v2m0 2v2m0 2v2m0 2h3v3h-3Z'],
  manifest: ['M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8Z','M14 3v5h5','m8 15 2 2 5-5'],
  slice: ['M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8Z','M14 3v5h5','M5 12h14M5 16h14']
};

export function icon(name, className = 'ui-icon') {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.setAttribute('class', className);
  for (const d of paths[name]) {
    const path = document.createElementNS(svg.namespaceURI, 'path');
    path.setAttribute('d', d); svg.append(path);
  }
  return svg;
}
