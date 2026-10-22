/** The production browser uses the API proxy on the page's own origin. */
export function resolveBrowserApiBase(configured: string | undefined, productionBrowser: boolean): string {
  if (productionBrowser) return "/api";
  return (configured?.trim() || "http://localhost:5000/api").replace(/\/+$/, "");
}
