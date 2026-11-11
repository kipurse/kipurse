// t1103 sign host. public/ keeps the live / and /v2–/v8 files byte-identical.
// /v9/index.html, /kpshell.v8.js and /limits.v2.js are the wallet-pays set.
// Deploy this onto the existing sign.kipurse.com worker. Do not create a second worker.
export function signAssetPath(pathname) {
  if (pathname === '/' || pathname === '') return '/index.html';
  const m = pathname.match(/^\/(v\d+)(\/.*)?$/);
  if (!m) return pathname;
  const rest = m[2] || '/';
  if (rest === '/' || rest === '') return `/${m[1]}/index.html`;
  const leaf = rest.split('/').filter(Boolean).pop() || '';
  if (leaf.includes('.')) return pathname;
  return `/${m[1]}/index.html`;
}
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const asset = new URL(signAssetPath(url.pathname), url);
    const res = await env.ASSETS.fetch(new Request(asset, request));
    const headers = new Headers(res.headers);
    headers.set('cache-control', 'no-store');
    headers.set('x-content-type-options', 'nosniff');
    return new Response(res.body, { status: res.status, headers });
  },
};
