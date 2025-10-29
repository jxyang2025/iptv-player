/**
 * M3U/CORS 代理服务 - 完整版（支持相对路径和 Base64）
 */

// CORS 允许的头部
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, POST, OPTIONS',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Max-Age': '86400'
};

// M3U8/TS 等媒体内容类型
const mediaTypes = [
  'application/vnd.apple.mpegurl',
  'application/x-mpegurl',
  'audio/mpegurl',
  'audio/x-mpegurl',
  'video/mp2t',
  'application/octet-stream'
];

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
    throw new Error('Base64 解码失败');
  }
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

  // === 2. 解析目标 URL：支持多种模式 ===
  let targetUrl = null;
  let isBase64Encoded = false;

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
          isBase64Encoded = true;
        } catch (err) {
          return new Response('错误: 无效的 Base64 编码', {
            status: 400,
            headers: { ...corsHeaders, 'Content-Type': 'text/plain; charset=utf-8' }
          });
        }
      } else {
        // 可能是相对路径，需要从 Referer 或其他方式获取原始基础 URL
        // 这里我们假设用户直接访问了相对路径，这在实际场景中是不合理的
        // 实际上，相对路径请求应该来自 M3U8 内容，而 M3U8 本身是通过 Base64 访问的
        // 所以这里需要一种机制来存储原始请求的上下文
        
        // 由于 Cloudflare Workers 无状态，我们无法直接获取原始请求上下文
        // 这种情况下，我们需要使用不同的策略
        
        // 从 URL 的查询参数中尝试获取原始信息（如果前端支持的话）
        // 或者返回错误，让用户知道请求格式不正确
        return new Response('错误: 无效请求格式。请确保通过代理访问 M3U8 文件。', {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'text/plain; charset=utf-8' }
        });
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

  // === 4. 设置代理请求选项 ===
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

  // === 5. 发起代理请求 ===
  try {
    const response = await fetch(targetUrl, proxyOptions);

    // 获取原始响应类型
    const contentType = response.headers.get('content-type') || '';
    const isMedia = mediaTypes.some(type => contentType.includes(type));
    const isHtml = contentType.includes('text/html') || contentType.includes('text/plain');

    // 构造新的响应头
    const newHeaders = new Headers(response.headers);
    Object.entries(corsHeaders).forEach(([key, value]) => {
      newHeaders.set(key, value);
    });

    // 如果是 M3U8 或文本类媒体，使用 HTMLRewriter 重写内容
    if (isMedia || isHtml) {
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
