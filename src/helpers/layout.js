export function tabToRow(tab) {
  return Math.ceil(tab / 2);
}

export function tabToCol(tab) {
  return tab % 2 === 0 ? 1 : 0;
}

export function classifyDualTab(tabs) {
  if (tabs.length !== 2) return null;
  const [a, b] = [Math.min(...tabs), Math.max(...tabs)];
  if (tabToRow(a) === tabToRow(b)) return "row-span";
  if (tabToCol(a) === tabToCol(b)) return "col-span";
  return "row-span";
}
