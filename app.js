document.addEventListener('DOMContentLoaded', () => {
    const iptvUrlInput = document.getElementById('iptv-url');
    const loadButton = document.getElementById('load-playlist');
    const channelListUl = document.getElementById('channels');
    const statusMessage = document.getElementById('status-message');
    const videoElement = document.getElementById('tv-player');
    
    // 初始化 Video.js 播放器
    const player = videojs(videoElement);

    // ==========================================================
    // !!! 关键配置: 替换为 AllOrigins 公共 CORS 代理 !!!
    // ==========================================================
    // 注意：使用公共代理仍有风险，但它使用标准的查询参数格式，可能更稳定。
    // 代理的调用方式是：WORKER_PROXY_BASE_URL + 目标URL
    const WORKER_PROXY_BASE_URL = 'https://api.allorigins.win/raw?url='; 

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
     * 获取 M3U 文件内容 (通过公共 CORS 代理)
     * @param {string} url - M3U 订阅链接
     * @returns {Promise<string|null>} M3U 文件内容或 null
     */
    async function fetchM3UContent(url) {
        updateStatus('正在通过公共代理 (AllOrigins) 加载 M3U 文件...', 'info');
        
        // ⭐ 核心修改: 拼接 URL。AllOrigins 需要在它的 ?url= 后面接上 encodeURIComponent(url)
        const proxyUrl = WORKER_PROXY_BASE_URL + encodeURIComponent(url);

        try {
            const response = await fetch(proxyUrl, {
                // 强制使用 no-cache 防止代理缓存旧的 M3U 文件
                headers: { 'Cache-Control': 'no-cache' } 
            });

            if (!response.ok) {
                // 检查源站或代理是否返回 4xx/5xx 错误
                const errorText = await response.text();
                updateStatus(`加载 M3U 失败: 状态码 ${response.status}。请检查流源或更换公共代理。`, 'error');
                console.error("Fetch Error Details:", errorText);
                return null;
            }

            const m3uContent = await response.text();
            updateStatus('M3U 文件加载成功！正在解析频道...', 'info');
            return m3uContent;

        } catch (e) {
            updateStatus(`网络或代理请求失败: ${e.message}`, 'error');
            return null;
        }
    }

    /**
     * 解析 M3U 文件内容
     * @param {string} content - M3U 文件文本内容
     * @returns {Array<{name: string, url: string}>} 频道列表
     */
    function parseM3U(content) {
        const lines = content.split('\n');
        const channels = [];
        let currentChannel = {};

        for (const line of lines) {
            if (line.startsWith('#EXTINF')) {
                // 提取频道名称
                const match = line.match(/,(.*)$/);
                if (match) {
                    currentChannel.name = match[1].trim();
                }
            } else if (line.startsWith('http') || line.startsWith('https')) {
                // 提取频道URL
                currentChannel.url = line.trim();
                if (currentChannel.name && currentChannel.url) {
                    channels.push(currentChannel);
                }
                currentChannel = {}; // 重置
            }
        }
        return channels;
    }

    /**
     * 渲染频道列表
     * @param {Array<{name: string, url: string}>} channels - 频道列表
     */
    function renderChannels(channels) {
        channelListUl.innerHTML = '';
        if (channels.length === 0) {
            channelListUl.innerHTML = '<p>未找到频道。</p>';
            return;
        }

        channels.forEach(channel => {
            const listItem = document.createElement('li');
            const link = document.createElement('a');
            
            link.href = '#';
            link.textContent = channel.name;
            link.dataset.url = channel.url;
            link.dataset.name = channel.name;

            link.addEventListener('click', (e) => {
                e.preventDefault();
                // 移除所有高亮
                document.querySelectorAll('#channels li a').forEach(a => a.classList.remove('active'));
                // 添加当前高亮
                link.classList.add('active');
                
                playChannel(link.dataset.url, link.dataset.name);
            });

            listItem.appendChild(link);
            channelListUl.appendChild(listItem);
        });

        updateStatus(`成功加载 ${channels.length} 个频道。`, 'success');
    }

    /**
     * 播放指定的频道流
     * @param {string} url - 频道 M3U8/MP4 等流地址
     * @param {string} name - 频道名称
     */
    function playChannel(url, name) {
        updateStatus(`正在尝试播放: ${name}`, 'info');

        // 停止并清理旧的 HLS 实例
        if (player.hls) {
            player.hls.destroy();
            player.hls = null;
        }
        
        let proxiedUrl = url;
        
        // ⭐ 核心修改：使用公共代理封装最终的流地址
        // 公共代理格式：proxy?url= + encodeURIComponent(url)
        proxiedUrl = WORKER_PROXY_BASE_URL + encodeURIComponent(url);
        
        // 尝试使用 hls.js (推荐用于 M3U8)
        if (Hls.isSupported()) {
            player.pause(); // 暂停 Video.js
            
            player.hls = new Hls({
                // 启用调试日志
                debug: false, 
                xhrSetup: function (xhr, url) {
                    // 无法在客户端设置 User-Agent 等头部，这需要代理服务器实现
                    xhr.setRequestHeader('X-Requested-With', 'XMLHttpRequest'); 
                }
            });
            
            player.hls.loadSource(proxiedUrl); // 使用代理后的 URL 加载流
            player.hls.attachMedia(videoElement);

            player.hls.on(Hls.Events.MANIFEST_PARSED, () => {
                player.play().catch(e => console.log("Player autplay blocked:", e));
                updateStatus(`频道播放中: ${name}`, 'success');
            });

            player.hls.on(Hls.Events.ERROR, (event, data) => {
                if (data.fatal) {
                    switch(data.type) {
                        case Hls.ErrorTypes.NETWORK_ERROR:
                            updateStatus(`HLS 网络错误: 无法加载流片段。请检查流源是否有效或更换代理。`, 'error');
                            break;
                        case Hls.ErrorTypes.MEDIA_ERROR:
                            updateStatus(`HLS 媒体错误: 视频播放失败。`, 'error');
                            break;
                        default:
                            player.hls.destroy();
                            updateStatus(`HLS 致命错误: ${data.details}`, 'error');
                            break;
                    }
                }
            });

        } 
        // 尝试 Video.js 原生播放 (用于 MP4 或浏览器原生支持的 HLS)
        else if (videoElement.canPlayType('application/vnd.apple.mpegurl') || videoElement.canPlayType('application/x-mpegURL')) {
            videoElement.src = proxiedUrl;
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
        const m3uUrl = iptvUrlInput.value.trim();
        if (!m3uUrl) {
            updateStatus('请输入 M3U 订阅链接！', 'error');
            return;
        }
        
        localStorage.setItem('iptvUrl', m3uUrl);

        const m3uContent = await fetchM3UContent(m3uUrl);
        
        if (m3uContent) {
            const channels = parseM3U(m3uContent);
            renderChannels(channels);
            
            if (channels.length > 0) {
                // 默认播放第一个频道
                // 直接点击即可
                document.querySelector('#channels li a')?.click(); 
            } else {
                 updateStatus('M3U 文件已加载，但未找到任何频道。', 'error');
            }
        }
    });

    // 从本地存储加载 URL (可选优化)
    const storedUrl = localStorage.getItem('iptvUrl');
    if (storedUrl) {
        iptvUrlInput.value = storedUrl;
        // 自动触发加载
        loadButton.click(); 
    }
});
