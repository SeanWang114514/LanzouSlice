export function setText(node, value) {
  const text = String(value);
  if (node.textContent !== text) node.textContent = text;
}
