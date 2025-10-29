/**
 * M3U/CORS 代理服务 - 强制 M3U8 重写版
 */

// CORS 允许的头部
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, POST, OPTIONS',
  'Access-Control-Max-Age': '86400'
};

// 模拟设备的 User-Agent
const FAKE_UA = 'Mozilla/5.0 (Linux; Android 10; SM-G960F) AppleWebKit/537.36';

// HTMLRewriter 用于重写 M3U8 中的链接为代理格式
class M3URewriter {
  constructor(requestUrl, originalTargetUrl) {
    this.requestUrl = new URL(requestUrl);
    this.originalTargetUrl = new URL(originalTargetUrl);
  }

  element(element) {}

  text(text) {
    let newText = text.text;
    
    // 重写完整 URL
    newText = newText.replace(/(https?:\/\/[^\s"'\]]+)/g, (match) => {
      if (match.includes(this.requestUrl.host)) return match;
      const encodedTarget = btoa(encodeURIComponent(match));
      return `${this.requestUrl.origin}/p/${encodedTarget}`;
    });
    
    // 重写相对路径（.m3u8, .ts 等）
    newText = newText.replace(/([^\n#]*\.(m3u8|ts)[^\s]*)/g, (match) => {
      if (match.startsWith('http')) return match; // 已是完整 URL
      if (match.includes(this.requestUrl.host)) return match; // 已是代理链接
      
      // 将相对路径转换为完整 URL
      try {
        const absoluteUrl = new URL(match, this.originalTargetUrl).href;
        const encodedTarget = btoa(encodeURIComponent(absoluteUrl));
        return `${this.requestUrl.origin}/p/${encodedTarget}`;
      } catch (e) {
        return match; // 保持原样
      }
    });
    
    text.replace(newText, { html: false });
  }
}

/**
 * Base64 解码函数（安全版）
 */
function safeDecode(str) {
  try {
    str = str.replace(/-/g, '+').replace(/_/g, '/');
    while (str.length % 4) str += '=';
    return atob(str);
  } catch (e) {
    throw new Error('Base64 解码失败: ' + e.message);
  }
}

/**
 * 检查内容是否为 M3U8（基于内容）
 */
async function isM3U8ByContent(response) {
  // 克隆响应以便读取内容
  const clonedResponse = response.clone();
  const text = await clonedResponse.text();
  
  // 检查是否以 #EXTM3U 开头（忽略空白字符）
  return text.trim().startsWith('#EXTM3U');
}

/**
 * 主处理函数
 */
async function handleRequest(request) {
  const url = new URL(request.url);

  // === 1. 处理 OPTIONS 预检请求 ===
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: corsHeaders
    });
  }

  // === 2. 解析目标 URL ===
  let targetUrl = null;

  // 模式 1: ?url= 参数代理（向后兼容）
  const urlParam = url.searchParams.get('url');
  if (urlParam) {
    try {
      targetUrl = new URL(decodeURIComponent(urlParam)).href;
    } catch (err) {
      return new Response('错误: 无效的 URL 格式 (url 参数)', {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'text/plain; charset=utf-8' }
      });
    }
  }

  // 模式 2: Base64 路径代理 /p/...
  if (!targetUrl) {
    const pathParts = url.pathname.split('/');
    
    if (pathParts[1] === 'p' && pathParts[2]) {
      const encodedTarget = pathParts[2];
      
      // 检查是否是 Base64 编码
      if (encodedTarget.length >= 4 && encodedTarget.match(/^[A-Za-z0-9+/]*={0,2}$/)) {
        // Base64 编码的完整 URL
        try {
          const decodedUrl = safeDecode(encodedTarget);
          targetUrl = decodeURIComponent(decodedUrl);
        } catch (err) {
          return new Response('错误: 无效的 Base64 编码 - ' + err.message, {
            status: 400,
            headers: { ...corsHeaders, 'Content-Type': 'text/plain; charset=utf-8' }
          });
        }
      } else {
        // 相对路径请求，尝试从 Referer 获取上下文
        const referer = request.headers.get('Referer');
        if (referer) {
          try {
            const refererUrl = new URL(referer);
            const refererPathParts = refererUrl.pathname.split('/');
            if (refererPathParts[1] === 'p' && refererPathParts[2]) {
              const refererEncoded = refererPathParts[2];
              if (refererEncoded.length >= 4 && refererEncoded.match(/^[A-Za-z0-9+/]*={0,2}$/)) {
                const refererDecoded = safeDecode(refererEncoded);
                const refererOriginal = decodeURIComponent(refererDecoded);
                
                const relativePath = encodedTarget + url.search;
                const finalTarget = new URL(relativePath, refererOriginal).href;
                
                targetUrl = finalTarget;
              }
            }
          } catch (e) {
            // 如果 Referer 解析失败，记录但继续
          }
        }
        
        if (!targetUrl) {
          return new Response(`错误: 无法处理相对路径请求。请确保主 M3U8 文件被正确重写。\n\n收到请求: ${url.pathname}${url.search}\nReferer: ${referer || 'none'}`, {
            status: 400,
            headers: { ...corsHeaders, 'Content-Type': 'text/plain; charset=utf-8' }
          });
        }
      }
    }
  }

  // === 3. 验证目标 URL ===
  if (!targetUrl) {
    return new Response('v1错误: 请提供目标 URL (url 参数或 /p/... 路径)', {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'text/plain; charset=utf-8' }
    });
  }

  try {
    targetUrl = new URL(targetUrl).href;
  } catch (err) {
    return new Response('错误: 无效的 URL 格式', {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'text/plain; charset=utf-8' }
    });
  }

  // === 4. 发起代理请求 ===
  const proxyOptions = {
    method: request.method,
    headers: {
      'User-Agent': FAKE_UA,
      'Referer': new URL(targetUrl).origin,
      'Origin': url.origin
    },
    redirect: 'follow'
  };

  delete proxyOptions.headers['host'];
  delete proxyOptions.headers['origin'];
  delete proxyOptions.headers['referer'];

  try {
    const response = await fetch(targetUrl, proxyOptions);

    // 获取原始响应类型
    const contentType = response.headers.get('content-type') || '';
    
    // 检查内容类型或内容本身是否为 M3U8
    const isContentTypeM3U8 = [
      'application/vnd.apple.mpegurl',
      'application/x-mpegurl',
      'audio/mpegurl',
      'audio/x-mpegurl',
      'video/mp2t',
      'application/octet-stream',
      'text/plain'
    ].some(type => contentType.includes(type));
    
    let shouldRewrite = false;
    
    if (isContentTypeM3U8) {
      // 对于可能的 M3U8 类型，检查内容
      if (contentType.includes('text/plain') || contentType.includes('application/octet-stream')) {
        // 检查内容是否为 M3U8
        if (await isM3U8ByContent(response)) {
          shouldRewrite = true;
        }
      } else {
        // 对于明确的 M3U8 类型，直接重写
        shouldRewrite = true;
      }
    }

    // 构造新的响应头
    const newHeaders = new Headers(response.headers);
    Object.entries(corsHeaders).forEach(([key, value]) => {
      newHeaders.set(key, value);
    });

    // 如果需要重写，使用 HTMLRewriter
    if (shouldRewrite) {
      return new HTMLRewriter()
        .on('body', new M3URewriter(request.url, targetUrl))
        .transform(
          new Response(response.body, {
            ...response,
            headers: newHeaders
          })
        );
    }

    // 普通响应直接返回
    return new Response(response.body, {
      ...response,
      headers: newHeaders
    });

  } catch (err) {
    console.error('代理请求失败:', err);
    return new Response(`代理请求失败: ${err.message}`, {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'text/plain; charset=utf-8' }
    });
  }
}

addEventListener('fetch', event => {
  event.respondWith(handleRequest(event.request));
});
