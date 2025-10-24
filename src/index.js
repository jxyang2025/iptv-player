// Worker 脚本 - 最终最稳定的 HLS 代理方案

// 辅助函数：确保所有响应都包含 CORS 头部
function addCORSHeaders(response) {
    const newResponse = new Response(response.body, response);
    newResponse.headers.set('Access-Control-Allow-Origin', '*');
    newResponse.headers.set('Access-Control-Allow-Methods', 'GET, HEAD, POST, OPTIONS');
    newResponse.headers.set('Access-Control-Allow-Headers', '*');
    // 强制关闭缓存，确保实时流不被 CDN 缓存
    newResponse.headers.set('Cache-Control', 'no-cache, no-store, must-revalidate'); 
    newResponse.headers.set('Pragma', 'no-cache');
    return newResponse;
}

addEventListener('fetch', event => {
  event.respondWith(handleRequest(event.request))
})

async function handleRequest(request) {
  const url = new URL(request.url);
  const targetUrl = url.searchParams.get('url');
  const WORKER_PROXY_BASE_URL = url.origin + '/'; 

  if (!targetUrl) {
    const errorResponse = new Response('错误 (400): 请提供 M3U 订阅链接或流地址作为 "url" 参数。', { 
        status: 400,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' }
    });
    return addCORSHeaders(errorResponse);
  }

  // ⭐ 最终最简头部：只设置 User-Agent，确保请求最“纯净”
  const newHeaders = new Headers();
  newHeaders.set('User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36');

  try {
    // 代理请求，使用最简头部
    const response = await fetch(targetUrl, {
      headers: newHeaders, 
      redirect: 'follow'
    });
    
    // 如果响应状态码是 4xx 或 5xx，直接返回，避免 Worker 崩溃
    if (response.status >= 400) {
        // 关键：将源站错误信息返回给客户端
        return addCORSHeaders(new Response(`源站返回错误: ${response.status} ${response.statusText}`, {
            status: response.status,
            headers: response.headers
        }));
    }

    // 检查是否是 M3U/M3U8 文件
    const contentType = response.headers.get('content-type') || '';
    const isM3U = contentType.includes('application/vnd.apple.mpegurl') || 
                  contentType.includes('application/x-mpegURL') || 
                  targetUrl.toLowerCase().endsWith('.m3u8') || 
                  targetUrl.toLowerCase().endsWith('.m3u') || 
                  targetUrl.includes('iptv.php');

    // M3U/M3U8 内容重写
    if (isM3U) {
        const responseClone = response.clone();
        let text = await responseClone.text();
        const baseUrlObject = new URL(targetUrl);
        
        // 核心重写函数：将所有链接封装成 Worker 代理格式
        const rewriteLink = (link) => {
            const absoluteLink = new URL(link, baseUrlObject.href).href;
            return `${WORKER_PROXY_BASE_URL}?url=${encodeURIComponent(absoluteLink)}`;
        };

        // 遍历所有行并重写：只处理非注释（#）且非空的行
        text = text.split('\n').map(line => {
            const trimmedLine = line.trim();
            if (trimmedLine.length > 0 && !trimmedLine.startsWith('#')) {
                return rewriteLink(trimmedLine);
            }
            return line;
        }).join('\n');

        const newResponse = new Response(text, {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers
        });

        newResponse.headers.set('Content-Type', 'application/vnd.apple.mpegurl; charset=utf-8');
        
        return addCORSHeaders(newResponse);

    } else {
        // 标准代理 (TS 视频片段或密钥文件)
        const newResponse = new Response(response.body, response);
        return addCORSHeaders(newResponse);
    }

  } catch (e) {
    // ⭐ 如果 fetch 失败（例如 DNS 错误、连接超时），返回 500
    const errorResponse = new Response(`代理请求失败 (Worker端网络错误): ${e.message}`, { 
        status: 500,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' }
    });
    return addCORSHeaders(errorResponse);
  }
}
