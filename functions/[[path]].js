// Cloudflare Pages Functions — 透明反代（最小可用版，专供 download.py 使用）
// 保存为仓库根目录下的：functions/[[path]].js  （双中括号，catch-all 路由）
// 部署后用法（download.py 的 base_url）：
//   https://<project>.pages.dev/proxy/zh.kid1412.by
//
// ⚠️ 关键修复：POST 请求必须把请求体【完整读出来】再转发，不能直接透传
//    request.body 这个流——Cloudflare Pages/Worker 在转发流时会抛
//    "Worker threw exception"（POST /login 必现）。GET 没有 body 所以不受影响。

export async function onRequest(context) {
  const request = context.request;
  const url = new URL(request.url);
  const pathname = url.pathname;

  // 健康检查：必须返回 JSON（用来验证 Functions 是否真的在跑）
  if (pathname === '/health') {
    return new Response(JSON.stringify({ status: 'healthy', ts: new Date().toISOString() }), {
      headers: { 'Content-Type': 'application/json;charset=UTF-8' }
    });
  }

  // 透明反代：/proxy/<host>/<path>  ->  https://<host>/<path>
  if (pathname.startsWith('/proxy/')) {
    const rest = pathname.slice('/proxy/'.length);            // 例: zh.kid1412.by/s/xxx
    const slash = rest.indexOf('/');
    const host = slash === -1 ? rest : rest.slice(0, slash);
    const targetPath = slash === -1 ? '' : rest.slice(slash + 1);
    const targetUrl = 'https://' + host + '/' + targetPath + url.search;

    const method = request.method;
    const headers = new Headers();
    const pass = ['accept', 'accept-encoding', 'accept-language', 'authorization',
                  'content-type', 'user-agent', 'cache-control', 'pragma', 'cookie', 'x-requested-with'];
    for (const [k, v] of request.headers.entries()) {
      if (pass.includes(k.toLowerCase())) headers.set(k, v);
    }

    // ★ 关键修复：把请求体读全（流不能直接透传，否则 POST 抛异常）
    let body = null;
    if (method !== 'GET' && method !== 'HEAD') {
      const ct = (request.headers.get('content-type') || '').toLowerCase();
      if (ct.includes('application/x-www-form-urlencoded') || ct.includes('multipart/form-data') || ct.includes('json')) {
        body = await request.text();
      } else {
        body = await request.arrayBuffer();
      }
    }

    const proxyReq = new Request(targetUrl, { method, headers, body });
    const resp = await fetch(proxyReq);

    const out = new Headers();
    const keep = ['content-type', 'content-encoding', 'content-length', 'cache-control',
                  'etag', 'last-modified', 'set-cookie', 'location'];
    for (const [k, v] of resp.headers.entries()) {
      const lk = k.toLowerCase();
      if (!keep.includes(lk)) continue;
      if (lk === 'set-cookie') out.append('set-cookie', v);   // 关键：保留登录会话 cookie
      else out.set(k, v);
    }
    return new Response(resp.body, { status: resp.status, statusText: resp.statusText, headers: out });
  }

  return new Response('Not Found', { status: 404 });
}
