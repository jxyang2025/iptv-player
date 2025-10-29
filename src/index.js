/**
 * M3U/CORS 代理服务 - 透明前缀代理版
 * 支持 /https://... 和 /http://... 前缀代理
 * 自动重写 M3U8 内部链接为代理格式
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

// HTMLRewriter 用于重写 M3U8 中的链接为透明前缀代理
class M3URewriter {
  constructor(requestUrl) {
    this.requestUrl = new URL(requestUrl);
  }

  element(element) {
    // 不处理 HTML，仅用于文本流
  }

  text(text) {
    const newText = text.text
      // 匹配以 http:// 或 https:// 开头的 URL
      .replace(/(https?:\/\/[^\s"'\]]+)/g, (match) => {
        // 避免递归代理：如果已经是代理链接，则不再包装
        if (match.includes(this.requestUrl.host)) return match;
        // 使用当前 Worker 地址作为透明前缀代理
        return `${this.requestUrl.origin}${match}`;
      });
    text.replace(newText, { html: false });
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

  // === 2. 解析目标 URL：支持两种模式 ===
  let targetUrl = null;

  // 模式 1: ?url= 参数代理（向后兼容）
  const urlParam = url.searchParams.get('url');
  if (urlParam) {
    try {
      targetUrl = new URL(decodeURIComponent(urlParam)).href;
    } catch (err) {
      return new Response('错误: 无效的 URL 格式 (url 参数)', {
        status: 400,
        headers: {
          ...corsHeaders,
          'Content-Type': 'text/plain; charset=utf-8'
        }
      });
    }
  }

  // 模式 2: 透明前缀代理 (路径代理)
  if (!targetUrl) {
    const path = url.pathname;
    if (path.startsWith('/http://') || path.startsWith('/https://')) {
      // 移除前缀斜杠，获取真实 URL
      targetUrl = path.substring(1);
      // 如果有查询参数，也拼接上去
      if (url.search) {
        targetUrl += url.search;
      }
    }
  }

  // === 3. 验证目标 URL ===
  if (!targetUrl) {
    return new Response('错误: 请提供目标 URL (url 参数或路径代理)', {
      status: 400,
      headers: {
        ...corsHeaders,
        'Content-Type': 'text/plain; charset=utf-8'
      }
    });
  }

  try {
    // 确保 targetUrl 是合法 URL
    targetUrl = new URL(targetUrl).href;
  } catch (err) {
    return new Response('错误: 无效的 URL 格式', {
      status: 400,
      headers: {
        ...corsHeaders,
        'Content-Type': 'text/plain; charset=utf-8'
      }
    });
  }

  // === 4. 设置代理请求选项 ===
  const proxyOptions = {
    method: request.method,
    headers: {
      'User-Agent': FAKE_UA, // 使用模拟设备 UA
      'Referer': new URL(targetUrl).origin,
      'Origin': this.requestUrl.origin
    },
    redirect: 'follow'
  };

  // 移除可能干扰的头部
  delete proxyOptions.headers['host'];
  delete proxyOptions.headers['origin'];
  delete proxyOptions.headers['referer'];

  // === 5. 发起代理请求（关键：添加 try-catch）===
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
        .on('body', new M3URewriter(request.url))
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
    // ✅ 捕获所有网络异常（DNS 失败、连接超时、TLS 错误等）
    console.error('代理请求失败:', err);

    return new Response(`代理请求失败: ${err.message}\n\n请检查目标地址是否可访问。`, {
      status: 500,
      headers: {
        ...corsHeaders,
        'Content-Type': 'text/plain; charset=utf-8'
      }
    });
  }
}

// 注册请求处理器
addEventListener('fetch', event => {
  event.respondWith(handleRequest(event.request));
});
