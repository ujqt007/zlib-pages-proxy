/**
 * Cloudflare Pages Functions 版透明反代（基于 QImageLab/cf-proxy）
 *
 * 为什么用 Pages 而非 Worker：
 *   沙箱实测 *.workers.dev 被网络层封锁（TCP 超时），但 *.pages.dev 可达（0.29s）。
 *   因此把代理部署到 Cloudflare Pages，用 <project>.pages.dev 域名，沙箱即可连通。
 *
 * 部署：
 *   1. 在 Cloudflare Pages 创建项目（可空 Git 仓库或本地上传）。
 *   2. 把本文件保存为项目根目录下的  functions/[[path]].js  （catch-all 路由，双中括号）。
 *   3. 部署上线，得到 https://<project>.pages.dev
 *
 * 用法（download.py 的 base_url 改成）：
 *   https://<project>.pages.dev/proxy/zh.kid1412.by
 */

export async function onRequest(context) {
  const request = context.request;
  try {
    const url = new URL(request.url);
    const pathname = url.pathname;

    // 自动获取当前域名
    const PROXY_DOMAIN = url.host;

    // 健康检查
    if (pathname === '/health') {
      return createJSONResponse({ status: 'healthy', timestamp: new Date().toISOString() });
    }

    // 首页
    if (pathname === '/') {
      return createHomeResponse(PROXY_DOMAIN);
    }

    // 基础代理路由（更长的路径先匹配，避免被短路径提前匹配）
    if (pathname.startsWith('/httpproxyport/')) {
      return await handleProxyPort(request, pathname, 'http');
    }
    if (pathname.startsWith('/proxyport/')) {
      return await handleProxyPort(request, pathname, 'https');
    }
    if (pathname.startsWith('/httpproxy/')) {
      return await handleProxy(request, pathname, 'http');
    }
    if (pathname.startsWith('/proxy/')) {
      return await handleProxy(request, pathname, 'https');
    }

    // HTML重写代理路由
    if (pathname.startsWith('/webproxy/')) {
      return await handleWebProxy(request, pathname, 'https');
    }
    if (pathname.startsWith('/httpwebproxy/')) {
      return await handleWebProxy(request, pathname, 'http');
    }

    // 未匹配到任何路由
    return createErrorResponse('Not Found', 404, 'Invalid route. Supported routes: /proxy/*, /webproxy/*');

  } catch (error) {
    return createErrorResponse('Internal Server Error', 500, error.message);
  }
}

/**
 * 处理基础代理
 */
async function handleProxy(request, pathname, protocol) {
  const prefix = protocol === 'https' ? '/proxy/' : '/httpproxy/';
  const path = pathname.substring(prefix.length);
  const parts = path.split('/');

  if (parts.length < 1) {
    return createErrorResponse('Bad Request', 400, 'Missing host parameter');
  }

  const host = parts[0];
  const targetPath = parts.slice(1).join('/') || '';
  const url = new URL(request.url);
  const targetUrl = `${protocol}://${host}/${targetPath}${url.search}`;

  return await proxyRequest(request, targetUrl);
}

/**
 * 处理HTML重写代理
 */
async function handleWebProxy(request, pathname, protocol) {
  const prefix = protocol === 'https' ? '/webproxy/' : '/httpwebproxy/';
  const path = pathname.substring(prefix.length);
  const parts = path.split('/');

  if (parts.length < 1) {
    return createErrorResponse('Bad Request', 400, 'Missing host parameter');
  }

  const host = parts[0];
  const targetPath = parts.slice(1).join('/') || '';
  const url = new URL(request.url);
  const targetUrl = `${protocol}://${host}/${targetPath}${url.search}`;

  return await proxyRequestWithRewrite(request, targetUrl, url.origin, prefix);
}

/**
 * 处理带端口代理
 */
async function handleProxyPort(request, pathname, protocol) {
  const prefix = protocol === 'https' ? '/proxyport/' : '/httpproxyport/';
  const path = pathname.substring(prefix.length);
  const parts = path.split('/');

  if (parts.length < 2) {
    return createErrorResponse('Bad Request', 400, 'Missing host or port parameter');
  }

  const host = parts[0];
  const port = parts[1];
  const targetPath = parts.slice(2).join('/') || '';

  const portNum = parseInt(port, 10);
  if (isNaN(portNum) || portNum < 1 || portNum > 65535) {
    return createErrorResponse('Bad Request', 400, `Invalid port: ${port}`);
  }

  const url = new URL(request.url);
  const targetUrl = `${protocol}://${host}:${portNum}/${targetPath}${url.search}`;

  try {
    return await proxyRequest(request, targetUrl);
  } catch (error) {
    return createErrorResponse('Proxy Error', 502, `Failed to connect to ${host}:${portNum} - ${error.message}`);
  }
}

/**
 * HTTP/HTTPS代理请求（带HTML重写）
 */
async function proxyRequestWithRewrite(request, targetUrl, proxyOrigin, proxyPrefix) {
  try {
    const headers = buildProxyHeaders(request.headers, targetUrl);
    const proxyRequest = new Request(targetUrl, {
      method: request.method,
      headers: headers,
      body: request.method !== 'GET' && request.method !== 'HEAD' ? request.body : null
    });

    const response = await fetch(proxyRequest);
    const contentType = response.headers.get('content-type') || '';

    if (contentType.includes('text/html')) {
      const html = await response.text();
      const targetOrigin = new URL(targetUrl).origin;
      const rewrittenHtml = rewriteHTML(html, targetOrigin, proxyOrigin, proxyPrefix);

      const responseHeaders = buildResponseHeaders(response.headers, true);
      responseHeaders.set('content-type', 'text/html;charset=UTF-8');
      responseHeaders.delete('content-length');

      return new Response(rewrittenHtml, {
        status: response.status,
        statusText: response.statusText,
        headers: responseHeaders
      });
    }

    const responseHeaders = buildResponseHeaders(response.headers, true);
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders
    });

  } catch (error) {
    return createErrorResponse('Proxy Error', 502, `Failed to connect to target: ${error.message}`);
  }
}

/**
 * HTTP/HTTPS代理请求
 */
async function proxyRequest(request, targetUrl) {
  try {
    const headers = buildProxyHeaders(request.headers, targetUrl);
    const proxyRequest = new Request(targetUrl, {
      method: request.method,
      headers: headers,
      body: request.method !== 'GET' && request.method !== 'HEAD' ? request.body : null
    });

    const response = await fetch(proxyRequest);

    // 构建响应头
    const responseHeaders = buildResponseHeaders(response.headers);

    // 返回响应（response.body 为二进制流/PDF，原样透传）
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders
    });

  } catch (error) {
    return createErrorResponse('Proxy Error', 502, `Failed to connect to target: ${error.message}`);
  }
}

/**
 * 重写HTML内容中的URL
 */
function rewriteHTML(html, targetOrigin, proxyOrigin, proxyPrefix) {
  html = html.replace(
    new RegExp('(href|src|action)="(https?://[^"]+)"', 'gi'),
    function (match, attr, url) {
      try {
        const urlObj = new URL(url);
        const newUrl = proxyOrigin + proxyPrefix + urlObj.host + urlObj.pathname + urlObj.search + urlObj.hash;
        return attr + '="' + newUrl + '"';
      } catch (e) {
        return match;
      }
    }
  );

  html = html.replace(
    new RegExp('(href|src|action)="(/[^"]*)"', 'gi'),
    function (match, attr, path) {
      if (path.startsWith('//')) return match;
      const targetHost = new URL(targetOrigin).host;
      const newUrl = proxyOrigin + proxyPrefix + targetHost + path;
      return attr + '="' + newUrl + '"';
    }
  );

  return html;
}

/**
 * 构建代理请求头（透传 Cookie 等关键头）
 */
function buildProxyHeaders(originalHeaders, targetUrl) {
  const headers = new Headers();
  const target = new URL(targetUrl);

  const importantHeaders = [
    'accept', 'accept-encoding', 'accept-language', 'authorization',
    'content-type', 'user-agent', 'cache-control', 'pragma', 'content-length',
    'origin', 'referer', 'cookie', 'x-requested-with'
  ];

  for (const [key, value] of originalHeaders.entries()) {
    if (importantHeaders.includes(key.toLowerCase())) {
      headers.set(key, value);
    }
  }

  headers.set('Host', target.host);

  if (!headers.has('User-Agent')) {
    headers.set('User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
  }

  return headers;
}

/**
 * 构建响应头（关键修复：基础 /proxy/ 也透传 set-cookie，多 cookie 用 append 保留）
 */
function buildResponseHeaders(originalHeaders, isWebProxy = false) {
  const headers = new Headers();

  const importantHeaders = [
    'content-type', 'content-encoding', 'content-length', 'cache-control',
    'etag', 'last-modified', 'set-cookie'
  ];

  for (const [key, value] of originalHeaders.entries()) {
    if (!importantHeaders.includes(key.toLowerCase())) continue;
    if (key.toLowerCase() === 'set-cookie') {
      headers.append('set-cookie', value);
    } else {
      headers.set(key, value);
    }
  }

  if (!isWebProxy) {
    headers.set('Access-Control-Allow-Origin', '*');
    headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS, HEAD, PATCH');
    headers.set('Access-Control-Allow-Headers', '*');
    headers.set('Access-Control-Max-Age', '86400');
  }

  return headers;
}

/**
 * 创建JSON响应
 */
function createJSONResponse(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status: status,
    headers: {
      'Content-Type': 'application/json;charset=UTF-8',
      'Access-Control-Allow-Origin': '*'
    }
  });
}

/**
 * 创建错误响应
 */
function createErrorResponse(message, status = 500, details = null) {
  const error = { error: message, code: status, timestamp: new Date().toISOString() };
  if (details) error.details = details;
  return createJSONResponse(error, status);
}

/**
 * 创建首页响应
 */
function createHomeResponse(proxyDomain) {
  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Proxy (Pages)</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); min-height: 100vh; padding: 15px; }
        .container { max-width: 700px; margin: 20px auto; background: white; padding: 25px; border-radius: 16px; box-shadow: 0 20px 60px rgba(0,0,0,0.3); }
        h1 { color: #333; text-align: center; margin-bottom: 25px; font-size: 32px; }
        code { background: #e8e8e8; padding: 2px 5px; border-radius: 4px; }
    </style>
</head>
<body>
    <div class="container">
        <h1>⚡ Proxy (Cloudflare Pages)</h1>
        <p>路由：<code>/proxy/:host/:path*</code> → <code>https://:host/:path</code></p>
        <p>示例：<code>https://${proxyDomain}/proxy/zh.kid1412.by/s/概率</code></p>
    </div>
</body>
</html>`;

  return new Response(html, {
    headers: { 'Content-Type': 'text/html;charset=UTF-8', 'Cache-Control': 'public, max-age=300' }
  });
}
