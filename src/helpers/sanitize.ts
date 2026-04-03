const ESC_MAP: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

export function escapeHtml(str: unknown): string {
  return String(str).replace(/[&<>"']/g, c => ESC_MAP[c] ?? c);
}
