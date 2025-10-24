document.addEventListener('DOMContentLoaded', () => {
    const iptvUrlInput = document.getElementById('iptv-url');
    const loadButton = document.getElementById('load-playlist');
    const channelListUl = document.getElementById('channels');
    const statusMessage = document.getElementById('status-message');
    const videoElement = document.getElementById('tv-player');
    
    // 初始化 Video.js 播放器
    const player = videojs(videoElement);

    // ==========================================================
    // !!! 关键配置: Cloudflare Worker 代理地址 !!!
    // ==========================================================
    // 确保这里是您的 Worker 的 HTTPS 地址，末尾包含斜杠 "/"。
    // 根据您的日志，您的 Worker 域名是 m3u.521986.xyz
    const WORKER_PROXY_BASE_URL = 'https://m3u.521986.xyz/'; 

    /**
     * 更新状态信息
     * @param {string} message - 要显示的消息
     * @param {string} type - 消息类型 ('info', 'error', 'success')
     */
    function updateStatus(message, type = 'info') {
        statusMessage.textContent = message;
        statusMessage.style.color = {
            'info': 'yellow',
            'error': 'red',
            'success': 'lightgreen'
        }[type] || 'yellow';
    }

    /**
     * ⭐ 核心修复：清理用户输入的 URL，防止双重代理 ⭐
     * 如果用户输入了 Worker 代理链接，则提取其内部的真实 M3U URL。
     * @param {string} url - 用户输入的 URL
     * @returns {string} - 原始的 M3U URL
     */
    function cleanInputUrl(url) {
        try {
            // 检查输入的 URL 是否已经指向 Worker 代理
            if (url.startsWith(WORKER_PROXY_BASE_URL)) {
                console.log("Input is already a worker proxy URL. Attempting to extract original URL.");
                const u = new URL(url);
                const originalUrl = u.searchParams.get('url');
                
                // 确保解码后的 URL 被返回
                if (originalUrl) {
                    // 如果成功提取，返回原始 URL
                    return decodeURIComponent(originalUrl);
                }
            }
        } catch (e) {
            console.error("Error cleaning input URL:", e);
            // 发生错误时，回退到使用原始输入
        }
        // 如果不是代理 URL，或者提取失败，则返回原始 URL
        return url;
    }

    /**
     * 将原始 URL 转换为 Worker 代理 URL
     * @param {string} url - 原始 M3U 或 M3U8/TS URL
     * @returns {string} - Worker 代理 URL
     */
    function getWorkerUrl(url) {
        if (!WORKER_PROXY_BASE_URL) {
            return url;
        }
        // 对 M3U/M3U8 链接进行编码，然后通过 Worker 代理
        return `${WORKER_PROXY_BASE_URL}?url=${encodeURIComponent(url)}`;
    }

    /**
     * 获取 M3U 文件内容 (通过 Worker 代理)
     * @param {string} url - M3U 订阅链接 (原始链接)
     * @returns {Promise<string|null>} - M3U 文件的内容文本
     */
    async function fetchM3UContent(url) {
        // 使用 Worker 代理加载 M3U 文件
        const proxyUrl = getWorkerUrl(url); 
        updateStatus(`正在通过 Worker 加载 M3U 列表: ${url.substring(0, 50)}...`, 'info');

        try {
            const response = await fetch(proxyUrl);

            if (!response.ok) {
                // 打印完整的错误信息
                const errorText = await response.text();
                throw new Error(`网络错误或源站超时: ${response.status} ${response.statusText}. Worker 响应: ${errorText}`);
            }

            const contentType = response.headers.get('content-type') || '';
            if (!contentType.includes('mpegurl') && !contentType.includes('text') && !contentType.includes('plain')) {
                 console.warn(`MIME type suggests this might not be a playlist: ${contentType}`);
            }

            const text = await response.text();
            updateStatus('M3U 列表加载成功，正在解析。', 'success');
            return text;

        } catch (error) {
            if (error.message.includes('522')) {
                 updateStatus('错误 (522): Worker 连接超时。这通常是由于 Worker 递归调用自身或无法连接到源站。请检查 M3U 链接是否有效。', 'error');
            } else {
                 updateStatus(`加载 M3U 失败: ${error.message}`, 'error');
            }
            console.error('Fetch M3U Error:', error);
            return null;
        }
    }

    /**
     * 解析 M3U 文件内容
     * @param {string} content - M3U 文件内容
     * @returns {Array<{name: string, url: string}>} - 频道列表
     */
    function parseM3U(content) {
        const lines = content.split('\n');
        const channels = [];
        let currentChannel = {};

        for (const line of lines) {
            if (line.startsWith('#EXTINF:')) {
                // 提取频道名称
                const match = line.match(/,(.+)$/);
                if (match && match[1]) {
                    currentChannel.name = match[1].trim();
                }
            } else if (line.trim().length > 0 && !line.startsWith('#')) {
                // 提取频道 URL
                currentChannel.url = line.trim();
                if (currentChannel.name && currentChannel.url) {
                    channels.push({ ...currentChannel });
                }
                currentChannel = {}; // 重置
            }
        }
        return channels;
    }

    /**
     * 渲染频道列表
     * @param {Array<{name: string, url: string}>} channels 
     */
    function renderChannels(channels) {
        channelListUl.innerHTML = '';
        channels.forEach((channel, index) => {
            const li = document.createElement('li');
            const a = document.createElement('a');
            a.href = '#';
            a.textContent = channel.name;
            a.setAttribute('data-url', channel.url);
            a.setAttribute('data-name', channel.name);
            a.onclick = (e) => {
                e.preventDefault();
                playChannel(channel.url, channel.name, index);
                
                // 移除所有激活状态
                document.querySelectorAll('#channels li a').forEach(el => {
                    el.classList.remove('active');
                });
                // 添加当前激活状态
                a.classList.add('active');
            };
            li.appendChild(a);
            channelListUl.appendChild(li);
        });
    }

    /**
     * 播放指定的频道
     * @param {string} rawUrl - 频道 M3U8/流的原始 URL
     * @param {string} name - 频道名称
     * @param {number} index - 频道索引
     */
    function playChannel(rawUrl, name, index) {
        player.pause(); // 停止当前播放

        // 将 M3U8 链接通过 Worker 代理一次。
        const url = getWorkerUrl(rawUrl); 

        // 确保 Video.js HLS 插件可用
        if (window.Hls && window.Hls.isSupported()) {
             // 如果使用 hls.js (Video.js 内部或外部)，通常只需要设置 src
             player.src({
                 src: url,
                 type: 'application/x-mpegURL'
             });
            player.load();
            player.play().catch(e => console.log("Player autplay blocked:", e));
            updateStatus(`频道播放中: ${name}`, 'success');
        } 
        // 尝试使用浏览器原生支持 (通常仅限 Safari/Edge)
        else if (videoElement.canPlayType('application/vnd.apple.mpegurl')) {
            videoElement.src = url;
            player.load();
            player.play().catch(e => console.log("Player autplay blocked:", e));
            updateStatus(`频道播放中: ${name}`, 'success');
        } 
        // 都不支持
        else {
            updateStatus('错误: 您的浏览器不支持 HLS/M3U8 流播放。', 'error');
        }
    }

    // ==========================================================
    // 事件监听器
    // ==========================================================
    loadButton.addEventListener('click', async () => {
        const m3uInput = iptvUrlInput.value.trim();
        if (!m3uInput) {
            updateStatus('请输入 M3U 订阅链接！', 'error');
            return;
        }

        // ⭐ 关键修复的应用：在加载前清理用户输入的 URL ⭐
        const m3uUrl = cleanInputUrl(m3uInput);

        // 保存清理后的 URL
        localStorage.setItem('iptvUrl', m3uUrl);

        const m3uContent = await fetchM3UContent(m3uUrl);
        
        if (m3uContent) {
            const channels = parseM3U(m3uContent);
            renderChannels(channels);
            
            if (channels.length > 0) {
                // 默认播放第一个频道
                // 使用 setTimeout 确保 DOM 渲染完成
                setTimeout(() => {
                    document.querySelector('#channels li a')?.click();
                }, 50); 
            } else {
                 updateStatus('M3U 文件已加载，但未找到任何频道。', 'error');
            }
        }
    });

    // 从本地存储加载 URL (可选优化)
    const storedUrl = localStorage.getItem('iptvUrl');
    if (storedUrl) {
        iptvUrlInput.value = storedUrl;
        loadButton.click(); // 自动加载
    }
});
