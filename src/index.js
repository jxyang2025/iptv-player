// Worker 脚本 - 解决 CORS, HLS 相对路径, 并对防盗链进行强力清理

// 辅助函数：确保所有响应都包含 CORS 头部
function addCORSHeaders(response) {
    const newResponse = new Response(response.body, response);
    newResponse.headers.set('Access-Control-Allow-Origin', '*');
    newResponse.headers.set('Access-Control-Allow-Methods', 'GET, HEAD, POST, OPTIONS');
    newResponse.headers.set('Access-Control-Allow-Headers', '*');
    // 强制关闭缓存，防止HLS片段被CDN缓存
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
    const errorResponse = new Response('错误: 请提供 M3U 订阅链接或流地址作为 "url" 参数。', { 
        status: 400,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' }
    });
    return addCORSHeaders(errorResponse);
  }

  // 强力清理请求头部，模拟纯净浏览器请求
  const newHeaders = new Headers();
  newHeaders.set('User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36');

  try {
    // 代理请求
    const response = await fetch(targetUrl, {
      headers: newHeaders, 
      redirect: 'follow'
    });

    // 检查是否是 M3U/M3U8 文件
    const contentType = response.headers.get('content-type') || '';
    const isM3U = contentType.includes('application/vnd.apple.mpegurl') || contentType.includes('application/x-mpegURL') || targetUrl.endsWith('.m3u') || targetUrl.includes('iptv.php');

    // M3U/M3U8 内容重写 (Content Rewriting)
    if (isM3U && !targetUrl.endsWith('.m3u8')) {
        // ⭐ 优化：仅对 M3U 列表或复杂 IPTV 列表 (如 iptv.php) 进行重写，
        // 对于单层 M3U8 (如 cctv1hd.m3u8) 或 TS 片段，跳过重写，只添加 CORS。
        
        // 克隆响应并读取内容
        const responseClone = response.clone();
        let text = await responseClone.text();
        
        // 修正 M3U8 基准 URL (保留原始逻辑用于需要重写的情况)
        const baseUrlObject = new URL(targetUrl);
        
        if (baseUrlObject.hostname === 'php.jdshipin.com' && !baseUrlObject.port) {
            baseUrlObject.port = '8880';
        }
        
        // 核心重写函数：将所有链接封装成 Worker 代理格式
        const rewriteLink = (link) => {
            const absoluteLink = new URL(link, baseUrlObject.href).href;
            return `${WORKER_PROXY_BASE_URL}?url=${encodeURIComponent(absoluteLink)}`;
        };

        // 遍历所有行并重写：
        text = text.split('\n').map(line => {
            const trimmedLine = line.trim();
            // 只重写 URL 行
            if (trimmedLine.length > 0 && !trimmedLine.startsWith('#')) {
                return rewriteLink(trimmedLine);
            }
            return line;
        }).join('\n');

        // 创建重写后的响应
        const newResponse = new Response(text, {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers
        });

        // 强制设置为正确的 MIME 类型
        newResponse.headers.set('Content-Type', 'application/vnd.apple.mpegurl; charset=utf-8');
        
        // 添加 CORS 头部并返回
        return addCORSHeaders(newResponse);

    } else {
        // 标准代理 (适用于 TS 视频片段或单层 M3U8 文件)
        const newResponse = new Response(response.body, response);
        // 添加 CORS 头部并返回
        return addCORSHeaders(newResponse);
    }

  } catch (e) {
    const errorResponse = new Response(`代理请求失败 (Worker端): ${e.message}`, { 
        status: 500,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' }
    });
    return addCORSHeaders(errorResponse);
  }
}
