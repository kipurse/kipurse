// CORS for the static signing host (Cloudflare Worker kipurse-sign on the free plan, t629 A1; the Pages asset upload was refused to the connector). Only that project's origins get CORS;
// no credentials/cookies are allowed cross-origin, so this exposes nothing a direct request couldn't already get.
export const SIGN_ORIGIN=/^https:\/\/(sign\.kipurse\.com|([0-9a-f]{8}-)?kipurse-sign\.example\.workers\.dev)$/;   // t887: Kipurse-owned sign host + old host as fallback
export function withSignCors(h,{re=SIGN_ORIGIN}={}){return (req,res)=>{const o=String(req.headers.origin||'');
  if(o&&re.test(o)){res.setHeader('access-control-allow-origin',o);res.setHeader('vary','origin');
    if(req.method==='OPTIONS'){res.writeHead(204,{'access-control-allow-methods':'GET, POST','access-control-allow-headers':'content-type, x-kp-shell, x-kp-csrf','access-control-max-age':'600'});res.end();return;}}
  return h(req,res);};}
